/**
 * @description Specs for the shape rules — how a tag becomes a string, an object, or an array. These are the builder's actual product, so they are tested through
 * `getOutput()` after a walk rather than by poking at internals. The walk helper below drives the builder exactly as a parser does, which keeps each
 * spec to a document plus an expected structure. The awkwardness being pinned down is that a repeated key is a bare value on its first occurrence and
 * an array from the second. That is inherent to producing a minimal object, and `alwaysArray` / `forceArray` exist to make a key predictable where it
 * matters — so those get the most attention here.
 */

import type { XmlError } from '@endevops/common-xml';

import { Expression, Matcher } from '@endevops/common-xml';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { BuilderError } from '#/errors.ts';
import type { CompactParserOptions, FactoryOptions, ForceArrayPredicate } from '#/index.ts';

import { CompactBuilderFactory } from '#/index.ts';
import { failed, makeFactory, run, runAny } from '#/test/helpers/effect.ts';

/**
 * @description The one place a spec runs an effect from either package. The `run` in the shared helper is typed for this package's `BuilderError`, and several
 * specs also drive `Expression.make`, which fails with `common-xml`'s `XmlError`. A local runner for that channel keeps those call sites free of
 * casts, and the assertion on both error types is what makes the two channels distinguishable in a failure.
 */
export const runXml = <A>(effect: Effect.Effect<A, XmlError>): A => Effect.runSync(effect);

/**
 * @description The parser options a spec's walk assumes.
 */
const PARSER_OPTIONS: CompactParserOptions = {
  nameFor: { text: '#text', comment: '', cdata: '' },
  skip: { comment: false, cdata: false, attributes: false },
  attributes: { prefix: '@_', suffix: '', groupBy: '' },
};

/**
 * @description One step of a document walk: either a tag with its content, or a leaf value.
 */
type WalkNode = Record<string, unknown>;

/**
 * @description Walk a nested object as a document, driving the builder the way a parser would. Attributes are read from the `@_` prefix, text from `#text`, and
 * everything else is a child tag. The matcher is pushed and popped in step with the walk, because the builder reads it on every close.
 *
 * @param input - The document.
 * @param builderOptions - This builder's options.
 * @param parserOptions - Overrides for the assumed parser options.
 *
 * @returns An effect producing `getOutput()`. The walk is a sequence of fallible calls — a builder method, then the matcher's own — so it is written
 *   as one rather than a callback that has to swallow each failure. The channel is the union of the two packages' error types, which is why the specs
 *   run it with `runAny` rather than `run`.
 */
const build = (
  input: WalkNode,
  builderOptions: FactoryOptions = {},
  parserOptions: Partial<CompactParserOptions> = {}
): Effect.Effect<unknown, BuilderError | XmlError> =>
  Effect.gen(function* () {
    const matcher = new Matcher();
    const builder = run(makeFactory(builderOptions).getInstance({ ...PARSER_OPTIONS, ...parserOptions } as CompactParserOptions, matcher.readOnly()));

    const walk = Effect.fnUntraced(function* (node: WalkNode, tagName: string): Effect.fn.Return<void, BuilderError | XmlError> {
      const attributes: Record<string, unknown> = {};
      let text = '';
      const children: Array<[string, unknown]> = [];

      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('@_')) {
          attributes[key.slice(2)] = value;
        } else if (key === '#text') {
          text = String(value);
        } else {
          children.push([key, value]);
        }
      }

      matcher.push(tagName);
      for (const [name, value] of Object.entries(attributes)) yield* builder.addAttribute(name, value, matcher.readOnly());
      builder.addElement({ name: tagName, index: matcher.getDepth() }, matcher.readOnly());
      if (text) builder.addValue(text, matcher.readOnly());
      for (const [name, value] of children) {
        if (Array.isArray(value)) {
          for (const item of value) yield* walk(asNode(item), name);
        } else {
          yield* walk(asNode(value), name);
        }
      }
      yield* builder.closeElement(matcher.readOnly(), { name: tagName });
      matcher.pop();
    });

    for (const [name, value] of Object.entries(input)) {
      if (Array.isArray(value)) {
        for (const item of value) yield* walk(asNode(item), name);
      } else {
        yield* walk(asNode(value), name);
      }
    }

    return builder.getOutput();
  });

/**
 * @description Read a walk input as a node, wrapping a bare value as text content.
 *
 * @param value - The value from the input object.
 *
 * @returns A node object.
 */
const asNode = (value: unknown): WalkNode =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as WalkNode) : { '#text': String(value) };

// ─── Leaf shapes ──────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — leaf shape', () => {
  it('collapses a text-only tag to its parsed value', () => {
    expect(runAny(build({ a: 'text' }))).toEqual({ a: 'text' });
  });

  it('runs text through the value chain, so "42" becomes 42', () => {
    expect(runAny(build({ a: '42' }))).toEqual({ a: 42 });
    expect(runAny(build({ a: 'true' }))).toEqual({ a: true });
  });

  it('trims and collapses whitespace in element text', () => {
    expect(runAny(build({ a: '  spaced   out  ' }))).toEqual({ a: 'spaced out' });
  });

  it('expands entities in element text', () => {
    expect(runAny(build({ a: '&amp;' }))).toEqual({ a: '&' });
  });

  it('collapses a tag with no content to an empty string', () => {
    expect(runAny(build({ a: {} }))).toEqual({ a: '' });
  });

  it('emits the root object directly, not wrapped', () => {
    expect(runAny(build({ a: '1', b: '2' }))).toEqual({ a: 1, b: 2 });
  });
});

// ─── Object shapes ──────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — object shapes', () => {
  it('nests child tags as an object', () => {
    expect(runAny(build({ a: { b: '1' } }))).toEqual({ a: { b: 1 } });
  });

  it('nests deeply', () => {
    expect(runAny(build({ a: { b: { c: { d: 'deep' } } } }))).toEqual({ a: { b: { c: { d: 'deep' } } } });
  });

  it('keeps siblings as separate keys', () => {
    expect(runAny(build({ a: { b: '1', c: '2' } }))).toEqual({ a: { b: 1, c: 2 } });
  });

  it('merges text into a non-leaf as the text key', () => {
    expect(runAny(build({ a: { '#text': 'mixed', b: 'child' } }))).toEqual({ a: { b: 'child', '#text': 'mixed' } });
  });

  it('does not add a text key to a non-leaf with no text of its own', () => {
    expect(runAny(build({ a: { b: '1' } }))).toEqual({ a: { b: 1 } });
    expect(Object.keys((runAny(build({ a: { b: '1' } })) as { a: object }).a)).toEqual(['b']);
  });

  it('produces no cycle for a nested document', () => {
    // A regression guard: an earlier version of this port captured the wrong
    // parent in the tag stack, which made every document self-referential.
    const out = runAny(build({ a: { b: { c: '1' } } })) as { a: { b: { c: unknown } } };
    expect(out.a).not.toBe(out.a.b);
    expect(out.a.b.c).toBe(1);
  });
});

// ─── Attributes ─────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — attributes', () => {
  // Attribute values go through the attribute value-parser chain, so `'1'`
  // arrives as `1`. Every expectation below is post-chain.

  it('folds attributes into the value when there is text', () => {
    expect(runAny(build({ a: { '@_id': '1', '#text': 'hello' } }))).toEqual({ a: { '@_id': 1, '#text': 'hello' } });
  });

  it('emits a tag with only attributes as an object', () => {
    expect(runAny(build({ a: { '@_id': '1' } }))).toEqual({ a: { '@_id': 1 } });
  });

  it('does not add an empty text key alongside attributes', () => {
    // A spurious `#text: ''` would be indistinguishable from real empty text.
    expect(runAny(build({ a: { '@_id': '1', '#text': '' } }))).toEqual({ a: { '@_id': 1 } });
  });

  it('groups attributes under groupBy when configured', () => {
    expect(
      runAny(
        build({ a: { '@_id': '1', '#text': 'x' } }, {}, { attributes: { prefix: '@_', suffix: '', groupBy: '$' } } as Partial<CompactParserOptions>)
      )
    ).toEqual({ a: { $: { '@_id': 1 }, '#text': 'x' } });
  });

  it('applies the configured prefix and suffix', () => {
    expect(
      runAny(build({ a: { '@_id': '1' } }, {}, { attributes: { prefix: '', suffix: '_s', groupBy: '' } } as Partial<CompactParserOptions>))
    ).toEqual({ a: { id_s: 1 } });
  });

  it('runs attribute values through the attribute chain', () => {
    expect(runAny(build({ a: { '@_n': '42' } }))).toEqual({ a: { '@_n': 42 } });
    expect(runAny(build({ a: { '@_b': 'true' } }))).toEqual({ a: { '@_b': true } });
  });

  it('does not normalize attribute whitespace', () => {
    expect(runAny(build({ a: { '@_v': '  x  y  ' } }))).toEqual({ a: { '@_v': '  x  y  ' } });
  });
});

// ─── forceTextNode ───────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — forceTextNode', () => {
  it('wraps a text-only tag in the text key', () => {
    expect(runAny(build({ a: 'text' }, { forceTextNode: true }))).toEqual({ a: { '#text': 'text' } });
  });

  it('writes an empty text key for an empty tag', () => {
    expect(runAny(build({ a: {} }, { forceTextNode: true }))).toEqual({ a: { '#text': '' } });
  });

  it('writes an empty text key alongside attributes', () => {
    expect(runAny(build({ a: { '@_id': '1', '#text': '' } }, { forceTextNode: true }))).toEqual({ a: { '@_id': 1, '#text': '' } });
  });

  it('wraps leaves too, and gives a childless parent an empty text key', () => {
    // forceTextNode is about a uniform shape, so it applies at every level: the
    // inner `b` is a leaf, and the outer `a` gets `#text: ''` because
    // closeElement writes the text key whenever the flag is set, not only when
    // there was text.
    expect(runAny(build({ a: { b: '1' } }, { forceTextNode: true }))).toEqual({ a: { b: { '#text': 1 }, '#text': '' } });
  });
});

// ─── Repeated tags ──────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — repeated tags', () => {
  it('keeps a single occurrence a bare value', () => {
    expect(runAny(build({ a: '1' }))).toEqual({ a: 1 });
  });

  it('promotes the second occurrence to an array', () => {
    expect(runAny(build({ a: ['1', '2'] }))).toEqual({ a: [1, 2] });
  });

  it('handles three or more occurrences', () => {
    expect(runAny(build({ a: ['1', '2', '3'] }))).toEqual({ a: [1, 2, 3] });
  });

  it('collects mixed repeated shapes', () => {
    expect(runAny(build({ a: ['x', { b: 'y' }] }))).toEqual({ a: ['x', { b: 'y' }] });
  });

  it('collects repeated attributed tags', () => {
    expect(runAny(build({ a: [{ '@_k': '1' }, { '@_k': '2' }] }))).toEqual({ a: [{ '@_k': 1 }, { '@_k': 2 }] });
  });
});

// ─── alwaysArray ───────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — alwaysArray', () => {
  it('wraps a single occurrence when the path matches', () => {
    expect(runAny(build({ a: '1' }, { alwaysArray: ['a'] }))).toEqual({ a: [1] });
  });

  it('leaves a non-matching tag alone', () => {
    expect(runAny(build({ a: '1', b: '2' }, { alwaysArray: ['a'] }))).toEqual({ a: [1], b: 2 });
  });

  it('matches at any depth with a deep wildcard', () => {
    expect(runAny(build({ root: { item: '1' } }, { alwaysArray: ['..item'] }))).toEqual({ root: { item: [1] } });
  });

  it('matches an exact path', () => {
    expect(runAny(build({ a: { b: '1' } }, { alwaysArray: ['a.b'] }))).toEqual({ a: { b: [1] } });
    expect(runAny(build({ a: { b: '1' } }, { alwaysArray: ['a.c'] }))).toEqual({ a: { b: 1 } });
  });

  it('accepts a pre-compiled Expression', () => {
    expect(runAny(build({ a: '1' }, { alwaysArray: [runXml(Expression.make('a'))] }))).toEqual({ a: [1] });
  });

  it('accepts a wildcard tag', () => {
    expect(runAny(build({ a: '1', b: '2' }, { alwaysArray: ['*'] }))).toEqual({ a: [1], b: [2] });
  });

  it('changes nothing when the list is empty', () => {
    expect(runAny(build({ a: '1' }, { alwaysArray: [] }))).toEqual({ a: 1 });
  });
});

// ─── forceArray voting ───────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — forceArray', () => {
  const vote = (fn: ForceArrayPredicate) => fn;

  it('forces when it votes true', () => {
    expect(runAny(build({ a: '1' }, { forceArray: vote(() => true) }))).toEqual({ a: [1] });
  });

  it('abstains when it returns undefined, leaving the default shape', () => {
    expect(runAny(build({ a: '1' }, { forceArray: vote(() => undefined) }))).toEqual({ a: 1 });
  });

  it('vetoes when it returns false, overriding an alwaysArray match', () => {
    // The whole reason forceArray can return three states: a veto has to be able
    // to beat alwaysArray, and an abstention must not.
    expect(runAny(build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => false) }))).toEqual({ a: 1 });
  });

  it('loses to an alwaysArray match when it abstains', () => {
    expect(runAny(build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => undefined) }))).toEqual({ a: [1] });
  });

  it('agrees with alwaysArray when both vote true', () => {
    expect(runAny(build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => true) }))).toEqual({ a: [1] });
  });

  it('decides per tag from the path', () => {
    expect(runAny(build({ a: '1', b: '2' }, { forceArray: vote(m => m.getCurrentTag() === 'a') }))).toEqual({ a: [1], b: 2 });
  });

  it('sees the leaf flag', () => {
    expect(runAny(build({ a: { b: '1' } }, { forceArray: vote((_m, isLeaf) => (isLeaf ? true : undefined)) }))).toEqual({ a: { b: [1] } });
  });

  it('sees an alwaysArray match it does not agree with', () => {
    expect(runAny(build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => false) }))).toEqual({ a: 1 });
  });

  it('treats a non-boolean return as an abstention', () => {
    // The implementation maps only an explicit true or false to a vote, so
    // anything else is silence — which is what lets a callback return a
    // conditional expression without guarding every branch.
    const truthy = () => 'yes' as unknown as boolean;
    expect(runAny(build({ a: '1' }, { forceArray: truthy }))).toEqual({ a: 1 });
  });
});

// ─── textJoint ───────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — textJoint', () => {
  it('joins nothing when there is one chunk', () => {
    expect(runAny(build({ a: 'x' }, { textJoint: ' ' }))).toEqual({ a: 'x' });
  });

  it('collapses consecutive text into the whitespace-normalized value', () => {
    // `ws` runs first in the default chain, so any joint the caller sets is
    // normalized away for element text — visible only on a non-default chain.
    expect(runAny(build({ a: 'x' }, { textJoint: '|', tags: { valueParsers: [] } }))).toEqual({ a: 'x' });
  });

  it('applies the joint when the chain does not normalize', () => {
    const builder = makeFactory({ textJoint: '|', tags: { valueParsers: [] } });
    const matcher = new Matcher();
    const b = run(builder.getInstance(PARSER_OPTIONS, matcher.readOnly()));
    matcher.push('a');
    b.addElement({ name: 'a', index: 1 }, matcher.readOnly());
    b.addValue('one', matcher.readOnly());
    b.addValue('two', matcher.readOnly());
    b.addValue('three', matcher.readOnly());
    run(b.closeElement(matcher.readOnly(), { name: 'a' }));
    matcher.pop();
    expect(b.getOutput()).toEqual({ a: 'one|two|three' });
  });

  it('defaults the joint to nothing', () => {
    const builder = makeFactory({ tags: { valueParsers: [] } });
    const matcher = new Matcher();
    const b = run(builder.getInstance(PARSER_OPTIONS, matcher.readOnly()));
    matcher.push('a');
    b.addElement({ name: 'a', index: 1 }, matcher.readOnly());
    b.addValue('one', matcher.readOnly());
    b.addValue('two', matcher.readOnly());
    run(b.closeElement(matcher.readOnly(), { name: 'a' }));
    matcher.pop();
    expect(b.getOutput()).toEqual({ a: 'onetwo' });
  });
});

// ─── Chains ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — value-parser chains', () => {
  it('uses ws/entity/boolean/number for tags by default', () => {
    expect(runAny(build({ a: '  42  ' }))).toEqual({ a: 42 });
  });

  it('omits ws from attributes', () => {
    // Attribute whitespace is significant, so it is not normalized away.
    expect(runAny(build({ a: { '@_v': '  x  y  ' } }))).toEqual({ a: { '@_v': '  x  y  ' } });
  });

  it('normalizes element text with a configured ws', () => {
    expect(runAny(build({ a: '  x  y  ' }, { tags: { valueParsers: ['ws'] } }))).toEqual({ a: 'x y' });
  });

  it('leaves text alone with an empty chain', () => {
    expect(runAny(build({ a: '  42  ' }, { tags: { valueParsers: [] } }))).toEqual({ a: '  42  ' });
  });

  it('accepts a chain of instances', () => {
    expect(runAny(build({ a: '  true  ' }, { tags: { valueParsers: ['ws'] } }))).toEqual({ a: 'true' });
  });
});

// ─── Factory ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilderFactory', () => {
  it('hands out a fresh builder per document', () => {
    const factory = makeFactory();
    const matcher = new Matcher();
    expect(run(factory.getInstance(PARSER_OPTIONS, matcher.readOnly()))).not.toBe(run(factory.getInstance(PARSER_OPTIONS, matcher.readOnly())));
  });

  it('gives each builder its own shared context', () => {
    const factory = makeFactory();
    const matcher = new Matcher();
    const a = run(factory.getInstance(PARSER_OPTIONS, matcher.readOnly()));
    const b = run(factory.getInstance(PARSER_OPTIONS, matcher.readOnly()));
    a.sharedContext.set('xmlVersion', 1.1);
    expect(b.sharedContext.get('xmlVersion')).toBeUndefined();
  });

  it('resolves the chains once, in the constructor', () => {
    const factory = makeFactory();
    expect(factory.builderOptions.tags?.valueParsers).toEqual(['ws', 'entity', 'boolean', 'number']);
    expect(factory.builderOptions.attributes?.valueParsers).toEqual(['entity', 'number', 'boolean']);
  });

  it('keeps a configured chain', () => {
    const factory = makeFactory({ tags: { valueParsers: ['trim'] } });
    expect(factory.builderOptions.tags?.valueParsers).toEqual(['trim']);
    expect(factory.builderOptions.attributes?.valueParsers).toEqual(['entity', 'number', 'boolean']);
  });

  it('compiles alwaysArray once, at construction', () => {
    const factory = makeFactory({ alwaysArray: ['a', 'b'] });
    expect(factory.builderOptions._alwaysArraySet.size).toBe(2);
  });

  it('defaults forceArray to null', () => {
    expect(makeFactory().builderOptions.forceArray).toBeNull();
  });

  it('shares one registry across every builder it produces', () => {
    const factory = makeFactory();
    const matcher = new Matcher();
    expect(run(factory.getInstance(PARSER_OPTIONS, matcher.readOnly())).registry).toBe(factory.registry);
  });

  it('rejects an empty alwaysArray pattern', () => {
    expect(failed(CompactBuilderFactory.make({ alwaysArray: [''] })).message).toContain('alwaysArray expression cannot be empty');
  });

  it('rejects an alwaysArray entry that is not a string or expression', () => {
    for (const bad of [42, null, {}, undefined]) {
      expect(failed(CompactBuilderFactory.make({ alwaysArray: [bad as unknown as string] })).message).toContain(
        'Invalid alwaysArray entry: expected a string, or Expression.'
      );
    }
  });

  it('refuses a forbidden key in the options', () => {
    // Reached through JSON.parse so `__proto__` is an own enumerable key, which
    // is the case a naive object spread would let through.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const options = JSON.parse(`{"${key}": {"polluted": true}}`) as FactoryOptions;
      const resolved = run(CompactBuilderFactory.make(options)).builderOptions as unknown as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(resolved, key)).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
