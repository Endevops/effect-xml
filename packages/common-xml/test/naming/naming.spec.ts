/**
 * @description Specs for `@endevops/common-xml`, covering all five productions, the XML 1.0 vs 1.1 differences, the `asciiOnly` fast path, and the diagnostic,
 * batch, sanitize and memoizing helpers. The two `as Production` casts are deliberate: they stand in for the untyped JavaScript caller the runtime
 * `TypeError` guard exists to catch, which is the only way to exercise that branch from a type-checked suite.
 */

import { describe, expect, it } from 'vite-plus/test';

import type { Production, ValidationResult } from '#/index.ts';

import { createValidator, name, ncName, nmToken, nmTokens, qName, sanitize, validate, validateAll } from '#/index.ts';

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
// name()
// ---------------------------------------------------------------------------

describe('name()', () => {
  it('accepts simple ASCII names', () => {
    expect(name('foo')).toBe(true);
    expect(name('Foo')).toBe(true);
    expect(name('_bar')).toBe(true);
    expect(name('_')).toBe(true);
  });

  it('accepts names with colons', () => {
    expect(name('a:b')).toBe(true);
    expect(name(':')).toBe(true); // colon alone is a valid Name
    expect(name('a:b:c')).toBe(true); // multiple colons allowed in Name
  });

  it('accepts names with digits, hyphens, dots after start', () => {
    expect(name('a1')).toBe(true);
    expect(name('a-b')).toBe(true);
    expect(name('a.b')).toBe(true);
    expect(name('a0.b-c')).toBe(true);
  });

  it('accepts Unicode letter start chars', () => {
    expect(name('café')).toBe(true); // \u00E9 in \u00C0-\u00F6 range
    expect(name('元素')).toBe(true); // \u5143 in \u3001-\uD7FF range
  });

  it('rejects names starting with a digit', () => {
    expect(name('1foo')).toBe(false);
    expect(name('0')).toBe(false);
  });

  it('rejects names starting with hyphen or dot', () => {
    expect(name('-foo')).toBe(false);
    expect(name('.foo')).toBe(false);
  });

  it('rejects names with illegal characters', () => {
    expect(name('foo bar')).toBe(false);
    expect(name('foo!')).toBe(false);
    expect(name('foo@bar')).toBe(false);
    expect(name("foo'bar")).toBe(false);
  });

  it('rejects empty string', () => {
    expect(name('')).toBe(false);
  });

  it('validates DOCTYPE entity names (Name production, not QName)', () => {
    expect(name('myEntity')).toBe(true);
    expect(name('my.entity-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// name() — XML 1.0 vs 1.1 version differences
// ---------------------------------------------------------------------------

describe('name() — XML 1.0 vs 1.1 differences', () => {
  // \u0487 — Combining Cyrillic Millions Sign
  // Added in Unicode 4.0, after XML 1.0 was written against Unicode 2.0.
  // Falls inside the \u037F-\u1FFF range, but explicitly excluded from XML 1.0
  // by splitting the range into \u037F-\u0486 and \u0488-\u1FFF.
  // Valid NameChar (not NameStartChar) in XML 1.1.
  it('rejects \\u0487 as NameChar in XML 1.0', () => {
    expect(name('foo\u0487', { xmlVersion: '1.0' })).toBe(false);
  });

  it('accepts \\u0487 as NameChar in XML 1.1', () => {
    expect(name('foo\u0487', { xmlVersion: '1.1' })).toBe(true);
  });

  it('rejects \\u0487 as NameStartChar in both versions', () => {
    // \u0487 is a combining mark — never valid as first character
    expect(name('\u0487foo', { xmlVersion: '1.0' })).toBe(false);
    expect(name('\u0487foo', { xmlVersion: '1.1' })).toBe(false);
  });

  // Supplementary plane characters (\u{10000}-\u{EFFFF})
  // XML 1.0: BMP only, tops out at \uFFFD — supplementary chars are invalid.
  // XML 1.1: explicitly allows \u{10000}-\u{EFFFF} as NameStartChar.
  // Requires /u flag on RegExp to correctly match surrogate pairs.
  it('rejects supplementary plane char as NameStartChar in XML 1.0', () => {
    expect(name('\u{10000}foo', { xmlVersion: '1.0' })).toBe(false);
    expect(name('\u{1F600}foo', { xmlVersion: '1.0' })).toBe(false); // emoji U+1F600
  });

  it('accepts supplementary plane char as NameStartChar in XML 1.1', () => {
    expect(name('\u{10000}foo', { xmlVersion: '1.1' })).toBe(true); // Linear B Syllable B008 A
    expect(name('\u{1F600}foo', { xmlVersion: '1.1' })).toBe(true); // emoji U+1F600
  });

  // Lone surrogates are illegal XML characters and must be rejected even in 1.1.
  // The /u flag on RegExp ensures surrogate pairs are matched as a unit,
  // so individual surrogates cannot slip through.
  it('rejects lone high surrogate in XML 1.1', () => {
    expect(name('\uD800foo', { xmlVersion: '1.1' })).toBe(false);
    expect(name('\uDBFF foo', { xmlVersion: '1.1' })).toBe(false);
  });

  it('rejects lone low surrogate in XML 1.1', () => {
    expect(name('\uDC00foo', { xmlVersion: '1.1' })).toBe(false);
    expect(name('\uDFFFfoo', { xmlVersion: '1.1' })).toBe(false);
  });

  it('accepts common ASCII names in both versions', () => {
    expect(name('fooBar', { xmlVersion: '1.0' })).toBe(true);
    expect(name('fooBar', { xmlVersion: '1.1' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ncName()
// ---------------------------------------------------------------------------

describe('ncName()', () => {
  it('accepts simple names without colons', () => {
    expect(ncName('foo')).toBe(true);
    expect(ncName('_bar')).toBe(true);
    expect(ncName('svg')).toBe(true);
    expect(ncName('my-id')).toBe(true);
  });

  it('rejects any name containing a colon', () => {
    expect(ncName('a:b')).toBe(false);
    expect(ncName(':')).toBe(false);
    expect(ncName('xlink:href')).toBe(false);
  });

  it('rejects invalid start characters', () => {
    expect(ncName('1foo')).toBe(false);
    expect(ncName('-foo')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(ncName('')).toBe(false);
  });

  it('validates SVG id attribute values', () => {
    expect(ncName('my-icon')).toBe(true);
    expect(ncName('icon_1')).toBe(true);
    expect(ncName('ns:icon')).toBe(false); // colon not allowed in SVG id
  });
});

// ---------------------------------------------------------------------------
// qName()
// ---------------------------------------------------------------------------

describe('qName()', () => {
  it('accepts unprefixed names', () => {
    expect(qName('foo')).toBe(true);
    expect(qName('svg')).toBe(true);
  });

  it('accepts prefixed names with exactly one colon', () => {
    expect(qName('svg:circle')).toBe(true);
    expect(qName('xlink:href')).toBe(true);
    expect(qName('xml:lang')).toBe(true);
  });

  it('rejects names with more than one colon', () => {
    expect(qName('a:b:c')).toBe(false);
  });

  it('rejects names starting or ending with colon', () => {
    expect(qName(':foo')).toBe(false);
    expect(qName('foo:')).toBe(false);
    expect(qName(':')).toBe(false);
  });

  it('rejects invalid start characters', () => {
    expect(qName('1foo')).toBe(false);
    expect(qName('-foo')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(qName('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nmToken()
// ---------------------------------------------------------------------------

describe('nmToken()', () => {
  it('accepts names starting with any NameChar', () => {
    expect(nmToken('foo')).toBe(true);
    expect(nmToken('123')).toBe(true);
    expect(nmToken('-bar')).toBe(true);
    expect(nmToken('.baz')).toBe(true);
    expect(nmToken('a:b')).toBe(true);
  });

  it('rejects strings with illegal characters', () => {
    expect(nmToken('foo bar')).toBe(false);
    expect(nmToken('foo!')).toBe(false);
    expect(nmToken('@id')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(nmToken('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nmTokens()
// ---------------------------------------------------------------------------

describe('nmTokens()', () => {
  it('accepts a single token', () => {
    expect(nmTokens('foo')).toBe(true);
    expect(nmTokens('123')).toBe(true);
  });

  it('accepts multiple whitespace-separated tokens', () => {
    expect(nmTokens('foo bar')).toBe(true);
    expect(nmTokens('token1 token2 -foo 123')).toBe(true);
  });

  it('rejects strings with illegal characters', () => {
    expect(nmTokens('foo!')).toBe(false);
    expect(nmTokens('foo @bar')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(nmTokens('')).toBe(false);
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

  it('throws TypeError for unknown production', () => {
    expect(() => validate('foo', 'unknown' as Production)).toThrowError(TypeError);
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
    expect(name('café')).toBe(true);
    expect(name('元素')).toBe(true);
    expect(ncName('café')).toBe(true);
    expect(qName('svg:café')).toBe(true);
  });

  it('accepts plain ASCII names identically to the default matcher', () => {
    const opts = { asciiOnly: true };
    expect(name('foo', opts)).toBe(true);
    expect(name('_bar', opts)).toBe(true);
    expect(name('a1', opts)).toBe(true);
    expect(name('a-b.c', opts)).toBe(true);
    expect(name('a:b:c', opts)).toBe(true);
    expect(ncName('my-id_1', opts)).toBe(true);
    expect(qName('svg:circle', opts)).toBe(true);
    expect(nmToken('123', opts)).toBe(true);
    expect(nmTokens('tok1 tok2 -foo 123', opts)).toBe(true);
  });

  it('still rejects structurally invalid ASCII names', () => {
    const opts = { asciiOnly: true };
    expect(name('1foo', opts)).toBe(false);
    expect(name('-foo', opts)).toBe(false);
    expect(name('foo bar', opts)).toBe(false);
    expect(ncName('foo:bar', opts)).toBe(false);
    expect(qName('a:b:c', opts)).toBe(false);
  });

  it('rejects non-ASCII names that are valid under the default matcher', () => {
    const opts = { asciiOnly: true };
    expect(name('café', opts)).toBe(false); // \u00E9 accepted by default, not ASCII
    expect(name('元素', opts)).toBe(false); // valid Han range char, not ASCII
    expect(ncName('café', opts)).toBe(false);
    expect(qName('svg:café', opts)).toBe(false);
  });

  it('works the same for xmlVersion 1.1 without needing the /u flag', () => {
    const opts11 = { xmlVersion: '1.1', asciiOnly: true } as const;
    expect(name('foo-bar_1', opts11)).toBe(true);
    expect(name('\u{10000}foo', opts11)).toBe(false); // supplementary plane, not ASCII
    // Sanity check: same input is valid under 1.1 when asciiOnly is off.
    expect(name('\u{10000}foo', { xmlVersion: '1.1' })).toBe(true);
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
  it('throws on unknown production', () => {
    expect(() => createValidator('bogus' as Production)).toThrowError(TypeError);
  });

  it('returns a function that matches the uncached validator for the same production', () => {
    const isName = createValidator('name');
    const cases = ['foo', '1foo', 'a:b:c', '-bad', '', 'café', ':', 'a-b.c1'];
    for (const str of cases) {
      expect(isName(str)).toBe(name(str));
    }
  });

  it('matches the uncached validator for qName', () => {
    const isQName = createValidator('qName');
    const cases = ['svg:circle', 'foo', 'a:b:c', ':foo', 'foo:'];
    for (const str of cases) {
      expect(isQName(str)).toBe(qName(str));
    }
  });

  it('matches the uncached validator for ncName', () => {
    const isNc = createValidator('ncName');
    const cases = ['my-id', 'xlink:href', 'foo'];
    for (const str of cases) {
      expect(isNc(str)).toBe(ncName(str));
    }
  });

  it('matches the uncached validator for nmToken and nmTokens', () => {
    const isTok = createValidator('nmToken');
    const isToks = createValidator('nmTokens');
    expect(isTok('123')).toBe(nmToken('123'));
    expect(isTok('foo bar')).toBe(nmToken('foo bar'));
    expect(isToks('tok1 tok2 -foo 123')).toBe(nmTokens('tok1 tok2 -foo 123'));
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
    const isQName = createValidator('qName');
    expect(isQName('sku')).toBe(true);
    expect(isQName('sku')).toBe(true);
    expect(isQName('1bad')).toBe(false);
    expect(isQName('1bad')).toBe(false);
  });

  it('stops caching new entries once maxCacheSize is reached, but keeps validating correctly', () => {
    const isName = createValidator('name', { maxCacheSize: 2 });
    expect(isName('a')).toBe(true);
    expect(isName('b')).toBe(true);
    // cache is now full (size 2) — further distinct inputs are still validated
    // correctly, just not cached
    expect(isName('c')).toBe(true);
    expect(isName('1bad')).toBe(false);
    expect(isName('d')).toBe(true);
    // previously cached entries still resolve correctly
    expect(isName('a')).toBe(true);
    expect(isName('b')).toBe(true);
  });

  it('exposes a reset() method that clears the cache without breaking correctness', () => {
    const isName = createValidator('name', { maxCacheSize: 1 });
    expect(isName('a')).toBe(true); // fills cache
    expect(isName('b')).toBe(true); // not cached (cache full)
    isName.reset();
    expect(isName('b')).toBe(true); // now cacheable again post-reset
    expect(isName('a')).toBe(true);
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
