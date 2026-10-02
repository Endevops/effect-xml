import type { CharScanContext, ScanStrategy } from '#/input-source/input-source.ts';

import {
  canRead,
  matchAhead,
  readCh,
  readChAt,
  readFromBuffer,
  readStr,
  readTextRun,
  readUpto,
  readUptoChar,
  readUptoCloseTag,
} from '#/input-source/char-scan-reads.ts';
import { scanTagExpEnd, scanTagExpEndFast } from '#/input-source/scan-tag-exp-end.ts';

/**
 * @description CharScanStrategy — for encodings that are NOT self-synchronizing (UTF-16 LE/BE by default, or any custom multi-byte encoding that doesn't assert
 * `selfSynchronizing: true`). Byte-level delimiter scanning is unsafe for these (an ASCII delimiter byte value can legitimately occur as part of a
 * different character), so the only correct option is to decode fully up front and scan on the resulting JS string — exactly what `StringSource`
 * already does. This is that same algorithm, extracted so `BufferSource` can reuse it verbatim instead of re-deriving a second copy. Cost model: one
 * eager decode of the whole buffer at construction (not per-token, not per-chunk). Only paid by documents that actually use one of these encodings;
 * the default UTF-8/ASCII/Latin-1 path never touches this file. The character-level reads are shared with `StringSource` and `FeedableSource` — see
 * `char-scan-reads.ts`. Only `updateBufferBoundary` is defined here, because it is the one cursor movement whose gate genuinely differs: this
 * strategy tracks a single mark (`_tokenStart`) where the two sources track two (`_marks[0]` / `_marks[1]`), so its flush gate is `_tokenStart < 0`
 * rather than the sources' ungated form.
 *
 * @returns A {@link ScanStrategy} whose methods are assigned onto a `BufferSource` and run with that instance as `this`.
 */
export function createCharScanStrategy(): ScanStrategy {
  return {
    readCh,
    readChAt,
    readStr,
    readTextRun,

    /**
     * @description See `StringSource`'s copy of this method for the full doc — identical contract, same plain-string buffer shape.
     */
    matchAhead,

    // Two variants — caller picks once based on skip.attributes, no flag
    // evaluated inside the loop. Always character-indexed (scans an already-
    // decoded string), so quote offsets are always safe for AttributeProcessor
    // to reuse. See src/input-source/scan-tag-exp-end.js.
    scanTagExpEnd,
    scanTagExpEndFast,

    readUpto,
    readUptoChar,
    readUptoCloseTag,
    readFromBuffer,

    updateBufferBoundary(this: CharScanContext, n: number = 1) {
      this.startIndex += n;
      if (this.autoFlush && this.startIndex >= this.flushThreshold && this._tokenStart < 0) {
        this.flush();
      }
    },

    // Relative to current position, matching FeedableSource's formula.
    canRead,
  };
}
