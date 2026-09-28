/**
 * @description Specs for the entity decoder — the half of this package that is a parser rather than a table lookup, and therefore the half whose behaviour a
 * caller can actually depend on getting exactly right. The specs are in two layers, and the split is the point. Everything that works is asserted as
 * a contract, because those assertions are what would catch a regression in a change someone meant to make. Everything that does not work is asserted
 * too, and asserted as _preserved upstream behaviour_ — pinned rather than endorsed. This is a port of `@nodable/entities@2.2.0`, verified against
 * the original over 236,252 differential assertions with zero differences, and a surprising number of its quirks are load-bearing: a caller who
 * registered `&amp;` as `a&b` already gets `a&b` back, a caller who relies on `postCheck` to sanitise already knows it never saw a string without an
 * ampersand, and a caller counting the `[EntityReplacer]` prefix in an error already matches on a class name this package does not have. So each
 * preserved quirk gets its own `describe` whose name says "preserved upstream quirk" and says what the quirk _is_, and each `it` inside names the
 * observable rather than the mechanism. A future change that repairs one of these will fail a test whose name explains what it was costing, which is
 * the only review that behaviour change deserves. That is the whole reason these specs exist; the differential harness is gone, and this is what it
 * left behind. The working half is asserted the way a contract is: the five XML entities, decimal and hex references, the numeric policy, the four
 * forms of `applyLimitsTo`, all three hook actions, and what `reset` does and does not clear.
 */

import { describe, expect, it } from 'vite-plus/test';

import type { ApplyLimitsTo, EntityDecoderOptions } from '#/index.ts';

import { EntityDecoder, ENTITY_ACTION } from '#/index.ts';

/**
 * @description A `postCheck` hook wrapped so a spec can see what it was called with and how often.
 */
interface PostCheckSpy {
  /**
   * @description The `original` argument of every call, in call order. An empty array after a `decode` means the hook never ran, which is a different fact from
   * "it ran and found nothing to do".
   */
  readonly seen: string[];
  /**
   * @description The hook itself, ready to hand to the constructor.
   */
  readonly postCheck: (resolved: string, original: string) => string;
}

/**
 * @description Build a `postCheck` that records every call and passes the resolved string through unchanged, so the number of calls is the only thing the spy
 * observes.
 *
 * @returns The spy.
 */
const spyPostCheck = (): PostCheckSpy => {
  const seen: string[] = [];
  return {
    seen,
    postCheck: (resolved, original) => {
      seen.push(original);
      return resolved;
    },
  };
};

/**
 * @description Build a `postCheck` that records every call and hands back the _original_ string, which is how a caller refuses an expansion outright.
 *
 * @returns The spy.
 */
const rejectingPostCheck = (): PostCheckSpy => {
  const seen: string[] = [];
  return {
    seen,
    postCheck: (_resolved, original) => {
      seen.push(original);
      return original;
    },
  };
};

/**
 * @description Hand `decode` a value its `string` signature forbids, which is the only way untyped caller code reaches the guard at the top of the method.
 *
 * @param decoder - The decoder to call.
 * @param value - The value to pass in, whatever its type.
 *
 * @returns Whatever `decode` returns for it.
 */
const decodeValue = (decoder: EntityDecoder, value: unknown): unknown => decoder.decode(value as string);

/**
 * @description Tell a decoder about an XML version its `number` signature forbids, so the normalisation is observable from untyped code.
 *
 * @param decoder - The decoder to configure.
 * @param version - The version to hand it.
 */
const setXmlVersionWith = (decoder: EntityDecoder, version: unknown): void => {
  decoder.setXmlVersion(version as number);
};

/**
 * @description The codepoints of a string as four-digit uppercase hex, so an assertion about a character reads the way the XML specification writes it. The step
 * over a low surrogate is what makes a surrogate pair report as the one character it is rather than as two halves — the distinction the whole
 * numeric-reference pipeline turns on, and the reason `&#55348;&#56456;` produces nothing at all.
 *
 * @param value - The string to read.
 *
 * @returns One entry per codepoint, in order.
 */
const codePointsOf = (value: string): string[] => {
  const points: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const point = value.codePointAt(index);
    points.push((point ?? 0).toString(16).toUpperCase().padStart(4, '0'));
    if (point !== undefined && point > 0xffff) index += 1;
  }
  return points;
};

/**
 * @description A decoder that has both a persistent external entity and a per-document input entity, so a spec can tell which tier a reference belongs to by
 * watching which one it picks up.
 *
 * @param options - Decoder options to configure on top of the two entities.
 *
 * @returns The configured decoder.
 */
const decoderWithBothTiers = (options: EntityDecoderOptions = {}): EntityDecoder => {
  const decoder = new EntityDecoder(options);
  decoder.setExternalEntities({ externalName: 'EXTERNAL' });
  decoder.addInputEntities({ inputName: 'INPUT' });
  return decoder;
};

/**
 * @description Run something that is expected to throw and hand back the message it threw with, so a spec can assert on the whole message rather than only on the
 * fact that something failed.
 *
 * @param run - The call to make.
 *
 * @returns The thrown message, or a marker if nothing was thrown.
 */
const messageOf = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return '(nothing thrown)';
};

/**
 * @description Build a decoder whose caller table holds entries its type forbids — a bare `val`, a number, a `null`, an `undefined` — which is the only way a
 * caller reaching past the signature reaches the merge's flattening branch and the drops it performs.
 *
 * @param entries - The table, untyped.
 *
 * @returns The configured decoder.
 */
const decoderWithRawEntities = (entries: Record<string, unknown>): EntityDecoder =>
  new EntityDecoder({ namedEntities: entries as Record<string, string> });

/**
 * @description Give the constructor an option object carrying an explicit `undefined`, which `exactOptionalPropertyTypes` forbids and which generated or untyped
 * caller code produces anyway. The runtime treats an explicit `undefined` as an absent key.
 *
 * @param options - The option object, untyped.
 *
 * @returns The same object, typed as options.
 */
const withExplicitUndefined = (options: Record<string, unknown>): EntityDecoderOptions => options as EntityDecoderOptions;

/**
 * @description Decode a string against a limit of one expansion and report whether it tripped, which is how a spec compares two `applyLimitsTo` settings without
 * asserting on a message it does not care about. Both runtime tiers are registered on the decoder, so the input names in the strings a caller passes
 * resolve.
 *
 * @param applyLimitsTo - The tier filter to configure.
 * @param input - The string to decode.
 *
 * @returns `true` when the limit threw.
 */
const tripsExpansionLimit = (applyLimitsTo: ApplyLimitsTo, input: string): boolean => {
  const decoder = decoderWithBothTiers({ limit: { maxTotalExpansions: 1, applyLimitsTo } });
  try {
    decoder.decode(input);
    return false;
  } catch {
    return true;
  }
};

// ─── The five predefined XML entities ──────────────────────────────────────────────────────────────────────

describe('the five predefined XML entities', () => {
  it('expands each of them, and nothing else about the base table', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
  });

  it('matches the names exactly, so the case variants are not entities without a table to supply them', () => {
    // The decoder's built-in map is the five lowercase names and nothing more. `&AMP;` and `&LT;` exist in `BASIC_LATIN`, but a table has to be
    // handed over for them to resolve.
    const decoder = new EntityDecoder();
    expect(decoder.decode('&AMP;&LT;&GT;')).toBe('&AMP;&LT;&GT;');
    expect(new EntityDecoder({ namedEntities: { AMP: '&' } }).decode('&AMP;')).toBe('&');
  });

  it('leaves a name it has never heard of as the text it was written as', () => {
    expect(new EntityDecoder().decode('&nosuchentity;')).toBe('&nosuchentity;');
  });

  it('takes the surrounding text with it, so a reference mid-string does not truncate anything', () => {
    expect(new EntityDecoder().decode('before &amp; middle &lt; after')).toBe('before & middle < after');
  });

  it('resolves the same name in one pass, from the table a caller supplied', () => {
    const decoder = new EntityDecoder({ namedEntities: { brand: 'Acme', copy: '©' } });
    expect(decoder.decode('&brand; &copy; &amp;')).toBe('Acme © &');
  });

  it('lets a caller table override a built-in of the same name, because it is merged second', () => {
    expect(new EntityDecoder({ namedEntities: { amp: 'AMP-OVERRIDDEN' } }).decode('&amp;')).toBe('AMP-OVERRIDDEN');
  });

  it('merges a caller table over the built-ins rather than replacing it', () => {
    const decoder = new EntityDecoder({ namedEntities: { brand: 'Acme' } });
    expect(decoder.decode('&brand;&amp;')).toBe('Acme&');
  });

  it('unwraps a `{ regex, val }` envelope down to the value, for the caller table', () => {
    const decoder = new EntityDecoder({ namedEntities: { a: { regex: /x/, val: 'AV' } } });
    expect(decoder.decode('&a;')).toBe('AV');
  });

  it('unwraps a `{ regx, val }` envelope for the input entities, which is the only path whose type admits that spelling', () => {
    // The two setters disagree about which key the envelope carries — `regex` on the caller table, `regx` on the input map — and the merge reads
    // either. A caller who gets it wrong has the entry dropped rather than an error.
    const decoder = new EntityDecoder();
    decoder.addInputEntities({ b: { regx: /x/, val: 'BV' } });
    expect(decoder.decode('&b;')).toBe('BV');
  });

  it('drops a function value, because a function has no meaning without the regex it was matched against', () => {
    const decoder = decoderWithRawEntities({ c: { val: () => 'CV' } });
    expect(decoder.decode('&c;')).toBe('&c;');
  });

  it('drops an entry whose value is not a string and not an envelope, rather than failing the construction', () => {
    const decoder = decoderWithRawEntities({ ok: 'OK', count: 5, nothing: null, absent: undefined });
    expect(decoder.decode('&ok;&count;&nothing;&absent;')).toBe('OK&count;&nothing;&absent;');
  });
});

// ─── Numeric character references ─────────────────────────────────────────────────────────────────────────

describe('numeric character references', () => {
  it('expands a decimal reference', () => {
    expect(new EntityDecoder().decode('caf&#233;')).toBe('café');
  });

  it('expands a hex reference in either case of the digits and either case of the X', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('&#xE9;')).toBe('é');
    expect(decoder.decode('&#xe9;')).toBe('é');
    expect(decoder.decode('&#XE9;')).toBe('é');
  });

  it('ignores leading zeros, because the number is what the digits spell', () => {
    expect(new EntityDecoder().decode('&#0000065;')).toBe('A');
  });

  it('expands a codepoint above the BMP to the one character it names', () => {
    // U+1D504 MATHEMATICAL FRAKTUR CAPITAL A — a surrogate pair in UTF-16, one character to a reader.
    expect(new EntityDecoder().decode('&#x1D504;')).toBe('𝔄');
  });

  it('deletes a lone surrogate, so writing an astral character as its halves produces nothing', () => {
    // Both halves fall in U+D800–U+DFFF, which is classified `remove` under every policy. The two references are each individually removed, so the
    // single character a surrogate pair would have spelled never exists at any point in the pass.
    expect(new EntityDecoder().decode('&#55348;&#56456;')).toBe('');
  });

  it('leaves an unparseable reference as written rather than deleting the document around it', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('&#;')).toBe('&#;');
    expect(decoder.decode('&#x;')).toBe('&#x;');
    expect(decoder.decode('&#xZZ;')).toBe('&#xZZ;');
    expect(decoder.decode('&#-41;')).toBe('&#-41;');
  });

  it('keeps tab, newline and carriage return, the three C0 codes XML 1.0 permits as literal characters', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('&#9;')).toBe('\t');
    expect(decoder.decode('&#xA;')).toBe('\n');
    expect(decoder.decode('&#xD;')).toBe('\r');
  });

  it('removes every other C0 control under XML 1.0, in decimal or in hex', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('a&#1F;b')).toBe('ab');
    expect(decoder.decode('a&#x1F;b')).toBe('ab');
  });

  it('lets the C0 controls through under XML 1.1, which permits them when written as references', () => {
    expect(new EntityDecoder({ ncr: { xmlVersion: 1.1 } }).decode('a&#x1;b')).toBe('a\u0001b');
  });

  it('removes a null reference, whatever the base policy says', () => {
    expect(new EntityDecoder().decode('a&#0;b')).toBe('ab');
  });

  it('throws on a null reference when asked to, naming the token and the codepoint', () => {
    expect(() => new EntityDecoder({ ncr: { nullNCR: 'throw' } }).decode('a&#0;b')).toThrow(
      '[EntityDecoder] Prohibited numeric character reference &#0; (U+0000)'
    );
  });
});

// ─── The numeric policy ──────────────────────────────────────────────────────────────────────────────────

describe('numericAllowed off', () => {
  it('leaves an ordinary reference in the output verbatim', () => {
    expect(new EntityDecoder({ numericAllowed: false }).decode('caf&#233;')).toBe('caf&#233;');
  });

  it('still removes a codepoint that carries a minimum action, because classification runs first', () => {
    // The option is a switch on the pipeline, not a way past it. Null, surrogates and the XML 1.0 C0 controls are all `remove` at the classification
    // stage, so `numericAllowed: false` never gets a say about them — which is exactly what makes the option safe to rely on.
    const decoder = new EntityDecoder({ numericAllowed: false });
    expect(decoder.decode('a&#0;b')).toBe('ab');
    expect(decoder.decode('a&#xD800;b')).toBe('ab');
    expect(decoder.decode('a&#x1F;b')).toBe('ab');
  });

  it('does still throw for those codepoints, so turning the option off is not a way to silence a prohibited reference', () => {
    expect(() => new EntityDecoder({ numericAllowed: false, ncr: { onNCR: 'throw' } }).decode('&#xD800;')).toThrow(
      '[EntityDecoder] Prohibited numeric character reference &#xD800; (U+D800)'
    );
  });

  it('leaves the named entities alone, which are not numeric references', () => {
    expect(new EntityDecoder({ numericAllowed: false }).decode('&amp;&lt;&copy;')).toBe('&<&copy;');
  });
});

describe('leave and remove', () => {
  it('emits a left reference as the text it was written as', () => {
    expect(new EntityDecoder({ leave: ['amp'] }).decode('a&amp;b')).toBe('a&amp;b');
  });

  it('deletes a removed reference, whether or not the name resolves', () => {
    expect(new EntityDecoder({ remove: ['amp', 'nosuch'] }).decode('a&amp;b&nosuch;c')).toBe('abc');
  });

  it('matches a numeric reference by its token, so `#38` and `#x26` are how a number is left alone', () => {
    expect(new EntityDecoder({ leave: ['#38'] }).decode('a&#38;b')).toBe('a&#38;b');
    expect(new EntityDecoder({ leave: ['#x26'] }).decode('a&#x26;b')).toBe('a&#x26;b');
  });

  it('applies remove before leave, so a name in both lists is deleted', () => {
    expect(new EntityDecoder({ remove: ['x'], leave: ['x'] }).decode('a&x;b')).toBe('ab');
  });

  it('applies leave before the numeric pipeline, so a left `#38` is not expanded', () => {
    expect(new EntityDecoder({ leave: ['#38'] }).decode('a&#38;b')).toBe('a&#38;b');
  });

  it('never charges a left reference to a limit, however many there are', () => {
    const decoder = new EntityDecoder({ leave: ['amp'], limit: { maxTotalExpansions: 1, applyLimitsTo: 'all' } });
    expect(decoder.decode('&amp;&amp;&amp;&amp;')).toBe('&amp;&amp;&amp;&amp;');
    expect(decoder._totalExpansions).toBe(0);
  });

  it('treats a bare ampersand as text rather than as a malformed reference', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('a & b')).toBe('a & b');
    expect(decoder.decode('&&')).toBe('&&');
    expect(decoder.decode('&;')).toBe('&;');
  });

  it('deletes a name registered to the empty string, rather than leaving the reference alone', () => {
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ gone: '' });
    expect(decoder.decode('a&gone;b')).toBe('ab');
  });
});

// ─── postCheck ───────────────────────────────────────────────────────────────────────────────────────────

describe('postCheck sees the resolved string and the original', () => {
  it('runs once on a string the scanner actually walked', () => {
    const spy = spyPostCheck();
    new EntityDecoder({ postCheck: spy.postCheck }).decode('&amp;');
    expect(spy.seen).toEqual(['&amp;']);
  });

  it('receives the expansion as the first argument and the untouched input as the second', () => {
    const seen: Array<[string, string]> = [];
    new EntityDecoder({
      postCheck: (resolved, original) => {
        seen.push([resolved, original]);
        return resolved;
      },
    }).decode('x&amp;y');
    expect(seen).toEqual([['x&y', 'x&amp;y']]);
  });

  it('can reject the whole expansion by handing back the original', () => {
    const spy = rejectingPostCheck();
    expect(new EntityDecoder({ postCheck: spy.postCheck }).decode('&amp;')).toBe('&amp;');
    expect(spy.seen).toEqual(['&amp;']);
  });

  it('runs on a string that has an ampersand in it even when nothing resolved', () => {
    // This is the boundary that matters: the guard is "is there an `&`", not "did anything expand". A sanitiser written against this hook has seen
    // every string that could contain a reference.
    const spy = spyPostCheck();
    new EntityDecoder({ postCheck: spy.postCheck }).decode('&nosuchentity;');
    expect(spy.seen).toEqual(['&nosuchentity;']);
  });
});

// ─── Preserved upstream quirk: postCheck is skipped on the two fast paths ────────────────────────────────

describe('preserved upstream quirk: postCheck never sees input that never reached the scan', () => {
  // The hook's own documentation says it is not called for a non-string, an empty string, or a string with no `&`. That is upstream's behaviour and it
  // is kept: a caller relying on `postCheck` as a sanitiser has never had it run over an already-safe string, and a caller relying on it to count work
  // has never seen a count that includes those. Not endorsed — it is a gap in the contract, pinned so that closing it is a visible decision.

  it('runs exactly once for a string containing only an XML entity', () => {
    const spy = spyPostCheck();
    new EntityDecoder({ postCheck: spy.postCheck }).decode('&amp;');
    expect(spy.seen).toHaveLength(1);
  });

  it('runs zero times for a string with no ampersand in it', () => {
    const spy = spyPostCheck();
    expect(new EntityDecoder({ postCheck: spy.postCheck }).decode('plain')).toBe('plain');
    expect(spy.seen).toHaveLength(0);
  });

  it('runs zero times for the empty string', () => {
    const spy = spyPostCheck();
    expect(new EntityDecoder({ postCheck: spy.postCheck }).decode('')).toBe('');
    expect(spy.seen).toHaveLength(0);
  });

  it('runs zero times for a non-string, because the guard is before the scan rather than around it', () => {
    const spy = spyPostCheck();
    const decoder = new EntityDecoder({ postCheck: spy.postCheck });
    decodeValue(decoder, null);
    decodeValue(decoder, 0);
    expect(spy.seen).toHaveLength(0);
  });
});

// ─── One pass, no rescan ────────────────────────────────────────────────────────────────────────────────

describe('expansion is a single pass', () => {
  it('does not re-scan its own output, so an expansion that spells a reference leaves that reference as text', () => {
    // This is what bounds the whole class: a registered value can contain reference text and it will never be expanded, so no entity definition can
    // reach a second level of indirection through the decoder.
    const decoder = new EntityDecoder({ namedEntities: { a: '&b;', b: 'B' } });
    expect(decoder.decode('&a;')).toBe('&b;');
  });

  it('does not re-scan a numeric reference that expands to an ampersand', () => {
    // U+0026 AMPERSAND, written as a reference. The `&` it produces is output, not input, so the `&#38;` inside it is never looked at.
    expect(new EntityDecoder().decode('&#x26;#38;')).toBe('&#38;');
  });

  it('still scans past an ampersand that turned out not to open a reference', () => {
    // The scan advances one character rather than to the end of the run, so a second `&` in the same text is still found.
    expect(new EntityDecoder().decode('& &amp;')).toBe('& &');
  });
});

// ─── Expansion limits ───────────────────────────────────────────────────────────────────────────────────

describe('expansion limits', () => {
  it('counts only the surplus an expansion adds, so a shrinking reference can never trip a length limit', () => {
    // `&amp;` is six characters of input for one character of output. A document of nothing but `&amp;` shrinks, so no length limit applies to it at all.
    const decoder = new EntityDecoder({ limit: { maxExpandedLength: 1, applyLimitsTo: 'all' } });
    expect(decoder.decode('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
  });

  it('counts a growing reference against the length limit', () => {
    // Twelve characters of output for three of input, so the surplus is nine.
    const decoder = new EntityDecoder({ namedEntities: { x: 'abcdefghijkl' }, limit: { maxExpandedLength: 8, applyLimitsTo: 'all' } });
    expect(() => decoder.decode('&x;')).toThrow('[EntityReplacer] Expanded content length limit exceeded: 9 > 8');
  });

  it('allows a growing reference whose surplus is exactly the limit', () => {
    const decoder = new EntityDecoder({ namedEntities: { x: 'abcdefghijkl' }, limit: { maxExpandedLength: 9, applyLimitsTo: 'all' } });
    expect(decoder.decode('&x;')).toBe('abcdefghijkl');
    expect(decoder._expandedLength).toBe(9);
  });

  it('treats a limit of zero, a negative limit, and a NaN limit as unlimited', () => {
    // The runtime tests `> 0` rather than the truthiness of the configured number, so anything that is not a positive number is no limit at all.
    for (const maxTotalExpansions of [0, -1, Number.NaN]) {
      const decoder = new EntityDecoder({ limit: { maxTotalExpansions, applyLimitsTo: 'all' } });
      expect(decoder.decode('&amp;&amp;&amp;&amp;&amp;')).toBe('&&&&&');
    }
  });

  it('accumulates across decode calls, which is what makes a limit a per-document budget', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 3, applyLimitsTo: 'all' } });
    decoder.decode('&amp;');
    decoder.decode('&amp;');
    expect(decoder._totalExpansions).toBe(2);
    decoder.decode('&amp;');
    expect(decoder._totalExpansions).toBe(3);
  });

  it('leaves the counter above the limit after it throws, so the message can report how far over it went', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 3, applyLimitsTo: 'all' } });
    decoder.decode('&amp;&amp;&amp;');
    expect(() => decoder.decode('&amp;')).toThrow('[EntityReplacer] Entity expansion count limit exceeded: 4 > 3');
    expect(decoder._totalExpansions).toBe(4);
  });

  it('clears the count on reset, which is where a new document gets a new budget', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 1, applyLimitsTo: 'all' } });
    decoder.decode('&amp;');
    expect(decoder._totalExpansions).toBe(1);
    decoder.reset();
    expect(decoder._totalExpansions).toBe(0);
    expect(decoder.decode('&amp;')).toBe('&');
  });
});

describe('which tiers count against the limits', () => {
  it('counts nothing but the runtime entities by default', () => {
    // The default is the point of the tier split: a document made entirely of built-in entities and numeric references cannot trip a limit the caller
    // set for the DOCTYPE entities it did not write.
    expect(tripsExpansionLimit('external', '&amp;&lt;&gt;')).toBe(false);
    expect(tripsExpansionLimit('external', '&externalName;')).toBe(false);
  });

  it('counts a base entity when the filter says base', () => {
    expect(tripsExpansionLimit('base', '&amp;&lt;')).toBe(true);
    expect(tripsExpansionLimit('base', '&externalName;&amp;')).toBe(false);
  });

  it('counts everything when the filter says all, whichever tier the reference came from', () => {
    expect(tripsExpansionLimit('all', '&amp;&lt;')).toBe(true);
    expect(tripsExpansionLimit('all', '&externalName;&amp;')).toBe(true);
    expect(tripsExpansionLimit('all', '&inputName;&amp;')).toBe(true);
  });

  it('takes an array naming one tier as a filter over that tier alone', () => {
    // `&externalName;` is charged to `external` and does not count, so only the one base reference lands on the budget and the limit of one is not
    // reached.
    const decoder = decoderWithBothTiers({ limit: { maxTotalExpansions: 1, applyLimitsTo: ['base'] } });
    expect(decoder.decode('&externalName;&amp;')).toBe('EXTERNAL&');
    expect(decoder._totalExpansions).toBe(1);
  });

  it('counts both tiers from an array naming both', () => {
    const decoder = decoderWithBothTiers({ limit: { maxTotalExpansions: 1, applyLimitsTo: ['base', 'external'] } });
    expect(() => decoder.decode('&externalName;&amp;')).toThrow('[EntityReplacer] Entity expansion count limit exceeded: 2 > 1');
  });

  it('honours an empty array literally, so nothing counts and no limit can ever trip', () => {
    expect(tripsExpansionLimit([], '&amp;&lt;&externalName;&inputName;')).toBe(false);
  });

  it('falls back to the external tier for a filter it does not recognise, so a typo cannot switch the limits off', () => {
    // An unrecognised string is not "no filtering" — it is the default. An empty *array*, by contrast, is honoured as written. The distinction is
    // deliberate and is what keeps a misspelt option from silently disabling a limit.
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 1, applyLimitsTo: 'nonsense' as never } });
    decoder.setExternalEntities({ externalName: 'EXTERNAL' });
    expect(() => decoder.decode('&externalName;&externalName;')).toThrow('[EntityReplacer] Entity expansion count limit exceeded: 2 > 1');
    expect(decoder.decode('&amp;&lt;&gt;')).toBe('&<>');
  });

  it('charges a per-document input entity to the external tier, since it is runtime input like any other', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 1 } });
    decoder.addInputEntities({ inputName: 'INPUT' });
    expect(() => decoder.decode('&inputName;&inputName;')).toThrow('[EntityReplacer] Entity expansion count limit exceeded: 2 > 1');
  });

  it('charges a persistent external entity to the same tier, and prefers it over an input entity of the same name', () => {
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ name: 'EXTERNAL' });
    decoder.addInputEntities({ name: 'INPUT' });
    expect(decoder.decode('&name;')).toBe('INPUT');
  });
});

describe('preserved upstream quirk: the limit check is greater-than, not greater-or-equal', () => {
  // A limit of `n` allows exactly `n` expansions and throws on the `n + 1`th. The option's own documentation states this, so it is a contract rather
  // than a bug — pinned here because the off-by-one is the kind of thing a tidy-up changes by accident.

  it('allows exactly the configured number of expansions', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 2, applyLimitsTo: 'all' } });
    expect(decoder.decode('&amp;&lt;')).toBe('&<');
    expect(decoder._totalExpansions).toBe(2);
  });

  it('throws on the one after it, and names the count it reached', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 2, applyLimitsTo: 'all' } });
    decoder.decode('&amp;&lt;');
    expect(() => decoder.decode('&amp;')).toThrow('[EntityReplacer] Entity expansion count limit exceeded: 3 > 2');
  });
});

describe('preserved upstream quirk: a removed reference is charged to the external tier whatever it is', () => {
  // `&lt;` is a base entity. Deleting it still charges the external tier, so a document full of removed built-ins can trip an `external` limit that
  // nothing it wrote could otherwise reach. The in-code comment claims the charge is there for unknown references, which is not what distinguishes
  // them — nothing in the branch looks at whether the name resolves. Not endorsed; pinned so that a "fix" is a visible decision about which tier a
  // deletion belongs to.

  it('charges the external tier for a removed built-in, and an external limit trips on it', () => {
    const decoder = new EntityDecoder({ remove: ['lt'], limit: { maxTotalExpansions: 1, applyLimitsTo: 'external' } });
    expect(() => decoder.decode('&lt;&lt;')).toThrow('[EntityReplacer] Entity expansion count limit exceeded: 2 > 1');
  });

  it('does not trip a base filter for the same input, because the charge landed on external', () => {
    const decoder = new EntityDecoder({ remove: ['lt'], limit: { maxTotalExpansions: 1, applyLimitsTo: 'base' } });
    expect(decoder.decode('&lt;&lt;')).toBe('');
  });

  it('charges the external tier for a removed name that resolves to nothing at all', () => {
    // The name is never looked up, so "removed but unknown" and "removed and known" are indistinguishable to the accounting.
    const decoder = new EntityDecoder({ remove: ['nosuch'], limit: { maxTotalExpansions: 1, applyLimitsTo: 'external' } });
    expect(() => decoder.decode('&nosuch;&nosuch;')).toThrow('[EntityReplacer] Entity expansion count limit exceeded: 2 > 1');
  });
});

// ─── Registration hooks ─────────────────────────────────────────────────────────────────────────────────

describe('registration hooks', () => {
  it('registers a name the hook allows', () => {
    const decoder = new EntityDecoder({ onExternalEntity: () => ENTITY_ACTION.ALLOW });
    decoder.setExternalEntities({ ok: 'OK' });
    expect(decoder.decode('&ok;')).toBe('OK');
  });

  it('skips a name the hook blocks, leaving it unresolvable rather than erroring', () => {
    const decoder = new EntityDecoder({ onExternalEntity: name => (name === 'blocked' ? ENTITY_ACTION.BLOCK : ENTITY_ACTION.ALLOW) });
    decoder.setExternalEntities({ ok: 'OK', blocked: 'BLOCKED' });
    expect(decoder.decode('&ok;')).toBe('OK');
    expect(decoder.decode('&blocked;')).toBe('&blocked;');
  });

  it('throws when the hook says throw, and the message quotes the entity', () => {
    const decoder = new EntityDecoder({ onExternalEntity: () => ENTITY_ACTION.THROW });
    expect(() => decoder.setExternalEntities({ boom: 'X' })).toThrow('[EntityDecoder] Registration of external entity "&boom;" was rejected by hook');
  });

  it('applies to the single-entity setter as well as to the map setter', () => {
    const blocked = new EntityDecoder({ onExternalEntity: () => ENTITY_ACTION.BLOCK });
    blocked.addExternalEntity('q', 'Q');
    expect(blocked.decode('&q;')).toBe('&q;');

    const boom = new EntityDecoder({ onExternalEntity: () => ENTITY_ACTION.THROW });
    expect(() => boom.addExternalEntity('q', 'Q')).toThrow('[EntityDecoder] Registration of external entity "&q;" was rejected by hook');
  });

  it('applies to the input entities too, through its own hook', () => {
    const decoder = new EntityDecoder({ onInputEntity: () => ENTITY_ACTION.BLOCK });
    decoder.addInputEntities({ a: 'A', b: 'B' });
    expect(decoder.decode('&a;&b;')).toBe('&a;&b;');

    const strict = new EntityDecoder({ onInputEntity: () => ENTITY_ACTION.THROW });
    expect(() => strict.addInputEntities({ a: 'A' })).toThrow('[EntityDecoder] Registration of input entity "&a;" was rejected by hook');
  });

  it('accepts a name it does not recognise as an action, so a typo cannot reject an entity by accident', () => {
    const decoder = new EntityDecoder({ onExternalEntity: () => 'whatever' as never });
    decoder.setExternalEntities({ q: 'Q' });
    expect(decoder.decode('&q;')).toBe('Q');
  });

  it('sees the resolved value, not the envelope it arrived in', () => {
    const seen: Array<[string, string]> = [];
    const decoder = new EntityDecoder({ onExternalEntity: (name, value) => (seen.push([name, value]), ENTITY_ACTION.ALLOW) });
    decoder.setExternalEntities({ a: { regex: /x/, val: 'AV' } });
    expect(seen).toEqual([['a', 'AV']]);
  });

  it('reaches a name that looks like an array index before one registered before it', () => {
    // The merge is an object, not a `Map`, so `Object.keys` lifts integer-like keys to the front in numeric order. A hook that counts registration
    // order is therefore reading key order, not the order the caller wrote them in.
    const seen: string[] = [];
    const decoder = new EntityDecoder({ onInputEntity: name => (seen.push(name), ENTITY_ACTION.ALLOW) });
    decoder.addInputEntities({ brand: 'B', 2: 'TWO' });
    expect(seen).toEqual(['2', 'brand']);
  });

  it('is dropped rather than rejected when the option is not a function', () => {
    const decoder = new EntityDecoder({ onExternalEntity: 'nope' as never });
    decoder.setExternalEntities({ q: 'Q' });
    expect(decoder.decode('&q;')).toBe('Q');
  });
});

describe('preserved upstream quirk: a throwing hook and a throwing input registration leave different things behind', () => {
  // Two registration paths, two different failure states. The external setter assigns its replacement only after every entry has passed the hook, so
  // a throw leaves the previous map intact — a useful property. The input setter zeroes its counters first and unconditionally, so a throw there
  // starts a new document's budget without installing any of its entities. Neither is wrong on its own terms; the pair is what a caller has to know.
  // Not endorsed — pinned so that changing either half is a visible decision.

  it('leaves the previous external map in place when the hook throws', () => {
    const decoder = new EntityDecoder({ onExternalEntity: name => (name === 'bad' ? ENTITY_ACTION.THROW : ENTITY_ACTION.ALLOW) });
    decoder.setExternalEntities({ good: 'G' });
    expect(() => decoder.setExternalEntities({ other: 'O', bad: 'B' })).toThrow(/was rejected by hook/);
    expect(decoder.decode('&good;')).toBe('G');
  });

  it('leaves none of the new names in place when the hook throws', () => {
    const decoder = new EntityDecoder({ onExternalEntity: name => (name === 'bad' ? ENTITY_ACTION.THROW : ENTITY_ACTION.ALLOW) });
    expect(() => decoder.setExternalEntities({ other: 'O', bad: 'B' })).toThrow(/was rejected by hook/);
    expect(decoder.decode('&other;')).toBe('&other;');
  });

  it('clears both counters before the input hook can throw', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 3, applyLimitsTo: 'all' }, onInputEntity: () => ENTITY_ACTION.THROW });
    decoder.decode('&amp;&amp;&amp;');
    expect(decoder._totalExpansions).toBe(3);
    expect(() => decoder.addInputEntities({ x: 'Y' })).toThrow(/was rejected by hook/);
    expect(decoder._totalExpansions).toBe(0);
  });
});

// ─── reset ───────────────────────────────────────────────────────────────────────────────────────────────

describe('reset', () => {
  it('returns the decoder, so a call can be chained onto the document it ends', () => {
    expect(new EntityDecoder().reset()).toBeInstanceOf(EntityDecoder);
  });

  it('drops the per-document input entities', () => {
    const decoder = decoderWithBothTiers();
    expect(decoder.decode('&inputName;')).toBe('INPUT');
    decoder.reset();
    expect(decoder.decode('&inputName;')).toBe('&inputName;');
  });

  it('keeps the persistent external entities, which is the whole distinction from the input map', () => {
    const decoder = decoderWithBothTiers();
    decoder.reset();
    expect(decoder.decode('&externalName;')).toBe('EXTERNAL');
  });

  it('keeps the caller table it was constructed with', () => {
    const decoder = new EntityDecoder({ namedEntities: { n: 'N' } });
    decoder.reset();
    expect(decoder.decode('&n;')).toBe('N');
  });

  it('keeps the XML version a declaration set', () => {
    const decoder = new EntityDecoder();
    decoder.setXmlVersion(1.1);
    decoder.reset();
    expect(decoder._ncrXmlVersion).toBe(1.1);
    // And with it, the looser C0 classification.
    expect(decoder.decode('a&#x1;b')).toBe('a\u0001b');
  });
});

// ─── Preserved upstream quirk: a non-string comes back as it went in ─────────────────────────────────────

describe('preserved upstream quirk: decode returns a non-string argument unchanged', () => {
  // `decode` is typed `string → string` and the return type does not describe this. Untyped caller code depends on it: a `null` reaching a decoder
  // from a document field comes back as `null` rather than as `'null'`, and an object reaches the caller as the object it was rather than as a string
  // of it. Not endorsed — the honest fix is a union return type, which is a breaking change for anyone who typed against the current signature, so
  // it is pinned here rather than made.

  it('returns null for null, rather than the string "null"', () => {
    expect(decodeValue(new EntityDecoder(), null)).toBeNull();
  });

  it('returns undefined for undefined', () => {
    expect(decodeValue(new EntityDecoder(), undefined)).toBeUndefined();
  });

  it('returns a number for a number, so a falsy zero is not confused with the string "0"', () => {
    const decoder = new EntityDecoder();
    expect(decodeValue(decoder, 0)).toBe(0);
    expect(decodeValue(decoder, 42)).toBe(42);
    expect(decodeValue(decoder, 0)).not.toBe('0');
  });

  it('returns an object by identity rather than stringifying it', () => {
    const value = { a: 1 };
    expect(decodeValue(new EntityDecoder(), value)).toBe(value);
  });

  it('returns an array by identity, so a structured value is not flattened into text', () => {
    const value = ['1', '2'];
    expect(decodeValue(new EntityDecoder(), value)).toBe(value);
  });

  it('leaves the counters alone, because the guard is before every increment', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 1, applyLimitsTo: 'all' } });
    decodeValue(decoder, 123);
    expect(decoder._totalExpansions).toBe(0);
  });
});

// ─── Preserved upstream quirk: the error messages name a class this package does not have ────────────────

describe('preserved upstream quirk: four error messages say EntityReplacer and three say EntityDecoder', () => {
  // The original's name-validation and limit errors are prefixed with the name of a different class — `EntityReplacer` — which this package does not
  // export and never did. A caller matching on that prefix, or on the `EntityReplacer` substring, already depends on it. The three remaining messages
  // are correctly prefixed. Making either side consistent would be a behaviour change for whoever is matching on it, so the split is pinned here in
  // one place rather than scattered across whichever spec happens to trigger each message.
  interface ErrorCase {
    /**
     * @description What went wrong, phrased so the generated spec name reads as a sentence.
     */
    readonly label: string;
    /**
     * @description The prefix the message is expected to carry.
     */
    readonly prefix: string;
    /**
     * @description The message the call below actually threw, captured at collection time. There is no other way to reach a message this class throws.
     */
    readonly message: string;
  }

  const ERROR_CASES: ErrorCase[] = [
    {
      label: 'a # in an entity name',
      prefix: '[EntityReplacer]',
      message: messageOf(() => {
        new EntityDecoder().addExternalEntity('#x', 'V');
      }),
    },
    {
      label: 'a special character in an entity name',
      prefix: '[EntityReplacer]',
      message: messageOf(() => {
        new EntityDecoder().addExternalEntity('a&b', 'V');
      }),
    },
    {
      label: 'the expansion count limit',
      prefix: '[EntityReplacer]',
      message: messageOf(() => {
        new EntityDecoder({ limit: { maxTotalExpansions: 1, applyLimitsTo: 'all' } }).decode('&amp;&lt;');
      }),
    },
    {
      label: 'the expanded length limit',
      prefix: '[EntityReplacer]',
      message: messageOf(() => {
        const decoder = new EntityDecoder({ namedEntities: { x: 'abcdefghijkl' }, limit: { maxExpandedLength: 1, applyLimitsTo: 'all' } });
        decoder.decode('&x;');
      }),
    },
    {
      label: 'an external registration the hook refused',
      prefix: '[EntityDecoder]',
      message: messageOf(() => {
        new EntityDecoder({ onExternalEntity: () => ENTITY_ACTION.THROW }).setExternalEntities({ x: 'V' });
      }),
    },
    {
      label: 'an input registration the hook refused',
      prefix: '[EntityDecoder]',
      message: messageOf(() => {
        new EntityDecoder({ onInputEntity: () => ENTITY_ACTION.THROW }).addInputEntities({ x: 'V' });
      }),
    },
    {
      label: 'a prohibited numeric reference',
      prefix: '[EntityDecoder]',
      message: messageOf(() => {
        new EntityDecoder({ ncr: { onNCR: 'throw' } }).decode('&#1;');
      }),
    },
  ];

  it('reaches all seven of them, so the assertions below are a census rather than a selection', () => {
    for (const { label, message } of ERROR_CASES) {
      expect(message, `nothing was thrown for ${label}`).not.toBe('(nothing thrown)');
    }
  });

  it('splits four ways to EntityReplacer and three ways to EntityDecoder, and no other way', () => {
    expect(ERROR_CASES.filter(entry => entry.prefix === '[EntityReplacer]')).toHaveLength(4);
    expect(ERROR_CASES.filter(entry => entry.prefix === '[EntityDecoder]')).toHaveLength(3);
  });

  for (const { label, prefix, message } of ERROR_CASES) {
    it(`prefixes the error for ${label} with ${prefix}`, () => {
      expect(message.startsWith(`${prefix} `)).toBe(true);
    });
  }

  it('names the offending character, the entity, the codepoint and the counts, because the message is the only record', () => {
    expect(ERROR_CASES[0].message).toBe('[EntityReplacer] Invalid character \'#\' in entity name: "#x"');
    expect(ERROR_CASES[1].message).toBe('[EntityReplacer] Invalid character \'&\' in entity name: "a&b"');
    expect(ERROR_CASES[2].message).toBe('[EntityReplacer] Entity expansion count limit exceeded: 2 > 1');
    expect(ERROR_CASES[3].message).toBe('[EntityReplacer] Expanded content length limit exceeded: 9 > 1');
    expect(ERROR_CASES[4].message).toBe('[EntityDecoder] Registration of external entity "&x;" was rejected by hook');
    expect(ERROR_CASES[5].message).toBe('[EntityDecoder] Registration of input entity "&x;" was rejected by hook');
    expect(ERROR_CASES[6].message).toBe('[EntityDecoder] Prohibited numeric character reference &#1; (U+0001)');
  });

  it('exports no class by the name it prefixes its own errors with', () => {
    // Nothing named `EntityReplacer` is exported, which is what makes the prefix a string a caller can only match on rather than a type they can
    // check against.
    expect((globalThis as Record<string, unknown>).EntityReplacer).toBeUndefined();
  });
});

// ─── Preserved upstream quirk: name validation refuses far less than it looks ───────────────────────────

describe('preserved upstream quirk: only a # and the eighteen special characters are refused in a name', () => {
  // The validation reads like a name-format check and is not one. Of the eleven shapes below, exactly two are refused: a leading `#`, which would
  // collide with the numeric pipeline, and a character from the special-character set. A space, a semicolon, an `=`, a newline, a leading digit and
  // the empty string are all accepted, and the empty one is a genuine trap — it registers successfully and then makes `&;` unregistrable, because a
  // token of length zero is skipped by the scanner before any lookup happens. Not endorsed: these are the cases a reader of the method name would
  // least expect, which is why each shape is named rather than swept.
  const SPECIAL: Record<string, string> = {
    'a<b': '<',
    'a&b': '&',
    'a!b': '!',
    'a\\b': '\\',
    'a/b': '/',
    'a[b': '[',
    'a]b': ']',
    a$b: '$',
    'a%b': '%',
    'a{b': '{',
    'a}b': '}',
    'a^b': '^',
    'a*b': '*',
    'a(b': '(',
    'a)b': ')',
    'a|b': '|',
    'a+b': '+',
    'a?b': '?',
  };

  for (const name of ['', '1abc', 'a b', 'a;b', 'a-b', 'a=b', 'a\nb', 'a#b']) {
    it(`accepts ${JSON.stringify(name)} as an entity name`, () => {
      const decoder = new EntityDecoder();
      expect(() => {
        decoder.addExternalEntity(name, 'V');
      }).not.toThrow();
    });
  }

  for (const [name, character] of Object.entries(SPECIAL)) {
    it(`refuses ${JSON.stringify(name)}, naming ${JSON.stringify(character)}`, () => {
      expect(() => new EntityDecoder().addExternalEntity(name, 'V')).toThrow(
        `[EntityReplacer] Invalid character '${character}' in entity name: "${name}"`
      );
    });
  }

  it('refuses a name beginning with #, positionally rather than by the character sweep', () => {
    expect(() => new EntityDecoder().addExternalEntity('#x', 'V')).toThrow('[EntityReplacer] Invalid character \'#\' in entity name: "#x"');
  });

  it('accepts a # that is not the first character, because the collision is with a leading one', () => {
    expect(() => new EntityDecoder().addExternalEntity('a#b', 'V')).not.toThrow();
  });

  it('validates a name before it looks at the value, so an invalid name throws even for a value the merge would have dropped', () => {
    // The validation loop is a separate pass over the keys, and it runs first. A name carrying a special character is refused whether its value is a
    // usable string or a form that would have been discarded unread.
    expect(() => new EntityDecoder().addExternalEntity('a<b', 5 as never)).toThrow(/Invalid character '<'/);
  });

  it('accepts the empty name, which then makes `&;` unregistrable because a zero-length token is never looked up', () => {
    // The two halves only meet by accident: the empty name registers, and the scanner drops `&;` before resolution because `token.length === 0`.
    // A caller who registered `''` gets a name no document can reference, and no error telling them so.
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ '': 'NOTHING' });
    expect(decoder.decode('&;')).toBe('&;');
  });

  it('clears the external set from a nullish map without validating anything at all', () => {
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ gone: 'G' });
    decoder.setExternalEntities(null as never);
    expect(decoder.decode('&gone;')).toBe('&gone;');
  });
});

// ─── Preserved upstream quirk: the scan window is 32 characters ─────────────────────────────────────────

describe('preserved upstream quirk: a name of exactly 32 characters resolves and 33 does not', () => {
  // The scan for the closing `;` gives up once more than 32 characters have passed since the `&`, so a 32-character name is the longest one a
  // document can reference and a 33-character one is not — even when it is registered and even when the whole point of the name is its length.
  // Not endorsed: a caller has no way to learn the bound from the API, and a 33-character name registering without complaint is the misleading half.
  const THIRTY_TWO = 'a'.repeat(32);
  const THIRTY_THREE = 'a'.repeat(33);

  it('resolves a name of exactly 32 characters', () => {
    const decoder = new EntityDecoder({ namedEntities: { [THIRTY_TWO]: 'IN-RANGE' } });
    expect(decoder.decode(`&${THIRTY_TWO};`)).toBe('IN-RANGE');
  });

  it('leaves a name of 33 characters as text, even though it is registered', () => {
    const decoder = new EntityDecoder({ namedEntities: { [THIRTY_THREE]: 'OUT-OF-RANGE' } });
    expect(decoder.decode(`&${THIRTY_THREE};`)).toBe(`&${THIRTY_THREE};`);
  });

  it('leaves a 33-character name as text even when a 32-character prefix of it would have matched nothing', () => {
    // The window is measured from the `&`, not from the name's start, so a shorter registered name inside a longer token does not rescue it.
    const decoder = new EntityDecoder({ namedEntities: { a: 'A' } });
    expect(decoder.decode(`&${THIRTY_THREE};`)).toBe(`&${THIRTY_THREE};`);
  });
});

// ─── Preserved upstream quirk: numeric references are parsed with parseInt ──────────────────────────────

describe('preserved upstream quirk: a leading space, a sign, or trailing garbage is all accepted in a reference', () => {
  // The parser is `parseInt`, which stops at the first character it cannot use rather than requiring the whole token to be a number. Every shape below
  // is malformed XML and every one of them decodes. Not endorsed: a document that meant one thing gets another, and `&#0x41;` in particular looks
  // like hex and is read as a null reference, which is then deleted.
  it('accepts a space between the # and the digits', () => {
    expect(new EntityDecoder().decode('&# 41;')).toBe(')');
  });

  it('accepts a plus sign between the # and the digits, in both radixes', () => {
    expect(new EntityDecoder().decode('&#+41;')).toBe(')');
    expect(new EntityDecoder().decode('&#x+41;')).toBe('A');
  });

  it('accepts trailing garbage after the digits', () => {
    expect(new EntityDecoder().decode('&#41zz;')).toBe(')');
    expect(new EntityDecoder().decode('&#x41zz;')).toBe('A');
  });

  it('accepts leading zeros as padding, in both radixes', () => {
    expect(new EntityDecoder().decode('&#0000041;')).toBe(')');
    expect(new EntityDecoder().decode('&#x00041;')).toBe('A');
  });

  it('refuses a minus sign, because parseInt returns a negative number and a negative codepoint is left as written', () => {
    // The asymmetry with `+` is the tell: the sign that makes the number negative is rejected downstream, while the one that does not is accepted by
    // `parseInt` and never questioned.
    expect(new EntityDecoder().decode('&#-41;')).toBe('&#-41;');
  });

  it('reads a decimal token beginning 0x as a null reference rather than as hex, so &#0x41; decodes to nothing', () => {
    // `parseInt('0x41', 10)` is 0, not 65, because the radix is fixed by the token's second character. A reader sees U+0041 and gets a deletion.
    expect(new EntityDecoder().decode('&#0x41;')).toBe('');
  });

  it('proves that reading by throwing on the null reference it parsed', () => {
    expect(() => new EntityDecoder({ ncr: { nullNCR: 'throw' } }).decode('&#0x41;')).toThrow(
      '[EntityDecoder] Prohibited numeric character reference &#0x41; (U+0000)'
    );
  });
});

describe('preserved upstream quirk: &#999999; is not out of range', () => {
  // The range check is against U+10FFFF, and 999,999 is below it, so the reference is not malformed and decodes to a private-use character. A reader
  // sees a six-digit number and expects a rejection. Not endorsed; pinned so that tightening the check is a visible decision about what a malformed
  // reference costs a caller.
  it('decodes to U+F423F, the private-use character at that codepoint', () => {
    const decoded = new EntityDecoder().decode('&#999999;');
    expect(codePointsOf(decoded)).toEqual(['F423F']);
  });

  it('rejects only what is genuinely above the maximum, in both radixes', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('&#1114112;')).toBe('&#1114112;');
    expect(decoder.decode('&#x110000;')).toBe('&#x110000;');
  });

  it('accepts the maximum itself, so the bound is inclusive', () => {
    expect(codePointsOf(new EntityDecoder().decode('&#x10FFFF;'))).toEqual(['10FFFF']);
  });
});

// ─── Preserved upstream quirk: the XML version is selected by exact number ──────────────────────────────

describe('preserved upstream quirk: only the exact number 1.1 selects XML 1.1', () => {
  // The comparison is `=== 1.1`, so a version read out of a document as text, a version someone rounded, and a version in an array all normalise to
  // 1.0 — the stricter classification. Defaulting to the stricter side is the right default; reading a `<?xml version?>` declaration that has not
  // been converted to a number first silently gives the other one. Not endorsed.
  it('selects XML 1.1 for the number 1.1, and keeps the C0 controls', () => {
    const decoder = new EntityDecoder();
    setXmlVersionWith(decoder, 1.1);
    expect(decoder._ncrXmlVersion).toBe(1.1);
    expect(decoder.decode('a&#x1;b')).toBe('a\u0001b');
  });

  for (const [label, value] of [
    ['the string "1.1"', '1.1'],
    ['the number 1.15', 1.15],
    ['the number 1', 1],
    ['the number 1.0', 1.0],
    ['a boolean', true],
    ['an array', [1.1]],
    ['NaN', Number.NaN],
  ] as const) {
    it(`normalises ${label} to XML 1.0`, () => {
      const decoder = new EntityDecoder();
      setXmlVersionWith(decoder, value);
      expect(decoder._ncrXmlVersion).toBe(1.0);
    });
  }

  it('is decided per reference, so a decoder can be moved from 1.0 to 1.1 and back', () => {
    const decoder = new EntityDecoder();
    expect(decoder.decode('a&#x1;b')).toBe('ab');
    setXmlVersionWith(decoder, 1.1);
    expect(decoder.decode('a&#x1;b')).toBe('a\u0001b');
    setXmlVersionWith(decoder, 1.0);
    expect(decoder.decode('a&#x1;b')).toBe('ab');
  });
});

// ─── Preserved upstream quirk: nullNCR is clamped whatever it is set to ────────────────────────────────

describe('preserved upstream quirk: a nullNCR weaker than remove is raised to remove', () => {
  // The option's type admits only `'remove' | 'throw'`, so a caller who reaches past the type with `'allow'` or `'leave'` is doing something the
  // signature says is impossible. The value is clamped rather than rejected, and the result is indistinguishable from having written `'remove'`.
  // Not endorsed: silently accepting a value the type forbids is the kind of thing that hides a bug at the call site.
  it('clamps allow up to remove', () => {
    const decoder = new EntityDecoder({ ncr: { nullNCR: 'allow' as never } });
    expect(decoder._ncrNullLevel).toBe(2);
    expect(decoder.decode('a&#0;b')).toBe('ab');
  });

  it('clamps leave up to remove, with the same result', () => {
    const decoder = new EntityDecoder({ ncr: { nullNCR: 'leave' as never } });
    expect(decoder._ncrNullLevel).toBe(2);
    expect(decoder.decode('a&#0;b')).toBe('ab');
  });

  it('keeps remove as remove, and throw as throw', () => {
    expect(new EntityDecoder({ ncr: { nullNCR: 'remove' } })._ncrNullLevel).toBe(2);
    expect(() => new EntityDecoder({ ncr: { nullNCR: 'throw' } }).decode('&#0;')).toThrow(/U\+0000/);
  });

  it('cannot be talked out of deleting a null reference by a base policy of leave', () => {
    // `onNCR` is a floor and a range's minimum is taken over it, so the base policy never weakens what a codepoint range requires.
    const decoder = new EntityDecoder({ ncr: { onNCR: 'leave', nullNCR: 'remove' } });
    expect(decoder.decode('a&#0;b')).toBe('ab');
  });
});

// ─── Preserved upstream quirk: C1 controls and the noncharacters are not classified ────────────────────

describe('preserved upstream quirk: the C1 controls and the U+FFFE/U+FFFF noncharacters decode', () => {
  // XML 1.0 §2.2 prohibits U+007F–U+009F and the two noncharacters outright, and the `xmlVersion` option's own documentation claims the C1 range is
  // permitted only under 1.1. Neither is checked: the classifier looks at null, at the surrogates, and at the C0 controls, and stops. Not endorsed —
  // this is the widest gap in the port, and it is in the safe direction only if a downstream consumer does its own validation.
  it('decodes U+009F, the top of the C1 range', () => {
    expect(codePointsOf(new EntityDecoder().decode('&#x9F;'))).toEqual(['009F']);
  });

  it('decodes the whole C1 range, under either XML version', () => {
    const one = new EntityDecoder();
    const eleven = new EntityDecoder({ ncr: { xmlVersion: 1.1 } });
    for (let cp = 0x7f; cp <= 0x9f; cp++) {
      const reference = `&#x${cp.toString(16)};`;
      expect(one.decode(reference).codePointAt(0)).toBe(cp);
      expect(eleven.decode(reference).codePointAt(0)).toBe(cp);
    }
  });

  it('decodes the U+FFFE and U+FFFF noncharacters', () => {
    expect(codePointsOf(new EntityDecoder().decode('&#xFFFE;&#xFFFF;'))).toEqual(['FFFE', 'FFFF']);
  });

  it('decodes U+007F, the bottom of the C1 range, which is DEL', () => {
    expect(codePointsOf(new EntityDecoder().decode('&#x7F;'))).toEqual(['007F']);
  });

  it('leaves them in place with numericAllowed off, because nothing classifies them', () => {
    const decoder = new EntityDecoder({ numericAllowed: false });
    expect(decoder.decode('a&#x9F;b')).toBe('a&#x9F;b');
  });
});

// ─── Preserved upstream quirk: prototype names stay literal ───────────────────────────────────────────

describe('preserved upstream quirk: &constructor;, &toString; and &__proto__; are never entities', () => {
  // The maps are null-prototype objects, so nothing from `Object.prototype` is reachable through a lookup. That closes a real hole — a document
  // naming `&constructor;` cannot read a function and stringify it into its own output — and it is why registration of those names is the only way to
  // make them resolve. `__proto__` is the exception: an object literal with a `__proto__` key sets a prototype rather than creating an own property,
  // so it never becomes an entry at all. All three are safe, none is documented, and all three are pinned here.
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    it(`leaves &${name}; as literal text`, () => {
      expect(new EntityDecoder().decode(`&${name};`)).toBe(`&${name};`);
    });
  }

  it('lets a caller register &constructor; and &toString; and have them resolve', () => {
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ constructor: 'C', toString: 'T' });
    expect(decoder.decode('&constructor;&toString;')).toBe('CT');
  });

  it('does not let a caller register &__proto__; through an object literal, because the key sets a prototype instead', () => {
    // `Object.keys` never sees it, so there is no entry to find. The only route that would work is a computed key built at runtime, which is what
    // makes this a fact about object literals rather than about the decoder.
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ __proto__: 'P' });
    expect(decoder.decode('&__proto__;')).toBe('&__proto__;');
  });

  it('does let a caller register &__proto__; under a computed key, so the reachability is the map’s own doing', () => {
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ ['__proto__']: 'P' });
    expect(decoder.decode('&__proto__;')).toBe('P');
  });

  it('registers the computed &__proto__; as a plain own entry rather than as a prototype', () => {
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ ['__proto__']: 'P' });
    expect(Object.getPrototypeOf(decoder._externalMap)).toBeNull();
  });
});

// ─── Preserved upstream quirk: an ampersand in a registered value ─────────────────────────────────────

describe('preserved upstream quirk: a value containing & is stored by two of the three registration paths', () => {
  // The documentation says a value containing `&` is skipped on the way in, to stop a registered value from expanding further. It is not: the two map
  // setters store it unchanged and it expands to the literal `&` text, which then reaches the caller unexpanded because the pass is over. The single
  // entity setter does check, and silently drops. So the same name registered either way can resolve or fail to, with no error to explain the
  // difference. Not endorsed — the inconsistency is the whole hazard, and it is pinned so that making the two paths agree is a visible decision about
  // which way round to go.
  it('stores and expands a value containing & from the constructor table', () => {
    const decoder = new EntityDecoder({ namedEntities: { x: 'a&b' } });
    expect(decoder.decode('&x;')).toBe('a&b');
  });

  it('stores and expands a value containing & from the external map setter', () => {
    const decoder = new EntityDecoder();
    decoder.setExternalEntities({ x: 'a&b' });
    expect(decoder.decode('&x;')).toBe('a&b');
  });

  it('drops the same value from the single-entity setter, so the name resolves to nothing', () => {
    const decoder = new EntityDecoder();
    decoder.addExternalEntity('x', 'a&b');
    expect(decoder.decode('&x;')).toBe('&x;');
  });

  it('leaves the ampersand in the stored value as text rather than expanding it, because the pass is over by then', () => {
    // The hazard the documentation describes is still not reachable — the value does not expand — but it happens because the output is not re-scanned,
    // not because the value was filtered.
    const decoder = new EntityDecoder({ namedEntities: { x: '&#38;', amp: '&' } });
    expect(decoder.decode('&x;')).toBe('&#38;');
  });
});

// ─── Preserved upstream quirk: the input entities are not validated at all ─────────────────────────────

describe('preserved upstream quirk: addInputEntities validates no entity name', () => {
  // The per-document path — the one that handles a DOCTYPE, and therefore the one that handles the part of the input nobody vouched for — is the one
  // that skips validation entirely. A `#`-prefixed name registers, where both external setters throw. It is then unreachable, because `decode` routes
  // every `#`-prefixed token to the numeric pipeline first and never consults the input map. Not endorsed: the asymmetry means a document can declare
  // an entity that silently never fires, while the same declaration on the other path is a hard error.
  it('accepts a #-prefixed name where both external setters throw', () => {
    const decoder = new EntityDecoder();
    expect(() => {
      decoder.addInputEntities({ '#a': 'W' });
    }).not.toThrow();
    expect(() => new EntityDecoder().setExternalEntities({ '#a': 'W' })).toThrow(/Invalid character '#'/);
    expect(() => new EntityDecoder().addExternalEntity('#a', 'W')).toThrow(/Invalid character '#'/);
  });

  it('accepts a name carrying characters the external setters refuse', () => {
    const decoder = new EntityDecoder();
    expect(() => {
      decoder.addInputEntities({ 'a&b': 'W', 'a<b': 'W', '': 'W' });
    }).not.toThrow();
  });

  it('stores the #-prefixed name, and never reaches it, because # routes to the numeric pipeline first', () => {
    const decoder = new EntityDecoder();
    decoder.addInputEntities({ '#a': 'W' });
    expect(decoder._inputMap['#a']).toBe('W');
    expect(decoder.decode('&#a;')).toBe('&#a;');
  });

  it('replaces the previous input set and clears the counters, so a second call is a new document', () => {
    const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 5, applyLimitsTo: 'all' } });
    decoder.addInputEntities({ first: '1' });
    decoder.decode('&first;');
    expect(decoder._totalExpansions).toBe(1);
    decoder.addInputEntities({ second: '2' });
    expect(decoder.decode('&first;')).toBe('&first;');
    expect(decoder.decode('&second;')).toBe('2');
    expect(decoder._totalExpansions).toBe(1);
  });

  it('clears the input set from a nullish map, without validating anything', () => {
    const decoder = new EntityDecoder();
    decoder.addInputEntities({ gone: 'G' });
    decoder.addInputEntities(null as never);
    expect(decoder.decode('&gone;')).toBe('&gone;');
  });
});

// ─── Construction ──────────────────────────────────────────────────────────────────────────────────────

describe('construction', () => {
  it('needs no options at all', () => {
    expect(new EntityDecoder().decode('&amp;')).toBe('&');
  });

  it('throws a TypeError naming the limit option when handed null rather than undefined', () => {
    // `= {}` covers only `undefined`, and the first property read is `options.limit`, so a `null` fails there. Which property the message names is
    // what a caller's error path can be matching on.
    expect(() => new EntityDecoder(null as never)).toThrow(TypeError);
    expect(() => new EntityDecoder(null as never)).toThrow(/reading 'limit'/);
  });

  it('keeps the limit option as given, for parity with the original’s field', () => {
    const limit = { maxTotalExpansions: 3 };
    expect(new EntityDecoder({ limit })._limit).toEqual(limit);
    expect(new EntityDecoder()._limit).toEqual({});
  });

  it('reads a limit of an explicit undefined as unlimited rather than as an error', () => {
    // `this._limit.maxTotalExpansions || 0`, so an explicit `undefined` and an absent key land on the same `0`.
    const decoder = new EntityDecoder(withExplicitUndefined({ limit: { maxTotalExpansions: undefined } }));
    expect(decoder._maxTotalExpansions).toBe(0);
    expect(decoder.decode('&amp;&amp;&amp;')).toBe('&&&');
  });

  it('reads a missing remove or leave list as empty rather than as an error', () => {
    const decoder = new EntityDecoder(withExplicitUndefined({ remove: undefined, leave: undefined }));
    expect(decoder.decode('&amp;')).toBe('&');
  });

  it('builds the base map once, from the built-ins and the caller table together', () => {
    const decoder = new EntityDecoder({ namedEntities: { brand: 'Acme' } });
    expect(Object.keys(decoder._baseMap).sort()).toEqual(['amp', 'apos', 'brand', 'gt', 'lt', 'quot']);
  });
});
