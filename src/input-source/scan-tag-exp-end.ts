import type { CharScanContext } from './input-source.ts';

/**
 * @description Shared scanTagExpEnd implementations for sources whose buffer is a JS string (StringSource, FeedableSource, CharScanStrategy). Two separate
 * functions instead of one with a flag — the flag was evaluated inside the loop on every character, which adds overhead to the hottest path in the
 * parser. The caller resolves which variant to use once, before the scan begins. Neither function is exported as a method — each source assigns both
 * onto itself so `this` binding works correctly with zero indirection.
 */

/**
 * @description Scan for the unquoted `>` that ends a tag expression, recording each quote boundary in `this._quotePairs` as it goes. Used when attributes will be
 * parsed (`skip.attributes` is false). Bracket access rather than `charCodeAt` is load-bearing here: these buffers can be V8 ConsStrings/ropes built
 * by repeated `+=`, and `charCodeAt` would force a full flatten on every access. The shared implementations use bracket access throughout.
 *
 * @returns Relative offset of the unquoted `>` from `startIndex`, or `-1` if the buffer was exhausted first (a chunk boundary for `FeedableSource`).
 */
export function scanTagExpEnd(this: CharScanContext) {
  const buf = this.buffer;
  const len = buf.length;
  const start = this.startIndex;
  const pairs = (this as { _quotePairs: Int32Array })._quotePairs;
  const capacity = pairs.length;
  let pairsLen = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < len; i++) {
    const c = buf[i];
    if (c === "'") {
      if (!inDouble) {
        inSingle = !inSingle;
        if (pairsLen < capacity) pairs[pairsLen++] = i - start;
      }
    } else if (c === '"') {
      if (!inSingle) {
        inDouble = !inDouble;
        if (pairsLen < capacity) pairs[pairsLen++] = i - start;
      }
    } else if (c === '>' && !inSingle && !inDouble) {
      (this as { _quotePairsLen: number })._quotePairsLen = pairsLen;
      return i - start;
    }
  }
  (this as { _quotePairsLen: number })._quotePairsLen = pairsLen;
  return -1;
}

/**
 * @description Scan for the unquoted `>` that ends a tag expression, without recording quote positions. Used when attributes are being skipped entirely
 * (`skip.attributes` is true) — nobody reads `_quotePairs`, so don't pay to populate it.
 *
 * @returns Relative offset of the unquoted `>` from `startIndex`, or `-1` if the buffer was exhausted first.
 */
export function scanTagExpEndFast(this: CharScanContext) {
  const buf = this.buffer;
  const len = buf.length;
  const start = this.startIndex;
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < len; i++) {
    const c = buf[i];
    if (c === "'") {
      if (!inDouble) inSingle = !inSingle;
    } else if (c === '"') {
      if (!inSingle) inDouble = !inDouble;
    } else if (c === '>' && !inSingle && !inDouble) {
      return i - start;
    }
  }
  return -1;
}
