import { Effect } from 'effect';

import type { EncodingRegistry } from '#/encoding/encoding-registry.ts';
import type { EncodingDecoder, FeedableOptions } from '#/options.ts';
import type { ParseError } from '#/parse-error.ts';

import { sniff } from '#/encoding/encoding-detector.ts';
import { createTextDecoderAdapter } from '#/encoding/text-decoder-adapter.ts';
import { DataMustBeString, InvalidInput } from '#/parse-error.ts';
import { QUOTE_PAIRS_CAPACITY } from '#/util.ts';

import type { InputSourceLike } from './input-source.ts';

import { canRead, matchAhead, readCh, readChAt, readStr, readTextRun, readUpto, readUptoChar, readUptoCloseTag } from './char-scan-reads.ts';
import { scanTagExpEnd, scanTagExpEndFast } from './scan-tag-exp-end.ts';

// Matches EncodingDetector's own declaration-peek window — bounds how much
// raw (undecoded) data 'auto' mode ever holds before giving up and resolving
// on whatever it has (a document with no BOM and no <?xml?> declaration is
// legitimately using the utf8 default, not something to keep waiting on).
const SNIFF_CAP = 200;

/**
 * @description `?>` — the end of an XML declaration, searched for in the sniff buffer to decide whether enough has arrived to read an `encoding="…"` attribute. A
 * module-level constant so the byte search does not rebuild it on every `feed()`.
 */
const DECLARATION_END = new Uint8Array([0x3f, 0x3e]); // '?' '>'

/**
 * @description Narrow any byte-array view to a `Uint8Array` over exactly its own bytes, without copying. `ArrayBufferView` is wider than `Uint8Array` (a
 * `DataView` or an `Int8Array` would satisfy `isView` but not be decodable as text), and this is the one place the package has to accept a view it
 * was handed rather than one it constructed, so the byteOffset/byteLength window is respected rather than assumed.
 *
 * @param view - A byte array or any `ArrayBufferView`.
 *
 * @returns A `Uint8Array` viewing the same memory, offset and length preserved.
 */
function toBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * @description Decide how this source will obtain its stateful decoder, which depends on which of the three encoding modes the caller selected:
 *
 * - An explicit name with a registry: resolve it and build the decoder. The resolve is deferred into the returned closure because the constructor must
 *   not fail on an unknown name — `feed()` reports it as `UNSUPPORTED_ENCODING` against real bytes, not against a source nobody ever fed.
 * - `'auto'`: nothing to build yet. Detection needs bytes that have not arrived, so the factory is `null` and `#resolveDetection()` supplies one once
 *   the sniff buffer holds enough.
 * - Neither supplied (direct construction, bypassing `XMLParser`): the caller's own `createDecoder`, else `null`, which `feed()` reads as plain utf8.
 *
 * @param options - The options the source was constructed with.
 * @param decodingOptions - `options.decoding`, normalized to `null` when absent.
 * @param detecting - Whether the `'auto'` mode is in effect, already computed by the caller.
 *
 * @returns A deferred decoder factory answering with an `Effect`, or `null` when detection must resolve the encoding first or the caller supplied no
 *   factory. The effect is where an explicit name is resolved against the registry, so an unknown name surfaces from `feed()`/`end()` rather than
 *   from constructing a source nobody ever fed.
 */
function decoderFactoryFor(
  options: FeedableSourceOptions,
  decodingOptions: FeedableSourceOptions['decoding'] | null,
  detecting: boolean
): (() => Effect.Effect<EncodingDecoder, ParseError>) | null {
  const requested = decodingOptions?.encoding;
  if (!detecting && requested && decodingOptions?.registry) {
    const registry = decodingOptions.registry;
    return () => Effect.map(registry.resolve(requested), descriptor => descriptor.createDecoder());
  }
  const createDecoder = options.createDecoder;
  return typeof createDecoder === 'function' ? () => Effect.succeed(createDecoder()) : null;
}

/**
 * @description Whether `haystack` contains `needle` as a contiguous byte run. `Uint8Array.prototype.includes` compares element identity, not byte value, so it
 * cannot answer this — hence the explicit loop over a 2-byte needle.
 */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const limit = haystack.length - needle.length;
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * @description Decoding inputs a `FeedableSource` / `StreamSource` can be constructed with. Internal — `XMLParser` builds this from the user's `feedable` and
 * `decoding` options; tests may pass `createDecoder` directly.
 */
export interface FeedableSourceOptions extends FeedableOptions {
  /**
   * @description Encoding name to resolve through the `registry` of the {@link FeedableSourceOptions.decoding} object, or `'auto'` to sniff once enough bytes have
   * arrived. Omit for plain utf8.
   */
  decoding?: {
    /**
     * @description Encoding name, or `'auto'` to defer resolution until a BOM / `<?xml?>` declaration / {@link SNIFF_CAP} bytes have been seen.
     */
    encoding?: string;
    /**
     * @description Registry to resolve {@link encoding} against. Required for both the explicit and the `'auto'` path.
     */
    registry: EncodingRegistry;
  };
  /**
   * @description Direct decoder factory, bypassing the registry entirely. Used when a `FeedableSource` is constructed without going through `XMLParser`.
   */
  createDecoder?: (() => EncodingDecoder) | undefined;
}

/**
 * @description FeedableSource — input source for the feed()/end() API. Accepts incremental string/byte-array chunks via feed(), accumulates them in a single
 * string buffer, and exposes the same read interface as `StringSource` so `Xml2JsParser` can use it without modification.
 *
 * ### Incremental parsing
 *
 * The parser calls `parseXml()` after every `feed()` call, consuming as much of the buffer as possible. When a chunk boundary falls mid-token (e.g. a
 * CDATA section split across two feeds), every reader function marks its start position with `markTokenStart()` before it begins. If the reader
 * throws `UNEXPECTED_END`, the caller (`XMLParser.feed`) catches it and calls `rewindToMark()` to restore `startIndex` to the beginning of the
 * incomplete token. The incomplete bytes stay in the buffer and are re-parsed on the next feed once the rest of the token has arrived.
 *
 * ### Two-level mark stack
 *
 * There are two mark levels: level 0 — outer mark, set by `parseXml()`'s main loop BEFORE it reads the `<` character that begins a tag dispatch. This
 * is the position that `rewindToMark()` always restores to, so the full tag (including its `<![`, `</`, etc. prefix) is replayed correctly on the
 * next `feed()`. Level 1 — inner mark, set by individual reader functions (`readCdata`, `readClosingTagName`, `readTagExp`, …) at the point where
 * _they_ begin. This does NOT affect `rewindToMark()`; it is used only by `flush()` to determine the safe trim boundary while a reader is in
 * progress. Using two levels instead of a single slot prevents inner `markTokenStart()` calls from overwriting the outer mark that `feed()` needs to
 * rewind to.
 *
 * ### Memory
 *
 * Parsed data is reclaimed from the buffer automatically (`autoFlush`) once the processed portion exceeds `flushThreshold` bytes. Because
 * `parseXml()` runs per chunk and completed tokens are consumed before the next chunk arrives, only incomplete tokens at the current chunk boundary
 * are retained — not the whole document. `maxBufferSize` is checked against the live (unprocessed) portion of the buffer plus the incoming chunk, not
 * the raw `buffer.length`, so post-flush sizing stays accurate.
 *
 * @implements {InputSourceLike}
 */
export default class FeedableSource implements InputSourceLike {
  /**
   * @description Decoded, not-yet-trimmed document text. Built by repeated `+=`, so it may be a V8 rope — hence bracket access over `charCodeAt` in the shared
   * scanners.
   */
  buffer: string;
  /**
   * @description Offset into {@link buffer} of the next character to read. Rebased downward by `flush()`.
   */
  startIndex: number;
  /**
   * @description Whether {@link end()} has been called. Readers use it to distinguish a genuine truncation from a chunk boundary.
   */
  isComplete: boolean;
  /**
   * @description Running total of characters trimmed off the front by {@link flush} so far — the other half of `util.absolutePosition()`.
   */
  _baseOffset: number;
  /**
   * @description Hard cap on buffered characters, checked against live (unprocessed) data plus the incoming chunk.
   */
  maxBufferSize: number;
  /**
   * @description Whether processed characters are discarded automatically past {@link flushThreshold}.
   */
  autoFlush: boolean;
  /**
   * @description Processed-character count that triggers an automatic {@link flush}.
   */
  flushThreshold: number;
  /**
   * @description How the decoder for this session is produced. Reassigned once when `'auto'` detection resolves. The factory answers with an `Effect` because
   * resolving an explicit encoding name can fail with `UNSUPPORTED_ENCODING`.
   */
  _createDecoder: (() => Effect.Effect<EncodingDecoder, ParseError>) | null;
  /**
   * @description `'auto'` mode only. Raw undecoded bytes held back until there is enough to decide an encoding.
   */
  _sniffBuffer: Uint8Array | null;
  /**
   * @description Two-level mark stack. `null` means "not set" for that level.
   */
  _marks: [number | null, number | null];
  /**
   * @description Reusable scratch array of quote positions, filled by {@link scanTagExpEnd} and reused by `AttributeProcessor`. Safe across a chunk-boundary
   * rewind: the failed scan's contents are irrelevant the moment the tag is re-scanned from scratch on the next `feed()`.
   */
  _quotePairs: Int32Array<ArrayBuffer>;
  /**
   * @description How many {@link _quotePairs} slots hold valid data.
   */
  _quotePairsLen: number;

  #decodingOptions: FeedableSourceOptions['decoding'] | null;
  #detecting: boolean;
  /**
   * @description Lazily-created and persistent for the whole `feed()` session. Byte chunks must go through this rather than a per-chunk decode — decoding each
   * chunk in isolation corrupts a multi-byte UTF-8 character whose bytes straddle a chunk boundary (each half independently replaced with U+FFFD).
   * The decoder holds back an incomplete trailing sequence internally and prepends it to the next `write()`, so a split character decodes correctly
   * once the rest of its bytes arrive. Only created if byte input is ever fed — string-only callers never pay for it.
   */
  #decoder: EncodingDecoder | null;

  constructor(options: FeedableSourceOptions = {}) {
    this.buffer = '';
    this.startIndex = 0;
    this.isComplete = false;
    // Running total of characters trimmed off the front by flush() so far.
    // See string-source.js's copy of this field / util.js#absolutePosition —
    // startIndex alone drifts from the true document offset after any flush.
    this._baseOffset = 0;

    this.maxBufferSize = options.maxBufferSize || 10 * 1024 * 1024; // 10 MB
    this.autoFlush = options.autoFlush !== false; // true by default
    this.flushThreshold = options.flushThreshold || 1024; // 1 KB

    // Encoding resolution. Three modes:
    //   - explicit name (options.decoding.encoding, e.g. 'utf16le'): resolve
    //     a decoder immediately via the registry.
    //   - 'auto': can't build a decoder yet — not enough bytes seen. Buffer
    //     raw (undecoded) bytes in `_sniffBuffer` until either a BOM+enough
    //     bytes, a complete `<?xml ... ?>` declaration, or SNIFF_CAP bytes
    //     have accumulated, then resolve once via #resolveDetection() and
    //     replay the held bytes through the real decoder. See feed() below.
    //   - neither supplied (direct FeedableSource construction, bypassing
    //     XMLParser): falls back to a caller-supplied `options.createDecoder`
    //     if given, else plain utf8 — identical to this class's behavior
    //     before this feature existed.
    this.#decodingOptions = options.decoding || null;
    const decodingOptions = this.#decodingOptions;
    this.#detecting = decodingOptions?.encoding === 'auto';
    this._sniffBuffer = this.#detecting ? new Uint8Array(0) : null;
    this._createDecoder = decoderFactoryFor(options, decodingOptions, this.#detecting);

    /**
     * @description Two-level mark stack. _marks[0] — outer mark: set by parseXml()'s loop before consuming '<'. rewindToMark() always restores startIndex here.
     * _marks[1] — inner mark: set by individual reader functions. Used only by flush() as the safe trim boundary. `null` means "not set" for that
     * level. Each entry is a plain startIndex number — no line/col to carry alongside it, since position reporting is index-only.
     */
    this._marks = [null, null];

    /**
     * @description Lazily-created, persistent across the whole feed() session. Byte chunks must go through this rather than a per-chunk decode — decoding each
     * chunk in isolation corrupts a multi-byte UTF-8 character whose bytes straddle a chunk boundary (each half independently replaced with U+FFFD).
     * The decoder holds back an incomplete trailing sequence internally and prepends it to the next write(), so a split character decodes correctly
     * once the rest of its bytes arrive. Only created if byte input is ever fed — string-only callers never pay for it.
     */
    this.#decoder = null;

    // Reused across every scanTagExpEnd() call, never reallocated. See
    // string-source.js's copy of this field for the full doc (fixed-capacity
    // typed array + manual length, not push()). Safe across a
    // chunk-boundary rewind: the failed scan's contents are irrelevant the
    // moment the tag is re-scanned from scratch on the next feed().
    this._quotePairs = new Int32Array(QUOTE_PAIRS_CAPACITY);
    this._quotePairsLen = 0;
  }

  /**
   * @description Append a data chunk to the buffer. `maxBufferSize` is checked against the live unprocessed portion (`buffer.length - startIndex`) plus the
   * incoming data length. Data that has already been parsed and is waiting to be flushed does not count against the limit.
   *
   * @param data - Next chunk. A `Buffer` or any `Uint8Array` is decoded through the session's stateful decoder; a string is assumed to be already
   *   decoded.
   *
   * @returns An effect producing the number of characters appended to the buffer (after decoding) — callers that track fed-byte totals (e.g.
   *   `XMLParser.feed`'s batch threshold) should use this rather than the raw input length, since a byte chunk ending mid-character may decode to
   *   fewer chars than its byte length until the next chunk completes the sequence. Fails with `INVALID_INPUT` when the buffer limit is exceeded,
   *   `DATA_MUST_BE_STRING` for an unsupported chunk type, and `UNSUPPORTED_ENCODING` when an explicit encoding name cannot be resolved.
   */
  feed = Effect.fnUntracedEager(function* (this: FeedableSource, data: string | Uint8Array): Effect.fn.Return<number, ParseError> {
    if (this.#detecting) {
      if (typeof data === 'string') {
        // Already decoded upstream (e.g. stream.setEncoding() was called by
        // the caller) — detection is moot, nothing left to sniff.
        this.#detecting = false;
      } else {
        const chunk = toBytes(data);
        const held = this._sniffBuffer;
        const merged = held !== null && held.length ? concatBytes(held, chunk) : chunk;
        this._sniffBuffer = merged;
        const declarationComplete = containsBytes(merged, DECLARATION_END);
        if (merged.length < SNIFF_CAP && !declarationComplete) {
          // Not enough to decide yet — hold everything, decode nothing.
          return 0;
        }
        data = yield* this.#resolveDetection();
      }
    }

    const newData = yield* this.#decodeNow(data);

    const liveBytes = this.buffer.length - this.startIndex;

    if (liveBytes + newData.length > this.maxBufferSize) {
      return yield* new InvalidInput({
        option: 'feedable.maxBufferSize',
        received: `${liveBytes + newData.length} > ${this.maxBufferSize}`,
        message:
          `Buffer size limit exceeded (${liveBytes + newData.length} > ${this.maxBufferSize}). ` +
          `Increase feedable.maxBufferSize or reduce chunk size.`,
      });
    }

    this.buffer += newData;
    return newData.length;
  });

  #decodeNow = Effect.fnUntracedEager(function* (this: FeedableSource, data: string | Uint8Array): Effect.fn.Return<string, ParseError> {
    if (typeof data === 'string') return data;
    if (ArrayBuffer.isView(data)) {
      // Stateful decode: bytes of a multi-byte char split across two feed()
      // calls are buffered internally by the decoder and correctly stitched
      // together, instead of each chunk being decoded in isolation.
      if (!this.#decoder) {
        const factory = this._createDecoder;
        this.#decoder = factory ? yield* factory() : createTextDecoderAdapter('utf-8');
      }
      return this.#decoder.write(toBytes(data));
    }
    // Defensive tail: `feed()`'s contract is `string | Uint8Array` and both are
    // handled above, but anything else carrying a usable toString() is coerced
    // rather than rejected outright.
    const coercible = data as { toString(): string };
    if (typeof coercible?.toString === 'function') return coercible.toString();
    return yield* new DataMustBeString({ received: typeof data, message: 'feed() data must be a string or a byte array.' });
  });

  /**
   * @description Resolve 'auto' encoding from `_sniffBuffer` (BOM + `<?xml encoding="...">` sniffing, XML 1.0 Appendix F — see `encoding/encoding-detector.ts`),
   * build the real decoder, strip any BOM, and return the held bytes ready to be decoded normally by the caller in `feed()`. Runs exactly once per
   * session.
   *
   * @returns An effect producing the held bytes, minus any BOM. Fails with `ENCODING_MISMATCH` when a BOM contradicts the declaration, or
   *   `UNSUPPORTED_ENCODING` when the detected name cannot be resolved.
   */
  #resolveDetection = Effect.fnUntracedEager(function* (this: FeedableSource): Effect.fn.Return<Uint8Array, ParseError> {
    const decoding = this.#decodingOptions as NonNullable<FeedableSourceOptions['decoding']>;
    const sniffBuffer = this._sniffBuffer as Uint8Array;
    const { encoding, bomLength } = yield* sniff(sniffBuffer, decoding.registry);
    const descriptor = yield* decoding.registry.resolve(encoding);
    this._createDecoder = () => Effect.succeed(descriptor.createDecoder());
    this.#detecting = false;
    const held = bomLength ? sniffBuffer.subarray(bomLength) : sniffBuffer;
    this._sniffBuffer = null;
    return held;
  });

  /**
   * @description Signal that no more data will be fed. Flushes the decoder's held-back bytes and marks the source complete.
   *
   * @returns An effect that finalizes the source. Fails with the same encoding errors `feed()` can.
   */
  end = Effect.fnUntracedEager(function* (this: FeedableSource): Effect.fn.Return<void, ParseError> {
    if (this.#detecting) {
      // Whole document arrived without ever reaching SNIFF_CAP or a
      // complete declaration (a short, unadorned document like <root/>) —
      // resolve now, on whatever bytes we have.
      const held = yield* this.#resolveDetection();
      this.buffer += yield* this.#decodeNow(held);
    }
    if (this.#decoder) {
      // Flush any final incomplete byte sequence held by the decoder. For
      // well-formed UTF-8 input this is normally '' (nothing pending); a
      // non-empty result here means the input was genuinely truncated
      // mid-character, and the decoder's own U+FFFD substitution is the
      // correct, standard behavior for that case.
      const tail = this.#decoder.end();
      if (tail) this.buffer += tail;
    }
    this.isComplete = true;
  });

  /**
   * @description Returns true when there is at least one character available at or after the given offset (relative to startIndex).
   */
  canRead = canRead;

  // ─── Two-level mark API ───────────────────────────────────────────────────

  /**
   * @description Save the current read position into the mark stack. The `level` parameter selects which mark slot to write: level 0 (default) — outer mark,
   * written by `parseXml()`'s main loop before it reads the `<` that begins a dispatch. level 1 — inner mark, written by reader functions
   * (`readCdata`, `readClosingTagName`, `readTagExp`, …) at the start of their own logic. The two levels are independent. An inner
   * `markTokenStart(1)` never overwrites the outer `mark[0]` that `rewindToMark()` relies on.
   */
  markTokenStart(level: 0 | 1 = 0) {
    this._marks[level] = this.startIndex;
  }

  /**
   * @description Restore startIndex to the OUTER mark (level 0) and clear both marks. Always rewinds to the outermost saved position so the full tag — including
   * any prefix characters consumed by `parseXml()` before the dispatch (e.g. `<`, `!`, `[`) — is replayed on the next `feed()`. Called by
   * `XMLParser.feed()` when a reader throws UNEXPECTED_END.
   */
  rewindToMark() {
    if (this._marks[0] !== null) {
      this.startIndex = this._marks[0];
    }
    this._marks[0] = null;
    this._marks[1] = null;
  }

  /**
   * @description Clear both mark slots after a token completes successfully. Should be called (or marks allowed to be overwritten) once a dispatch fully succeeds
   * so stale positions don't block `flush()`. In practice the outer mark is overwritten at the top of every `parseXml()` loop iteration, so explicit
   * clearing is only needed when the loop does NOT continue (e.g. after a non-`<` character is consumed as plain text). The flush guard uses the
   * minimum of set marks, so a stale mark only delays flushing — it does not cause correctness issues.
   */
  clearMark() {
    this._marks[0] = null;
    this._marks[1] = null;
  }

  /**
   * @description Read next character and advance position.
   *
   * @returns The character, or `undefined` at end of input.
   */
  // Shared with StringSource and CharScanStrategy, which are the same three
  // sources reading the same kind of buffer. See char-scan-reads.ts. Assigned
  // rather than wrapped so `this` binds correctly with no call-site indirection.

  readCh = readCh;

  /**
   * @description Read character at offset without advancing.
   *
   * @param index - Offset from current position.
   *
   * @returns The character, or `undefined` past the end.
   */
  readChAt = readChAt;

  /**
   * @description Read n characters as string.
   *
   * @param n - Number of characters to read.
   * @param from - Start position. Defaults to the current position.
   */
  readStr = readStr;

  /**
   * @description See `StringSource`'s copy of this method for the full doc — identical contract, same plain-string buffer shape. The buffer here may be a V8 rope
   * built by repeated `+=`, which `indexOf` flattens once rather than re-reading it through bracket access.
   */
  readTextRun = readTextRun;

  /**
   * @description See `StringSource`'s copy of this method for the full doc — identical contract here. `null` (not enough buffered data yet) is the routine case
   * for this source in particular, since a chunk boundary can land mid-check; callers already have to handle that the same way they handle
   * `scanTagExpEnd`'s `-1`.
   */
  matchAhead = matchAhead;

  // Two variants — caller picks once based on skip.attributes, no flag
  // evaluated inside the loop. Bracket access (not charCodeAt) is load-bearing
  // here: this buffer is a V8 ConsString/rope built via repeated +=, and
  // charCodeAt would force a full flatten on every access (confirmed O(n^2)
  // memory regression). The shared implementations use bracket access throughout.
  // See src/input-source/scan-tag-exp-end.js.
  scanTagExpEnd = scanTagExpEnd;
  scanTagExpEndFast = scanTagExpEndFast;

  /**
   * @description Read until stop string is found.
   *
   * @param stopStr - The string to read up to. Consumed when found.
   *
   * @returns Content before the stop string.
   *
   * @throws {ParseError} UNEXPECTED_END when stop string is not found
   */
  readUpto = readUpto;

  /**
   * @description Single-character variant of readUpto — faster because there is no inner match loop. Reads until `stopChar` is found, consumes it, and returns the
   * text before it.
   *
   * @param stopChar Exactly one character.
   */
  readUptoChar = readUptoChar;

  /**
   * @description Read until a closing tag is found (used for stop nodes).
   *
   * @param stopStr E.g. `"</tagname"`
   *
   * @returns Raw content between the current position and the closing tag
   *
   * @throws {ParseError} UNEXPECTED_END when the closing tag is not found
   */
  readUptoCloseTag = readUptoCloseTag;

  /**
   * @description Advance the read cursor by n characters. Triggers an automatic flush of already-processed data when autoFlush is enabled, the processed portion
   * has grown past flushThreshold, and no mark is currently active. Any active mark (either level) blocks the flush to prevent the saved position
   * from becoming invalid.
   */
  updateBufferBoundary(n: number = 1) {
    this.startIndex += n;
    // No "any mark active" gate here — flush()'s own min(startIndex, marks...)
    // origin computation already guarantees any in-progress token (at either
    // mark level) survives the trim. A separate boolean gate on top of that
    // was redundant, and since _marks[0] is set on every parseXml() loop
    // iteration and never nulled outside of rewindToMark() (an error path),
    // that gate was effectively permanent — flush() never ran in normal
    // operation. See specs/flushArchitecture_spec.js for the regression test.
    if (this.autoFlush && this.startIndex >= this.flushThreshold) {
      this.flush();
    }
  }

  /**
   * @description Discard already-processed data from the front of the buffer to free memory. startIndex is reset to 0 after the trim. The flush origin is the
   * minimum of all active mark positions, so that any in-progress token (at either mark level) is preserved in the buffer and can be re-read after
   * the flush. This is the sole safety mechanism for flush() — callers do not need to additionally check "is a mark active" before calling this; an
   * active mark simply caps how much origin can advance, rather than blocking the call outright. If no marks are active, the origin is startIndex
   * itself — everything before the current read position is discarded.
   */
  flush() {
    // Determine the earliest position that must be kept.
    let origin = this.startIndex;
    for (const m of this._marks) {
      if (m !== null && m < origin) origin = m;
    }

    if (origin > 0) {
      this.buffer = this.buffer.substring(origin);

      // Adjust all mark offsets by the amount trimmed.
      const marksLen = this._marks.length;
      for (let i = 0; i < marksLen; i++) {
        const mark = this._marks[i as 0 | 1];
        if (mark !== null) this._marks[i as 0 | 1] = mark - origin;
      }

      this.startIndex -= origin;
      this._baseOffset += origin;
    }
  }
}
