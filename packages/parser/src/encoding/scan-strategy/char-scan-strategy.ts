import type { CharScanContext, ScanStrategy } from '../../input-source/input-source.ts';

import { scanTagExpEnd, scanTagExpEndFast } from '../../input-source/scan-tag-exp-end.js';
import { ErrorCode, parseError } from '../../parse-error.js';
import { isSpace } from '../../util.js';

/**
 * @description CharScanStrategy — for encodings that are NOT self-synchronizing (UTF-16 LE/BE by default, or any custom multi-byte encoding that doesn't assert
 * `selfSynchronizing: true`). Byte-level delimiter scanning is unsafe for these (an ASCII delimiter byte value can legitimately occur as part of a
 * different character), so the only correct option is to decode fully up front and scan on the resulting JS string — exactly what `StringSource`
 * already does. This is that same algorithm, extracted so `BufferSource` can reuse it verbatim instead of re-deriving a second copy. Cost model: one
 * eager decode of the whole buffer at construction (not per-token, not per-chunk). Only paid by documents that actually use one of these encodings;
 * the default UTF-8/ASCII/Latin-1 path never touches this file.
 *
 * @returns A {@link ScanStrategy} whose methods are assigned onto a `BufferSource` and run with that instance as `this`.
 *
 *   ```*
 *   @returns A {@link ScanStrategy} whose methods are assigned onto a `BufferSource` and run with that instance as `this`.
 *   ```
 */
export function createCharScanStrategy(): ScanStrategy {
  return {
    readCh(this: CharScanContext) {
      return this.buffer[this.startIndex++];
    },

    readChAt(this: CharScanContext, index: number) {
      return this.buffer[this.startIndex + index];
    },

    readStr(this: CharScanContext, n: number, from?: number) {
      if (typeof from === 'undefined') from = this.startIndex;
      return this.buffer.substring(from, from + n);
    },

    /**
     * @description See `StringSource``` for the full doc — identical contract, same plain-string buffer shape.
     */
    matchAhead(this: CharScanContext, expected: string, caseInsensitive: boolean = false) {
      const len = expected.length;
      for (let i = 0; i < len; i++) {
        let ch = this.buffer[this.startIndex + i];
        if (ch === undefined) return null;
        if (caseInsensitive) ch = ch.toLowerCase();
        if (ch !== expected[i]) return false;
      }
      return true;
    },

    // Two variants — caller picks once based on skip.attributes, no flag
    // evaluated inside the loop. Always character-indexed (scans an already-
    // decoded string), so quote offsets are always safe for AttributeProcessor
    // to reuse. See src/input-source/scan-tag-exp-end.js.
    scanTagExpEnd,
    scanTagExpEndFast,

    readUpto(this: CharScanContext, stopStr: string) {
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
      throw parseError({ _tag: ErrorCode.UNEXPECTED_END, reading: `'${stopStr}'` }, `Unexpected end of source reading '${stopStr}'`);
    },

    readUptoChar(this: CharScanContext, stopChar: string) {
      const i = this.buffer.indexOf(stopChar, this.startIndex);
      if (i === -1) {
        throw parseError({ _tag: ErrorCode.UNEXPECTED_END, reading: `'${stopChar}'` }, `Unexpected end of source reading '${stopChar}'`);
      }
      const result = this.buffer.substring(this.startIndex, i);
      this.startIndex = i + 1;
      return result;
    },

    readUptoCloseTag(this: CharScanContext, stopStr: string) {
      const inputLength = this.buffer.length;
      const stopLength = stopStr.length;
      let tagMatchStart = -1;
      let state = 0; // 0=scanning, 1=tag-name matched (scanning for '>'), 2=full match

      // 0=scanning, 1=tag-name matched (scanning for '>'), 2=full match

      // 0=scanning, 1=tag-name matched (scanning for '>'), 2=full match

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

      throw parseError({ _tag: ErrorCode.UNEXPECTED_END, reading: `'${stopStr}'` }, `Unexpected end of source reading '${stopStr}'`);
    },

    readFromBuffer(this: CharScanContext, n: number, shouldUpdate?: boolean) {
      const ch = n === 1 ? this.buffer[this.startIndex] : this.buffer.substring(this.startIndex, this.startIndex + n);
      if (shouldUpdate) this.updateBufferBoundary(n);
      return ch;
    },

    updateBufferBoundary(this: CharScanContext, n: number = 1) {
      this.startIndex += n;
      if (this.autoFlush && this.startIndex >= this.flushThreshold && this._tokenStart < 0) {
        this.flush();
      }
    },

    // Relative to current position, matching FeedableSource's formula.
    canRead(this: CharScanContext, n: number = 0) {
      return this.startIndex + n < this.buffer.length;
    },
  };
}
