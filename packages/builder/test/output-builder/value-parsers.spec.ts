/**
 * @description Specs for the five built-in value parsers and the final-value contract they share. Every parser is exercised through the same lens: what it does to
 * a value, what it leaves alone, and what happens when the final flag is set. Those cases matter more than they look — the final flag is the only way
 * a parser ends a chain, so a regression there silently changes every value downstream of it. The parsers that consult a {@link Context} — the
 * whitespace normalizer mainly — are tested against a real `Matcher` from `@endevops/common-xml`, since a hand-built stub would only prove the stub
 * works.
 */

import type { MatcherView } from '@endevops/common-xml';
import type { XmlError } from '@endevops/common-xml';

import { describe, expect, it } from '@effect/vitest';
import { Expression, Matcher } from '@endevops/common-xml';
import { Effect } from 'effect';

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

/**
 * @description The one place a spec runs an effect synchronously. Several specs also need an `Expression` in place before a parser is configured, and
 * `Expression.make` fails with `common-xml`'s `XmlError` rather than this package's `BuilderError`. A local runner for that channel keeps those call
 * sites free of casts.
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

  it.effect('trims a string', () =>
    Effect.gen(function* () {
      expect(yield* trim.parse('  x  ')).toBe('x');
      expect(yield* trim.parse('\t\nx\r\n')).toBe('x');
    })
  );

  it.effect('leaves an already-trimmed string alone', () =>
    Effect.gen(function* () {
      expect(yield* trim.parse('x')).toBe('x');
      expect(yield* trim.parse('')).toBe('');
    })
  );

  it.effect('only trims the ends — internal runs survive', () =>
    Effect.gen(function* () {
      expect(yield* trim.parse('  a  b  ')).toBe('a  b');
    })
  );

  it.effect('passes non-strings through untouched', () =>
    Effect.gen(function* () {
      for (const v of [null, undefined, 0, 1, false, true, {}, []]) {
        expect(yield* trim.parse(v)).toBe(v);
      }
    })
  );
});

// ─── BooleanParser ─────────────────────────────────────────────────────────────────────────────────────────────

describe('BooleanParser', () => {
  it.effect('converts true and false, case-insensitively', () =>
    Effect.gen(function* () {
      const p = makeBooleanParser();
      for (const v of ['true', 'TRUE', 'True', 'tRuE']) expect(yield* p.parse(v)).toBe(true);
      for (const v of ['false', 'FALSE', 'False', 'fAlSe']) expect(yield* p.parse(v)).toBe(false);
    })
  );

  it.effect('passes through anything not on either list', () =>
    Effect.gen(function* () {
      const p = makeBooleanParser();
      for (const v of ['yes', 'no', '0', '1', '', 'truthy']) expect(yield* p.parse(v)).toBe(v);
    })
  );

  it.effect('passes non-strings through untouched', () =>
    Effect.gen(function* () {
      const p = makeBooleanParser();
      for (const v of [null, undefined, 0, 1, true, false, {}]) expect(yield* p.parse(v)).toBe(v);
    })
  );

  it.effect('accepts custom word lists', () =>
    Effect.gen(function* () {
      const p = makeBooleanParser(['y', 'yes'], ['n', 'no']);
      expect(yield* p.parse('Y')).toBe(true);
      expect(yield* p.parse('NO')).toBe(false);
      expect(yield* p.parse('true')).toBe('true');
    })
  );

  it.effect('treats an empty list as matching nothing', () =>
    Effect.gen(function* () {
      const p = makeBooleanParser([], []);
      expect(yield* p.parse('true')).toBe('true');
      expect(yield* p.parse('false')).toBe('false');
    })
  );

  it.effect('falls back to the default lists when given undefined', () =>
    Effect.gen(function* () {
      const p = makeBooleanParser(undefined, undefined);
      expect(yield* p.parse('true')).toBe(true);
      expect(yield* p.parse('false')).toBe(false);
    })
  );

  it.effect('wraps in a FinalValue only when the final flag is set', () =>
    Effect.gen(function* () {
      expect(yield* makeBooleanParser().parse('true')).toBe(true);
      expect(isFinalValue(yield* makeBooleanParser(undefined, undefined, true).parse('true'))).toBe(true);
      expect(isFinalValue(yield* makeBooleanParser(undefined, undefined, true).parse('false'))).toBe(true);
      // A non-match is never wrapped — there is no new value to finalise.
      expect(yield* makeBooleanParser(undefined, undefined, true).parse('maybe')).toBe('maybe');
    })
  );
});

// ─── NumberValueParser ─────────────────────────────────────────────────────────────────────────────────────────

describe('NumberValueParser', () => {
  const p = makeNumberValueParser();

  it.effect('converts plain integers and decimals', () =>
    Effect.gen(function* () {
      expect(yield* p.parse('42')).toBe(42);
      expect(yield* p.parse('-42')).toBe(-42);
      expect(yield* p.parse('3.14')).toBe(3.14);
      expect(yield* p.parse('.5')).toBe(0.5);
      expect(yield* p.parse('5.')).toBe(5);
    })
  );

  it.effect('leaves non-numeric strings alone', () =>
    Effect.gen(function* () {
      for (const v of ['', 'abc', '1.2.3', '12px', '1_000', '1,000', '  ']) expect(yield* p.parse(v)).toBe(v);
    })
  );

  it.effect('passes non-strings through untouched', () =>
    Effect.gen(function* () {
      for (const v of [null, undefined, 0, 1, true, {}, []]) expect(yield* p.parse(v)).toBe(v);
    })
  );

  // strnum's own defaults are permissive — hex, exponents, leading zeros and a
  // leading plus are all accepted out of the box. These assert that permissiveness
  // so a future dependency bump that tightened it would surface here, and that
  // the options this package's registry passes do not change it.
  it.effect('accepts hex, exponent, leading-zero and plus forms by default', () =>
    Effect.gen(function* () {
      expect(yield* p.parse('0x1f')).toBe(31);
      expect(yield* p.parse('1e3')).toBe(1000);
      expect(yield* p.parse('007')).toBe(7);
      expect(yield* p.parse('+5')).toBe(5);
    })
  );

  it.effect('behaves identically with the registry default options', () =>
    Effect.gen(function* () {
      const configured = makeNumberValueParser({ hex: true, leadingZeros: true, eNotation: true });
      for (const v of ['0x1f', '1e3', '007', '+5', '42', 'abc']) {
        expect(yield* configured.parse(v)).toBe(yield* p.parse(v));
      }
    })
  );

  it.effect('refuses binary and octal prefixes unless asked', () =>
    Effect.gen(function* () {
      expect(yield* p.parse('0b11')).toBe('0b11');
      expect(yield* p.parse('0o17')).toBe('0o17');
      expect(yield* makeNumberValueParser({ binary: true }).parse('0b11')).toBe(3);
      expect(yield* makeNumberValueParser({ octal: true }).parse('0o17')).toBe(15);
    })
  );

  it.effect('rejects leading zeros when leadingZeros is off', () =>
    Effect.gen(function* () {
      expect(yield* makeNumberValueParser({ leadingZeros: false }).parse('007')).toBe('007');
      expect(yield* makeNumberValueParser({ leadingZeros: false }).parse('07')).toBe('07');
      // A zero before a decimal point is not a leading zero, so it still converts.
      expect(yield* makeNumberValueParser({ leadingZeros: false }).parse('0.5')).toBe(0.5);
    })
  );

  it.effect('wraps the result in a FinalValue whenever the final flag is set', () =>
    Effect.gen(function* () {
      expect(isFinalValue(yield* makeNumberValueParser({}, true).parse('42'))).toBe(true);
      expect((yield* makeNumberValueParser({}, true).parse('42') as { value: unknown }).value).toBe(42);
      // Including when the value did not convert. With the final flag set, this
      // parser ends the chain even for input it did not touch. Preserved as-is and
      // asserted here so the behaviour is a decision rather than an accident: a
      // chain using a final number parser stops after it regardless.
      expect(isFinalValue(yield* makeNumberValueParser({}, true).parse('abc'))).toBe(true);
      expect((yield* makeNumberValueParser({}, true).parse('abc') as { value: unknown }).value).toBe('abc');
    })
  );
});

// ─── WSNormalizer ───────────────────────────────────────────────────────────────────────────────────────────

describe('WSNormalizer', () => {
  const ws = wsNormalizerBuiltin();

  it.effect('collapses internal runs to a single space and trims both ends', () =>
    Effect.gen(function* () {
      expect(yield* ws.parse('  a  b  ')).toBe('a b');
      expect(yield* ws.parse('a\t\tb')).toBe('a b');
      expect(yield* ws.parse('a\r\n\r\nb')).toBe('a b');
      expect(yield* ws.parse('   ')).toBe('');
    })
  );

  it.effect('passes non-strings through untouched', () =>
    Effect.gen(function* () {
      for (const v of [null, undefined, 0, 1, true, {}, []]) expect(yield* ws.parse(v)).toBe(v);
    })
  );

  it.effect('normalizes when there is no context at all', () =>
    Effect.gen(function* () {
      expect(yield* ws.parse('  a  b  ')).toBe('a b');
    })
  );

  it.effect('leaves an attribute value alone — attribute whitespace is data, not layout', () =>
    Effect.gen(function* () {
      const ctx = makeContext('a', atA(), true, true);
      expect(yield* ws.parse('  a  b  ', ctx)).toBe('  a  b  ');
    })
  );

  it.effect('normalizes element text when the context says it is not an attribute', () =>
    Effect.gen(function* () {
      const ctx = makeContext('a', atA(), true, false);
      expect(yield* ws.parse('  a  b  ', ctx)).toBe('a b');
    })
  );

  it.effect('leaves the value alone under xml:space="preserve"', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root', { 'xml:space': 'preserve' }, null, { keep: ['xml:space'] });
      matcher.push('pre');
      const ctx = makeContext('pre', matcher.readOnly(), true, false);
      expect(yield* ws.parse('  a  b  ', ctx)).toBe('  a  b  ');
    })
  );

  it.effect('scopes the preserve to its own subtree — a sibling is normalized again', () =>
    Effect.gen(function* () {
      // `getAnyParentAttr` walks the kept-attribute stack, so the scope ends when
      // the node that declared it is popped, not merely when a sibling is entered.
      const matcher = new Matcher();
      matcher.push('keepme', { 'xml:space': 'preserve' }, null, { keep: ['xml:space'] });
      matcher.push('pre');
      expect(yield* ws.parse('  a  b  ', makeContext('pre', matcher.readOnly(), true, false))).toBe('  a  b  ');

      matcher.pop();
      matcher.pop();
      matcher.push('div');
      expect(yield* ws.parse('  a  b  ', makeContext('div', matcher.readOnly(), true, false))).toBe('a b');
    })
  );

  it.effect('normalizes in a subtree that never declared preserve', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('pre');
      expect(yield* ws.parse('  a  b  ', makeContext('pre', matcher.readOnly(), true, false))).toBe('a b');
    })
  );

  it.effect('leaves an excluded path alone, at any depth', () =>
    Effect.gen(function* () {
      const parser = yield* makeWSNormalizer({ exclude: ['..pre'] });
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('section');
      matcher.push('pre');
      const ctx = makeContext('pre', matcher.readOnly(), true, false);
      expect(yield* parser.parse('  a  b  ', ctx)).toBe('  a  b  ');
    })
  );

  it.effect('normalizes a path that is not excluded', () =>
    Effect.gen(function* () {
      const parser = yield* makeWSNormalizer({ exclude: ['..pre'] });
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('div');
      const ctx = makeContext('div', matcher.readOnly(), true, false);
      expect(yield* parser.parse('  a  b  ', ctx)).toBe('a b');
    })
  );

  it.effect('accepts a pre-compiled Expression in exclude', () =>
    Effect.gen(function* () {
      const parser = yield* makeWSNormalizer({ exclude: [runXml(Expression.make('..code'))] });
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('code');
      expect(yield* parser.parse('  a  b  ', makeContext('code', matcher.readOnly(), true, false))).toBe('  a  b  ');
    })
  );

  it.effect('normalizes when exclude is empty', () =>
    Effect.gen(function* () {
      const parser = yield* makeWSNormalizer({ exclude: [] });
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('pre');
      expect(yield* parser.parse('  a  b  ', makeContext('pre', matcher.readOnly(), true, false))).toBe('a b');
    })
  );
});

// ─── EntitiesValueParser ─────────────────────────────────────────────────────────────────────────────────────

describe('EntitiesValueParser', () => {
  const entities = makeEntitiesValueParser();

  it.effect('expands the predefined XML entities', () =>
    Effect.gen(function* () {
      expect(yield* entities.parse('&amp;')).toBe('&');
      expect(yield* entities.parse('&lt;')).toBe('<');
      expect(yield* entities.parse('&gt;')).toBe('>');
      expect(yield* entities.parse('&quot;')).toBe('"');
      expect(yield* entities.parse('&apos;')).toBe("'");
    })
  );

  it.effect('expands a numeric character reference', () =>
    Effect.gen(function* () {
      expect(yield* entities.parse('&#65;')).toBe('A');
      expect(yield* entities.parse('&#x41;')).toBe('A');
    })
  );

  it.effect('expands several references in one value', () =>
    Effect.gen(function* () {
      expect(yield* entities.parse('a&amp;b&lt;c')).toBe('a&b<c');
    })
  );

  it.effect('passes non-strings through untouched', () =>
    Effect.gen(function* () {
      for (const v of [null, undefined, 0, 1, true, {}, []]) expect(yield* entities.parse(v)).toBe(v);
    })
  );

  it.effect('accepts extra named entities, merged over the defaults rather than replacing them', () =>
    Effect.gen(function* () {
      const parser = makeEntitiesValueParser({ namedEntities: { myent: 'X' } });
      expect(yield* parser.parse('&myent;')).toBe('X');
      // The five predefined ones still work — that is the point of merging.
      expect(yield* parser.parse('&amp;')).toBe('&');
    })
  );

  it.effect('can refuse numeric references', () =>
    Effect.gen(function* () {
      const parser = makeEntitiesValueParser({ numericAllowed: false });
      expect(yield* parser.parse('&#65;')).not.toBe('A');
    })
  );

  it.effect('forgets the document on reset, so the next parse re-reads its context', () =>
    Effect.gen(function* () {
      const parser = makeEntitiesValueParser();
      expect(yield* parser.parse('&amp;')).toBe('&');
      parser.reset?.();
      expect(yield* parser.parse('&lt;')).toBe('<');
    })
  );
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
