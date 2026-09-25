import type { BufferSourceOptions } from '#/input-source/buffer-source-options.ts';

import type { EncodingProfile } from '../encoding/encoding-profile.ts';
import type { InputSourceLike } from './input-source.ts';

import { createByteScanStrategy, decodeCharAtUtf8 } from '../encoding/scan-strategy/byte-scan-strategy.js';
import { QUOTE_PAIRS_CAPACITY } from '../util.js';

// Zero-config default when no profile is supplied (e.g. tests/callers that
// construct BufferSource directly rather than through XMLParser): UTF-8
// byte-scan. Identical output/cost to the pre-encoding-feature code for pure
// ASCII content (the common case) and correctly decodes multi-byte UTF-8,
// which the old raw fromCharCode() path did not.
const DEFAULT_SCAN_STRATEGY = createByteScanStrategy(decodeCharAtUtf8, 'utf8');

/**
 * @description BufferSource — input source backed by a Node.js Buffer (byte array).
 *
 * ### Memory reclamation
 *
 * The full document is available from the start, so there is no chunk-boundary risk and `rewindToMark()` is a safe no-op. However, the parsed prefix
 * of the Buffer is held in memory until the parse finishes. `flush()` reclaims it by slicing the Buffer and resetting `startIndex` to 0. The same
 * mark/flush protocol used by `FeedableSource` is implemented here so all reader functions work without source-type conditionals: `markTokenStart()`
 * — save current read position at the start of a token; `rewindToMark()` — no-op for `BufferSource` (full doc always present); `flush()` — drop the
 * already-parsed prefix to free memory. Auto-flush fires inside `updateBufferBoundary()` whenever the processed portion exceeds `flushThreshold` and
 * no token checkpoint is active.
 *
 * ### Index units
 *
 * `startIndex` is a BYTE offset, not a character offset, on the byte-scan path. Callers report positions through `util.absolutePosition()` and never
 * interpret the raw index themselves.
 *
 * @implements {InputSourceLike}
 */
export default class BufferSource implements InputSourceLike {
  /**
   * @description The live buffer, or — when the profile required decoding first — the decoded string. A prefix is trimmed by `flush()` as the document is
   * consumed.
   */
  buffer: Buffer | string;
  /**
   * @description Byte offset into {@link buffer} of the next character to read. Rebased downward by `flush()`.
   */
  startIndex: number;
  /**
   * @description Running total of bytes/chars trimmed off the front by `flush()` so far — the other half of `util.absolutePosition()`.
   */
  _baseOffset: number;
  /**
   * @description Whether already-processed bytes are discarded automatically past {@link flushThreshold}.
   */
  autoFlush: boolean;
  /**
   * @description Processed-byte count that triggers an automatic {@link flush}.
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
   * @description Whether `_quotePairs` offsets can be reused as indices into the decoded attribute string. `false` for byte-scan + utf8, where a byte offset can
   * land mid-character once decoded. Set from the profile; see `EncodingProfile.buildProfileForBuffer()`'s doc for the full reasoning.
   */
  _quotePairsUsable: boolean;
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
  declare readUpto: (stopStr: string) => string;
  declare readUptoChar: (stopChar: string) => string;
  declare readUptoCloseTag: (stopStr: string) => string;
  declare readFromBuffer: (n: number, shouldUpdate?: boolean) => string | undefined;
  declare updateBufferBoundary: (n?: number) => void;
  declare canRead: (n?: number) => boolean;

  /**
   * @param bytesArr - The full XML document as a Node.js Buffer.
   * @param options.autoFlush - Enable automatic flushing. Default is `true`
   * @param options.flushThreshold - Flush after this many processed bytes. Default is `1024`
   * @param profile - Resolved encoding profile from `encoding/encoding-profile.ts#buildProfileForBuffer`. Omit for the zero-config UTF-8 default
   *   (used directly by tests/callers that don't go through `XMLParser`).
   */
  constructor(bytesArr: Buffer, options: BufferSourceOptions = {}, profile: EncodingProfile | null = null) {
    // BOM bytes (if any) are detection artifacts, not content — strip them
    // and exclude from the index.
    this.buffer = profile?.bomLength ? bytesArr.subarray(profile.bomLength) : bytesArr;
    if (profile?.decodeFirst) {
      // Not self-synchronizing (UTF-16, or a custom encoding that didn't
      // assert selfSynchronizing) — byte-level delimiter scanning is unsafe,
      // so decode the whole buffer once up front and hand off to
      // CharScanStrategy, which then behaves exactly like StringSource.
      const decoder = profile.descriptor.createDecoder();
      this.buffer = decoder.write(this.buffer as Buffer) + decoder.end();
    }
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
    // string-source.js's copy of this field for the full doc. Populated by
    // whichever ScanStrategy (byte or char) is assigned below.
    this._quotePairs = new Int32Array(QUOTE_PAIRS_CAPACITY);
    this._quotePairsLen = 0;

    // Resolve once, dispatch polymorphically from here on — no encoding
    // branching anywhere else in this class. See encoding-profile.js.
    const strategy = profile?.scanStrategy ?? DEFAULT_SCAN_STRATEGY;
    Object.assign(this, strategy);
    this.encodingName = profile?.descriptor?.name ?? 'utf8';
    // See encoding-profile.js's buildProfileForBuffer() doc — false only for
    // ByteScanStrategy+utf8, where a raw byte offset can land mid-character
    // once decoded. DEFAULT_SCAN_STRATEGY (used when no profile is supplied)
    // is itself utf8 byte-scan, so the no-profile default must also be false.
    this._quotePairsUsable = profile ? profile.quotePairsUsable !== false : false;
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
   * @description Discard the already-processed prefix of the buffer to free memory. Uses `Buffer.subarray()` (zero-copy view) rather than `Buffer.slice()` for
   * clarity, then copies to a fresh Buffer so the original allocation can be GC'd. If a token checkpoint is active, the flush origin is moved back to
   * the checkpoint so the in-progress token is preserved.
   */
  flush() {
    const origin = this._tokenStart >= 0 ? this._tokenStart : this.startIndex;
    if (origin > 0) {
      // Buffer.from(subarray) copies the bytes so the original large Buffer
      // can be released by the GC once no other references remain.
      this.buffer = Buffer.from((this.buffer as Buffer).subarray(origin));
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
