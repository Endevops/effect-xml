import type { BufferSourceOptions } from '#/input-source/buffer-source-options.ts';

import { QUOTE_PAIRS_CAPACITY } from '#/util.ts';

import type { InputSourceLike } from './input-source.ts';

import { canRead, matchAhead, readCh, readChAt, readStr, readTextRun, readUpto, readUptoChar, readUptoCloseTag } from './char-scan-reads.ts';
import { scanTagExpEnd, scanTagExpEndFast } from './scan-tag-exp-end.ts';

/**
 * @description StringSource — input source backed by an in-memory string.
 *
 * ### Memory reclamation
 *
 * Unlike `FeedableSource`, the full document is available from the start, so there is no chunk-boundary risk and `rewindToMark()` is a safe no-op.
 * However, the parsed prefix of the string is still held in memory until the parse finishes. `flush()` reclaims that prefix by slicing the buffer and
 * resetting `startIndex` to 0. The same mark/flush protocol used by `FeedableSource` is implemented here so all reader functions (`readTagExp`,
 * `readClosingTagName`, `readCdata`, etc.) work without any source-type conditionals: `markTokenStart()` — save the current read position at the
 * start of a token; `rewindToMark()` — a no-op, since the full document is always present; `flush()` — drop the already-parsed prefix to free memory.
 * Auto-flush fires inside `updateBufferBoundary()` whenever the processed portion exceeds `flushThreshold` and no token checkpoint is active.
 * Position reporting is index-only (absolute character offset from document start) — no line/column tracking. That bookkeeping used to run on every
 * character and every bulk-read span for a field most callers never read; dropping it is a straight speed win. A caller that wants line/column can
 * derive it from `index` plus the original document text.
 */
export default class StringSource implements InputSourceLike {
  /**
   * @description The live buffer. A prefix is trimmed off the front by `flush()` as the document is consumed.
   */
  buffer: string;
  /**
   * @description Offset into {@link buffer} of the next character to read. Rebased downward by `flush()`.
   */
  startIndex: number = 0;
  /**
   * @description Whether already-processed characters are discarded automatically past {@link flushThreshold}.
   */
  autoFlush: boolean;
  /**
   * @description Processed-character count that triggers an automatic {@link flush}.
   */
  flushThreshold: number;
  /**
   * @description Running total of characters trimmed off the front so far — the other half of `util.absolutePosition()`.
   */
  _baseOffset: number;
  /**
   * @description Two-level mark stack matching `FeedableSource`'s API. `[0]` is the outer mark (`parseXml` loop), `[1]` the inner mark (readers). `-1` means "not
   * set" for that level.
   */
  _marks: [number, number];
  /**
   * @description Reusable scratch array holding flat `[openIdx, closeIdx, …]` quote positions found by the most recent `scanTagExpEnd()`. Fixed-size typed array
   * plus a manually-tracked length, NOT `Array.push()` — `push()` was measured to cost more than the per-character quote re-scan it was meant to
   * replace (bounds/growth checks on every call add up across thousands of tags). Plain indexed writes with a local counter avoid that entirely.
   */
  _quotePairs: Int32Array<ArrayBuffer>;
  /**
   * @description How many {@link _quotePairs} slots hold valid data — not `_quotePairs.length`, which is always the full capacity.
   */
  _quotePairsLen: number;

  /**
   * @param str - The full XML document string.
   * @param options.autoFlush - Enable automatic flushing. Default is `true`
   * @param options.flushThreshold - Flush after this many processed chars. Default is `1024`
   */
  constructor(str: string, options: BufferSourceOptions = {}) {
    this.buffer = str;
    // Boundary pointer: data before this index has been consumed and may be freed.
    this.startIndex = 0;
    // Running total of characters trimmed off the front by flush() so far.
    // startIndex alone is only an offset into the live (post-trim) buffer;
    // the true document-start-relative position is startIndex + _baseOffset.
    // See util.js#absolutePosition — the single place that sum is computed.
    this._baseOffset = 0;

    this.autoFlush = options.autoFlush !== false;
    this.flushThreshold = options.flushThreshold ?? 1024;

    // Two-level mark stack matching FeedableSource's API.
    this._marks = [-1, -1];

    // Reused across every scanTagExpEnd() call, never reallocated. Holds
    // flat [openIdx, closeIdx, ...] pairs of quoted-attribute-value
    // positions found while scanning for the tag's closing '>'. Fixed-size
    // typed array + a manually-tracked length (`_quotePairsLen`), NOT
    // Array.push() — push() was measured to cost more than the per-character
    // quote re-scan it was meant to replace (bounds/growth checks on every
    // call add up across thousands of tags). Plain indexed writes with a
    // local counter avoid that entirely. See scanTagExpEnd() doc for the
    // capacity rationale and overflow behaviour.
    this._quotePairs = new Int32Array(QUOTE_PAIRS_CAPACITY);
    this._quotePairsLen = 0;
  }

  // ─── Token-start checkpoint ───────────────────────────────────────────────

  /**
   * @description Save the current read position into the two-level mark stack. Mirrors `FeedableSource`'s two-level API so all reader functions work identically
   * regardless of source type: level 0 (default) is the outer mark set by `parseXml()`'s main loop; level 1 is the inner mark set by individual
   * reader functions. For `StringSource` the distinction only matters for `flush()` boundary calculations — `rewindToMark()` is always a no-op here.
   */
  markTokenStart(level: 0 | 1 = 0) {
    this._marks[level] = this.startIndex;
  }

  /**
   * @description Restore `startIndex` to the last `markTokenStart()` position. `StringSource` always has the full document available, so a mid-token end of input
   * cannot occur and this method is a safe no-op. It exists solely so caller code (`XMLParser.feed` / `parseXml`) can call `rewindToMark()`
   * unconditionally without branching on source type.
   */
  rewindToMark() {
    // No-op: the complete document is in memory; no rewind is ever needed.
  }

  /**
   * @description Clear both mark slots (mirrors `FeedableSource.clearMark`).
   */
  clearMark() {
    this._marks[0] = -1;
    this._marks[1] = -1;
  }

  /**
   * @description Discard the already-processed prefix of the buffer. The flush origin is the minimum of all active mark positions so that any in-progress token
   * (at either mark level) is preserved in the buffer. If no marks are active, the origin is `startIndex` itself.
   */
  flush() {
    let origin = this.startIndex;
    for (const m of this._marks) {
      if (m >= 0 && m < origin) origin = m;
    }
    if (origin > 0) {
      this.buffer = this.buffer.substring(origin);
      const marksLen = this._marks.length;
      for (let i = 0; i < marksLen; i++) {
        if (this._marks[i as 0 | 1] >= 0) this._marks[i as 0 | 1] -= origin;
      }
      this.startIndex -= origin;
      this._baseOffset += origin;
    }
  }

  // ─── Core read interface ──────────────────────────────────────────────────

  // Shared with FeedableSource and CharScanStrategy, which are the same three
  // sources reading the same kind of buffer. See char-scan-reads.ts. Assigned
  // rather than wrapped so `this` binds correctly with no call-site indirection.

  readCh = readCh;
  readChAt = readChAt;
  readStr = readStr;
  readTextRun = readTextRun;

  /**
   * @description Check whether the upcoming characters equal `expected`, without consuming or allocating anything — no substring is built even for a full match.
   * Contrast with the `readStr(n).toUpperCase() === "X"` style, which allocates two throwaway strings on every call, matching or not. Caller decides
   * what to do with a match — this never consumes. Follow a `true` result with `updateBufferBoundary(expected.length)` (or more, if something like
   * trailing whitespace should also be consumed).
   *
   * @param expected - Literal to match against, already in the case `caseInsensitive` compares against (e.g. pass `"system"`, not `"SYSTEM"`,
   *   together with `caseInsensitive: true`)
   * @param caseInsensitive - Lowercase both sides before comparing. Default is `false`
   *
   * @returns `true` on full match, `false` on a definite mismatch, `null` if the buffer runs out before enough characters are available to decide
   *   either way (treat like any other not-enough-data-yet case — same handling as `scanTagExpEnd`'s `-1`)
   */
  matchAhead = matchAhead;

  // Two variants — caller picks once based on skip.attributes, no flag
  // evaluated inside the loop. See src/input-source/scan-tag-exp-end.js.
  scanTagExpEnd = scanTagExpEnd;
  scanTagExpEndFast = scanTagExpEndFast;

  readUpto = readUpto;
  readUptoChar = readUptoChar;
  readUptoCloseTag = readUptoCloseTag;

  /**
   * @description Advance the read cursor by n characters. Triggers an automatic flush of already-processed data when autoFlush is enabled, the processed portion
   * has grown past flushThreshold, and no token checkpoint is currently active (a flush while a checkpoint is live would invalidate the saved
   * position).
   */
  updateBufferBoundary(n: number = 1) {
    this.startIndex += n;
    // See FeedableSource.updateBufferBoundary() for why there is no "any mark
    // active" gate here — flush()'s own min-origin computation already
    // protects any in-progress token; a separate gate was redundant and, since
    // marks are effectively always set in normal operation, made flush()
    // permanently unreachable. See specs/flushArchitecture_spec.js.
    if (this.autoFlush && this.startIndex >= this.flushThreshold) {
      this.flush();
    }
  }

  /**
   * @description Returns true when there is at least one character available at or after the given offset (relative to startIndex). Mirrors FeedableSource's
   * formula so all three sources answer the same question the same way.
   */
  canRead = canRead;
}
