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
 * @description Whether a value is written in exponent notation, in either case of the marker.
 *
 * @param value - The candidate string.
 *
 * @returns `true` when it holds an `e` or an `E`.
 */
function hasExponentMarker(value: string): boolean {
  return value.includes('e') || value.includes('E');
}

/**
 * @description Whether a mantissa starts at the exponent marker rather than carrying digits in front of it — `e3` and `.e3` are the two shapes `"0e3"` and
 * `"0.e3"` are written in.
 *
 * @param mantissa - The mantissa capture from {@link EXPONENT_PATTERN}.
 * @param marker - The exponent marker as written, `'e'` or `'E'`.
 *
 * @returns `true` when the mantissa opens on the marker, optionally behind a point.
 */
function opensAtMarker(mantissa: string, marker: string): boolean {
  return mantissa.startsWith(`.${marker}`) || mantissa[0] === marker;
}

/**
 * @description An exponent literal split into the pieces its leading-zero rule is judged on.
 */
interface ExponentParts {
  /**
   * @description The input as written, echoed back by every rule that refuses.
   */
  original: string;
  /**
   * @description The trimmed input, which the accepting rules parse.
   */
  value: string;
  /**
   * @description The `+` or `-` capture group, or `''`.
   */
  sign: string;
  /**
   * @description Everything from the first significant digit through the exponent digits.
   */
  mantissa: string;
  /**
   * @description The exponent marker as written, `'e'` or `'E'`.
   */
  marker: string;
  /**
   * @description The run of zeros the literal opens with, `''` when it opens with digits.
   */
  zeros: string;
  /**
   * @description Whether the run of zeros runs straight into the exponent marker in the input as written.
   */
  zerosAgainstMarker: boolean;
}

/**
 * @description Read the pieces of an exponent literal out of a {@link EXPONENT_PATTERN} match.
 *
 * @param original - The input as written.
 * @param value - The trimmed input.
 * @param match - The pattern match.
 *
 * @returns The split literal.
 */
function exponentParts(original: string, value: string, match: RegExpExecArray): ExponentParts {
  const sign = match[1] ?? '';
  const zeros = match[2] ?? '';
  // Group 3 is required by the pattern — it holds the `[eE]` and at least one
  // digit — so the fallback cannot fire. It is written out because the index
  // access is typed as possibly undefined and a reader should not have to
  // re-derive the pattern to see why.
  const mantissa = match[3] ?? '';
  const marker = mantissa.includes('e') ? 'e' : 'E';
  return {
    original,
    value,
    sign,
    mantissa,
    marker,
    zeros,
    // A zero run immediately before the exponent is `"0e3"`, which is a
    // different shape from `"03e3"` and is judged by a different rule. The
    // sign shifts where in the input the run ends.
    zerosAgainstMarker: original[sign ? zeros.length + 1 : zeros.length] === marker,
  };
}

/**
 * @description The leading-zero shapes an exponent literal can be written in, applied in order. Which shape it is written in decides the answer outright, so the
 * sequence is the contract rather than an implementation detail: a run of two or more pressed against the marker is refused, a lone zero that _is_
 * the value is accepted whatever the leading-zero option says, a run the marker has moved away from is ordinary padding, and a literal with no run at
 * all is not this function's business.
 *
 * @param parts - The split literal.
 * @param options - The resolved options.
 *
 * @returns The parsed number, or the original string when the notation is not acceptable.
 */
function judgeExponent(parts: ExponentParts, options: ResolvedOptions): string | number {
  if (parts.zeros.length > 1 && parts.zerosAgainstMarker) return parts.original;
  if (parts.zeros.length === 1 && opensAtMarker(parts.mantissa, parts.marker)) return Number(parts.value);
  if (parts.zeros.length > 0) {
    if (options.leadingZeros && !parts.zerosAgainstMarker) return Number(`${parts.sign}${parts.mantissa}`);
    return parts.original;
  }
  return Number(parts.value);
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
  return judgeExponent(exponentParts(original, value, match), options);
}

/**
 * @description Whether a run of zeros in front of a decimal is padding rather than the number's own zero. A run of two or more is always padding; a single zero is
 * padding too, unless it is the zero of the fraction.
 *
 * @param zeros - The leading zero run.
 * @param touchesPoint - Whether the character after the run in the input as written is a decimal point.
 *
 * @returns `true` when the run is padding a value.
 */
function isPaddedZeroRun(zeros: string, touchesPoint: boolean): boolean {
  if (zeros.length > 1) return true;
  return zeros.length === 1 && !touchesPoint;
}

/**
 * @description Parse a `0x` / `0b` / `0o` literal, if the candidate is one and the caller allows that base. Hex first, then binary, then octal — a value matching
 * none of them comes back `undefined` and falls through to the decimal rules untouched.
 *
 * @param candidate - The trimmed candidate.
 * @param resolved - The resolved options.
 *
 * @returns The parsed integer, or `undefined` when the candidate is not an enabled radix literal.
 */
function parseRadixLiteral(candidate: string, resolved: ResolvedOptions): number | undefined {
  if (resolved.hex && HEX_PATTERN.test(candidate)) return parseRadix(candidate, 16);
  if (resolved.binary && BINARY_PATTERN.test(candidate)) return parseRadix(candidate, 2);
  if (resolved.octal && OCTAL_PATTERN.test(candidate)) return parseRadix(candidate, 8);
  return undefined;
}

/**
 * @description The {@link NUMBER_PATTERN} capture groups, read once so the decimal rules never index into a match again. Splitting the candidate into sign,
 * leading zeros and the rest is what lets the leading-zero rules be judged without re-parsing the whole thing.
 */
interface DecimalMatch {
  /**
   * @description The `+` or `-` capture group, or `''`.
   */
  sign: string;
  /**
   * @description The run of zeros in front of the digits, or `''`.
   */
  zeros: string;
  /**
   * @description The digits, with the zero run already excluded and any fraction still attached.
   */
  digits: string;
  /**
   * @description The character that follows the zero run in the input as written, or `undefined` at the end of it. `'00.5'` puts a point there and `'007'` puts a
   * digit, and that one character is what tells a padded identifier from a decimal.
   */
  afterZeros: string | undefined;
}

/**
 * @description Read the pieces of a decimal out of a {@link NUMBER_PATTERN} match, against the input as written.
 *
 * @param original - The input as written, which is where the character after the zero run is looked up.
 * @param match - The pattern match.
 *
 * @returns The split decimal.
 */
function readDecimalMatch(original: string, match: RegExpExecArray): DecimalMatch {
  const sign = match[1] ?? '';
  const zeros = match[2] ?? '';
  return {
    sign,
    zeros,
    digits: match[3] ?? '',
    // The sign shifts where in the input the run ends, so it belongs to the index rather than to the run's length.
    afterZeros: original[sign ? zeros.length + 1 : zeros.length],
  };
}

/**
 * @description A candidate decimal split into the pieces the round-trip rules are judged on. Passed whole rather than as an argument list because both judges need
 * most of it, and because the pieces have to stay together: the rules compare the digits against the form JS printed back, and unpacking them from a
 * signature is how a reader loses track of which is which.
 */
interface DecimalParts {
  /**
   * @description The trimmed candidate, as the numeric rules see it.
   */
  candidate: string;
  /**
   * @description The input as written, echoed back by every rule that refuses.
   */
  original: string;
  /**
   * @description The `+` or `-` capture group, or `''`.
   */
  sign: string;
  /**
   * @description The run of zeros in front of the digits, or `''`.
   */
  leadingZeros: string;
  /**
   * @description The digits with the fraction's trailing zeros trimmed and the point tidied.
   */
  withoutZeros: string;
  /**
   * @description The candidate as a number.
   */
  num: number;
  /**
   * @description The candidate as JS printed it back, which is the form the rules compare against.
   */
  roundTripped: string;
}

/**
 * @description Judge a decimal that has a point in it against the form JS printed back. The printed form may match the tidied digits with the sign folded in by
 * `Number`, or with the sign still standing in front of them — those are the two spellings that survive the round trip, and anything else means the
 * input said something the number does not.
 *
 * @param parts - The split candidate.
 *
 * @returns The number, or the original string.
 */
function judgePointed(parts: DecimalParts): string | number {
  if (parts.roundTripped === '0') return parts.num;
  if (parts.roundTripped === parts.withoutZeros) return parts.num;
  if (parts.roundTripped === `${parts.sign}${parts.withoutZeros}`) return parts.num;
  return parts.original;
}

/**
 * @description Judge an integer against the form JS printed back. The two branches differ in where the sign is looked for, which follows from the zero run: with
 * one in front, the digits have to come back with the sign still standing in front of them, because that sign is part of what the run was padding.
 * Without one, the comparison is against the signless digits and the sign is checked against the printed sign separately.
 *
 * @param parts - The split candidate.
 *
 * @returns The number, or the original string.
 */
function judgeInteger(parts: DecimalParts): string | number {
  const comparable = parts.leadingZeros ? parts.withoutZeros : parts.candidate;
  const accepted = parts.leadingZeros
    ? comparable === parts.roundTripped || parts.sign + comparable === parts.roundTripped
    : comparable === parts.roundTripped || comparable === parts.sign + parts.roundTripped;
  return accepted ? parts.num : parts.original;
}

/**
 * @description Apply the decimal rules to a candidate that is neither a radix literal nor exponent notation.
 *
 * @param original - The input as written.
 * @param candidate - The trimmed candidate.
 * @param resolved - The resolved options.
 *
 * @returns The number, or the original string when the decimal rules refuse it.
 */
function parseDecimal(original: string, candidate: string, resolved: ResolvedOptions): string | number {
  const match = NUMBER_PATTERN.exec(candidate);
  if (!match) return original;

  const { sign, zeros, digits, afterZeros } = readDecimalMatch(original, match);
  if (!resolved.leadingZeros && isPaddedZeroRun(zeros, afterZeros === '.')) return original;

  const num = Number(candidate);
  const parts: DecimalParts = {
    candidate,
    original,
    sign,
    leadingZeros: zeros,
    withoutZeros: trimTrailingZeros(digits),
    num,
    roundTripped: String(num),
  };

  if (num === 0) return num;
  // A long literal that JS printed back in exponent form. Accept it only if
  // the caller allows exponents, or the round trip is not faithful.
  if (hasExponentMarker(parts.roundTripped)) return resolved.eNotation ? num : original;
  return candidate.indexOf('.') !== -1 ? judgePointed(parts) : judgeInteger(parts);
}

/**
 * @description The numeric forms that are not a plain decimal, in the order they are tried: a radix literal, then the overflow branch, then exponent notation. The
 * order is the contract rather than an implementation detail. The overflow check has to run before the notation branch, because a value that
 * overflows is judged as an overflow however it was written. The radix literals have to win outright, because `Number('0x1f')` is `NaN` where
 * `parseInt('0x1f', 16)` is 31.
 *
 * @param original - The input as written.
 * @param candidate - The trimmed, and possibly Unicode-normalized, candidate.
 * @param resolved - The resolved options.
 *
 * @returns The number, the original string, or `null` when the `infinity` option asks for it.
 */
function convertNumericForm(original: string, candidate: string, resolved: ResolvedOptions): string | number | null {
  const radix = parseRadixLiteral(candidate, resolved);
  if (radix !== undefined) return radix;
  // `Number(candidate)` is explicit about coercing. The global `isFinite` does
  // the same thing, and the original relied on that: `Number.isFinite` does not
  // coerce, so it answers `false` for the string `"1.5"` and every decimal would
  // take the infinity branch below.
  if (!Number.isFinite(Number(candidate))) return handleInfinity(original, Number(candidate), resolved.infinity);
  if (hasExponentMarker(candidate)) return resolveExponent(original, candidate, resolved);
  return parseDecimal(original, candidate, resolved);
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
function toNumber(value: string, options: ToNumberOptions = {}): string | number | null {
  const resolved: ResolvedOptions = { ...DEFAULTS, ...options };

  if (!value || typeof value !== 'string') return value;

  const original = value;
  let candidate = value.trim();
  if (candidate.length === 0) return value;
  if (resolved.skipLike !== undefined && resolved.skipLike.test(candidate)) return value;
  if (!resolved.unicode && resolved.infinity === 'original') {
    // Every accepted form starts with a sign, a decimal point, or an ASCII digit, so any other first
    // character is text and can come back untouched before the pattern work below. Most values in a
    // document are text, and this is the difference between a trim and a scan per value and a
    // trim plus four patterns. Skipped when `infinity` asks for a non-finite value to be
    // represented, or Unicode digits are accepted — both change what a non-numeric first character
    // means.
    const first = candidate.charCodeAt(0);
    if (!((first >= 48 && first <= 57) || first === 43 || first === 45 || first === 46)) return value;
  }
  if (candidate === '0') return 0;

  if (resolved.unicode) {
    candidate = normalizeUnicode(candidate);
    if (candidate === '0') return 0;
  }

  return convertNumericForm(original, candidate, resolved);
}

export default toNumber;
