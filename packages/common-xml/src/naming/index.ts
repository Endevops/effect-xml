// xml-naming
// Validates XML Name productions as defined in the XML 1.0 and 1.1 specifications.
// Covers: Name, NCName, QName, NMToken, NMTokens
//
// XML 1.0 spec: https://www.w3.org/TR/xml/#NT-Name
// XML 1.1 spec: https://www.w3.org/TR/xml11/#NT-NameStartChar
// XML NS spec:  https://www.w3.org/TR/xml-names/#NT-NCName
//
// Two error conventions run through this module, and the split is deliberate:
//
//   - The five boolean validators and `sanitize` are infallible. A regex test cannot fail and a
//     character-substitution has nothing to fail about, so they stay plain synchronous functions and stay
//     usable as predicates — which is how the builder and the codec call them, per name, inside their own
//     hot loops.
//   - `createValidator`, `validate` and `validateAll` can fail, on an unknown production, and so return an
//     `Effect` with an {@link XmlError} rather than throwing. The failure is unreachable from TypeScript,
//     where `Production` is a closed union; it is the guard for untyped JavaScript callers and for values
//     that crossed a boundary as `unknown`.

import { Effect } from 'effect';

import type { XmlError } from '../errors.ts';

import { XmlError as XmlErrorCtor } from '../errors.ts';

/**
 * @description The XML specification version a production is validated against. The two differ only in their non-ASCII character ranges — see {@link getRegexes}.
 */
export type XmlVersion = '1.0' | '1.1';

/**
 * @description One of the five XML name productions this package validates. The name is the production's grammar rule: `name` is the full Name production,
 * `ncName` its non-colonized form, `qName` the prefixed form, and `nmToken`/`nmTokens` the attribute-value productions that drop the first-character
 * restriction.
 */
export type Production = 'name' | 'ncName' | 'qName' | 'nmToken' | 'nmTokens';

/**
 * @description Options shared by every validator.
 */
export interface ValidationOptions {
  /**
   * @description XML specification version to validate against. Defaults to '1.0'.
   */
  xmlVersion?: XmlVersion;
  /**
   * @description Restrict matching to the ASCII subset of the NameStartChar/NameChar productions and skip unicode-aware regex matching entirely. Faster,
   * especially for XML 1.1 (which otherwise requires the `/u` regex flag), but rejects legitimate non-ASCII XML names. Off by default for backward
   * compatibility — opt in only when inputs are known to be ASCII. Defaults to false.
   */
  asciiOnly?: boolean;
}

/**
 * @description Options for {@link sanitize}.
 */
export interface SanitizeOptions {
  /**
   * @description Character used to replace invalid characters. Defaults to '_'.
   */
  replacement?: string;
  /**
   * @description Also replace any non-ASCII character, not just XML-illegal ones. Defaults to false.
   */
  asciiOnly?: boolean;
  /**
   * @description Accepted and ignored. Sanitizing is not version-dependent — the character set it considers illegal is the union of both versions — but the option
   * is part of the published signature, so dropping it would break callers that pass it through a shared options object.
   */
  xmlVersion?: XmlVersion;
}

/**
 * @description Options for {@link createValidator}.
 */
export interface CreateValidatorOptions extends ValidationOptions {
  /**
   * @description Max number of distinct strings to cache. Once reached, new strings are still validated correctly but are no longer cached; existing cached
   * entries keep being served. Defaults to 2048.
   */
  maxCacheSize?: number;
}

/**
 * @description A boolean validator with a private string cache attached. Call `reset` to drop the cache; the function stays correct afterwards.
 */
export interface MemoizedValidator {
  (str: string): boolean;
  /**
   * @description Clears the internal cache.
   */
  reset: () => void;
}

/**
 * @description The outcome of {@link validate}, discriminated on `valid` so a caller can narrow to the reason and position without a cast.
 */
export type ValidationResult =
  | { valid: true; production: Production; input: string }
  | {
      valid: false;
      production: Production;
      input: string;
      reason: string;
      /**
       * @description Index of the first offending character, or `undefined` when the failure is structural (an empty input, or a colon count) rather than a
       * specific character.
       */
      position: number | undefined;
    };

/**
 * @description The five productions, in the order the runtime error message lists them.
 */
const PRODUCTIONS = ['name', 'ncName', 'qName', 'nmToken', 'nmTokens'] as const satisfies readonly Production[];

/**
 * @description One compiled regex per production.
 */
type ProductionRegexes = Record<Production, RegExp>;

// ---------------------------------------------------------------------------
// Character class strings — XML 1.0
//
// NameStartChar ::= ":" | [A-Z] | "_" | [a-z]
//   | [#xC0-#xD6]   | [#xD8-#xF6]   | [#xF8-#x2FF]
//   | [#x370-#x37D] | [#x37F-#x1FFF]    <- split to exclude #x0487
//   | [#x200C-#x200D]
//   | [#x2070-#x218F] | [#x2C00-#x2FEF]
//   | [#x3001-#xD7FF] | [#xF900-#xFDCF] | [#xFDF0-#xFFFD]
//
// NameChar ::= NameStartChar | "-" | "." | [0-9]
//   | #xB7 | [#x0300-#x036F] | [#x203F-#x2040]
//
// Note: \u0487 (Combining Cyrillic Millions Sign) was added in Unicode 4.0,
// after XML 1.0 was defined against Unicode 2.0. It falls inside the range
// \u037F-\u1FFF but must be excluded. We split that range into
// \u037F-\u0486 and \u0488-\u1FFF to exclude it explicitly.
// ---------------------------------------------------------------------------

const nameStartChar10 =
  ':A-Za-z_' +
  '\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF' +
  '\u0370-\u037D' +
  '\u037F-\u0486\u0488-\u1FFF' + // split to exclude \u0487
  '\u200C-\u200D' +
  '\u2070-\u218F' +
  '\u2C00-\u2FEF' +
  '\u3001-\uD7FF' +
  '\uF900-\uFDCF' +
  '\uFDF0-\uFFFD';

const nameChar10 = nameStartChar10 + '\\-\\.\\d' + '\u00B7' + '\u0300-\u036F' + '\u203F-\u2040';

// ---------------------------------------------------------------------------
// Character class strings — XML 1.1
//
// Differences from XML 1.0:
//
// NameStartChar:
//   1.0 has split ranges: \u00C0-\u00D6, \u00D8-\u00F6, \u00F8-\u02FF
//   1.1 merges them into: \u00C0-\u02FF
//   (\u00D7 x and \u00F7 / are division symbols, excluded in both versions)
//
//   1.0 tops out at \uFFFD (BMP only)
//   1.1 adds \u{10000}-\u{EFFFF} (supplementary planes)
//   These require the /u flag on the RegExp — see buildRegexes below.
//
// NameChar:
//   1.1 adds \u0487 (Combining Cyrillic Millions Sign, added in Unicode 4.0)
// ---------------------------------------------------------------------------

const nameStartChar11 =
  ':A-Za-z_' +
  '\u00C0-\u02FF' + // merged — 1.0 had three split ranges here
  '\u0370-\u037D' +
  '\u037F-\u0486\u0488-\u1FFF' + // split to exclude \u0487 (combining mark, never a NameStartChar)
  '\u200C-\u200D' +
  '\u2070-\u218F' +
  '\u2C00-\u2FEF' +
  '\u3001-\uD7FF' +
  '\uF900-\uFDCF' +
  '\uFDF0-\uFFFD' +
  '\u{10000}-\u{EFFFF}'; // supplementary planes — REQUIRES /u flag on RegExp

const nameChar11 =
  nameStartChar11 +
  '\\-\\.\\d' +
  '\u00B7' +
  '\u0300-\u036F' +
  '\u0487' + // Combining Cyrillic Millions Sign — valid in 1.1, not 1.0
  '\u203F-\u2040';

// ---------------------------------------------------------------------------
// Regex builders
//
// XML 1.0 regexes: no flags — BMP only, standard JS regex behaviour.
// XML 1.1 regexes: /u flag — required for \u{10000}-\u{EFFFF} to match actual
//   supplementary code points rather than lone surrogates (which are illegal XML).
// ---------------------------------------------------------------------------

/**
 * @description Compiles the five production regexes from a NameStartChar/NameChar pair.
 *
 * @param startChar - Character class body for the first character.
 * @param char - Character class body for every subsequent character.
 * @param flags - RegExp flags. `'u'` for the XML 1.1 set, so its supplementary-plane range matches code points rather than lone surrogates.
 *
 * @returns One regex per {@link Production}.
 */
const buildRegexes = (startChar: string, char: string, flags = ''): ProductionRegexes => {
  const ncStart = startChar.replace(':', '');
  const ncChar = char.replace(':', '');
  const ncNamePat = `[${ncStart}][${ncChar}]*`;

  return {
    name: new RegExp(`^[${startChar}][${char}]*$`, flags),
    ncName: new RegExp(`^${ncNamePat}$`, flags),
    qName: new RegExp(`^${ncNamePat}(?::${ncNamePat})?$`, flags),
    nmToken: new RegExp(`^[${char}]+$`, flags),
    nmTokens: new RegExp(`^[${char}]+(?:\\s+[${char}]+)*$`, flags),
  };
};

const regexes10 = buildRegexes(nameStartChar10, nameChar10); // no /u — BMP only
const regexes11 = buildRegexes(nameStartChar11, nameChar11, 'u'); // /u — enables \u{10000}-\u{EFFFF}

// ---------------------------------------------------------------------------
// ASCII-only fast path (opt-in, off by default)
//
// The XML 1.0 vs 1.1 NameStartChar/NameChar productions differ *only* in
// their non-ASCII ranges (merged vs split Latin-1 ranges, \u0487, and
// supplementary planes). Restricted to ASCII, both versions collapse to the
// same character classes, so a single regex pair covers both xmlVersion
// values — no /u flag needed.
//
// Rationale: unicode-aware regexes (the /u flag, required for XML 1.1's
// supplementary-plane range) are measurably slower in V8 than plain
// non-unicode regexes on the same input, even when the input is pure ASCII.
// For the common case — HTML/SVG ids, XML tags — names are ASCII, so callers
// who know this can opt in to skip the unicode-aware matching path entirely.
// This is a real but *conditional* win: mainly for XML 1.1 input (avoids /u),
// or at scale where the larger unicode character classes add engine
// overhead. It also changes behaviour (rejects legitimate non-ASCII XML
// 1.0/1.1 names), so it must never be silently enabled — hence off by
// default.
// ---------------------------------------------------------------------------

const nameStartCharAscii = ':A-Za-z_';
const nameCharAscii = nameStartCharAscii + '\\-\\.\\d';

const regexesAscii = buildRegexes(nameStartCharAscii, nameCharAscii); // no /u — ASCII only

/**
 * @description The compiled regex set for a version/ASCII combination. Only three sets are ever built, at module load; this is a lookup, not a compile.
 *
 * @param xmlVersion - Which XML version's character classes to use.
 * @param asciiOnly - Return the ASCII-only set regardless of `xmlVersion`.
 *
 * @returns The regex set to validate against.
 */
const getRegexes = (xmlVersion: XmlVersion = '1.0', asciiOnly = false): ProductionRegexes => {
  if (asciiOnly) return regexesAscii;
  return xmlVersion === '1.1' ? regexes11 : regexes10;
};

// ---------------------------------------------------------------------------
// Boolean validators
// ---------------------------------------------------------------------------

/**
 * @description Returns true if the string is a valid XML Name. Colons are allowed anywhere (Name production). Used for: DOCTYPE entity names, notation names, DTD
 * element declarations.
 *
 * @param str - The candidate name.
 * @param opts - `asciiOnly` skips unicode-aware matching, ASCII names only (default false).
 *
 * @returns Whether `str` satisfies the Name production.
 */
export const name = (str: string, { xmlVersion = '1.0', asciiOnly = false }: ValidationOptions = {}): boolean =>
  getRegexes(xmlVersion, asciiOnly).name.test(str);

/**
 * @description Returns true if the string is a valid NCName (Non-Colonized Name). Colons are not permitted. Used for: namespace prefixes, local names, SVG id
 * attributes.
 *
 * @param str - The candidate name.
 * @param opts - `asciiOnly` skips unicode-aware matching, ASCII names only (default false).
 *
 * @returns Whether `str` satisfies the NCName production.
 */
export const ncName = (str: string, { xmlVersion = '1.0', asciiOnly = false }: ValidationOptions = {}): boolean =>
  getRegexes(xmlVersion, asciiOnly).ncName.test(str);

/**
 * @description Returns true if the string is a valid QName (Qualified Name). Allows exactly one colon as a prefix separator: `prefix:localName`. Used for: element
 * and attribute names in namespace-aware XML/SVG.
 *
 * @param str - The candidate name.
 * @param opts - `asciiOnly` skips unicode-aware matching, ASCII names only (default false).
 *
 * @returns Whether `str` satisfies the QName production.
 */
export const qName = (str: string, { xmlVersion = '1.0', asciiOnly = false }: ValidationOptions = {}): boolean =>
  getRegexes(xmlVersion, asciiOnly).qName.test(str);

/**
 * @description Returns true if the string is a valid NMToken. Like Name but no restriction on the first character. Used for: DTD NMTOKEN attribute values.
 *
 * @param str - The candidate token.
 * @param opts - `asciiOnly` skips unicode-aware matching, ASCII names only (default false).
 *
 * @returns Whether `str` satisfies the NMToken production.
 */
export const nmToken = (str: string, { xmlVersion = '1.0', asciiOnly = false }: ValidationOptions = {}): boolean =>
  getRegexes(xmlVersion, asciiOnly).nmToken.test(str);

/**
 * @description Returns true if the string is a valid NMTokens value — a whitespace-separated list of NMToken values. Used for: DTD NMTOKENS attribute values.
 *
 * @param str - The candidate list.
 * @param opts - `asciiOnly` skips unicode-aware matching, ASCII names only (default false).
 *
 * @returns Whether `str` satisfies the NMTokens production.
 */
export const nmTokens = (str: string, { xmlVersion = '1.0', asciiOnly = false }: ValidationOptions = {}): boolean =>
  getRegexes(xmlVersion, asciiOnly).nmTokens.test(str);

// ---------------------------------------------------------------------------
// Memoized validator factory
//
// Real documents reuse a small vocabulary of tag/attribute names across many
// siblings (e.g. `id`, `class`, `href` repeated across hundreds of elements).
// The plain boolean validators above re-run the regex on every call
// regardless of repeats. `createValidator` returns a closure with a private
// string -> boolean cache, so repeated names after the first become O(1)
// lookups instead of regex tests.
//
// - opts (xmlVersion, asciiOnly) are fixed at creation time, so the regex is
//   resolved once, not on every call.
// - The cache is private to the returned closure — no shared/global state,
//   no cross-caller pollution.
// - `maxCacheSize` bounds memory: once the cache reaches this many entries,
//   it stops accepting new ones (existing entries keep serving hits; new
//   misses just fall through to the regex, uncached). This avoids unbounded
//   growth against adversarial/high-cardinality input (e.g. validating
//   attacker-supplied names with no repeats) without the cost/complexity of
//   a full LRU, and without the perf cliff of reset-and-refill thrashing.
// - Call `.reset()` on the returned function to clear the cache manually
//   (e.g. between unrelated parse calls).
// ---------------------------------------------------------------------------

/**
 * @description Returns a memoized boolean validator for a single production, with options fixed at creation time. Repeated calls with the same string after the
 * first are served from a private cache instead of re-running the regex.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { createValidator } from '@endevops/common-xml';
 *
 *   const isNCName = Effect.runSync(Effect.orElseSucceed(createValidator('ncName'), () => () => false));
 *   isNCName('svg:circle'); // false — a colon is not an NCName
 *   ```;
 *
 * @param production - The production to validate against.
 * @param opts - `maxCacheSize` bounds the cache (default 2048). Once reached, new strings are validated but not cached; existing entries keep being
 *   served.
 *
 * @returns An effect producing a validator function with a `reset` method that clears its cache. Fails with {@link XmlError} and the
 *   `InvalidProduction` reason when `production` is not one of the five known productions — unreachable from TypeScript, kept as the guard for
 *   untyped JavaScript callers.
 */
export const createValidator = (
  production: Production,
  { xmlVersion = '1.0', asciiOnly = false, maxCacheSize = 2048 }: CreateValidatorOptions = {}
): Effect.Effect<MemoizedValidator, XmlError> => {
  if (!PRODUCTIONS.includes(production)) {
    return Effect.fail(
      new XmlErrorCtor({
        reason: { _tag: 'InvalidProduction', production, expected: PRODUCTIONS.join(', ') },
        message: `Unknown production "${production}". Must be one of: ${PRODUCTIONS.join(', ')}`,
      })
    );
  }

  const regex = getRegexes(xmlVersion, asciiOnly)[production];
  let cache = new Map<string, boolean>();

  return Effect.succeed(
    Object.assign(
      (str: string): boolean => {
        const cached = cache.get(str);
        if (cached !== undefined) return cached;

        const result = regex.test(str);
        if (cache.size < maxCacheSize) cache.set(str, result);
        return result;
      },
      {
        reset: (): void => {
          cache = new Map();
        },
      }
    )
  );
};

// ---------------------------------------------------------------------------
// Diagnostic validator
// ---------------------------------------------------------------------------

/**
 * @description The reason a name failed a production, as an effect. The single place the unknown-production guard lives, so `validate` and `validateAll` cannot
 * drift into reporting it differently.
 *
 * @param production - The production to check.
 *
 * @returns `Effect.void` for a known production, or the `InvalidProduction` failure.
 */
const checkProduction = (production: Production): Effect.Effect<void, XmlError> =>
  PRODUCTIONS.includes(production)
    ? Effect.void
    : Effect.fail(
        new XmlErrorCtor({
          reason: { _tag: 'InvalidProduction', production, expected: PRODUCTIONS.join(', ') },
          message: `Unknown production "${production}". Must be one of: ${PRODUCTIONS.join(', ')}`,
        })
      );

/**
 * @description The diagnostic body {@link validate} reports, with the production already known to be valid. Kept separate so the reason-finding logic carries no
 * error channel and the batch path can map over it without re-entering the guard per element.
 *
 * @param str - The candidate name.
 * @param production - The production to validate against, already checked.
 * @param xmlVersion - Which version's character classes to use.
 * @param asciiOnly - Whether the ASCII-only fast path applied.
 *
 * @returns The discriminated result.
 */
const diagnose = (str: string, production: Production, xmlVersion: XmlVersion, asciiOnly: boolean): ValidationResult => {
  const validators: Record<Production, (str: string, opts?: ValidationOptions) => boolean> = { name, ncName, qName, nmToken, nmTokens };
  const isValid = validators[production](str, { xmlVersion, asciiOnly });

  if (isValid) return { valid: true, production, input: str };

  let reason = 'Does not match the production rules';
  let position: number | undefined;

  // Diagnostic fallback char checks must mirror the same character set the
  // boolean validator above used, or the reported reason/position could
  // contradict the `valid: false` result (e.g. flagging a char as illegal
  // that the unicode-aware check would have accepted).
  const startCharPattern = asciiOnly ? /^[:A-Za-z_]/ : /^[:A-Za-z_\u00C0-\uFFFD]/;
  const namePattern = asciiOnly ? /[\w\-\\.:]/ : /[\w\-\\.:\u00B7\u00C0-\uFFFD]/;

  const firstChar = str[0];

  if (str.length === 0) {
    reason = 'Input is empty';
  } else if (production === 'ncName' && str.includes(':')) {
    position = str.indexOf(':');
    reason = 'Colon is not allowed in NCName';
  } else if (production === 'qName' && str.startsWith(':')) {
    reason = 'QName cannot start with a colon';
    position = 0;
  } else if (production === 'qName' && str.endsWith(':')) {
    reason = 'QName cannot end with a colon';
    position = str.length - 1;
  } else if (production === 'qName' && (str.match(/:/g) ?? []).length > 1) {
    reason = 'QName can have at most one colon';
    position = str.lastIndexOf(':');
  } else if (['name', 'ncName', 'qName'].includes(production) && !startCharPattern.test(firstChar ?? '')) {
    reason = `First character "${firstChar}" is not a valid NameStartChar`;
    position = 0;
  } else {
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char !== undefined && !namePattern.test(char)) {
        reason = `Character "${char}" at position ${i} is not a valid NameChar`;
        position = i;
        break;
      }
    }
  }

  return { valid: false, production, input: str, reason, position };
};

/**
 * @description Validates a string against a named production and, on failure, reports why and where.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { validate } from '@endevops/common-xml';
 *
 *   Effect.runSync(Effect.orElseSucceed(validate('not a name', 'ncName'), () => null));
 *   // { valid: false, production: 'ncName', input: 'not a name', reason: 'First character " " is not a valid NameStartChar', position: 0 }
 *   ```;
 *
 * @param str - The candidate name.
 * @param production - The production to validate against.
 * @param opts - Version and ASCII-only selection, as for the boolean validators.
 *
 * @returns An effect producing a discriminated result: the plain triple when valid, or the offending `reason` and `position` when not. A name that
 *   fails to validate is a successful call with `valid: false`, not a failed effect — a name being invalid is the question being answered, not a
 *   failure of the function. Fails only with {@link XmlError} and the `InvalidProduction` reason, which is unreachable from TypeScript and is the
 *   guard for untyped JavaScript callers.
 */
export const validate = (
  str: string,
  production: Production,
  { xmlVersion = '1.0', asciiOnly = false }: ValidationOptions = {}
): Effect.Effect<ValidationResult, XmlError> =>
  // A generator, not `Effect.as(diagnose(...))`: the argument to `as` is a
  // value, so the diagnostic would run — and index an unknown production into
  // the validator table — before the guard had a chance to fail.
  Effect.gen(function* () {
    yield* checkProduction(production);
    return diagnose(str, production, xmlVersion, asciiOnly);
  });

// ---------------------------------------------------------------------------
// Batch validator
// ---------------------------------------------------------------------------

/**
 * @description Validates an array of strings against a named production.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { validateAll } from '@endevops/common-xml';
 *
 *   const results = Effect.runSync(Effect.orElseSucceed(validateAll(['a', '1b'], 'ncName'), () => []));
 *   results.filter(r => !r.valid).length; // 1 — '1b' cannot start with a digit
 *   ```;
 *
 * @param strings - The candidate names, in input order.
 * @param production - The production to validate against.
 * @param opts - Version and ASCII-only selection, as for the boolean validators.
 *
 * @returns An effect producing one result per input, in the same order. Fails with {@link XmlError} and the `InvalidProduction` reason, checked once
 *   up front rather than once per string — an unknown production would otherwise fail on the first element, and an empty input would silently
 *   succeed.
 */
export const validateAll = (
  strings: string[],
  production: Production,
  { xmlVersion = '1.0', asciiOnly = false }: ValidationOptions = {}
): Effect.Effect<ValidationResult[], XmlError> =>
  Effect.gen(function* () {
    yield* checkProduction(production);
    return strings.map(str => diagnose(str, production, xmlVersion, asciiOnly));
  });

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * @description Transforms an invalid string into the nearest valid XML name for the given production: strips or replaces illegal characters, fixes an invalid
 * start character by prepending the replacement, and removes colons for NCName.
 *
 * @param str - The candidate name.
 * @param production - The production to sanitize for. Defaults to `'name'`.
 * @param opts - `replacement` is the substitute character (default `'_'`); `asciiOnly` also replaces non-ASCII characters.
 *
 * @returns A string that satisfies `production` for the ASCII range, or the nearest approximation of it.
 */
export const sanitize = (str: string, production: Production = 'name', { replacement = '_', asciiOnly = false }: SanitizeOptions = {}): string => {
  if (!str) return replacement;

  let result = str;

  // Strip colons for NCName
  if (production === 'ncName') {
    result = result.replace(/:/g, '');
  }

  // Replace illegal characters
  const allowedCharPattern = asciiOnly ? /[^\w\-.:]/g : /[^\w\-.:\u00B7\u00C0-\uFFFD]/g;
  result = result.replace(allowedCharPattern, replacement);

  // Fix invalid start character for Name / NCName / QName
  if (production !== 'nmToken' && production !== 'nmTokens') {
    if (/^[-.\d]/.test(result)) {
      result = replacement + result;
    }
  }

  return result || replacement;
};
