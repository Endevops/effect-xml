import type { ByteScanContext, ScanStrategy } from '../../input-source/input-source.ts';

import { UnexpectedEnd } from '../../parse-error.js';
import { isSpaceCode } from '../../util.js';

/**
 * @description Result of decoding the single character that starts at byte offset `i`.
 */
export interface DecodedChar {
  /**
   * @description The decoded character.
   */
  char: string;
  /**
   * @description How many bytes it occupies. Byte offset `i` advances by this much after reading it.
   */
  width: number;
}

/**
 * @description Decodes the character at byte offset `i` of `buf`. The one piece that varies per encoding.
 */
export type DecodeCharAt = (buf: Buffer, i: number) => DecodedChar;

/**
 * @description ByteScanStrategy — for self-synchronizing encodings only (utf8/ascii/latin1 by default; any custom encoding that explicitly asserts
 * `selfSynchronizing: true`). All positions/indices here (`n`, `index`, loop counters passed in from XmlPartReader/DocTypeReader/StopNodeProcessor)
 * are BYTE offsets, matching `BufferSource`'s original convention throughout — unchanged by the encoding feature. Delimiters (`<`, `>`, `"`, `'`) are
 * matched at the byte level for speed, safe here precisely because self-synchronizing means an ASCII delimiter byte can never occur as a continuation
 * byte of a different character. `decodeCharAt(buf, i)` → `{ char, width }` is the one piece that varies per encoding (width in BYTES for the
 * character starting at byte offset `i`). ascii/latin1 are always width 1. utf8 needs the real multi-byte decode so `startIndex` advances by the
 * correct byte count per character — that part is still required for correct scanning, independent of any position reporting: the parser only ever
 * exposes the absolute byte/char `index`, not line/col, so no per-character column bookkeeping is needed here. Methods are plain (non-arrow) so they
 * can be assigned directly onto a `BufferSource` instance and keep correct `this` binding with zero extra indirection — resolved once at
 * construction, no per-call branching. @param decodeCharAt - Per-encoding single-character decoder. @param nodeEncoding - Buffer encoding name used
 * for bulk `toString()` reads. Must be a label `Buffer#toString()` accepts. @param isContinuationByte - Predicate classifying a byte as a UTF-8
 * continuation byte. Default is "never". @returns A {@link ScanStrategy} whose methods are assigned onto a `BufferSource` and run with that instance
 * as `this`. @param _isContinuationByte - Reserved for byte classification; no branch of this strategy reads it, since byte vs. character scanning is
 * already settled by the descriptor's `selfSynchronizing` flag.
 */
export function createByteScanStrategy(
  decodeCharAt: DecodeCharAt,
  nodeEncoding: BufferEncoding = 'utf8',
  _isContinuationByte_isContinuationByte_isContinuationByte_isContinuationByte_isContinuationByte_isContinuationByte: (
    byte: number
  ) => boolean = () => false
): ScanStrategy {
  return {
    readCh(this: ByteScanContext) {
      const { char, width } = decodeCharAt(this.buffer, this.startIndex);
      this.startIndex += width;
      return char;
    },

    /**
     * @description Index is a BYTE offset ahead of startIndex, same as original BufferSource.
     */
    readChAt(this: ByteScanContext, index: number) {
      return decodeCharAt(this.buffer, this.startIndex + index).char;
    },

    readStr(this: ByteScanContext, n: number, from?: number) {
      if (typeof from === 'undefined') from = this.startIndex;
      return this.buffer.slice(from, from + n).toString(nodeEncoding);
    },

    /**
     * @description See `StringSource` for the full doc — same contract. Compares raw byte codes directly rather than going through decodeCharAt/readChAt: safe
     * here because every literal this is ever called with (DOCTYPE keywords, tag names for closing-tag matching) is plain ASCII, and ASCII is always
     * exactly one byte per character in every encoding this strategy handles (UTF-8, Latin-1, ASCII — see the module doc above for why that guarantee
     * is what lets this whole strategy exist).
     */
    matchAhead(this: ByteScanContext, expected: string, caseInsensitive: boolean = false) {
      const len = expected.length;
      for (let i = 0; i < len; i++) {
        const b = this.buffer[this.startIndex + i];
        if (b === undefined) return null;
        let code = b;
        if (caseInsensitive && code >= 65 && code <= 90) code += 32; // 'A'-'Z' -> 'a'-'z'
        if (code !== expected.charCodeAt(i)) return false;
      }
      return true;
    },

    // Two variants — caller picks once based on skip.attributes, no flag
    // evaluated inside the loop. Compares raw byte codes (39=', 34=", 62=>)
    // rather than characters — safe here because self-synchronizing encodings
    // guarantee these byte values never appear as continuation bytes.
    scanTagExpEnd(this: ByteScanContext) {
      const buf = this.buffer;
      const len = buf.length;
      const start = this.startIndex;
      const pairs = this._quotePairs;
      const capacity = pairs.length;
      let pairsLen = 0;
      let inSingle = false;
      let inDouble = false;
      for (let i = start; i < len; i++) {
        const c = buf[i];
        if (c === 39) {
          if (!inDouble) {
            inSingle = !inSingle;
            if (pairsLen < capacity) pairs[pairsLen++] = i - start;
          }
        } else if (c === 34) {
          if (!inSingle) {
            inDouble = !inDouble;
            if (pairsLen < capacity) pairs[pairsLen++] = i - start;
          }
        } else if (c === 62 && !inSingle && !inDouble) {
          this._quotePairsLen = pairsLen;
          return i - start;
        }
      }
      this._quotePairsLen = pairsLen;
      return -1;
    },

    scanTagExpEndFast(this: ByteScanContext) {
      const buf = this.buffer;
      const len = buf.length;
      const start = this.startIndex;
      let inSingle = false;
      let inDouble = false;
      for (let i = start; i < len; i++) {
        const c = buf[i];
        if (c === 39) {
          if (!inDouble) inSingle = !inSingle;
        } else if (c === 34) {
          if (!inSingle) inDouble = !inDouble;
        } else if (c === 62 && !inSingle && !inDouble) {
          return i - start;
        }
      }
      return -1;
    },

    readUpto(this: ByteScanContext, stopStr: string) {
      const inputLength = this.buffer.length;
      const stopLength = stopStr.length;
      const stopBuffer = Buffer.from(stopStr);
      for (let i = this.startIndex; i < inputLength; i++) {
        let match = true;
        for (let j = 0; j < stopLength; j++) {
          if (this.buffer[i + j] !== stopBuffer[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          const result = this.buffer.slice(this.startIndex, i).toString(nodeEncoding);
          this.startIndex = i + stopLength;
          return result;
        }
      }
      throw new UnexpectedEnd({ reading: `'${stopStr}'`, message: `Unexpected end of source reading '${stopStr}'` });
    },

    readUptoChar(this: ByteScanContext, stopChar: string) {
      const stopCode = stopChar.charCodeAt(0);
      const buf = this.buffer;
      const len = buf.length;
      for (let i = this.startIndex; i < len; i++) {
        if (buf[i] === stopCode) {
          const result = buf.slice(this.startIndex, i).toString(nodeEncoding);
          this.startIndex = i + 1;
          return result;
        }
      }
      throw new UnexpectedEnd({ reading: `'${stopChar}'`, message: `Unexpected end of source reading '${stopChar}'` });
    },

    readUptoCloseTag(this: ByteScanContext, stopStr: string) {
      const inputLength = this.buffer.length;
      const stopLength = stopStr.length;
      const stopBuffer = Buffer.from(stopStr);
      const GT = 62;
      let tagMatchStart = -1;
      let state = 0; // 0=scanning, 1=tag-name matched (scanning for '>'), 2=full match
      for (let i = this.startIndex; i < inputLength; i++) {
        const b = this.buffer[i];
        if (state === 1) {
          if (isSpaceCode(b as number)) continue;
          if (b === GT) {
            state = 2;
          } else {
            state = 0;
            tagMatchStart = -1;
          }
        } else {
          let matched = true;
          for (let j = 0; j < stopLength; j++) {
            if (this.buffer[i + j] !== stopBuffer[j]) {
              matched = false;
              break;
            }
          }
          if (matched) {
            state = 1;
            tagMatchStart = i;
            i += stopLength - 1;
          }
        }
        if (state === 2) {
          const result = this.buffer.slice(this.startIndex, tagMatchStart).toString(nodeEncoding);
          this.startIndex = i + 1;
          return result;
        }
      }
      throw new UnexpectedEnd({ reading: `'${stopStr}'`, message: `Unexpected end of source reading '${stopStr}'` });
    },

    readFromBuffer(this: ByteScanContext, n: number, shouldUpdate?: boolean) {
      if (n === 1) {
        const { char, width } = decodeCharAt(this.buffer, this.startIndex);
        if (shouldUpdate) this.updateBufferBoundary(width);
        return char;
      }
      const ch = this.buffer.slice(this.startIndex, this.startIndex + n).toString(nodeEncoding);
      if (shouldUpdate) this.updateBufferBoundary(n);
      return ch;
    },

    updateBufferBoundary(this: ByteScanContext, n: number = 1) {
      this.startIndex += n;
      if (this.autoFlush && this.startIndex >= this.flushThreshold && this._tokenStart < 0) {
        this.flush();
      }
    },

    // Relative to current position, matching FeedableSource's formula.
    canRead(this: ByteScanContext, n: number = 0) {
      return this.startIndex + n < this.buffer.length;
    },
  };
}

// ─── decodeCharAt implementations ─────────────────────────────────────────────

/**
 * @description Decoder for any single-byte encoding (ascii, latin1, and any custom self-synchronizing fixed-width encoding). Always one byte per character.
 */
export function decodeCharAtFixedWidth1(buf: Buffer, i: number): DecodedChar {
  return { char: String.fromCharCode(buf[i] as number), width: 1 };
}

/**
 * @description Decoder for UTF-8. Reads the lead byte to size the sequence, then defers to `Buffer#toString('utf8')` for the actual character. An invalid or
 * truncated lead byte falls through with width 1; `toString()` then surfaces U+FFFD, consistent with Node's own UTF-8 handling rather than us
 * inventing a different fallback.
 */
export function decodeCharAtUtf8(buf: Buffer, i: number): DecodedChar {
  const b0 = buf[i] as number;
  let width = 1;
  if ((b0 & 0x80) === 0x00) width = 1;
  else if ((b0 & 0xe0) === 0xc0) width = 2;
  else if ((b0 & 0xf0) === 0xe0) width = 3;
  else if ((b0 & 0xf8) === 0xf0) width = 4;
  if (i + width > buf.length) width = buf.length - i;
  const char = buf.toString('utf8', i, i + width);
  return { char, width };
}

/**
 * @description Whether `b` is a UTF-8 continuation byte (10xxxxxx). Kept as an export for callers that classify byte kinds; no longer consumed by this strategy's
 * own position bookkeeping since only the absolute index is tracked now.
 */
export function isUtf8ContinuationByte(b: number): boolean {
  return (b & 0xc0) === 0x80;
}
