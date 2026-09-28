/**
 * @description Specs for `@endevops/common-xml`, covering all five productions, the XML 1.0 vs 1.1 differences, the `asciiOnly` fast path, and the diagnostic,
 * batch, sanitize and memoizing helpers. The two `as Production` casts are deliberate: they stand in for the untyped JavaScript caller the runtime
 * `TypeError` guard exists to catch, which is the only way to exercise that branch from a type-checked suite.
 */

import { describe, expect, it } from 'vite-plus/test';

import type { Production, ValidationResult } from '#/index.ts';

import { createValidator, name, ncName, nmToken, nmTokens, qName, sanitize, validate, validateAll } from '#/index.ts';
import { run, failedWith } from '#/test/helpers/effect.ts';

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
    expect(run(name('foo'))).toBe(true);
    expect(run(name('Foo'))).toBe(true);
    expect(run(name('_bar'))).toBe(true);
    expect(run(name('_'))).toBe(true);
  });

  it('accepts names with colons', () => {
    expect(run(name('a:b'))).toBe(true);
    expect(run(name(':'))).toBe(true); // colon alone is a valid Name
    expect(run(name('a:b:c'))).toBe(true); // multiple colons allowed in Name
  });

  it('accepts names with digits, hyphens, dots after start', () => {
    expect(run(name('a1'))).toBe(true);
    expect(run(name('a-b'))).toBe(true);
    expect(run(name('a.b'))).toBe(true);
    expect(run(name('a0.b-c'))).toBe(true);
  });

  it('accepts Unicode letter start chars', () => {
    expect(run(name('café'))).toBe(true); // \u00E9 in \u00C0-\u00F6 range
    expect(run(name('元素'))).toBe(true); // \u5143 in \u3001-\uD7FF range
  });

  it('rejects names starting with a digit', () => {
    expect(run(name('1foo'))).toBe(false);
    expect(run(name('0'))).toBe(false);
  });

  it('rejects names starting with hyphen or dot', () => {
    expect(run(name('-foo'))).toBe(false);
    expect(run(name('.foo'))).toBe(false);
  });

  it('rejects names with illegal characters', () => {
    expect(run(name('foo bar'))).toBe(false);
    expect(run(name('foo!'))).toBe(false);
    expect(run(name('foo@bar'))).toBe(false);
    expect(run(name("foo'bar"))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(run(name(''))).toBe(false);
  });

  it('validates DOCTYPE entity names (Name production, not QName)', () => {
    expect(run(name('myEntity'))).toBe(true);
    expect(run(name('my.entity-1'))).toBe(true);
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
    expect(run(name('foo\u0487', { xmlVersion: '1.0' }))).toBe(false);
  });

  it('accepts \\u0487 as NameChar in XML 1.1', () => {
    expect(run(name('foo\u0487', { xmlVersion: '1.1' }))).toBe(true);
  });

  it('rejects \\u0487 as NameStartChar in both versions', () => {
    // \u0487 is a combining mark — never valid as first character
    expect(run(name('\u0487foo', { xmlVersion: '1.0' }))).toBe(false);
    expect(run(name('\u0487foo', { xmlVersion: '1.1' }))).toBe(false);
  });

  // Supplementary plane characters (\u{10000}-\u{EFFFF})
  // XML 1.0: BMP only, tops out at \uFFFD — supplementary chars are invalid.
  // XML 1.1: explicitly allows \u{10000}-\u{EFFFF} as NameStartChar.
  // Requires /u flag on RegExp to correctly match surrogate pairs.
  it('rejects supplementary plane char as NameStartChar in XML 1.0', () => {
    expect(run(name('\u{10000}foo', { xmlVersion: '1.0' }))).toBe(false);
    expect(run(name('\u{1F600}foo', { xmlVersion: '1.0' }))).toBe(false); // emoji U+1F600
  });

  it('accepts supplementary plane char as NameStartChar in XML 1.1', () => {
    expect(run(name('\u{10000}foo', { xmlVersion: '1.1' }))).toBe(true); // Linear B Syllable B008 A
    expect(run(name('\u{1F600}foo', { xmlVersion: '1.1' }))).toBe(true); // emoji U+1F600
  });

  // Lone surrogates are illegal XML characters and must be rejected even in 1.1.
  // The /u flag on RegExp ensures surrogate pairs are matched as a unit,
  // so individual surrogates cannot slip through.
  it('rejects lone high surrogate in XML 1.1', () => {
    expect(run(name('\uD800foo', { xmlVersion: '1.1' }))).toBe(false);
    expect(run(name('\uDBFF foo', { xmlVersion: '1.1' }))).toBe(false);
  });

  it('rejects lone low surrogate in XML 1.1', () => {
    expect(run(name('\uDC00foo', { xmlVersion: '1.1' }))).toBe(false);
    expect(run(name('\uDFFFfoo', { xmlVersion: '1.1' }))).toBe(false);
  });

  it('accepts common ASCII names in both versions', () => {
    expect(run(name('fooBar', { xmlVersion: '1.0' }))).toBe(true);
    expect(run(name('fooBar', { xmlVersion: '1.1' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ncName()
// ---------------------------------------------------------------------------

describe('ncName()', () => {
  it('accepts simple names without colons', () => {
    expect(run(ncName('foo'))).toBe(true);
    expect(run(ncName('_bar'))).toBe(true);
    expect(run(ncName('svg'))).toBe(true);
    expect(run(ncName('my-id'))).toBe(true);
  });

  it('rejects any name containing a colon', () => {
    expect(run(ncName('a:b'))).toBe(false);
    expect(run(ncName(':'))).toBe(false);
    expect(run(ncName('xlink:href'))).toBe(false);
  });

  it('rejects invalid start characters', () => {
    expect(run(ncName('1foo'))).toBe(false);
    expect(run(ncName('-foo'))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(run(ncName(''))).toBe(false);
  });

  it('validates SVG id attribute values', () => {
    expect(run(ncName('my-icon'))).toBe(true);
    expect(run(ncName('icon_1'))).toBe(true);
    expect(run(ncName('ns:icon'))).toBe(false); // colon not allowed in SVG id
  });
});

// ---------------------------------------------------------------------------
// qName()
// ---------------------------------------------------------------------------

describe('qName()', () => {
  it('accepts unprefixed names', () => {
    expect(run(qName('foo'))).toBe(true);
    expect(run(qName('svg'))).toBe(true);
  });

  it('accepts prefixed names with exactly one colon', () => {
    expect(run(qName('svg:circle'))).toBe(true);
    expect(run(qName('xlink:href'))).toBe(true);
    expect(run(qName('xml:lang'))).toBe(true);
  });

  it('rejects names with more than one colon', () => {
    expect(run(qName('a:b:c'))).toBe(false);
  });

  it('rejects names starting or ending with colon', () => {
    expect(run(qName(':foo'))).toBe(false);
    expect(run(qName('foo:'))).toBe(false);
    expect(run(qName(':'))).toBe(false);
  });

  it('rejects invalid start characters', () => {
    expect(run(qName('1foo'))).toBe(false);
    expect(run(qName('-foo'))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(run(qName(''))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nmToken()
// ---------------------------------------------------------------------------

describe('nmToken()', () => {
  it('accepts names starting with any NameChar', () => {
    expect(run(nmToken('foo'))).toBe(true);
    expect(run(nmToken('123'))).toBe(true);
    expect(run(nmToken('-bar'))).toBe(true);
    expect(run(nmToken('.baz'))).toBe(true);
    expect(run(nmToken('a:b'))).toBe(true);
  });

  it('rejects strings with illegal characters', () => {
    expect(run(nmToken('foo bar'))).toBe(false);
    expect(run(nmToken('foo!'))).toBe(false);
    expect(run(nmToken('@id'))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(run(nmToken(''))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nmTokens()
// ---------------------------------------------------------------------------

describe('nmTokens()', () => {
  it('accepts a single token', () => {
    expect(run(nmTokens('foo'))).toBe(true);
    expect(run(nmTokens('123'))).toBe(true);
  });

  it('accepts multiple whitespace-separated tokens', () => {
    expect(run(nmTokens('foo bar'))).toBe(true);
    expect(run(nmTokens('token1 token2 -foo 123'))).toBe(true);
  });

  it('rejects strings with illegal characters', () => {
    expect(run(nmTokens('foo!'))).toBe(false);
    expect(run(nmTokens('foo @bar'))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(run(nmTokens(''))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe('validate()', () => {
  it('returns { valid: true } for valid input', () => {
    expect(run(validate('foo', 'name'))).toEqual({ valid: true, production: 'name', input: 'foo' });
    expect(run(validate('svg:circle', 'qName'))).toEqual({ valid: true, production: 'qName', input: 'svg:circle' });
  });

  it('returns valid: false with reason for invalid start char', () => {
    const result = run(validate('1foo', 'ncName'));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).position).toBe(0);
    expect(diagnosticsOf(result).reason).toMatch(/NameStartChar/i);
  });

  it('reports colon in NCName', () => {
    const result = run(validate('foo:bar', 'ncName'));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/colon/i);
    expect(diagnosticsOf(result).position).toBe(3);
  });

  it('reports leading colon in QName', () => {
    const result = run(validate(':foo', 'qName'));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/cannot start/i);
    expect(diagnosticsOf(result).position).toBe(0);
  });

  it('reports trailing colon in QName', () => {
    const result = run(validate('foo:', 'qName'));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/cannot end/i);
    expect(diagnosticsOf(result).position).toBe(3);
  });

  it('reports multiple colons in QName', () => {
    const result = run(validate('a:b:c', 'qName'));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/at most one colon/i);
  });

  it('reports empty string', () => {
    const result = run(validate('', 'name'));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toMatch(/empty/i);
  });

  it('narrows to reason and position on the invalid branch', () => {
    // The discriminated return type is the point of the port: no cast and no
    // optional chaining needed to read the diagnostics off a failed validation.
    const diagnostics = diagnosticsOf(run(validate('foo!bar', 'name')));
    expect(diagnostics.reason).toContain('NameChar');
    expect(diagnostics.position).toBe(3);
  });

  it('fails with InvalidProduction for unknown production', () => {
    // Unreachable from TypeScript, where `Production` is a closed union. It is
    // the guard for an untyped caller, and it reports through the error channel
    // rather than by throwing.
    failedWith(validate('foo', 'unknown' as Production), 'InvalidProduction');
  });

  it('respects xmlVersion — \\u0487 valid only in 1.1', () => {
    expect(run(validate('foo\u0487', 'name', { xmlVersion: '1.0' })).valid).toBe(false);
    expect(run(validate('foo\u0487', 'name', { xmlVersion: '1.1' })).valid).toBe(true);
  });

  it('respects xmlVersion — supplementary plane valid only in 1.1', () => {
    expect(run(validate('\u{10000}foo', 'name', { xmlVersion: '1.0' })).valid).toBe(false);
    expect(run(validate('\u{10000}foo', 'name', { xmlVersion: '1.1' })).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateAll()
// ---------------------------------------------------------------------------

describe('validateAll()', () => {
  it('returns a result per input string', () => {
    const results = run(validateAll(['svg', 'circle', '123bad', 'xlink:href'], 'ncName'));
    expect(results.length).toBe(4);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(true);
    expect(results[2].valid).toBe(false);
    expect(results[3].valid).toBe(false);
  });

  it('returns all valid for clean input', () => {
    const results = run(validateAll(['foo', 'bar', 'baz'], 'name'));
    expect(results.every(r => r.valid)).toBe(true);
  });

  it('returns all invalid for bad input', () => {
    const results = run(validateAll(['1bad', '!bad', ''], 'qName'));
    expect(results.every(r => !r.valid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitize()
// ---------------------------------------------------------------------------

describe('sanitize()', () => {
  it('prefixes underscore when name starts with a digit', () => {
    expect(run(sanitize('123abc', 'ncName'))).toBe('_123abc');
  });

  it('replaces spaces with underscore by default', () => {
    expect(run(sanitize('my element', 'name'))).toBe('my_element');
  });

  it('removes colons for ncName production', () => {
    expect(run(sanitize('foo:bar', 'ncName'))).toBe('foobar');
  });

  it('removes multiple colons for ncName production', () => {
    expect(run(sanitize('a:b:c', 'ncName'))).toBe('abc');
  });

  it('replaces illegal characters', () => {
    expect(run(sanitize('foo!bar', 'name'))).toBe('foo_bar');
    expect(run(sanitize('hello@world', 'name'))).toBe('hello_world');
  });

  it('uses custom replacement character', () => {
    expect(run(sanitize('foo bar', 'name', { replacement: '-' }))).toBe('foo-bar');
  });

  it('handles empty string', () => {
    expect(run(sanitize('', 'name'))).toBe('_');
  });

  it('does not modify already valid names', () => {
    expect(run(sanitize('validName', 'name'))).toBe('validName');
    expect(run(sanitize('svg:circle', 'qName'))).toBe('svg:circle');
  });

  it('defaults to the Name production', () => {
    expect(run(sanitize('123abc'))).toBe('_123abc');
  });

  it('does not prepend for nmToken (digit start is valid)', () => {
    expect(run(sanitize('123abc', 'nmToken'))).toBe('123abc');
  });

  it('replaces non-ASCII characters when asciiOnly is true', () => {
    expect(run(sanitize('café', 'name', { asciiOnly: true }))).toBe('caf_');
  });

  it('keeps non-ASCII characters when asciiOnly is false (default)', () => {
    expect(run(sanitize('café', 'name'))).toBe('café');
  });
});

// ---------------------------------------------------------------------------
// asciiOnly option
// ---------------------------------------------------------------------------

describe('asciiOnly option', () => {
  it('is off by default — behaviour is unchanged when the option is omitted', () => {
    // Same assertions as the default-behaviour specs above, repeated here as
    // an explicit backward-compatibility regression check.
    expect(run(name('café'))).toBe(true);
    expect(run(name('元素'))).toBe(true);
    expect(run(ncName('café'))).toBe(true);
    expect(run(qName('svg:café'))).toBe(true);
  });

  it('accepts plain ASCII names identically to the default matcher', () => {
    const opts = { asciiOnly: true };
    expect(run(name('foo', opts))).toBe(true);
    expect(run(name('_bar', opts))).toBe(true);
    expect(run(name('a1', opts))).toBe(true);
    expect(run(name('a-b.c', opts))).toBe(true);
    expect(run(name('a:b:c', opts))).toBe(true);
    expect(run(ncName('my-id_1', opts))).toBe(true);
    expect(run(qName('svg:circle', opts))).toBe(true);
    expect(run(nmToken('123', opts))).toBe(true);
    expect(run(nmTokens('tok1 tok2 -foo 123', opts))).toBe(true);
  });

  it('still rejects structurally invalid ASCII names', () => {
    const opts = { asciiOnly: true };
    expect(run(name('1foo', opts))).toBe(false);
    expect(run(name('-foo', opts))).toBe(false);
    expect(run(name('foo bar', opts))).toBe(false);
    expect(run(ncName('foo:bar', opts))).toBe(false);
    expect(run(qName('a:b:c', opts))).toBe(false);
  });

  it('rejects non-ASCII names that are valid under the default matcher', () => {
    const opts = { asciiOnly: true };
    expect(run(name('café', opts))).toBe(false); // \u00E9 accepted by default, not ASCII
    expect(run(name('元素', opts))).toBe(false); // valid Han range char, not ASCII
    expect(run(ncName('café', opts))).toBe(false);
    expect(run(qName('svg:café', opts))).toBe(false);
  });

  it('works the same for xmlVersion 1.1 without needing the /u flag', () => {
    const opts11 = { xmlVersion: '1.1', asciiOnly: true } as const;
    expect(run(name('foo-bar_1', opts11))).toBe(true);
    expect(run(name('\u{10000}foo', opts11))).toBe(false); // supplementary plane, not ASCII
    // Sanity check: same input is valid under 1.1 when asciiOnly is off.
    expect(run(name('\u{10000}foo', { xmlVersion: '1.1' }))).toBe(true);
  });

  it('keeps validate() reason/position consistent with the ASCII-only result', () => {
    const result = run(validate('éfoo', 'name', { asciiOnly: true }));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toContain('NameStartChar');
    expect(diagnosticsOf(result).position).toBe(0);
  });

  it('flags a non-ASCII NameChar (not just NameStartChar) under asciiOnly', () => {
    const result = run(validate('fooé', 'name', { asciiOnly: true }));
    expect(result.valid).toBe(false);
    expect(diagnosticsOf(result).reason).toContain('NameChar');
    expect(diagnosticsOf(result).position).toBe(3);
  });

  it('is respected by validateAll via opts passthrough', () => {
    const results = run(validateAll(['foo', 'café'], 'name', { asciiOnly: true }));
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createValidator()
// ---------------------------------------------------------------------------

describe('createValidator()', () => {
  it('fails with InvalidProduction for unknown production', () => {
    failedWith(createValidator('bogus' as Production), 'InvalidProduction');
  });

  it('returns a function that matches the uncached validator for the same production', () => {
    const isName = run(createValidator('name'));
    const cases = ['foo', '1foo', 'a:b:c', '-bad', '', 'café', ':', 'a-b.c1'];
    for (const str of cases) {
      expect(run(isName(str))).toBe(run(name(str)));
    }
  });

  it('matches the uncached validator for qName', () => {
    const isQName = run(createValidator('qName'));
    const cases = ['svg:circle', 'foo', 'a:b:c', ':foo', 'foo:'];
    for (const str of cases) {
      expect(run(isQName(str))).toBe(run(qName(str)));
    }
  });

  it('matches the uncached validator for ncName', () => {
    const isNc = run(createValidator('ncName'));
    const cases = ['my-id', 'xlink:href', 'foo'];
    for (const str of cases) {
      expect(run(isNc(str))).toBe(run(ncName(str)));
    }
  });

  it('matches the uncached validator for nmToken and nmTokens', () => {
    const isTok = run(createValidator('nmToken'));
    const isToks = run(createValidator('nmTokens'));
    expect(run(isTok('123'))).toBe(run(nmToken('123')));
    expect(run(isTok('foo bar'))).toBe(run(nmToken('foo bar')));
    expect(run(isToks('tok1 tok2 -foo 123'))).toBe(run(nmTokens('tok1 tok2 -foo 123')));
  });

  it('respects xmlVersion fixed at creation time', () => {
    const is10 = run(createValidator('name', { xmlVersion: '1.0' }));
    const is11 = run(createValidator('name', { xmlVersion: '1.1' }));
    // Supplementary-plane char is only valid as a NameStartChar in XML 1.1
    const supplementaryChar = '\u{10000}';
    expect(run(is10(supplementaryChar))).toBe(false);
    expect(run(is11(supplementaryChar))).toBe(true);
  });

  it('respects asciiOnly fixed at creation time', () => {
    const isAscii = run(createValidator('name', { asciiOnly: true }));
    const isUnicode = run(createValidator('name', { asciiOnly: false }));
    expect(run(isAscii('café'))).toBe(false);
    expect(run(isUnicode('café'))).toBe(true);
  });

  it('returns the same boolean result on repeated calls (cache hit path)', () => {
    const isQName = run(createValidator('qName'));
    expect(run(isQName('sku'))).toBe(true);
    expect(run(isQName('sku'))).toBe(true);
    expect(run(isQName('1bad'))).toBe(false);
    expect(run(isQName('1bad'))).toBe(false);
  });

  it('stops caching new entries once maxCacheSize is reached, but keeps validating correctly', () => {
    const isName = run(createValidator('name', { maxCacheSize: 2 }));
    expect(run(isName('a'))).toBe(true);
    expect(run(isName('b'))).toBe(true);
    // cache is now full (size 2) — further distinct inputs are still validated
    // correctly, just not cached
    expect(run(isName('c'))).toBe(true);
    expect(run(isName('1bad'))).toBe(false);
    expect(run(isName('d'))).toBe(true);
    // previously cached entries still resolve correctly
    expect(run(isName('a'))).toBe(true);
    expect(run(isName('b'))).toBe(true);
  });

  it('exposes a reset() method that clears the cache without breaking correctness', () => {
    const isName = run(createValidator('name', { maxCacheSize: 1 }));
    expect(run(isName('a'))).toBe(true); // fills cache
    expect(run(isName('b'))).toBe(true); // not cached (cache full)
    run(isName.reset());
    expect(run(isName('b'))).toBe(true); // now cacheable again post-reset
    expect(run(isName('a'))).toBe(true);
  });

  it('keeps caches independent across separate createValidator instances', () => {
    const v1 = run(createValidator('name', { maxCacheSize: 1 }));
    const v2 = run(createValidator('name', { maxCacheSize: 1 }));
    run(v1('x'));
    run(v2('y'));
    // Filling v1's single-entry cache with 'x' must not affect v2's ability
    // to validate/cache 'y', and vice versa — no shared state.
    expect(run(v1('x'))).toBe(true);
    expect(run(v2('y'))).toBe(true);
  });
});
