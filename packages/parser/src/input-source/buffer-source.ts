import type { Effect } from 'effect';

import type { EncodingProfile } from '#/encoding/encoding-profile.ts';
import type { BufferSourceOptions } from '#/input-source/buffer-source-options.ts';
import type { ParseError } from '#/parse-error.ts';

import { createCharScanStrategy } from '#/encoding/scan-strategy/char-scan-strategy.ts';
import { createTextDecoderAdapter } from '#/encoding/text-decoder-adapter.ts';
import { QUOTE_PAIRS_CAPACITY } from '#/util.ts';

import type { InputSourceLike } from './input-source.ts';

/**
 * @description BufferSource — input source backed by a byte array.
 *
 * ### Bytes in, string out
 *
 * The bytes are decoded once, in the constructor, and every read after that works on a JS string — the same `CharScanStrategy` `StringSource` uses.
 * This used to take a byte-scan fast path for self-synchronizing encodings, avoiding the decoded string, but it measured slower than decoding up
 * front (588 ms vs 508 ms on a 4.5 MiB document) because it needed 2.5M tiny per-token decodes to avoid one. See `encoding-profile.ts`'s doc for the
 * full reasoning. The decoded string means every reader, mark and flush rule is the string implementation, and this class holds no `Buffer`.
 *
 * ### Memory reclamation
 *
 * The full document is available from the start, so there is no chunk-boundary risk and `rewindToMark()` is a safe no-op. However, the parsed prefix
 * of the decoded string is held in memory until the parse finishes. `flush()` reclaims it by slicing the string and resetting `startIndex` to 0. The
 * same mark/flush protocol used by `FeedableSource` is implemented here so all reader functions work without source-type conditionals:
 * `markTokenStart()` — save current read position at the start of a token; `rewindToMark()` — no-op for `BufferSource` (full doc always present);
 * `flush()` — drop the already-parsed prefix to free memory. Auto-flush fires inside `updateBufferBoundary()` whenever the processed portion exceeds
 * `flushThreshold` and no token checkpoint is active.
 *
 * ### Index units
 *
 * `startIndex` is a CHARACTER offset into the decoded string, not a byte offset. Callers report positions through `util.absolutePosition()` and never
 * interpret the raw index themselves. A byte-offset reading of this field predates the decode-first design and no longer applies.
 *
 * @implements {InputSourceLike}
 */
export default class BufferSource implements InputSourceLike {
  /**
   * @description The decoded document. The input bytes are decoded once in the constructor and this string is what every read scans; `flush()` trims a prefix of
   * it as the document is consumed.
   */
  buffer: string;
  /**
   * @description Character offset into {@link buffer} of the next character to read. Rebased downward by `flush()`.
   */
  startIndex: number;
  /**
   * @description Running total of characters trimmed off the front by `flush()` so far — the other half of `util.absolutePosition()`.
   */
  _baseOffset: number;
  /**
   * @description Whether already-processed characters are discarded automatically past {@link flushThreshold}.
   */
  autoFlush: boolean;
  /**
   * @description Processed-character count that triggers an automatic {@link flush}.
   */
  flushThreshold: number;
  /**
   * @description Start of the token currently being read, or `-1` when no token is in progress. Caps how far {@link flush} may trim.
   */
  _tokenStart: number;
  /**
   * @description Reusable scratch array holding flat `[openIdx, closeIdx, …]` quote positions found by the most recent `scanTagExpEnd()`. See `StringSource`'s
   * copy of this field for the rationale behind a fixed typed array over `Array.push()`.
   */
  _quotePairs: Int32Array<ArrayBuffer>;
  /**
   * @description How many {@link _quotePairs} slots hold valid data.
   */
  _quotePairsLen: number;
  /**
   * @description Resolved encoding name, for diagnostics. Set from the profile's descriptor.
   */
  encodingName: string;

  // Character-level reads and cursor movement come from the resolved
  // `ScanStrategy`, assigned onto this instance in the constructor. Declared
  // with `declare` so they describe the contract without emitting a field
  // initialiser that would shadow the assignment.
  declare readCh: () => string | undefined;
  declare readChAt: (index: number) => string | undefined;
  declare readStr: (n: number, from?: number) => string;
  declare matchAhead: (expected: string, caseInsensitive?: boolean) => boolean | null;
  declare scanTagExpEnd: () => number;
  declare scanTagExpEndFast: () => number;
  declare readUpto: (stopStr: string) => Effect.Effect<string, ParseError>;
  declare readUptoChar: (stopChar: string) => Effect.Effect<string, ParseError>;
  declare readUptoCloseTag: (stopStr: string) => Effect.Effect<string, ParseError>;
  declare readFromBuffer: (n: number, shouldUpdate?: boolean) => string | undefined;
  declare updateBufferBoundary: (n?: number) => void;
  declare canRead: (n?: number) => boolean;

  /**
   * @param bytesArr - The full XML document as a byte array. Accepts a `Buffer`, a `Uint8Array`, or any `ArrayBufferView`; the parser's own entry
   *   points narrow to those before calling this.
   * @param options.autoFlush - Enable automatic flushing. Default is `true`
   * @param options.flushThreshold - Flush after this many processed characters. Default is `1024`
   * @param profile - Resolved encoding profile from `encoding/encoding-profile.ts#buildProfileForBuffer`. Omit for the zero-config UTF-8 default
   *   (used directly by tests/callers that don't go through `XMLParser`).
   */
  constructor(bytesArr: Uint8Array, options: BufferSourceOptions = {}, profile: EncodingProfile | null = null) {
    // BOM bytes (if any) are detection artifacts, not content — strip them
    // and exclude from the index.
    const body = profile?.bomLength ? bytesArr.subarray(profile.bomLength) : bytesArr;

    // Decode once, up front, and scan the resulting string. Every encoding
    // takes this path; there is no byte-scan alternative (see the class doc).
    // The fallback covers a directly-constructed BufferSource with no profile,
    // which has always meant plain UTF-8.
    const decoder = profile?.descriptor?.createDecoder() ?? createTextDecoderAdapter('utf-8');
    this.buffer = decoder.write(body) + decoder.end();
    this.startIndex = 0;
    // Running total of bytes/chars trimmed off the front by flush() so far.
    // See string-source.js's copy of this field / util.js#absolutePosition —
    // startIndex alone drifts from the true document offset after any flush.
    this._baseOffset = 0;

    this.autoFlush = options.autoFlush !== false;
    this.flushThreshold = options.flushThreshold ?? 1024;

    // Token-start checkpoint for mark/rewind (mirrors FeedableSource API).
    this._tokenStart = -1;

    // Reused across every scanTagExpEnd() call, never reallocated. See
    // string-source.js's copy of this field for the full doc (fixed-capacity
    // typed array + manual length, not push()).
    this._quotePairs = new Int32Array(QUOTE_PAIRS_CAPACITY);
    this._quotePairsLen = 0;

    // Resolve once, dispatch polymorphically from here on — no encoding
    // branching anywhere else in this class. See encoding-profile.js.
    const strategy = profile?.scanStrategy ?? createCharScanStrategy();
    Object.assign(this, strategy);
    this.encodingName = profile?.descriptor?.name ?? 'utf8';
  }

  // ─── Token-start checkpoint ───────────────────────────────────────────────

  /**
   * @description Save the current read position as the start of a new logical token. For `BufferSource` this primarily guards `flush()` from reclaiming data that
   * is still being read, mirroring the same safety invariant as `FeedableSource`.
   */
  markTokenStart() {
    this._tokenStart = this.startIndex;
  }

  /**
   * @description Restore `startIndex` to the last `markTokenStart()` position. `BufferSource` always has the full document available, so a mid-token end of input
   * cannot occur and this method is a safe no-op. It exists solely so caller code can call `rewindToMark()` unconditionally without branching on
   * source type.
   */
  rewindToMark() {
    // No-op: the complete document is in memory; no rewind is ever needed.
  }

  /**
   * @description Discard the already-processed prefix of the buffer to free memory. Slices the decoded string, leaving the original allocation for the GC once no
   * other references remain. If a token checkpoint is active, the flush origin is moved back to the checkpoint so the in-progress token is
   * preserved.
   */
  flush() {
    const origin = this._tokenStart >= 0 ? this._tokenStart : this.startIndex;
    if (origin > 0) {
      this.buffer = this.buffer.slice(origin);
      if (this._tokenStart >= 0) {
        this.startIndex -= origin;
        this._tokenStart = 0;
      } else {
        this.startIndex = 0;
      }
      this._baseOffset += origin;
    }
  }
}
