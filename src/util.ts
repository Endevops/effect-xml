import type { InputSourceLike } from './InputSource/input-source.ts';

import { ParseError, ErrorCode } from './ParseError.ts';

/**
 * @description Every capture group of every match of `regex` in `string`, flattened into one array per match, with the match's start offset attached as
 * `startIndex`.
 *
 * @param string - Subject to search.
 * @param regex - Must be global; `lastIndex` is carried across iterations.
 *
 * @returns One array per match, holding the full match followed by each capture group.
 */
export function getAllMatches(string: string, regex: RegExp): (string[] & { startIndex: number })[] {
  const matches: (string[] & { startIndex: number })[] = [];
  let match = regex.exec(string);
  while (match) {
    // Built empty, then given its startIndex below — an array literal cannot be
    // cast directly to the intersection type it acquires a moment later.
    const allmatches = [] as unknown as string[] & { startIndex: number };
    allmatches.startIndex = regex.lastIndex - (match[0]?.length ?? 0);
    const len = match.length;
    for (let index = 0; index < len; index++) {
      allmatches.push(match[index] as string);
    }
    matches.push(allmatches);
    match = regex.exec(string);
  }
  return matches;
}

/**
 * @description Whether `char` is XML whitespace. Accepts `undefined` so callers that read past the end of input get `false` rather than a throw.
 */
export function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/**
 * @description Whether `code` is one of the five XML whitespace character codes: space, tab, LF, CR, FF.
 */
export function isSpaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12; // space \t \n \r \f
}

/**
 * @description Whether `v` is not `undefined`. Deliberately a check for an _absent_ value, not a nullish one — `null` counts as existing and passes straight
 * through {@link getValue}.
 */
export function isExist<T>(v: T | undefined): v is T {
  return typeof v !== 'undefined';
}

/**
 * @description Whether `obj` has no own enumerable keys.
 */
export function isEmptyObject(obj: object): boolean {
  return Object.keys(obj).length === 0;
}

/**
 * @description `v` when it exists, `''` otherwise. Collapses a missing value and an empty string to the same result; `null` passes through as `null`.
 */
export function getValue<T>(v: T | undefined): T | '' {
  if (isExist(v)) {
    return v;
  } else {
    return '';
  }
}

/**
 * @description `Object.prototype` members that a document could shadow. Shadowing these is a naming collision, not a prototype-pollution vector — renaming them is
 * cosmetic and skippable via `sanitizeNames: false`.
 */
export const DANGEROUS_PROPERTY_NAMES: string[] = [
  'hasOwnProperty',
  'toString',
  'valueOf',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'toLocaleString',
  'isPrototypeOf',
  'propertyIsEnumerable',
];

/**
 * @description Names whose use would actually pollute `Object.prototype` through the output object. Always rejected, whatever `sanitizeNames` says.
 */
export const criticalProperties: string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * @description Capacity (in numbers, i.e. `QUOTE_PAIRS_CAPACITY / 2` quoted-attribute-values) of the reusable typed array each InputSource uses to record quote
 * positions found by `scanTagExpEnd()`, reused by `AttributeProcessor.parseAttributes()`. A plain fixed cap, not a growable array — see
 * `scanTagExpEnd()`'s doc for why: comfortably covers real-world tags, and a tag with more quoted attributes than this just falls back to
 * per-character quote scanning for the overflow, so there's no correctness cost to keeping this small and allocation-free.
 */
export const QUOTE_PAIRS_CAPACITY: number = 128; // 64 quoted attribute values per tag

/**
 * @description True document-start-relative offset for a source's current read position. `source.startIndex` is only an offset into the source's _live buffer_ —
 * every `flush()` trims already-consumed characters off the front of that buffer and rebases `startIndex` back down, so `startIndex` alone drifts
 * from the true document offset the moment a flush has happened. Each source tracks how much it has trimmed away so far in `_baseOffset` (bumped by
 * the trimmed amount inside `flush()`); the real position is always the sum of the two. This is the one place that sum is computed — every caller
 * that needs an absolute, document-start-relative position (errors, tag `index` / `openEnd` / `closeEnd`, attribute offsets, stop-node end) must go
 * through this function rather than reading `startIndex` directly.
 */
export function absolutePosition(source: InputSourceLike): number {
  return source.startIndex + (source._baseOffset || 0);
}

/**
 * @description Uniform error-position accessor across all InputSource types. Position reporting is index-only (absolute offset from document start) — no
 * line/column.
 */
export function errorPositionOf(source: InputSourceLike): { index: number } {
  return { index: absolutePosition(source) };
}

/**
 * @description True for character codes that are illegal as literal characters anywhere in an XML document (element text, attribute values, CDATA, comments):
 * 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F. Tab/LF/CR (0x09/0x0A/0x0D) are legal whitespace and excluded. A numeric character reference like `&#0;` is just
 * ASCII text at this stage (entity expansion happens later, in the output builder), so it never reaches this check as a raw byte.
 */
function isIllegalControlCode(c: number): boolean {
  return c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31);
}

/**
 * @description Normalize a complete piece of document content (element text, CDATA content, or comment content) per XML §2.11: a real `\r\n` pair or a lone `\r`
 * becomes a single `\n`; a bare `\n` is left alone. Also rejects illegal literal control characters (see {@link isIllegalControlCode}) — this check
 * always runs, regardless of autoClose/lenient settings. Meant to be called exactly once per finished token (a whole text run, a whole CDATA block, a
 * whole comment) — never mid-scan — so no chunk-boundary carry logic is needed: by the time a reader has a complete string, any `\r\n` that happened
 * to straddle a `feed()` chunk boundary has already been concatenated back together by the caller.
 *
 * @param str - The finished token.
 * @param source - Source to report an error position from. Omit when unavailable.
 *
 * @returns The normalized text, or `str` itself when there is no `\r` to fold (the fast path allocates nothing).
 *
 * @throws {ParseError} `ILLEGAL_CHARACTER` on any illegal control code.
 */
export function sanitizeContent(str: string, source?: InputSourceLike): string {
  const len = str.length;
  let hasCR = false;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    if (isIllegalControlCode(c)) {
      throw new ParseError(
        `Illegal control character 0x${c.toString(16).padStart(2, '0')} in document content`,
        ErrorCode.ILLEGAL_CHARACTER,
        source ? errorPositionOf(source) : {}
      );
    }
    if (c === 13) hasCR = true;
  }
  if (!hasCR) return str; // fast path — nothing to fold, no reallocation

  let out = '';
  let segStart = 0;
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) === 13) {
      out += str.substring(segStart, i) + '\n';
      if (str.charCodeAt(i + 1) === 10) i++; // \r\n pair → one \n, not two
      segStart = i + 1;
    }
  }
  out += str.substring(segStart);
  return out;
}

/**
 * @description Assert that the upcoming characters in the source match the expected string. If not enough data → throws UNEXPECTED_END. If mismatch → throws
 * INVALID_TAG with the given errorMsg. On success, consumes the matched characters (advances startIndex).
 *
 * @param source - Input source.
 * @param expected - String to match.
 * @param errorMsg - Description of what is being read (used in error messages).
 * @param caseInsensitive - Lowercase both sides before comparing. `expected` must already be lowercase. Default is `false`
 *
 * @throws {ParseError} `UNEXPECTED_END` when the buffer is too short to decide, `INVALID_TAG` on a definite mismatch.
 */
export function expectMatch(source: InputSourceLike, expected: string, errorMsg: string, caseInsensitive: boolean = false): void {
  const len = expected.length;
  if (!source.canRead(len)) {
    throw new ParseError(`Unexpected end of source reading ${errorMsg}`, ErrorCode.UNEXPECTED_END, errorPositionOf(source));
  }
  const matched = source.matchAhead(expected, caseInsensitive);
  if (matched !== true) {
    throw new ParseError(`Invalid ${errorMsg}`, ErrorCode.INVALID_TAG, errorPositionOf(source));
  }
  source.updateBufferBoundary(len);
}

/**
 * @description Assert that the source has at least `n` characters available from the current position. Throws UNEXPECTED_END if not enough data. Does NOT consume
 * any characters.
 *
 * @param source - Input source.
 * @param n - Number of characters needed.
 * @param errorMsg - Description of what is being read (used in error message).
 *
 * @throws {ParseError} `UNEXPECTED_END` when fewer than `n` characters are buffered.
 */
export function ensureCanRead(source: InputSourceLike, n: number, errorMsg: string): void {
  if (!source.canRead(n)) {
    throw new ParseError(`Unexpected end of source reading ${errorMsg}`, ErrorCode.UNEXPECTED_END, errorPositionOf(source));
  }
}
