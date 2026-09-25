/**
 * @description Numeric-string conversion, ported in-tree from `strnum`. Which strings count as numbers is a real decision rather than a formality. `"1e3"`,
 * `"0x1f"`, `"007"`, `"+5"`, `".5"` and `"5."` all look numeric and a naive parse disagrees with the user about which. So do the options: a document
 * that says `version="007"` may well want the number 7, and one that says `id="007"` may well want the string.
 *
 * @see {@link toNumber} for the entry point.
 */

/**
 * @description Everything `toNumber` can be told. A field left `undefined` takes its default. Defaults are the ones a numeric field in a document normally wants:
 * hex and exponents accepted, leading zeros treated as insignificant, binary and octal refused.
 */
export interface ToNumberOptions {
  /**
   * @description Accept `0x`-prefixed hexadecimal, with an optional sign. On by default.
   */
  hex?: boolean;
  /**
   * @description Accept `0b`-prefixed binary. Off by default — a leading zero on a document field is far more likely to be a padded ID than a binary literal.
   */
  binary?: boolean;
  /**
   * @description Accept `0o`-prefixed octal. Off by default, for the same reason as {@link ToNumberOptions.binary}.
   */
  octal?: boolean;
  /**
   * @description Treat a leading zero as insignificant, so `"007"` is 7. Off means `"007"` stays the string. On by default. A zero directly before a decimal point
   * is not a leading zero: `"0.5"` converts either way.
   */
  leadingZeros?: boolean;
  /**
   * @description Accept exponent notation. On by default.
   */
  eNotation?: boolean;
  /**
   * @description Normalize Unicode digits and minus variants to ASCII before matching. Off by default. On means `"٣"` is 3 and `"−5"` is -5. See {@link toNumber}
   * for the coverage, which is wider than the dependency's was.
   */
  unicode?: boolean;
  /**
   * @description Return the input unchanged, however numeric it looks, when this pattern matches it. Useful for a path where coercing a value would be wrong — a
   * version string, say.
   */
  skipLike?: RegExp;
  /**
   * @description What to do with a value that is not a finite number. `"original"` returns the input as written, `"null"` returns `null`, `"string"` returns
   * `"Infinity"` or `"-Infinity"`, `"infinity"` returns `NaN`. Defaults to `"original"`. Read the name carefully: this is reached by **any** value
   * that is not a finite number, not only by one that overflows. `'1e1000'` overflows, and so does `'abc'`, because `Number('abc')` is `NaN` and
   * `NaN` is not finite. So `toNumber('abc', { infinity: 'null' })` returns `null` rather than `'abc'`. That is the dependency's behaviour, verified
   * identical, and it is kept because an XML value parser hands this function text from a document, where a non-numeric string is the common case
   * rather than the exception. If you want non-numeric text left alone, leave this at its default. Reach for it only when an overflowing value
   * genuinely needs a different representation.
   */
  infinity?: 'original' | 'null' | 'string' | 'infinity';
}

const HEX_PATTERN = /^[-+]?0x[a-fA-F0-9]+$/;
const BINARY_PATTERN = /^0b[01]+$/;
const OCTAL_PATTERN = /^0o[0-7]+$/;
const NUMBER_PATTERN = /^([-+])?(0*)([0-9]*(\.[0-9]*)?)$/;
const EXPONENT_PATTERN = /^([-+])?(0*)(\d*(\.\d*)?[eE][-+]?\d+)$/;

/**
 * @description Every option with its default filled in.
 */
interface ResolvedOptions {
  /**
   * @description See {@link ToNumberOptions.hex}.
   */
  hex: boolean;
  /**
   * @description See {@link ToNumberOptions.binary}.
   */
  binary: boolean;
  /**
   * @description See {@link ToNumberOptions.octal}.
   */
  octal: boolean;
  /**
   * @description See {@link ToNumberOptions.leadingZeros}.
   */
  leadingZeros: boolean;
  /**
   * @description See {@link ToNumberOptions.eNotation}.
   */
  eNotation: boolean;
  /**
   * @description See {@link ToNumberOptions.unicode}.
   */
  unicode: boolean;
  /**
   * @description See {@link ToNumberOptions.skipLike}. No default: there is no pattern to match against unless a caller supplies one.
   */
  skipLike: RegExp | undefined;
  /**
   * @description See {@link ToNumberOptions.infinity}.
   */
  infinity: NonNullable<ToNumberOptions['infinity']>;
}

/**
 * @description The options every call falls back to.
 */
const DEFAULTS: ResolvedOptions = {
  hex: true,
  binary: false,
  octal: false,
  leadingZeros: true,
  eNotation: true,
  infinity: 'original',
  unicode: false,
  skipLike: undefined,
};

/**
 * @description Unicode minus and hyphen variants normalized to ASCII `-` when {@link ToNumberOptions.unicode} is on. U+2212 MINUS SIGN, U+FF0D FULLWIDTH
 * HYPHEN-MINUS and U+FE63 SMALL HYPHEN-MINUS are what a human or a locale formatter plausibly writes as a minus. The en dash, em dash and typographic
 * hyphen are deliberately excluded: those are punctuation, and rewriting them would mangle a string that was never a number.
 */
const UNICODE_MINUS_PATTERN = /[−－﹣]/gu;

/**
 * @description Every Unicode decimal digit, mapped to its ASCII equivalent. Built on first use from `\p{Nd}` rather than kept as a literal table, because a table
 * goes stale: Unicode adds digit blocks, and a hand-maintained one silently stops converting them. Deriving from the regex follows whatever Unicode
 * version the engine ships.
 */
let digitMap: Map<string, string> | null = null;

/**
 * @description Build the digit map, once, on first use. A Unicode decimal-digit block is always ten consecutive code points with values 0 through 9, so each
 * digit's value is its offset from the start of its block. Walking back from a digit to the first non-digit finds that start.
 *
 * @returns The map.
 */
function buildDigitMap(): Map<string, string> {
  const isDigit = /\p{Nd}/u;
  const map = new Map<string, string>();
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are not characters
    const char = String.fromCodePoint(cp);
    if (!isDigit.test(char)) continue;
    let blockStart = cp;
    while (blockStart > 0 && isDigit.test(String.fromCodePoint(blockStart - 1))) blockStart--;
    map.set(char, String(cp - blockStart));
  }
  return map;
}

/**
 * @description Normalize Unicode digits and minus variants to ASCII, leaving every other character alone.
 *
 * @param value - The value to normalize.
 *
 * @returns The normalized value.
 */
function normalizeUnicode(value: string): string {
  const map = (digitMap ??= buildDigitMap());
  let out = '';
  for (const char of value) {
    out += map.get(char) ?? char;
  }
  return out.replace(UNICODE_MINUS_PATTERN, '-');
}

/**
 * @description Strip a decimal's trailing zeros, and tidy the point itself. Walks backwards rather than using `/0+$/`, which backtracks badly on a string that
 * ends in something other than zero but has a long internal run of them.
 *
 * @param value - The digits, with leading zeros already removed.
 *
 * @returns The tidied digits.
 */
function trimTrailingZeros(value: string): string {
  if (!value || value.indexOf('.') === -1) return value;
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 48 /* '0' */) end--;
  let out = value.slice(0, end);
  if (out === '.') out = '0';
  else if (out[0] === '.') out = `0${out}`;
  else if (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

/**
 * @description Parse a digit string in a given base, dropping the `0x` / `0b` / `0o` prefix for the bases that have one.
 *
 * @param value - The digits, with prefix and sign.
 * @param base - 16, 2 or 8.
 *
 * @returns The parsed integer.
 */
function parseRadix(value: string, base: number): number {
  const digits = base === 2 || base === 8 ? value.trim().substring(2) : value.trim();
  return Number.parseInt(digits, base);
}

/**
 * @description Decide what a value that overflows to infinity becomes.
 *
 * @param original - The input as written.
 * @param value - The parsed value, `Infinity` or `-Infinity`.
 * @param mode - The caller's `infinity` option.
 *
 * @returns The original string, `null`, a spelled-out string, or the numeric infinity.
 */
function handleInfinity(original: string, value: number, mode: ToNumberOptions['infinity']): string | number | null {
  switch ((mode ?? 'original').toLowerCase()) {
    case 'null':
      return null;
    case 'infinity':
      return value;
    case 'string':
      return value === Number.POSITIVE_INFINITY ? 'Infinity' : '-Infinity';
    default:
      return original;
  }
}

/**
 * @description Resolve exponent notation, honouring the leading-zero rules.
 *
 * @param original - The input as written.
 * @param value - The trimmed input.
 * @param options - The resolved options.
 *
 * @returns The parsed number, or the original string when the notation is not acceptable.
 */
function resolveExponent(original: string, value: string, options: ResolvedOptions): string | number {
  if (!options.eNotation) return original;
  const match = EXPONENT_PATTERN.exec(value);
  if (!match) return original;

  const sign = match[1] ?? '';
  const leadingZeros = match[2] ?? '';
  // Group 3 is required by the pattern — it holds the `[eE]` and at least one
  // digit — so the fallback cannot fire. It is written out because the index
  // access is typed as possibly undefined and a reader should not have to
  // re-derive the pattern to see why.
  const mantissa = match[3] ?? '';
  const eChar = mantissa.includes('e') ? 'e' : 'E';
  // A zero run immediately before the exponent is `"0e3"`, which is a different
  // shape from `"03e3"` and is judged by a different rule.
  const zerosAdjacentToExponent = sign ? original[leadingZeros.length + 1] === eChar : original[leadingZeros.length] === eChar;

  if (leadingZeros.length > 1 && zerosAdjacentToExponent) return original;
  if (leadingZeros.length === 1 && (mantissa.startsWith(`.${eChar}`) || mantissa[0] === eChar)) return Number(value);
  if (leadingZeros.length > 0) {
    if (options.leadingZeros && !zerosAdjacentToExponent) return Number(`${sign}${mantissa}`);
    return original;
  }
  return Number(value);
}

/**
 * @description Convert a string to a number when it is unambiguously numeric, and hand back the original string when it is not. The return type is `string |
 * number` on purpose. Returning the input rather than `NaN` is what lets a value parser sit in a chain without having to check whether it was the one
 * that converted anything: a caller distinguishes "this was a number" from "this was text" by the type, and both `42` and `"forty two"` come back
 * intact.
 *
 * @example
 *   ```typescript
 *   toNumber('42'); // 42
 *   toNumber('0x1f'); // 31
 *   toNumber('1,000'); // '1,000'
 *   toNumber('007'); // 7
 *   toNumber('007', { leadingZeros: false }); // '007'
 *   toNumber('1e1000'); // '1e1000'  (infinity: 'original')
 *   ```;
 *
 * @param value - The candidate string.
 * @param options - Which numeric forms to accept.
 *
 * @returns The number, or `value` unchanged when it is not numeric under `options`.
 */
export function toNumber(value: string, options: ToNumberOptions = {}): string | number | null {
  const resolved: ResolvedOptions = { ...DEFAULTS, ...options };

  if (!value || typeof value !== 'string') return value;

  const original = value;
  let candidate = value.trim();
  if (candidate.length === 0) return value;
  if (resolved.skipLike !== undefined && resolved.skipLike.test(candidate)) return value;
  if (candidate === '0') return 0;

  if (resolved.unicode) {
    candidate = normalizeUnicode(candidate);
    if (candidate === '0') return 0;
  }

  if (resolved.hex && HEX_PATTERN.test(candidate)) return parseRadix(candidate, 16);
  if (resolved.binary && BINARY_PATTERN.test(candidate)) return parseRadix(candidate, 2);
  if (resolved.octal && OCTAL_PATTERN.test(candidate)) return parseRadix(candidate, 8);
  // `Number(candidate)` is explicit about coercing. The global `isFinite` does
  // the same thing, and the original relied on that: `Number.isFinite` does not
  // coerce, so it answers `false` for the string `"1.5"` and every decimal would
  // take the infinity branch below.
  if (!Number.isFinite(Number(candidate))) return handleInfinity(original, Number(candidate), resolved.infinity);
  if (candidate.includes('e') || candidate.includes('E')) return resolveExponent(original, candidate, resolved);

  // Split the candidate into sign, leading zeros and the rest, so the
  // leading-zero rules can be judged without re-parsing the whole thing.
  const match = NUMBER_PATTERN.exec(candidate);
  if (!match) return value;

  const sign = match[1] ?? '';
  const leadingZeros = match[2] ?? '';
  const withoutZeros = trimTrailingZeros(match[3] ?? '');
  const zeroRunTouchesPoint = sign ? original[leadingZeros.length + 1] === '.' : original[leadingZeros.length] === '.';

  if (!resolved.leadingZeros && (leadingZeros.length > 1 || (leadingZeros.length === 1 && !zeroRunTouchesPoint))) {
    return value;
  }

  const num = Number(candidate);
  const roundTripped = String(num);

  if (num === 0) return num;
  if (/[eE]/.test(roundTripped)) {
    // A long literal that JS printed back in exponent form. Accept it only if
    // the caller allows exponents, or the round trip is not faithful.
    return resolved.eNotation ? num : value;
  }
  if (candidate.indexOf('.') !== -1) {
    if (roundTripped === '0') return num;
    if (roundTripped === withoutZeros) return num;
    if (roundTripped === `${sign}${withoutZeros}`) return num;
    return value;
  }

  const comparable = leadingZeros ? withoutZeros : candidate;
  if (leadingZeros) {
    return comparable === roundTripped || sign + comparable === roundTripped ? num : value;
  }
  return comparable === roundTripped || comparable === sign + roundTripped ? num : value;
}

export default toNumber;
