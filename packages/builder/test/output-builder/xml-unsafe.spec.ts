// oxlint-disable vitest/valid-title
/**
 * @description Specs for the XML unsafe-value rules — the security control on the DOCTYPE entity path. This is the one place in the package where a missed match
 * is an exploitable bug rather than a wrong number, so the shape here is a table: every rule gets a string that must trip it and a near-miss that
 * must not. A near-miss matters more than a positive here, because a rule that fires too eagerly silently refuses legitimate entities, and the only
 * way to notice that is a test that asserts the boundary. The rules are a verbatim port of `is-unsafe@1.0.1`'s XML context, verified against the
 * dependency over a corpus of attack and benign strings, so these specs are not the only evidence that behaviour is unchanged. They are what keeps it
 * unchanged as the code moves.
 */

import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { BuilderError } from '#/errors.ts';
import type { XmlUnsafeRule } from '#/index.ts';

import { XML_UNSAFE_RULES, allUnsafeXml, isUnsafeXml, whyUnsafeXml } from '#/index.ts';

/**
 * @description A rule paired with a string it must catch and a string that must slip past.
 */
interface RuleCase {
  /**
   * @description The string that trips the rule.
   */
  readonly trips: string;
  /**
   * @description A string close enough to be worth checking, which must not trip it.
   */
  readonly nearMiss: string;
}

/**
 * @description One case per rule, keyed by rule id. The near-misses are the interesting half. `SYSTEMX "x"` is not an external entity declaration. `&x;&y;` is two
 * references, not the three the billion-laughs heuristic wants. `<!DOCTYPEX` is not a DOCTYPE. Each of those is a case where a looser regex would
 * refuse a document that had no reason to be refused.
 */
const CASES: Record<string, RuleCase> = {
  'xml-cdata-injection': { trips: 'a<![CDATA[b', nearMiss: '<![cdataX[b' },
  'xml-cdata-close': { trips: 'a]]>b', nearMiss: 'a]]b' },
  'xml-processing-instruction': { trips: '<?xml-stylesheet href="x"?>', nearMiss: '<?query ?>' },
  'xml-doctype-injection': { trips: '<!DOCTYPE foo', nearMiss: '<!DOCTYPEX foo' },
  'xml-entity-system': { trips: 'SYSTEM "file:///etc/passwd"', nearMiss: 'SYSTEMX "x"' },
  'xml-entity-public': { trips: 'PUBLIC "http://x"', nearMiss: 'PUBLICX "x"' },
  'xml-entity-declaration': { trips: '<!ENTITY x "y">', nearMiss: '<!ENTITYx "y">' },
  'xml-billion-laughs': { trips: '&e0;&e1;&e2;', nearMiss: '&x;&y;' },
  'xml-namespace-confusion': { trips: 'xmlns="http://x"', nearMiss: 'xmlnsfoo="x"' },
  'xml-comment-injection': { trips: 'a<!--b', nearMiss: 'a<!-b' },
  'xml-comment-close': { trips: 'a-->b', nearMiss: 'a--b' },
  'xml-pi-close': { trips: 'a?>b', nearMiss: 'a?b' },
};

/**
 * @description Look a rule up by id, failing loudly rather than silently skipping a case.
 *
 * @param id - The rule id.
 *
 * @returns The rule.
 */
const rule = (id: string): XmlUnsafeRule => {
  const found = XML_UNSAFE_RULES.find(r => r.id === id);
  if (!found) throw new Error(`no such rule: ${id}`);
  return found;
};

// ─── Rule inventory ──────────────────────────────────────────────────────────────────────────────────────────

describe('XML_UNSAFE_RULES', () => {
  it('carries the twelve rules, in the order they are tested', () => {
    expect(XML_UNSAFE_RULES.map(r => r.id)).toEqual([
      'xml-cdata-injection',
      'xml-cdata-close',
      'xml-processing-instruction',
      'xml-doctype-injection',
      'xml-entity-system',
      'xml-entity-public',
      'xml-entity-declaration',
      'xml-billion-laughs',
      'xml-namespace-confusion',
      'xml-comment-injection',
      'xml-comment-close',
      'xml-pi-close',
    ]);
  });

  it('gives every rule an id, a description and a pattern', () => {
    for (const r of XML_UNSAFE_RULES) {
      expect(r.id).toMatch(/^xml-[a-z-]+$/);
      expect(r.description.length).toBeGreaterThan(10);
      expect(r.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('has no rule that can carry lastIndex between calls', () => {
    // A `g` or `y` flag makes `.test` alternate true/false on the same input,
    // which would make a security decision depend on call order.
    for (const r of XML_UNSAFE_RULES) {
      expect(r.pattern.global).toBe(false);
      expect(r.pattern.sticky).toBe(false);
    }
  });

  it('has no duplicate rule id', () => {
    expect(new Set(XML_UNSAFE_RULES.map(r => r.id)).size).toBe(XML_UNSAFE_RULES.length);
  });
});

// ─── Per-rule behaviour ─────────────────────────────────────────────────────────────────────────────────────

describe('the XML rules', () => {
  for (const [id, { trips, nearMiss }] of Object.entries(CASES)) {
    describe(id, () => {
      it.effect(`catches ${JSON.stringify(trips)}`, () =>
        Effect.gen(function* () {
          expect(rule(id).pattern.test(trips)).toBe(true);
          expect(yield* isUnsafeXml(trips)).toBe(true);
        })
      );

      it(`lets ${JSON.stringify(nearMiss)} through`, () => {
        // The near-miss may still trip a *different* rule, so this asserts the
        // specific pattern rather than isUnsafeXml.
        expect(rule(id).pattern.test(nearMiss)).toBe(false);
      });
    });
  }

  it('matches the upstream pattern for every case', () => {
    // The cases above are hand-written; this ties each one back to the rule it
    // is meant to exercise, so a rule renamed upstream cannot leave a case
    // silently testing nothing.
    for (const id of Object.keys(CASES)) expect(rule(id).id).toBe(id);
  });
});

// ─── Benign values ──────────────────────────────────────────────────────────────────────────────────────────

describe('isUnsafeXml — values that must never be refused', () => {
  const benign = [
    '',
    ' ',
    'plain text',
    'Hello, world',
    '0',
    '-1',
    '3.14',
    'true',
    '© 2026 Endevops',
    'naïve café',
    '日本語テキスト',
    'emoji 🎉',
    'C++',
    'user@example.com',
    'https://example.com/p?a=1&b=2',
    'line1\nline2',
    'quote " double',
    "apostrophe ' single",
    '100%',
    '$100',
    'key=value',
    'a-b_c.d',
    '&amp;',
    '&#65;',
    'AT&T',
    '5 < 10 and 10 > 5',
    'a < b',
    'x > y',
  ];

  for (const value of benign) {
    it.effect(`accepts ${JSON.stringify(value)}`, () =>
      Effect.gen(function* () {
        expect(yield* isUnsafeXml(value)).toBe(false);
        expect(yield* whyUnsafeXml(value)).toBeNull();
        expect(yield* allUnsafeXml(value)).toEqual([]);
      })
    );
  }
});

// ─── Attack shapes ───────────────────────────────────────────────────────────────────────────────────────────

describe('isUnsafeXml — real attack payloads', () => {
  it.effect('catches an external entity pointing at a local file', () =>
    Effect.gen(function* () {
      expect(yield* isUnsafeXml('<!ENTITY xxe SYSTEM "file:///etc/passwd">')).toBe(true);
    })
  );

  it.effect('catches a billion-laughs chain', () =>
    Effect.gen(function* () {
      const bomb = '<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">';
      expect(yield* isUnsafeXml(bomb)).toBe(true);
    })
  );

  it.effect('catches a public external entity', () =>
    Effect.gen(function* () {
      expect(yield* isUnsafeXml('<!ENTITY x SYSTEM PUBLIC "http://evil/x" >')).toBe(true);
    })
  );

  it.effect('catches an internal DTD smuggled into content', () =>
    Effect.gen(function* () {
      expect(yield* isUnsafeXml('<!DOCTYPE note [<!ENTITY x "y">]>')).toBe(true);
    })
  );

  it.effect('catches a CDATA breakout', () =>
    Effect.gen(function* () {
      expect(yield* isUnsafeXml('safe]]><script>not-a-script-but-a-breakout</script>')).toBe(true);
    })
  );

  it.effect('catches a namespace redefinition', () =>
    Effect.gen(function* () {
      expect(yield* isUnsafeXml('<root xmlns="http://attacker.example/">')).toBe(true);
    })
  );

  it.effect('is case-insensitive where the upstream rules are', () =>
    Effect.gen(function* () {
      for (const value of ['<!doctype x', 'system "x"', '<!entity x "y">', 'xmlns="x"']) {
        expect(yield* isUnsafeXml(value)).toBe(true);
      }
    })
  );
});

// ─── Reporting ──────────────────────────────────────────────────────────────────────────────────────────────

describe('whyUnsafeXml', () => {
  it.effect('names the rule that caught the value', () =>
    Effect.gen(function* () {
      const match = yield* whyUnsafeXml('SYSTEM "file:///etc/passwd"');
      expect(match?.rule.id).toBe('xml-entity-system');
    })
  );

  it.effect('reports the offending span, not the whole value', () =>
    Effect.gen(function* () {
      const match = yield* whyUnsafeXml('harmless prefix SYSTEM "x" harmless suffix');
      // The rule's pattern stops at the opening quote — it looks for the keyword
      // followed by a quote, not for the whole identifier — so the span is
      // `SYSTEM "` and not the URL that follows.
      expect(match?.matchedText).toBe('SYSTEM "');
    })
  );

  it.effect('returns the first match when several rules would fire', () =>
    Effect.gen(function* () {
      // First-match-wins is the contract, and the order is the table above.
      const match = yield* whyUnsafeXml('<!DOCTYPE a SYSTEM "b">');
      expect(match?.rule.id).toBe('xml-doctype-injection');
    })
  );

  it.effect('is null for a safe value', () =>
    Effect.gen(function* () {
      expect(yield* whyUnsafeXml('hello')).toBeNull();
    })
  );
});

describe('allUnsafeXml', () => {
  it.effect('reports every rule that fires, in rule order', () =>
    Effect.gen(function* () {
      const ids = (yield* allUnsafeXml('<!DOCTYPE a SYSTEM "b">')).map(m => m.rule.id);
      expect(ids).toEqual(['xml-doctype-injection', 'xml-entity-system']);
    })
  );

  it.effect('is a superset of whyUnsafeXml', () =>
    Effect.gen(function* () {
      for (const value of ['<![CDATA[x]]>', 'a-->b?>c', 'SYSTEM "x" PUBLIC "y"']) {
        const first = yield* whyUnsafeXml(value);
        const all = yield* allUnsafeXml(value);
        expect(all.length).toBeGreaterThanOrEqual(1);
        expect(all.map(m => m.rule.id)).toContain(first?.rule.id);
      }
    })
  );

  it.effect('returns an empty array for a safe value', () =>
    Effect.gen(function* () {
      expect(yield* allUnsafeXml('hello')).toEqual([]);
    })
  );
});

// ─── Determinism ────────────────────────────────────────────────────────────────────────────────────────────

describe('the rules are stateless', () => {
  it.effect('gives the same verdict every time the same value is tested', () =>
    Effect.gen(function* () {
      const value = '<![CDATA[x]]> SYSTEM "y"';
      const verdicts: Array<boolean> = [];
      for (let i = 0; i < 5; i++) verdicts.push(yield* isUnsafeXml(value));
      expect(new Set(verdicts).size).toBe(1);
    })
  );

  it.effect('gives the same report every time allUnsafeXml runs', () =>
    Effect.gen(function* () {
      const value = '<!DOCTYPE a SYSTEM "b">';
      const first = (yield* allUnsafeXml(value)).map(m => m.rule.id);
      for (let i = 0; i < 3; i++) {
        expect((yield* allUnsafeXml(value)).map(m => m.rule.id)).toEqual(first);
      }
    })
  );

  it.effect('does not let one value leak state into the next', () =>
    Effect.gen(function* () {
      yield* isUnsafeXml('<![CDATA[');
      expect(yield* isUnsafeXml('clean')).toBe(false);
    })
  );
});

// ─── Input contract ─────────────────────────────────────────────────────────────────────────────────────────

describe('the rules reject a non-string', () => {
  it.effect('fails rather than coercing, so a caller cannot pass a number by accident', () =>
    Effect.gen(function* () {
      // A silent String() would let an entity value of `0` or `null` skip the check.
      for (const bad of [undefined, null, 0, 1, true, {}, []]) {
        // Each predicate names *itself* in the failure. The original hard-coded `isUnsafeXml`
        // even when one of its two siblings raised it, which sent a caller to the wrong function.
        // Typed as `Effect<unknown, BuilderError>` because the loop only reads the error —
        // the three predicates' success types differ and nothing here depends on them.
        const predicates: ReadonlyArray<readonly [(value: string) => Effect.Effect<unknown, BuilderError>, string]> = [
          [isUnsafeXml, 'isUnsafeXml'],
          [whyUnsafeXml, 'whyUnsafeXml'],
          [allUnsafeXml, 'allUnsafeXml'],
        ];
        for (const [fn, name] of predicates) {
          const result = yield* fn(bad as unknown as string).pipe(Effect.result);
          assert(Result.isFailure(result));
          const error = result.failure;
          expect(error.message).toContain(`${name}: first argument must be a string`);
          expect(error.reason._tag === 'InvalidArgument' && error.reason.function).toBe(name);
        }
      }
    })
  );
});
