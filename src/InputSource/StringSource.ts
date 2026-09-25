import type { BufferSourceOptions } from '#/InputSource/buffer-source-options.ts';

import { ParseError, ErrorCode } from '../ParseError.js';
import { isSpace, QUOTE_PAIRS_CAPACITY } from '../util.js';
import { scanTagExpEnd, scanTagExpEndFast } from './scanTagExpEnd.js';

/**
 * @description StringSource — input source backed by an in-memory string.
 *
 * ### Memory reclamation
 *
 * Unlike FeedableSource, the full document is available from the start, so there is no chunk-boundary risk and rewindToMark() is a safe no-op.
 * However, the parsed prefix of the string is still held in memory until the parse finishes. flush() reclaims that prefix by slicing the buffer and
 * resetting startIndex to 0. The same mark/flush protocol used by FeedableSource is implemented here so all reader functions (readTagExp,
 * readClosingTagName, readCdata, etc.) work without any source-type conditionals: MarkTokenStart() — save the current read position at the start of a
 * token rewindToMark() — no-op for StringSource (full doc always present) flush() — drop the already-parsed prefix to free memory. Auto-flush fires
 * inside updateBufferBoundary() whenever the processed portion exceeds flushThreshold and no token checkpoint is active. Position reporting is
 * index-only (absolute character offset from document start) — no line/column tracking. That bookkeeping used to run on every character and every
 * bulk-read span for a field most callers never read; dropping it is a straight speed win. A caller that wants line/column can derive it from `index`
 * plus the original document text.
 */
export default class StringSource {
  buffer: string;
  startIndex: number = 0;
  autoFlush: boolean;
  flushThreshold: number;
  _baseOffset: number;
  _marks: [number, number];
  _quotePairs: Int32Array<ArrayBuffer>;
  _quotePairsLen: number;

  /**
   * @param {string} str — the full XML document string.
   * @param {object} [options]
   * @param {boolean} [options.autoFlush=true] — enable automatic flushing. Default is `true`
   * @param {number} [options.flushThreshold=1024] — flush after this many processed chars. Default is `1024`
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
    // _marks[0] = outer mark (parseXml loop), _marks[1] = inner mark (readers).
    // -1 means "not set" for that level.
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
   * @description Save the current read position into the two-level mark stack. Mirrors FeedableSource's two-level API so all reader functions work identically
   * regardless of source type: Level 0 (default) — outer mark, set by parseXml()'s main loop. level 1 — inner mark, set by individual reader
   * functions. For StringSource the distinction only matters for flush() boundary calculations — rewindToMark() is always a no-op here.
   *
   * @param {0 | 1} [level=0] Default is `0`
   */
  markTokenStart(level: 0 | 1 = 0) {
    this._marks[level] = this.startIndex;
  }

  /**
   * @description Restore startIndex to the last markTokenStart() position. StringSource always has the full document available, so a mid-token end of input cannot
   * occur and this method is a safe no-op. It exists solely so caller code (XMLParser.feed / parseXml) can call rewindToMark() unconditionally
   * without branching on source type.
   */
  rewindToMark() {
    // No-op: the complete document is in memory; no rewind is ever needed.
  }

  /**
   * @description Clear both mark slots (mirrors FeedableSource.clearMark).
   */
  clearMark() {
    this._marks[0] = -1;
    this._marks[1] = -1;
  }

  /**
   * @description Discard the already-processed prefix of the buffer to free memory. The flush origin is the minimum of all active mark positions so that any
   * in-progress token (at either mark level) is preserved in the buffer. If no marks are active, the origin is startIndex itself.
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

  readCh() {
    return this.buffer[this.startIndex++];
  }

  readChAt(index: number) {
    return this.buffer[this.startIndex + index];
  }

  readStr(n: number, from?: number) {
    if (typeof from === 'undefined') from = this.startIndex;
    return this.buffer.substring(from, from + n);
  }

  /**
   * @description Check whether the upcoming characters equal `expected`, without consuming or allocating anything — no substring is built even for a full match.
   * Contrast with the `readStr(n).toUpperCase() === "X"` style, which allocates two throwaway strings on every call, matching or not. Caller decides
   * what to do with a match — this never consumes. Follow a `true` result with `updateBufferBoundary(expected.length)` (or more, if something like
   * trailing whitespace should also be consumed).
   *
   * @param {string} expected - Literal to match against, already in the case matchAhead should compare against when caseInsensitive is true (e.g.
   *   pass "system", not "SYSTEM", together with caseInsensitive=true)
   * @param {boolean} [caseInsensitive=false] Default is `false`
   *
   * @returns {boolean | null} True on full match, false on a definite mismatch, null if the buffer runs out before enough characters are available to
   *   decide either way (treat like any other not-enough-data-yet case — same handling as scanTagExpEnd's -1)
   */
  matchAhead(expected: string, caseInsensitive: boolean = false): boolean | null {
    const len = expected.length;
    for (let i = 0; i < len; i++) {
      let ch = this.buffer[this.startIndex + i];
      if (ch === undefined) return null;
      if (caseInsensitive) ch = ch.toLowerCase();
      if (ch !== expected[i]) return false;
    }
    return true;
  }

  // Two variants — caller picks once based on skip.attributes, no flag
  // evaluated inside the loop. See src/InputSource/scanTagExpEnd.js.
  scanTagExpEnd = scanTagExpEnd;
  scanTagExpEndFast = scanTagExpEndFast;

  readUpto(stopStr: string) {
    const inputLength = this.buffer.length;
    const stopLength = stopStr.length;

    for (let i = this.startIndex; i < inputLength; i++) {
      let match = true;
      for (let j = 0; j < stopLength; j++) {
        if (this.buffer[i + j] !== stopStr[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const result = this.buffer.substring(this.startIndex, i);
        this.startIndex = i + stopLength;
        return result;
      }
    }

    throw new ParseError(`Unexpected end of source reading '${stopStr}'`, ErrorCode.UNEXPECTED_END);
  }

  /**
   * @description Single-character variant of readUpto — faster because there is no inner match loop. Reads until `stopChar` is found, consumes it, and returns the
   * text before it.
   *
   * @param {string} stopChar Exactly one character.
   *
   * @returns {string}
   */
  readUptoChar(stopChar: string): string {
    const i = this.buffer.indexOf(stopChar, this.startIndex);
    if (i === -1) {
      throw new ParseError(`Unexpected end of source reading '${stopChar}'`, ErrorCode.UNEXPECTED_END);
    }
    const result = this.buffer.substring(this.startIndex, i);
    this.startIndex = i + 1;
    return result;
  }

  readUptoCloseTag(stopStr: string): string {
    // stopStr: "</tagname"
    const inputLength = this.buffer.length;
    const stopLength = stopStr.length;
    let tagMatchStart = -1;
    // 0: scanning, 1: tag-name matched (scanning for '>'), 2: full match
    let state = 0;

    for (let i = this.startIndex; i < inputLength; i++) {
      if (state === 1) {
        const c = this.buffer[i];
        if (isSpace(c)) continue;
        if (c === '>') {
          state = 2;
        } else {
          state = 0;
          tagMatchStart = -1;
        } // false match e.g. </scriptX>
      } else {
        // Try to match stopStr at position i
        let matched = true;
        for (let j = 0; j < stopLength; j++) {
          if (this.buffer[i + j] !== stopStr[j]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          state = 1;
          tagMatchStart = i;
          i += stopLength - 1; // skip past matched string
        }
      }
      if (state === 2) {
        const result = this.buffer.substring(this.startIndex, tagMatchStart);
        this.startIndex = i + 1;
        return result;
      }
    }

    throw new ParseError(`Unexpected end of source reading '${stopStr}'`, ErrorCode.UNEXPECTED_END);
  }

  readFromBuffer(n: number, updateIndex?: number) {
    const ch = n === 1 ? this.buffer[this.startIndex] : this.buffer.substring(this.startIndex, this.startIndex + n);
    if (updateIndex) this.updateBufferBoundary(n);
    return ch;
  }

  /**
   * @description Advance the read cursor by n characters. Triggers an automatic flush of already-processed data when autoFlush is enabled, the processed portion
   * has grown past flushThreshold, and no token checkpoint is currently active (a flush while a checkpoint is live would invalidate the saved
   * position).
   *
   * @param {number} [n=1] Default is `1`
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
   *
   * @param {number} [n=0] Default is `0`
   */
  canRead(n: number = 0) {
    return this.startIndex + n < this.buffer.length;
  }
}
