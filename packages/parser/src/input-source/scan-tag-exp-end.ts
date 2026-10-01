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
  const pairs = this._quotePairs;
  let pairsLen = 0;
  // The delimiter of the quoted value being scanned, or null outside one. Two
  // booleans (`inSingle` / `inDouble`) said the same thing and needed two
  // near-identical record blocks; one character needs one.
  let quote: string | null = null;

  for (let i = start; i < len; i++) {
    const c = buf[i];
    // Flat guards, kept out of an `else if` chain so this loop — which runs
    // once per character of every tag expression — carries no nested branches.
    // A quote of the other kind inside a value is content, not a delimiter, so
    // it falls through to the next check, which is what the old inner `if` did
    // by doing nothing.
    if (c === "'" && quote !== '"') {
      quote = flipQuote(quote, "'");
      pairsLen = recordQuote(pairs, pairsLen, i - start);
      continue;
    }
    if (c === '"' && quote !== "'") {
      quote = flipQuote(quote, '"');
      pairsLen = recordQuote(pairs, pairsLen, i - start);
      continue;
    }
    if (c === '>' && quote === null) {
      this._quotePairsLen = pairsLen;
      return i - start;
    }
  }
  this._quotePairsLen = pairsLen;
  return -1;
}

/**
 * @description The quote state after reading one occurrence of `delimiter`. An occurrence matching what is already open closes it; any other occurrence while
 * nothing is open opens it. The caller has already excluded the case where this delimiter is inert.
 */
function flipQuote(open: string | null, delimiter: string): string | null {
  return open === delimiter ? null : delimiter;
}

/**
 * @description Append one quote boundary to the pair array, or drop it if the array is full. Overflow is dropped rather than grown, and the offset returned is
 * `pairsLen` unchanged, so a tag with more than `capacity` quoted values simply records the ones that fit and `parseAttributes()` falls back to
 * scanning the rest. Both scanners reuse one fixed-capacity array across every tag, so it cannot be per-document sized.
 */
function recordQuote(pairs: Int32Array, pairsLen: number, at: number): number {
  if (pairsLen >= pairs.length) return pairsLen;
  pairs[pairsLen] = at;
  return pairsLen + 1;
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
