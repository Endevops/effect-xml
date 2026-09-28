/**
 * @description Specs for the five built-in value parsers and the `BaseValueParser` contract they share. Every parser is exercised through the same lens: what it
 * does to a value, what it leaves alone, and what happens when `IS_FINAL` is set. The `IS_FINAL` cases matter more than they look — that flag is the
 * only way a parser ends a chain, so a regression there silently changes every value downstream of it. The parsers that consult a {@link Context} —
 * `WSNormalizer` mainly — are tested against a real `Matcher` from `@endevops/common-xml`, since a hand-built stub would only prove the stub works.
 */

import type { MatcherView } from '@endevops/common-xml';
import type { XmlError } from '@endevops/common-xml';

import { Expression, Matcher } from '@endevops/common-xml';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { Context } from '#/index.ts';

import {
  BaseValueParser,
  BooleanParser,
  Context as ContextClass,
  EntitiesValueParser,
  FinalValue,
  NumberValueParser,
  Trim,
  WSNormalizer,
} from '#/index.ts';
import { failedWith, run } from '#/test/helpers/effect.ts';
/**
 * @description The one place a spec runs an effect from either package. The `run` in the shared helper is typed for this package's `BuilderError`, and several
 * specs also drive `Expression.make`, which fails with `common-xml`'s `XmlError`. A local runner for that channel keeps those call sites free of
 * casts, and the assertion on both error types is what makes the two channels distinguishable in a failure.
 */
const runXml = <A>(effect: Effect.Effect<A, XmlError>): A => Effect.runSync(effect);

import type { BuilderError } from '#/errors.ts';

/**
 * @description A matcher positioned on a single `<a>` element. A real `Matcher` rather than a hand-built stub, because the parsers call real methods on it — a
 * stub would only prove the stub works. `readOnly()` is what a builder actually hands to a value parser.
 *
 * @returns The read-only view, positioned at `<a>`.
 */
const atA = (): MatcherView => {
  const matcher = new Matcher();
  runXml(matcher.push('a'));
  return runXml(matcher.readOnly());
};

/**
 * @description A value parser that counts how many times it has run, so the `IS_FINAL` short-circuit can be observed from outside.
 */
class CountingParser extends BaseValueParser {
  runs = 0;

  override parse(val: unknown): Effect.Effect<unknown, BuilderError> {
    this.runs++;
    const counted = `counted:${String(val)}`;
    return Effect.succeed(this.IS_FINAL ? new FinalValue(counted) : counted);
  }
}

/**
 * @description A value parser holding state across calls, to exercise the reset lifecycle.
 */
class StickyParser extends BaseValueParser {
  seen: string[] = [];

  override parse(val: unknown): Effect.Effect<unknown, BuilderError> {
    this.seen.push(String(val));
    return Effect.succeed(this.seen.length);
  }

  override reset(): void {
    this.seen = [];
  }
}

// ─── BaseValueParser ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('BaseValueParser', () => {
  it('defaults IS_FINAL to false', () => {
    expect(new BaseValueParser().IS_FINAL).toBe(false);
    expect(new BaseValueParser(true).IS_FINAL).toBe(true);
  });

  it('leaves ctx undefined until the pipeline injects it', () => {
    expect(new BaseValueParser().ctx).toBeUndefined();
  });

  it('fails from parse, naming the method a subclass must implement', () => {
    expect(failedWith(new BaseValueParser().parse('x'), 'NotImplemented').message).toContain('You must implement parse() in a value parser.');
  });

  it('has a no-op reset, so a stateless subclass need not override it', () => {
    expect(() => new BaseValueParser().reset()).not.toThrow();
  });

  it('wraps in FinalValue only when IS_FINAL is set', () => {
    const loose = new CountingParser();
    const tight = new CountingParser(true);
    expect(run(loose.parse('a'))).toBe('counted:a');
    expect(run(tight.parse('a'))).toBeInstanceOf(FinalValue);
    expect((run(tight.parse('a')) as FinalValue).value).toBe('counted:a');
  });
});

// ─── FinalValue ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('FinalValue', () => {
  it('carries its value verbatim, including falsy ones', () => {
    for (const v of [0, '', false, null, undefined, NaN]) {
      expect(new FinalValue(v).value).toBe(v);
    }
  });
});

// ─── Trim ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Trim', () => {
  const trim = new Trim();

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
    const p = new BooleanParser();
    for (const v of ['true', 'TRUE', 'True', 'tRuE']) expect(run(p.parse(v))).toBe(true);
    for (const v of ['false', 'FALSE', 'False', 'fAlSe']) expect(run(p.parse(v))).toBe(false);
  });

  it('passes through anything not on either list', () => {
    const p = new BooleanParser();
    for (const v of ['yes', 'no', '0', '1', '', 'truthy']) expect(run(p.parse(v))).toBe(v);
  });

  it('passes non-strings through untouched', () => {
    const p = new BooleanParser();
    for (const v of [null, undefined, 0, 1, true, false, {}]) expect(run(p.parse(v))).toBe(v);
  });

  it('accepts custom word lists', () => {
    const p = new BooleanParser(['y', 'yes'], ['n', 'no']);
    expect(run(p.parse('Y'))).toBe(true);
    expect(run(p.parse('NO'))).toBe(false);
    expect(run(p.parse('true'))).toBe('true');
  });

  it('treats an empty list as matching nothing', () => {
    const p = new BooleanParser([], []);
    expect(run(p.parse('true'))).toBe('true');
    expect(run(p.parse('false'))).toBe('false');
  });

  it('falls back to the default lists when given undefined', () => {
    const p = new BooleanParser(undefined, undefined);
    expect(run(p.parse('true'))).toBe(true);
    expect(run(p.parse('false'))).toBe(false);
  });

  it('wraps in FinalValue only when IS_FINAL is set', () => {
    expect(run(new BooleanParser().parse('true'))).toBe(true);
    expect(run(new BooleanParser(undefined, undefined, true).parse('true'))).toBeInstanceOf(FinalValue);
    expect(run(new BooleanParser(undefined, undefined, true).parse('false'))).toBeInstanceOf(FinalValue);
    // A non-match is never wrapped — there is no new value to finalise.
    expect(run(new BooleanParser(undefined, undefined, true).parse('maybe'))).toBe('maybe');
  });
});

// ─── NumberValueParser ─────────────────────────────────────────────────────────────────────────────────────────

describe('NumberValueParser', () => {
  const p = new NumberValueParser();

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
    const configured = new NumberValueParser({ hex: true, leadingZeros: true, eNotation: true });
    for (const v of ['0x1f', '1e3', '007', '+5', '42', 'abc']) {
      expect(run(configured.parse(v))).toBe(run(p.parse(v)));
    }
  });

  it('refuses binary and octal prefixes unless asked', () => {
    expect(run(p.parse('0b11'))).toBe('0b11');
    expect(run(p.parse('0o17'))).toBe('0o17');
    expect(run(new NumberValueParser({ binary: true }).parse('0b11'))).toBe(3);
    expect(run(new NumberValueParser({ octal: true }).parse('0o17'))).toBe(15);
  });

  it('rejects leading zeros when leadingZeros is off', () => {
    expect(run(new NumberValueParser({ leadingZeros: false }).parse('007'))).toBe('007');
    expect(run(new NumberValueParser({ leadingZeros: false }).parse('07'))).toBe('07');
    // A zero before a decimal point is not a leading zero, so it still converts.
    expect(run(new NumberValueParser({ leadingZeros: false }).parse('0.5'))).toBe(0.5);
  });

  it('wraps the result in FinalValue whenever IS_FINAL is set', () => {
    expect(run(new NumberValueParser({}, true).parse('42'))).toBeInstanceOf(FinalValue);
    expect((run(new NumberValueParser({}, true).parse('42')) as FinalValue).value).toBe(42);
    // Including when the value did not convert. The guard upstream intended was
    // "did strnum change the value", but `typeof newval !== val` compares a type
    // name against a value and is therefore always true — so with IS_FINAL set,
    // this parser ends the chain even for input it did not touch. Preserved as-is
    // and asserted here so the behaviour is a decision rather than an accident:
    // a chain using a final number parser stops after it regardless.
    expect(run(new NumberValueParser({}, true).parse('abc'))).toBeInstanceOf(FinalValue);
    expect((run(new NumberValueParser({}, true).parse('abc')) as FinalValue).value).toBe('abc');
  });
});

// ─── WSNormalizer ───────────────────────────────────────────────────────────────────────────────────────────

describe('WSNormalizer', () => {
  const ws = WSNormalizer.builtin();

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
    const ctx = new ContextClass('a', atA(), true, true);
    expect(run(ws.parse('  a  b  ', ctx))).toBe('  a  b  ');
  });

  it('normalizes element text when the context says it is not an attribute', () => {
    const ctx = new ContextClass('a', atA(), true, false);
    expect(run(ws.parse('  a  b  ', ctx))).toBe('a b');
  });

  it('leaves the value alone under xml:space="preserve"', () => {
    const matcher = new Matcher();
    runXml(matcher.push('root', { 'xml:space': 'preserve' }, null, { keep: ['xml:space'] }));
    runXml(matcher.push('pre'));
    const ctx = new ContextClass('pre', runXml(matcher.readOnly()), true, false);
    expect(run(ws.parse('  a  b  ', ctx))).toBe('  a  b  ');
  });

  it('scopes the preserve to its own subtree — a sibling is normalized again', () => {
    // `getAnyParentAttr` walks the kept-attribute stack, so the scope ends when
    // the node that declared it is popped, not merely when a sibling is entered.
    const matcher = new Matcher();
    runXml(matcher.push('keepme', { 'xml:space': 'preserve' }, null, { keep: ['xml:space'] }));
    runXml(matcher.push('pre'));
    expect(run(ws.parse('  a  b  ', new ContextClass('pre', runXml(matcher.readOnly()), true, false)))).toBe('  a  b  ');

    runXml(matcher.pop());
    runXml(matcher.pop());
    runXml(matcher.push('div'));
    expect(run(ws.parse('  a  b  ', new ContextClass('div', runXml(matcher.readOnly()), true, false)))).toBe('a b');
  });

  it('normalizes in a subtree that never declared preserve', () => {
    const matcher = new Matcher();
    runXml(matcher.push('root'));
    runXml(matcher.push('pre'));
    expect(run(ws.parse('  a  b  ', new ContextClass('pre', runXml(matcher.readOnly()), true, false)))).toBe('a b');
  });

  it('leaves an excluded path alone, at any depth', () => {
    const parser = run(WSNormalizer.make({ exclude: ['..pre'] }));
    const matcher = new Matcher();
    runXml(matcher.push('root'));
    runXml(matcher.push('section'));
    runXml(matcher.push('pre'));
    const ctx = new ContextClass('pre', runXml(matcher.readOnly()), true, false);
    expect(run(parser.parse('  a  b  ', ctx))).toBe('  a  b  ');
  });

  it('normalizes a path that is not excluded', () => {
    const parser = run(WSNormalizer.make({ exclude: ['..pre'] }));
    const matcher = new Matcher();
    runXml(matcher.push('root'));
    runXml(matcher.push('div'));
    const ctx = new ContextClass('div', runXml(matcher.readOnly()), true, false);
    expect(run(parser.parse('  a  b  ', ctx))).toBe('a b');
  });

  it('accepts a pre-compiled Expression in exclude', () => {
    const parser = run(WSNormalizer.make({ exclude: [runXml(Expression.make('..code'))] }));
    const matcher = new Matcher();
    runXml(matcher.push('root'));
    runXml(matcher.push('code'));
    expect(run(parser.parse('  a  b  ', new ContextClass('code', runXml(matcher.readOnly()), true, false)))).toBe('  a  b  ');
  });

  it('normalizes when exclude is empty', () => {
    const parser = run(WSNormalizer.make({ exclude: [] }));
    const matcher = new Matcher();
    runXml(matcher.push('root'));
    runXml(matcher.push('pre'));
    expect(run(parser.parse('  a  b  ', new ContextClass('pre', runXml(matcher.readOnly()), true, false)))).toBe('a b');
  });
});

// ─── EntitiesValueParser ─────────────────────────────────────────────────────────────────────────────────────

describe('EntitiesValueParser', () => {
  const entities = new EntitiesValueParser();

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
    const parser = new EntitiesValueParser({ namedEntities: { myent: 'X' } });
    expect(run(parser.parse('&myent;'))).toBe('X');
    // The five predefined ones still work — that is the point of merging.
    expect(run(parser.parse('&amp;'))).toBe('&');
  });

  it('can refuse numeric references', () => {
    const parser = new EntitiesValueParser({ numericAllowed: false });
    expect(run(parser.parse('&#65;'))).not.toBe('A');
  });

  it('forgets the document on reset, so the next parse re-reads its context', () => {
    const parser = new EntitiesValueParser();
    expect(run(parser.parse('&amp;'))).toBe('&');
    run(parser.reset());
    expect(run(parser.parse('&lt;'))).toBe('<');
  });
});

// ─── Context ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('Context', () => {
  it('carries its four fields', () => {
    const matcher = atA();
    const ctx = new ContextClass('tag', matcher, true, false);
    expect(ctx.elementName).toBe('tag');
    expect(ctx.matcher).toBe(matcher);
    expect(ctx.isLeafNode).toBe(true);
    expect(ctx.isAttribute).toBe(false);
  });

  it('defaults isAttribute to false and accepts null for the undetermined fields', () => {
    const ctx = new ContextClass('tag', null, null);
    expect(ctx.isAttribute).toBe(false);
    expect(ctx.matcher).toBeNull();
    expect(ctx.isLeafNode).toBeNull();
  });

  it('is structurally what a value parser receives', () => {
    const ctx: Context = new ContextClass('tag', null, true, true);
    expect(ctx.isAttribute).toBe(true);
  });
});

export { StickyParser };
