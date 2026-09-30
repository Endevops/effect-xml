import type { CharScanReadContext } from './input-source.ts';

import { UnexpectedEnd } from '../parse-error.js';
import { isSpace } from '../util.js';

/**
 * @description The character-level reads shared by every string-backed scan context — `StringSource`, `FeedableSource` and the `CharScanStrategy` assigned onto
 * `BufferSource`. All three hold their live document in a plain JS string behind the same `CharScanReadContext` fields, so a read over that buffer is
 * the same computation in all three and had been written out three times. It drifted: `StringSource` had grown a `readFromBuffer(n, updateIndex?:
 * number)` that no caller invoked and that did not match the `(n, shouldUpdate?: boolean)` signature the interface and `BufferSource` both use, which
 * is why `Xml2JsParser.parse()` had to cast `new StringSource(...) as InputSourceLike`. These are free functions taking `this` rather than methods,
 * and each source assigns them onto itself, so the call sites keep zero indirection and stay monomorphic — the same tradeoff already made for
 * `scan-tag-exp-end.ts`, and the reason the cursor-advancing methods live here too rather than only the scanning ones. `updateBufferBoundary` is
 * deliberately NOT here. `StringSource` and `FeedableSource` share one form of it, but `CharScanStrategy` gates on `_tokenStart < 0` because it
 * tracks a single mark where the sources track two, and each class documents why its own gate is the correct one. That difference is a real
 * behavioural distinction, not a copy-paste slip, so the method stays per-class.
 */

export function readCh(this: CharScanReadContext) {
  return this.buffer[this.startIndex++];
}

export function readChAt(this: CharScanReadContext, index: number) {
  return this.buffer[this.startIndex + index];
}

export function readStr(this: CharScanReadContext, n: number, from?: number) {
  if (typeof from === 'undefined') from = this.startIndex;
  return this.buffer.substring(from, from + n);
}

export function matchAhead(this: CharScanReadContext, expected: string, caseInsensitive: boolean = false): boolean | null {
  const len = expected.length;
  for (let i = 0; i < len; i++) {
    let ch = this.buffer[this.startIndex + i];
    if (ch === undefined) return null;
    if (caseInsensitive) ch = ch.toLowerCase();
    if (ch !== expected[i]) return false;
  }
  return true;
}

export function canRead(this: CharScanReadContext, n: number = 0) {
  return this.startIndex + n < this.buffer.length;
}

export function readUpto(this: CharScanReadContext, stopStr: string): string {
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

  throw new UnexpectedEnd({ reading: `'${stopStr}'`, message: `Unexpected end of source reading '${stopStr}'` });
}

export function readUptoChar(this: CharScanReadContext, stopChar: string): string {
  const i = this.buffer.indexOf(stopChar, this.startIndex);
  if (i === -1) {
    throw new UnexpectedEnd({ reading: `'${stopChar}'`, message: `Unexpected end of source reading '${stopChar}'` });
  }
  const result = this.buffer.substring(this.startIndex, i);
  this.startIndex = i + 1;
  return result;
}

/**
 * @description Whether `str` occurs in `buffer` starting exactly at `at`. Reading past the end yields `undefined`, which never equals `str[j]`, so a truncated
 * tail is a miss rather than a throw — the buffer may be mid-chunk on `FeedableSource`.
 */
function matchesAt(buffer: string, at: number, str: string): boolean {
  for (let j = 0; j < str.length; j++) {
    if (buffer[at + j] !== str[j]) return false;
  }
  return true;
}

/**
 * @description Index of the `>` that closes a tag whose name ended at `from`, skipping whitespace — a close tag may be written `</script >`. Returns `-1` when the
 * text at `from` is not a close-tag tail at all: a name character means the tag name matched only a prefix of the real one (the `</scriptX>` case),
 * and end-of-buffer means the close tag is not there yet.
 */
function closeTagEnd(buffer: string, from: number): number {
  for (let i = from; i < buffer.length; i++) {
    const c = buffer[i];
    if (c === '>') return i;
    if (!isSpace(c)) return -1;
  }
  return -1;
}

/**
 * @description Read up to but not including a closing tag (used for stop nodes). `stopStr` is the `"</tagname"` prefix. A match only counts once the following `>`
 * is found, so `</scriptX>` does not terminate a `<script>` stop node.
 */
export function readUptoCloseTag(this: CharScanReadContext, stopStr: string): string {
  const buffer = this.buffer;
  const first = stopStr[0];

  for (let i = this.startIndex; i < buffer.length; i++) {
    // Cheap reject before the full compare — the first character is '<' for
    // every close tag, so most positions in a stop node's body fail here.
    if (buffer[i] !== first) continue;
    if (!matchesAt(buffer, i, stopStr)) continue;

    const gt = closeTagEnd(buffer, i + stopStr.length);
    if (gt === -1) continue; // tag-name prefix only, e.g. </scriptX> — keep scanning

    const result = buffer.substring(this.startIndex, i);
    this.startIndex = gt + 1;
    return result;
  }

  throw new UnexpectedEnd({ reading: `'${stopStr}'`, message: `Unexpected end of source reading '${stopStr}'` });
}

export function readFromBuffer(this: CharScanReadContext, n: number, shouldUpdate?: boolean) {
  const ch = n === 1 ? this.buffer[this.startIndex] : this.buffer.substring(this.startIndex, this.startIndex + n);
  if (shouldUpdate) this.updateBufferBoundary(n);
  return ch;
}
