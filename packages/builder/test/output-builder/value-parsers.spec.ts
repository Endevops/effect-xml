/**
 * @description Specs for the five built-in value parsers and the final-value contract they share. Every parser is exercised through the same lens: what it does to
 * a value, what it leaves alone, and what happens when the final flag is set. Those cases matter more than they look — the final flag is the only way
 * a parser ends a chain, so a regression there silently changes every value downstream of it. The parsers that consult a {@link Context} — the
 * whitespace normalizer mainly — are tested against a real `Matcher` from `@endevops/common-xml`, since a hand-built stub would only prove the stub
 * works.
 */

import type { MatcherView } from '@endevops/common-xml';
import type { XmlError } from '@endevops/common-xml';

import { Expression, Matcher } from '@endevops/common-xml';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { Context } from '#/index.ts';

import {
  finalValue,
  isFinalValue,
  makeBooleanParser,
  makeContext,
  makeEntitiesValueParser,
  makeNumberValueParser,
  makeTrim,
  makeWSNormalizer,
  wsNormalizerBuiltin,
} from '#/index.ts';
import { run } from '#/test/helpers/effect.ts';
/**
 * @description The one place a spec runs an effect from either package. The `run` in the shared helper is typed for this package's `BuilderError`, and several
 * specs also drive `Expression.make`, which fails with `common-xml`'s `XmlError`. A local runner for that channel keeps those call sites free of
 * casts, and the assertion on both error types is what makes the two channels distinguishable in a failure.
 */
const runXml = <A>(effect: Effect.Effect<A, XmlError>): A => Effect.runSync(effect);

/**
 * @description A matcher positioned on a single `<a>` element. A real `Matcher` rather than a hand-built stub, because the parsers call real methods on it — a
 * stub would only prove the stub works. `readOnly()` is what a builder actually hands to a value parser.
 *
 * @returns The read-only view, positioned at `<a>`.
 */
const atA = (): MatcherView => {
  const matcher = new Matcher();
  matcher.push('a');
  return matcher.readOnly();
};

// ─── FinalValue ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('FinalValue', () => {
  it('carries its value verbatim, including falsy ones', () => {
    for (const v of [0, '', false, null, undefined, NaN]) {
      expect(finalValue(v).value).toBe(v);
    }
  });

  it('is recognisable as a final value and nothing else is', () => {
    expect(isFinalValue(finalValue('x'))).toBe(true);
    expect(isFinalValue('x')).toBe(false);
    expect(isFinalValue(null)).toBe(false);
    expect(isFinalValue({ value: 'x' })).toBe(false);
  });
});

// ─── Trim ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Trim', () => {
  const trim = makeTrim();

  it('trims a string', () => {
    expect(run(trim.parse('  x  '))).toBe('x');
    expect(run(trim.parse('\t\nx\r\n'))).toBe('x');
  });

  it('leaves an already-trimmed string alone', () => {
    expect(run(trim.parse('x'))).toBe('x');
    expect(run(trim.parse(''))).toBe('');
  });

  it('only trims the ends — internal runs survive', () => {
    expect(run(trim.parse('  a  b  '))).toBe('a  b');
  });

  it('passes non-strings through untouched', () => {
    for (const v of [null, undefined, 0, 1, false, true, {}, []]) {
      expect(run(trim.parse(v))).toBe(v);
    }
  });
});

// ─── BooleanParser ─────────────────────────────────────────────────────────────────────────────────────────────

describe('BooleanParser', () => {
  it('converts true and false, case-insensitively', () => {
    const p = makeBooleanParser();
    for (const v of ['true', 'TRUE', 'True', 'tRuE']) expect(run(p.parse(v))).toBe(true);
    for (const v of ['false', 'FALSE', 'False', 'fAlSe']) expect(run(p.parse(v))).toBe(false);
  });

  it('passes through anything not on either list', () => {
    const p = makeBooleanParser();
    for (const v of ['yes', 'no', '0', '1', '', 'truthy']) expect(run(p.parse(v))).toBe(v);
  });

  it('passes non-strings through untouched', () => {
    const p = makeBooleanParser();
    for (const v of [null, undefined, 0, 1, true, false, {}]) expect(run(p.parse(v))).toBe(v);
  });

  it('accepts custom word lists', () => {
    const p = makeBooleanParser(['y', 'yes'], ['n', 'no']);
    expect(run(p.parse('Y'))).toBe(true);
    expect(run(p.parse('NO'))).toBe(false);
    expect(run(p.parse('true'))).toBe('true');
  });

  it('treats an empty list as matching nothing', () => {
    const p = makeBooleanParser([], []);
    expect(run(p.parse('true'))).toBe('true');
    expect(run(p.parse('false'))).toBe('false');
  });

  it('falls back to the default lists when given undefined', () => {
    const p = makeBooleanParser(undefined, undefined);
    expect(run(p.parse('true'))).toBe(true);
    expect(run(p.parse('false'))).toBe(false);
  });

  it('wraps in a FinalValue only when the final flag is set', () => {
    expect(run(makeBooleanParser().parse('true'))).toBe(true);
    expect(isFinalValue(run(makeBooleanParser(undefined, undefined, true).parse('true')))).toBe(true);
    expect(isFinalValue(run(makeBooleanParser(undefined, undefined, true).parse('false')))).toBe(true);
    // A non-match is never wrapped — there is no new value to finalise.
    expect(run(makeBooleanParser(undefined, undefined, true).parse('maybe'))).toBe('maybe');
  });
});

// ─── NumberValueParser ─────────────────────────────────────────────────────────────────────────────────────────

describe('NumberValueParser', () => {
  const p = makeNumberValueParser();

  it('converts plain integers and decimals', () => {
    expect(run(p.parse('42'))).toBe(42);
    expect(run(p.parse('-42'))).toBe(-42);
    expect(run(p.parse('3.14'))).toBe(3.14);
    expect(run(p.parse('.5'))).toBe(0.5);
    expect(run(p.parse('5.'))).toBe(5);
  });

  it('leaves non-numeric strings alone', () => {
    for (const v of ['', 'abc', '1.2.3', '12px', '1_000', '1,000', '  ']) expect(run(p.parse(v))).toBe(v);
  });

  it('passes non-strings through untouched', () => {
    for (const v of [null, undefined, 0, 1, true, {}, []]) expect(run(p.parse(v))).toBe(v);
  });

  // strnum's own defaults are permissive — hex, exponents, leading zeros and a
  // leading plus are all accepted out of the box. These assert that permissiveness
  // so a future dependency bump that tightened it would surface here, and that
  // the options this package's registry passes do not change it.
  it('accepts hex, exponent, leading-zero and plus forms by default', () => {
    expect(run(p.parse('0x1f'))).toBe(31);
    expect(run(p.parse('1e3'))).toBe(1000);
    expect(run(p.parse('007'))).toBe(7);
    expect(run(p.parse('+5'))).toBe(5);
  });

  it('behaves identically with the registry default options', () => {
    const configured = makeNumberValueParser({ hex: true, leadingZeros: true, eNotation: true });
    for (const v of ['0x1f', '1e3', '007', '+5', '42', 'abc']) {
      expect(run(configured.parse(v))).toBe(run(p.parse(v)));
    }
  });

  it('refuses binary and octal prefixes unless asked', () => {
    expect(run(p.parse('0b11'))).toBe('0b11');
    expect(run(p.parse('0o17'))).toBe('0o17');
    expect(run(makeNumberValueParser({ binary: true }).parse('0b11'))).toBe(3);
    expect(run(makeNumberValueParser({ octal: true }).parse('0o17'))).toBe(15);
  });

  it('rejects leading zeros when leadingZeros is off', () => {
    expect(run(makeNumberValueParser({ leadingZeros: false }).parse('007'))).toBe('007');
    expect(run(makeNumberValueParser({ leadingZeros: false }).parse('07'))).toBe('07');
    // A zero before a decimal point is not a leading zero, so it still converts.
    expect(run(makeNumberValueParser({ leadingZeros: false }).parse('0.5'))).toBe(0.5);
  });

  it('wraps the result in a FinalValue whenever the final flag is set', () => {
    expect(isFinalValue(run(makeNumberValueParser({}, true).parse('42')))).toBe(true);
    expect((run(makeNumberValueParser({}, true).parse('42')) as { value: unknown }).value).toBe(42);
    // Including when the value did not convert. With the final flag set, this
    // parser ends the chain even for input it did not touch. Preserved as-is and
    // asserted here so the behaviour is a decision rather than an accident: a
    // chain using a final number parser stops after it regardless.
    expect(isFinalValue(run(makeNumberValueParser({}, true).parse('abc')))).toBe(true);
    expect((run(makeNumberValueParser({}, true).parse('abc')) as { value: unknown }).value).toBe('abc');
  });
});

// ─── WSNormalizer ───────────────────────────────────────────────────────────────────────────────────────────

describe('WSNormalizer', () => {
  const ws = wsNormalizerBuiltin();

  it('collapses internal runs to a single space and trims both ends', () => {
    expect(run(ws.parse('  a  b  '))).toBe('a b');
    expect(run(ws.parse('a\t\tb'))).toBe('a b');
    expect(run(ws.parse('a\r\n\r\nb'))).toBe('a b');
    expect(run(ws.parse('   '))).toBe('');
  });

  it('passes non-strings through untouched', () => {
    for (const v of [null, undefined, 0, 1, true, {}, []]) expect(run(ws.parse(v))).toBe(v);
  });

  it('normalizes when there is no context at all', () => {
    expect(run(ws.parse('  a  b  '))).toBe('a b');
  });

  it('leaves an attribute value alone — attribute whitespace is data, not layout', () => {
    const ctx = makeContext('a', atA(), true, true);
    expect(run(ws.parse('  a  b  ', ctx))).toBe('  a  b  ');
  });

  it('normalizes element text when the context says it is not an attribute', () => {
    const ctx = makeContext('a', atA(), true, false);
    expect(run(ws.parse('  a  b  ', ctx))).toBe('a b');
  });

  it('leaves the value alone under xml:space="preserve"', () => {
    const matcher = new Matcher();
    matcher.push('root', { 'xml:space': 'preserve' }, null, { keep: ['xml:space'] });
    matcher.push('pre');
    const ctx = makeContext('pre', matcher.readOnly(), true, false);
    expect(run(ws.parse('  a  b  ', ctx))).toBe('  a  b  ');
  });

  it('scopes the preserve to its own subtree — a sibling is normalized again', () => {
    // `getAnyParentAttr` walks the kept-attribute stack, so the scope ends when
    // the node that declared it is popped, not merely when a sibling is entered.
    const matcher = new Matcher();
    matcher.push('keepme', { 'xml:space': 'preserve' }, null, { keep: ['xml:space'] });
    matcher.push('pre');
    expect(run(ws.parse('  a  b  ', makeContext('pre', matcher.readOnly(), true, false)))).toBe('  a  b  ');

    matcher.pop();
    matcher.pop();
    matcher.push('div');
    expect(run(ws.parse('  a  b  ', makeContext('div', matcher.readOnly(), true, false)))).toBe('a b');
  });

  it('normalizes in a subtree that never declared preserve', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('pre');
    expect(run(ws.parse('  a  b  ', makeContext('pre', matcher.readOnly(), true, false)))).toBe('a b');
  });

  it('leaves an excluded path alone, at any depth', () => {
    const parser = run(makeWSNormalizer({ exclude: ['..pre'] }));
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('section');
    matcher.push('pre');
    const ctx = makeContext('pre', matcher.readOnly(), true, false);
    expect(run(parser.parse('  a  b  ', ctx))).toBe('  a  b  ');
  });

  it('normalizes a path that is not excluded', () => {
    const parser = run(makeWSNormalizer({ exclude: ['..pre'] }));
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('div');
    const ctx = makeContext('div', matcher.readOnly(), true, false);
    expect(run(parser.parse('  a  b  ', ctx))).toBe('a b');
  });

  it('accepts a pre-compiled Expression in exclude', () => {
    const parser = run(makeWSNormalizer({ exclude: [runXml(Expression.make('..code'))] }));
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('code');
    expect(run(parser.parse('  a  b  ', makeContext('code', matcher.readOnly(), true, false)))).toBe('  a  b  ');
  });

  it('normalizes when exclude is empty', () => {
    const parser = run(makeWSNormalizer({ exclude: [] }));
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('pre');
    expect(run(parser.parse('  a  b  ', makeContext('pre', matcher.readOnly(), true, false)))).toBe('a b');
  });
});

// ─── EntitiesValueParser ─────────────────────────────────────────────────────────────────────────────────────

describe('EntitiesValueParser', () => {
  const entities = makeEntitiesValueParser();

  it('expands the predefined XML entities', () => {
    expect(run(entities.parse('&amp;'))).toBe('&');
    expect(run(entities.parse('&lt;'))).toBe('<');
    expect(run(entities.parse('&gt;'))).toBe('>');
    expect(run(entities.parse('&quot;'))).toBe('"');
    expect(run(entities.parse('&apos;'))).toBe("'");
  });

  it('expands a numeric character reference', () => {
    expect(run(entities.parse('&#65;'))).toBe('A');
    expect(run(entities.parse('&#x41;'))).toBe('A');
  });

  it('expands several references in one value', () => {
    expect(run(entities.parse('a&amp;b&lt;c'))).toBe('a&b<c');
  });

  it('passes non-strings through untouched', () => {
    for (const v of [null, undefined, 0, 1, true, {}, []]) expect(run(entities.parse(v))).toBe(v);
  });

  it('accepts extra named entities, merged over the defaults rather than replacing them', () => {
    const parser = makeEntitiesValueParser({ namedEntities: { myent: 'X' } });
    expect(run(parser.parse('&myent;'))).toBe('X');
    // The five predefined ones still work — that is the point of merging.
    expect(run(parser.parse('&amp;'))).toBe('&');
  });

  it('can refuse numeric references', () => {
    const parser = makeEntitiesValueParser({ numericAllowed: false });
    expect(run(parser.parse('&#65;'))).not.toBe('A');
  });

  it('forgets the document on reset, so the next parse re-reads its context', () => {
    const parser = makeEntitiesValueParser();
    expect(run(parser.parse('&amp;'))).toBe('&');
    parser.reset?.();
    expect(run(parser.parse('&lt;'))).toBe('<');
  });
});

// ─── Context ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('Context', () => {
  it('carries its four fields', () => {
    const matcher = atA();
    const ctx = makeContext('tag', matcher, true, false);
    expect(ctx.elementName).toBe('tag');
    expect(ctx.matcher).toBe(matcher);
    expect(ctx.isLeafNode).toBe(true);
    expect(ctx.isAttribute).toBe(false);
  });

  it('defaults isAttribute to false and accepts null for the undetermined fields', () => {
    const ctx = makeContext('tag', null, null);
    expect(ctx.isAttribute).toBe(false);
    expect(ctx.matcher).toBeNull();
    expect(ctx.isLeafNode).toBeNull();
  });

  it('is structurally what a value parser receives', () => {
    const ctx: Context = makeContext('tag', null, true, true);
    expect(ctx.isAttribute).toBe(true);
  });
});
