/**
 * @description Specs for `@endevops/common-xml`, covering all five productions, the XML 1.0 vs 1.1 differences, the `asciiOnly` fast path, and the diagnostic,
 * batch, sanitize and memoizing helpers. The two `as Production` casts are deliberate: they stand in for the untyped JavaScript caller the runtime
 * guard exists to catch, which is the only way to exercise that branch from a type-checked suite.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { CreateValidatorOptions, MemoizedValidator, Production, ValidationOptions, ValidationResult } from '#/index.ts';

import {
  createValidator as createValidatorEffect,
  isName,
  isNcName,
  isNmToken,
  isNmTokens,
  isQName,
  sanitize,
  validate as validateEffect,
  validateAll as validateAllEffect,
} from '#/index.ts';

/**
 * @description Runs an effectful validator the way a caller not already in an `Effect` would: `Effect.runSync` throws the failure, so a spec asserting on a thrown
 * `XmlError` keeps reading the same, and a spec asserting on the value does too.
 */
const validate = (str: string, production: Production, options?: ValidationOptions): ValidationResult =>
  Effect.runSync(validateEffect(str, production, options));
const validateAll = (strings: Array<string>, production: Production, options?: ValidationOptions): Array<ValidationResult> =>
  Effect.runSync(validateAllEffect(strings, production, options));
const createValidator = (production: Production, options?: CreateValidatorOptions): MemoizedValidator =>
  Effect.runSync(createValidatorEffect(production, options));

/**
 * @description Narrows a validation result to its diagnostics. Throws if the result was valid, so a spec that expected a failure cannot pass on a success.
 *
 * @param result - Whatever {@link validate} returned.
 *
 * @returns The invalid branch, with `reason` and `position` in scope.
 */
const diagnosticsOf = (result: ValidationResult): { reason: string; position: number | undefined } => {
  if (result.valid) throw new Error(`expected "${result.input}" to be invalid`);
  return result;
};

// ---------------------------------------------------------------------------
// isName()
// ---------------------------------------------------------------------------

describe('isName()', () => {
  it('accepts simple ASCII names', () => {
    expect(isName('foo')).toBe(true);
    expect(isName('Foo')).toBe(true);
    expect(isName('_bar')).toBe(true);
    expect(isName('_')).toBe(true);
  });

  it('accepts names with colons', () => {
    expect(isName('a:b')).toBe(true);
    expect(isName(':')).toBe(true); // colon alone is a valid Name
    expect(isName('a:b:c')).toBe(true); // multiple colons allowed in Name
  });

  it('accepts names with digits, hyphens, dots after start', () => {
    expect(isName('a1')).toBe(true);
    expect(isName('a-b')).toBe(true);
    expect(isName('a.b')).toBe(true);
    expect(isName('a0.b-c')).toBe(true);
  });

  it('accepts Unicode letter start chars', () => {
    expect(isName('café')).toBe(true); // \u00E9 in \u00C0-\u00F6 range
    expect(isName('元素')).toBe(true); // \u5143 in \u3001-\uD7FF range
  });

  it('rejects names starting with a digit', () => {
    expect(isName('1foo')).toBe(false);
    expect(isName('0')).toBe(false);
  });

  it('rejects names starting with hyphen or dot', () => {
    expect(isName('-foo')).toBe(false);
    expect(isName('.foo')).toBe(false);
  });

  it('rejects names with illegal characters', () => {
    expect(isName('foo bar')).toBe(false);
    expect(isName('foo!')).toBe(false);
    expect(isName('foo@bar')).toBe(false);
    expect(isName("foo'bar")).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isName('')).toBe(false);
  });

  it('validates DOCTYPE entity names (Name production, not QName)', () => {
    expect(isName('myEntity')).toBe(true);
    expect(isName('my.entity-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isName() — XML 1.0 vs 1.1 version differences
// ---------------------------------------------------------------------------

describe('isName() — XML 1.0 vs 1.1 differences', () => {
  // \u0487 — Combining Cyrillic Millions Sign
  // Added in Unicode 4.0, after XML 1.0 was written against Unicode 2.0.
  // Falls inside the \u037F-\u1FFF range, but explicitly excluded from XML 1.0
  // by splitting the range into \u037F-\u0486 and \u0488-\u1FFF.
  // Valid NameChar (not NameStartChar) in XML 1.1.
  it('rejects \\u0487 as NameChar in XML 1.0', () => {
    expect(isName('foo\u0487', { xmlVersion: '1.0' })).toBe(false);
  });

  it('accepts \\u0487 as NameChar in XML 1.1', () => {
    expect(isName('foo\u0487', { xmlVersion: '1.1' })).toBe(true);
  });

  it('rejects \\u0487 as NameStartChar in both versions', () => {
    // \u0487 is a combining mark — never valid as first character
    expect(isName('\u0487foo', { xmlVersion: '1.0' })).toBe(false);
    expect(isName('\u0487foo', { xmlVersion: '1.1' })).toBe(false);
  });

  // Supplementary plane characters (\u{10000}-\u{EFFFF})
  // XML 1.0: BMP only, tops out at \uFFFD — supplementary chars are invalid.
  // XML 1.1: explicitly allows \u{10000}-\u{EFFFF} as NameStartChar.
  // Requires /u flag on RegExp to correctly match surrogate pairs.
  it('rejects supplementary plane char as NameStartChar in XML 1.0', () => {
    expect(isName('\u{10000}foo', { xmlVersion: '1.0' })).toBe(false);
    expect(isName('\u{1F600}foo', { xmlVersion: '1.0' })).toBe(false); // emoji U+1F600
  });

  it('accepts supplementary plane char as NameStartChar in XML 1.1', () => {
    expect(isName('\u{10000}foo', { xmlVersion: '1.1' })).toBe(true); // Linear B Syllable B008 A
    expect(isName('\u{1F600}foo', { xmlVersion: '1.1' })).toBe(true); // emoji U+1F600
  });

  // Lone surrogates are illegal XML characters and must be rejected even in 1.1.
  // The /u flag on RegExp ensures surrogate pairs are matched as a unit,
  // so individual surrogates cannot slip through.
  it('rejects lone high surrogate in XML 1.1', () => {
    expect(isName('\uD800foo', { xmlVersion: '1.1' })).toBe(false);
    expect(isName('\uDBFF foo', { xmlVersion: '1.1' })).toBe(false);
  });

  it('rejects lone low surrogate in XML 1.1', () => {
    expect(isName('\uDC00foo', { xmlVersion: '1.1' })).toBe(false);
    expect(isName('\uDFFFfoo', { xmlVersion: '1.1' })).toBe(false);
  });

  it('accepts common ASCII names in both versions', () => {
    expect(isName('fooBar', { xmlVersion: '1.0' })).toBe(true);
    expect(isName('fooBar', { xmlVersion: '1.1' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isNcName()
// ---------------------------------------------------------------------------

describe('isNcName()', () => {
  it('accepts simple names without colons', () => {
    expect(isNcName('foo')).toBe(true);
    expect(isNcName('_bar')).toBe(true);
    expect(isNcName('svg')).toBe(true);
    expect(isNcName('my-id')).toBe(true);
  });

  it('rejects any name containing a colon', () => {
    expect(isNcName('a:b')).toBe(false);
    expect(isNcName(':')).toBe(false);
    expect(isNcName('xlink:href')).toBe(false);
  });

  it('rejects invalid start characters', () => {
    expect(isNcName('1foo')).toBe(false);
    expect(isNcName('-foo')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isNcName('')).toBe(false);
  });

  it('validates SVG id attribute values', () => {
    expect(isNcName('my-icon')).toBe(true);
    expect(isNcName('icon_1')).toBe(true);
    expect(isNcName('ns:icon')).toBe(false); // colon not allowed in SVG id
  });
});

// ---------------------------------------------------------------------------
// isQName()
// ---------------------------------------------------------------------------

describe('isQName()', () => {
  it('accepts unprefixed names', () => {
    expect(isQName('foo')).toBe(true);
    expect(isQName('svg')).toBe(true);
  });

  it('accepts prefixed names with exactly one colon', () => {
    expect(isQName('svg:circle')).toBe(true);
    expect(isQName('xlink:href')).toBe(true);
    expect(isQName('xml:lang')).toBe(true);
  });

  it('rejects names with more than one colon', () => {
    expect(isQName('a:b:c')).toBe(false);
  });

  it('rejects names starting or ending with colon', () => {
    expect(isQName(':foo')).toBe(false);
    expect(isQName('foo:')).toBe(false);
    expect(isQName(':')).toBe(false);
  });

  it('rejects invalid start characters', () => {
    expect(isQName('1foo')).toBe(false);
    expect(isQName('-foo')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isQName('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNmToken()
// ---------------------------------------------------------------------------

describe('isNmToken()', () => {
  it('accepts names starting with any NameChar', () => {
    expect(isNmToken('foo')).toBe(true);
    expect(isNmToken('123')).toBe(true);
    expect(isNmToken('-bar')).toBe(true);
    expect(isNmToken('.baz')).toBe(true);
    expect(isNmToken('a:b')).toBe(true);
  });

  it('rejects strings with illegal characters', () => {
    expect(isNmToken('foo bar')).toBe(false);
    expect(isNmToken('foo!')).toBe(false);
    expect(isNmToken('@id')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isNmToken('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNmTokens()
// ---------------------------------------------------------------------------

describe('isNmTokens()', () => {
  it('accepts a single token', () => {
    expect(isNmTokens('foo')).toBe(true);
    expect(isNmTokens('123')).toBe(true);
  });

  it('accepts multiple whitespace-separated tokens', () => {
    expect(isNmTokens('foo bar')).toBe(true);
    expect(isNmTokens('token1 token2 -foo 123')).toBe(true);
  });

  it('rejects strings with illegal characters', () => {
    expect(isNmTokens('foo!')).toBe(false);
    expect(isNmTokens('foo @bar')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isNmTokens('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe('validate()', () => {
  it('returns { valid: true } for valid input', () => {
    expect(validate('foo', 'name')).toEqual({ valid: true, production: 'name', input: 'foo' });
    expect(validate('svg:circle', 'qName')).toEqual({ valid: true, production: 'qName', input: 'svg:circle' });
  });

  it('returns valid: false with reason for invalid start char', () => {
    const result = validate('1foo', 'ncName');
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).position).toBe(0);
    expect(diagnosticsOf(result).reason).toMatch(/NameStartChar/i);
  });

  it('reports colon in NCName', () => {
    const result = validate('foo:bar', 'ncName');
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/colon/i);
    expect(diagnosticsOf(result).position).toBe(3);
  });

  it('reports leading colon in QName', () => {
    const result = validate(':foo', 'qName');
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/cannot start/i);
    expect(diagnosticsOf(result).position).toBe(0);
  });

  it('reports trailing colon in QName', () => {
    const result = validate('foo:', 'qName');
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/cannot end/i);
    expect(diagnosticsOf(result).position).toBe(3);
  });

  it('reports multiple colons in QName', () => {
    const result = validate('a:b:c', 'qName');
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/at most one colon/i);
  });

  it('reports empty string', () => {
    const result = validate('', 'name');
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/empty/i);
  });

  it('narrows to reason and position on the invalid branch', () => {
    // The discriminated return type is the point of the port: no cast and no
    // optional chaining needed to read the diagnostics off a failed validation.
    const diagnostics = diagnosticsOf(validate('foo!bar', 'name'));
    expect(diagnostics.reason).toContain('NameChar');
    expect(diagnostics.position).toBe(3);
  });

  it('throws InvalidProduction for an unknown production', () => {
    // Unreachable from TypeScript, where `Production` is a closed union. It is
    // the guard for an untyped caller, and it throws rather than reporting
    // through an error channel.
    expect(() => validate('foo', 'unknown' as Production)).toThrow();
  });

  it('respects xmlVersion — \\u0487 valid only in 1.1', () => {
    expect(validate('foo\u0487', 'name', { xmlVersion: '1.0' }).valid).toBe(false);
    expect(validate('foo\u0487', 'name', { xmlVersion: '1.1' }).valid).toBe(true);
  });

  it('respects xmlVersion — supplementary plane valid only in 1.1', () => {
    expect(validate('\u{10000}foo', 'name', { xmlVersion: '1.0' }).valid).toBe(false);
    expect(validate('\u{10000}foo', 'name', { xmlVersion: '1.1' }).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateAll()
// ---------------------------------------------------------------------------

describe('validateAll()', () => {
  it('returns a result per input string', () => {
    const results = validateAll(['svg', 'circle', '123bad', 'xlink:href'], 'ncName');
    expect(results.length).toBe(4);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(true);
    expect(results[2].valid).toBe(false);
    expect(results[3].valid).toBe(false);
  });

  it('returns all valid for clean input', () => {
    const results = validateAll(['foo', 'bar', 'baz'], 'name');
    expect(results.every(r => r.valid)).toBe(true);
  });

  it('returns all invalid for bad input', () => {
    const results = validateAll(['1bad', '!bad', ''], 'qName');
    expect(results.every(r => !r.valid)).toBe(true);
  });

  it('throws InvalidProduction for an unknown production', () => {
    // Checked once up front rather than once per string, so an empty input
    // cannot silently succeed on an unknown production.
    expect(() => validateAll([], 'unknown' as Production)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// sanitize()
// ---------------------------------------------------------------------------

describe('sanitize()', () => {
  it('prefixes underscore when name starts with a digit', () => {
    expect(sanitize('123abc', 'ncName')).toBe('_123abc');
  });

  it('replaces spaces with underscore by default', () => {
    expect(sanitize('my element', 'name')).toBe('my_element');
  });

  it('removes colons for ncName production', () => {
    expect(sanitize('foo:bar', 'ncName')).toBe('foobar');
  });

  it('removes multiple colons for ncName production', () => {
    expect(sanitize('a:b:c', 'ncName')).toBe('abc');
  });

  it('replaces illegal characters', () => {
    expect(sanitize('foo!bar', 'name')).toBe('foo_bar');
    expect(sanitize('hello@world', 'name')).toBe('hello_world');
  });

  it('uses custom replacement character', () => {
    expect(sanitize('foo bar', 'name', { replacement: '-' })).toBe('foo-bar');
  });

  it('handles empty string', () => {
    expect(sanitize('', 'name')).toBe('_');
  });

  it('does not modify already valid names', () => {
    expect(sanitize('validName', 'name')).toBe('validName');
    expect(sanitize('svg:circle', 'qName')).toBe('svg:circle');
  });

  it('defaults to the Name production', () => {
    expect(sanitize('123abc')).toBe('_123abc');
  });

  it('does not prepend for nmToken (digit start is valid)', () => {
    expect(sanitize('123abc', 'nmToken')).toBe('123abc');
  });

  it('replaces non-ASCII characters when asciiOnly is true', () => {
    expect(sanitize('café', 'name', { asciiOnly: true })).toBe('caf_');
  });

  it('keeps non-ASCII characters when asciiOnly is false (default)', () => {
    expect(sanitize('café', 'name')).toBe('café');
  });
});

// ---------------------------------------------------------------------------
// asciiOnly option
// ---------------------------------------------------------------------------

describe('asciiOnly option', () => {
  it('is off by default — behaviour is unchanged when the option is omitted', () => {
    // Same assertions as the default-behaviour specs above, repeated here as
    // an explicit backward-compatibility regression check.
    expect(isName('café')).toBe(true);
    expect(isName('元素')).toBe(true);
    expect(isNcName('café')).toBe(true);
    expect(isQName('svg:café')).toBe(true);
  });

  it('accepts plain ASCII names identically to the default matcher', () => {
    const opts = { asciiOnly: true };
    expect(isName('foo', opts)).toBe(true);
    expect(isName('_bar', opts)).toBe(true);
    expect(isName('a1', opts)).toBe(true);
    expect(isName('a-b.c', opts)).toBe(true);
    expect(isName('a:b:c', opts)).toBe(true);
    expect(isNcName('my-id_1', opts)).toBe(true);
    expect(isQName('svg:circle', opts)).toBe(true);
    expect(isNmToken('123', opts)).toBe(true);
    expect(isNmTokens('tok1 tok2 -foo 123', opts)).toBe(true);
  });

  it('still rejects structurally invalid ASCII names', () => {
    const opts = { asciiOnly: true };
    expect(isName('1foo', opts)).toBe(false);
    expect(isName('-foo', opts)).toBe(false);
    expect(isName('foo bar', opts)).toBe(false);
    expect(isNcName('foo:bar', opts)).toBe(false);
    expect(isQName('a:b:c', opts)).toBe(false);
  });

  it('rejects non-ASCII names that are valid under the default matcher', () => {
    const opts = { asciiOnly: true };
    expect(isName('café', opts)).toBe(false); // \u00E9 accepted by default, not ASCII
    expect(isName('元素', opts)).toBe(false); // valid Han range char, not ASCII
    expect(isNcName('café', opts)).toBe(false);
    expect(isQName('svg:café', opts)).toBe(false);
  });

  it('works the same for xmlVersion 1.1 without needing the /u flag', () => {
    const opts11 = { xmlVersion: '1.1', asciiOnly: true } as const;
    expect(isName('foo-bar_1', opts11)).toBe(true);
    expect(isName('\u{10000}foo', opts11)).toBe(false); // supplementary plane, not ASCII
    // Sanity check: same input is valid under 1.1 when asciiOnly is off.
    expect(isName('\u{10000}foo', { xmlVersion: '1.1' })).toBe(true);
  });

  it('keeps validate() reason/position consistent with the ASCII-only result', () => {
    const result = validate('éfoo', 'name', { asciiOnly: true });
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toContain('NameStartChar');
    expect(diagnosticsOf(result).position).toBe(0);
  });

  it('flags a non-ASCII NameChar (not just NameStartChar) under asciiOnly', () => {
    const result = validate('fooé', 'name', { asciiOnly: true });
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toContain('NameChar');
    expect(diagnosticsOf(result).position).toBe(3);
  });

  it('is respected by validateAll via opts passthrough', () => {
    const results = validateAll(['foo', 'café'], 'name', { asciiOnly: true });
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createValidator()
// ---------------------------------------------------------------------------

describe('createValidator()', () => {
  it('throws InvalidProduction for an unknown production', () => {
    expect(() => createValidator('bogus' as Production)).toThrow();
  });

  it('returns a function that matches the uncached validator for the same production', () => {
    const memo = createValidator('name');
    const cases = ['foo', '1foo', 'a:b:c', '-bad', '', 'café', ':', 'a-b.c1'];
    for (const str of cases) {
      expect(memo(str)).toBe(isName(str));
    }
  });

  it('matches the uncached validator for qName', () => {
    const memo = createValidator('qName');
    const cases = ['svg:circle', 'foo', 'a:b:c', ':foo', 'foo:'];
    for (const str of cases) {
      expect(memo(str)).toBe(isQName(str));
    }
  });

  it('matches the uncached validator for ncName', () => {
    const isNc = createValidator('ncName');
    const cases = ['my-id', 'xlink:href', 'foo'];
    for (const str of cases) {
      expect(isNc(str)).toBe(isNcName(str));
    }
  });

  it('matches the uncached validator for nmToken and nmTokens', () => {
    const isTok = createValidator('nmToken');
    const isToks = createValidator('nmTokens');
    expect(isTok('123')).toBe(isNmToken('123'));
    expect(isTok('foo bar')).toBe(isNmToken('foo bar'));
    expect(isToks('tok1 tok2 -foo 123')).toBe(isNmTokens('tok1 tok2 -foo 123'));
  });

  it('respects xmlVersion fixed at creation time', () => {
    const is10 = createValidator('name', { xmlVersion: '1.0' });
    const is11 = createValidator('name', { xmlVersion: '1.1' });
    // Supplementary-plane char is only valid as a NameStartChar in XML 1.1
    const supplementaryChar = '\u{10000}';
    expect(is10(supplementaryChar)).toBe(false);
    expect(is11(supplementaryChar)).toBe(true);
  });

  it('respects asciiOnly fixed at creation time', () => {
    const isAscii = createValidator('name', { asciiOnly: true });
    const isUnicode = createValidator('name', { asciiOnly: false });
    expect(isAscii('café')).toBe(false);
    expect(isUnicode('café')).toBe(true);
  });

  it('returns the same boolean result on repeated calls (cache hit path)', () => {
    const memo = createValidator('qName');
    expect(memo('sku')).toBe(true);
    expect(memo('sku')).toBe(true);
    expect(memo('1bad')).toBe(false);
    expect(memo('1bad')).toBe(false);
  });

  it('stops caching new entries once maxCacheSize is reached, but keeps validating correctly', () => {
    const memo = createValidator('name', { maxCacheSize: 2 });
    expect(memo('a')).toBe(true);
    expect(memo('b')).toBe(true);
    // cache is now full (size 2) — further distinct inputs are still validated
    // correctly, just not cached
    expect(memo('c')).toBe(true);
    expect(memo('1bad')).toBe(false);
    expect(memo('d')).toBe(true);
    // previously cached entries still resolve correctly
    expect(memo('a')).toBe(true);
    expect(memo('b')).toBe(true);
  });

  it('exposes a reset() method that clears the cache without breaking correctness', () => {
    const memo = createValidator('name', { maxCacheSize: 1 });
    expect(memo('a')).toBe(true); // fills cache
    expect(memo('b')).toBe(true); // not cached (cache full)
    memo.reset();
    expect(memo('b')).toBe(true); // now cacheable again post-reset
    expect(memo('a')).toBe(true);
  });

  it('keeps caches independent across separate createValidator instances', () => {
    const v1 = createValidator('name', { maxCacheSize: 1 });
    const v2 = createValidator('name', { maxCacheSize: 1 });
    v1('x');
    v2('y');
    // Filling v1's single-entry cache with 'x' must not affect v2's ability
    // to validate/cache 'y', and vice versa — no shared state.
    expect(v1('x')).toBe(true);
    expect(v2('y')).toBe(true);
  });
});
