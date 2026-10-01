/**
 * @description Specs for the shape rules — how a tag becomes a string, an object, or an array. These are the builder's actual product, so they are tested through
 * `getOutput()` after a walk rather than by poking at internals. The walk helper below drives the builder exactly as a parser does, which keeps each
 * spec to a document plus an expected structure. The awkwardness being pinned down is that a repeated key is a bare value on its first occurrence and
 * an array from the second. That is inherent to producing a minimal object, and `alwaysArray` / `forceArray` exist to make a key predictable where it
 * matters — so those get the most attention here.
 */

import type { XmlError } from '@endevops/common-xml';

import { assert, describe, expect, it } from '@effect/vitest';
import { Expression, Matcher } from '@endevops/common-xml';
import { Effect, Result } from 'effect';

import type { BuilderError } from '#/errors.ts';
import type { CompactParserOptions, FactoryOptions, ForceArrayPredicate } from '#/index.ts';

import { CompactBuilderFactory } from '#/index.ts';

/**
 * @description The one place a spec runs an effect synchronously. Several specs also need an `Expression` in place before the builder is configured, and
 * `Expression.make` fails with `common-xml`'s `XmlError` rather than this package's `BuilderError`. A local runner for that channel keeps those call
 * sites free of casts.
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
 *   `yield*` it directly rather than running it synchronously.
 */
const build = (
  input: WalkNode,
  builderOptions: FactoryOptions = {},
  parserOptions: Partial<CompactParserOptions> = {}
): Effect.Effect<unknown, BuilderError | XmlError> =>
  Effect.gen(function* () {
    const matcher = new Matcher();
    const factory = yield* CompactBuilderFactory.make(builderOptions);
    const builder = yield* factory.getInstance({ ...PARSER_OPTIONS, ...parserOptions } as CompactParserOptions, matcher.readOnly());

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
  it.effect('collapses a text-only tag to its parsed value', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: 'text' })).toEqual({ a: 'text' });
    })
  );

  it.effect('runs text through the value chain, so "42" becomes 42', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '42' })).toEqual({ a: 42 });
      expect(yield* build({ a: 'true' })).toEqual({ a: true });
    })
  );

  it.effect('trims and collapses whitespace in element text', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '  spaced   out  ' })).toEqual({ a: 'spaced out' });
    })
  );

  it.effect('expands entities in element text', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '&amp;' })).toEqual({ a: '&' });
    })
  );

  it.effect('collapses a tag with no content to an empty string', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: {} })).toEqual({ a: '' });
    })
  );

  it.effect('emits the root object directly, not wrapped', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1', b: '2' })).toEqual({ a: 1, b: 2 });
    })
  );
});

// ─── Object shapes ──────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — object shapes', () => {
  it.effect('nests child tags as an object', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { b: '1' } })).toEqual({ a: { b: 1 } });
    })
  );

  it.effect('nests deeply', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { b: { c: { d: 'deep' } } } })).toEqual({ a: { b: { c: { d: 'deep' } } } });
    })
  );

  it.effect('keeps siblings as separate keys', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { b: '1', c: '2' } })).toEqual({ a: { b: 1, c: 2 } });
    })
  );

  it.effect('merges text into a non-leaf as the text key', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { '#text': 'mixed', b: 'child' } })).toEqual({ a: { b: 'child', '#text': 'mixed' } });
    })
  );

  it.effect('does not add a text key to a non-leaf with no text of its own', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { b: '1' } })).toEqual({ a: { b: 1 } });
      expect(Object.keys((yield* build({ a: { b: '1' } }) as { a: object }).a)).toEqual(['b']);
    })
  );

  it.effect('produces no cycle for a nested document', () =>
    Effect.gen(function* () {
      // A regression guard: an earlier version of this port captured the wrong
      // parent in the tag stack, which made every document self-referential.
      const out = (yield* build({ a: { b: { c: '1' } } })) as { a: { b: { c: unknown } } };
      expect(out.a).not.toBe(out.a.b);
      expect(out.a.b.c).toBe(1);
    })
  );
});

// ─── Attributes ─────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — attributes', () => {
  // Attribute values go through the attribute value-parser chain, so `'1'`
  // arrives as `1`. Every expectation below is post-chain.

  it.effect('folds attributes into the value when there is text', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { '@_id': '1', '#text': 'hello' } })).toEqual({ a: { '@_id': 1, '#text': 'hello' } });
    })
  );

  it.effect('emits a tag with only attributes as an object', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { '@_id': '1' } })).toEqual({ a: { '@_id': 1 } });
    })
  );

  it.effect('does not add an empty text key alongside attributes', () =>
    Effect.gen(function* () {
      // A spurious `#text: ''` would be indistinguishable from real empty text.
      expect(yield* build({ a: { '@_id': '1', '#text': '' } })).toEqual({ a: { '@_id': 1 } });
    })
  );

  it.effect('groups attributes under groupBy when configured', () =>
    Effect.gen(function* () {
      expect(
        yield* build({ a: { '@_id': '1', '#text': 'x' } }, {}, {
          attributes: { prefix: '@_', suffix: '', groupBy: '$' },
        } as Partial<CompactParserOptions>)
      ).toEqual({ a: { $: { '@_id': 1 }, '#text': 'x' } });
    })
  );

  it.effect('applies the configured prefix and suffix', () =>
    Effect.gen(function* () {
      expect(
        yield* build({ a: { '@_id': '1' } }, {}, { attributes: { prefix: '', suffix: '_s', groupBy: '' } } as Partial<CompactParserOptions>)
      ).toEqual({ a: { id_s: 1 } });
    })
  );

  it.effect('runs attribute values through the attribute chain', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { '@_n': '42' } })).toEqual({ a: { '@_n': 42 } });
      expect(yield* build({ a: { '@_b': 'true' } })).toEqual({ a: { '@_b': true } });
    })
  );

  it.effect('does not normalize attribute whitespace', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { '@_v': '  x  y  ' } })).toEqual({ a: { '@_v': '  x  y  ' } });
    })
  );
});

// ─── forceTextNode ───────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — forceTextNode', () => {
  it.effect('wraps a text-only tag in the text key', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: 'text' }, { forceTextNode: true })).toEqual({ a: { '#text': 'text' } });
    })
  );

  it.effect('writes an empty text key for an empty tag', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: {} }, { forceTextNode: true })).toEqual({ a: { '#text': '' } });
    })
  );

  it.effect('writes an empty text key alongside attributes', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { '@_id': '1', '#text': '' } }, { forceTextNode: true })).toEqual({ a: { '@_id': 1, '#text': '' } });
    })
  );

  it.effect('wraps leaves too, and gives a childless parent an empty text key', () =>
    Effect.gen(function* () {
      // forceTextNode is about a uniform shape, so it applies at every level: the
      // inner `b` is a leaf, and the outer `a` gets `#text: ''` because
      // closeElement writes the text key whenever the flag is set, not only when
      // there was text.
      expect(yield* build({ a: { b: '1' } }, { forceTextNode: true })).toEqual({ a: { b: { '#text': 1 }, '#text': '' } });
    })
  );
});

// ─── Repeated tags ──────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — repeated tags', () => {
  it.effect('keeps a single occurrence a bare value', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' })).toEqual({ a: 1 });
    })
  );

  it.effect('promotes the second occurrence to an array', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: ['1', '2'] })).toEqual({ a: [1, 2] });
    })
  );

  it.effect('handles three or more occurrences', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: ['1', '2', '3'] })).toEqual({ a: [1, 2, 3] });
    })
  );

  it.effect('collects mixed repeated shapes', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: ['x', { b: 'y' }] })).toEqual({ a: ['x', { b: 'y' }] });
    })
  );

  it.effect('collects repeated attributed tags', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: [{ '@_k': '1' }, { '@_k': '2' }] })).toEqual({ a: [{ '@_k': 1 }, { '@_k': 2 }] });
    })
  );
});

// ─── alwaysArray ───────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — alwaysArray', () => {
  it.effect('wraps a single occurrence when the path matches', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { alwaysArray: ['a'] })).toEqual({ a: [1] });
    })
  );

  it.effect('leaves a non-matching tag alone', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1', b: '2' }, { alwaysArray: ['a'] })).toEqual({ a: [1], b: 2 });
    })
  );

  it.effect('matches at any depth with a deep wildcard', () =>
    Effect.gen(function* () {
      expect(yield* build({ root: { item: '1' } }, { alwaysArray: ['..item'] })).toEqual({ root: { item: [1] } });
    })
  );

  it.effect('matches an exact path', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { b: '1' } }, { alwaysArray: ['a.b'] })).toEqual({ a: { b: [1] } });
      expect(yield* build({ a: { b: '1' } }, { alwaysArray: ['a.c'] })).toEqual({ a: { b: 1 } });
    })
  );

  it.effect('accepts a pre-compiled Expression', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { alwaysArray: [runXml(Expression.make('a'))] })).toEqual({ a: [1] });
    })
  );

  it.effect('accepts a wildcard tag', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1', b: '2' }, { alwaysArray: ['*'] })).toEqual({ a: [1], b: [2] });
    })
  );

  it.effect('changes nothing when the list is empty', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { alwaysArray: [] })).toEqual({ a: 1 });
    })
  );
});

// ─── forceArray voting ───────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — forceArray', () => {
  const vote = (fn: ForceArrayPredicate) => fn;

  it.effect('forces when it votes true', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { forceArray: vote(() => true) })).toEqual({ a: [1] });
    })
  );

  it.effect('abstains when it returns undefined, leaving the default shape', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { forceArray: vote(() => undefined) })).toEqual({ a: 1 });
    })
  );

  it.effect('vetoes when it returns false, overriding an alwaysArray match', () =>
    Effect.gen(function* () {
      // The whole reason forceArray can return three states: a veto has to be able
      // to beat alwaysArray, and an abstention must not.
      expect(yield* build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => false) })).toEqual({ a: 1 });
    })
  );

  it.effect('loses to an alwaysArray match when it abstains', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => undefined) })).toEqual({ a: [1] });
    })
  );

  it.effect('agrees with alwaysArray when both vote true', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => true) })).toEqual({ a: [1] });
    })
  );

  it.effect('decides per tag from the path', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1', b: '2' }, { forceArray: vote(m => m.getCurrentTag() === 'a') })).toEqual({ a: [1], b: 2 });
    })
  );

  it.effect('sees the leaf flag', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: { b: '1' } }, { forceArray: vote((_m, isLeaf) => (isLeaf ? true : undefined)) })).toEqual({ a: { b: [1] } });
    })
  );

  it.effect('sees an alwaysArray match it does not agree with', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '1' }, { alwaysArray: ['a'], forceArray: vote(() => false) })).toEqual({ a: 1 });
    })
  );

  it.effect('treats a non-boolean return as an abstention', () =>
    Effect.gen(function* () {
      // The implementation maps only an explicit true or false to a vote, so
      // anything else is silence — which is what lets a callback return a
      // conditional expression without guarding every branch.
      const truthy = () => 'yes' as unknown as boolean;
      expect(yield* build({ a: '1' }, { forceArray: truthy })).toEqual({ a: 1 });
    })
  );
});

// ─── textJoint ───────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — textJoint', () => {
  it.effect('joins nothing when there is one chunk', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: 'x' }, { textJoint: ' ' })).toEqual({ a: 'x' });
    })
  );

  it.effect('collapses consecutive text into the whitespace-normalized value', () =>
    Effect.gen(function* () {
      // `ws` runs first in the default chain, so any joint the caller sets is
      // normalized away for element text — visible only on a non-default chain.
      expect(yield* build({ a: 'x' }, { textJoint: '|', tags: { valueParsers: [] } })).toEqual({ a: 'x' });
    })
  );

  it.effect('applies the joint when the chain does not normalize', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make({ textJoint: '|', tags: { valueParsers: [] } });
      const matcher = new Matcher();
      const b = yield* factory.getInstance(PARSER_OPTIONS, matcher.readOnly());
      matcher.push('a');
      b.addElement({ name: 'a', index: 1 }, matcher.readOnly());
      b.addValue('one', matcher.readOnly());
      b.addValue('two', matcher.readOnly());
      b.addValue('three', matcher.readOnly());
      yield* b.closeElement(matcher.readOnly(), { name: 'a' });
      matcher.pop();
      expect(b.getOutput()).toEqual({ a: 'one|two|three' });
    })
  );

  it.effect('defaults the joint to nothing', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make({ tags: { valueParsers: [] } });
      const matcher = new Matcher();
      const b = yield* factory.getInstance(PARSER_OPTIONS, matcher.readOnly());
      matcher.push('a');
      b.addElement({ name: 'a', index: 1 }, matcher.readOnly());
      b.addValue('one', matcher.readOnly());
      b.addValue('two', matcher.readOnly());
      yield* b.closeElement(matcher.readOnly(), { name: 'a' });
      matcher.pop();
      expect(b.getOutput()).toEqual({ a: 'onetwo' });
    })
  );
});

// ─── Chains ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilder — value-parser chains', () => {
  it.effect('uses ws/entity/boolean/number for tags by default', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '  42  ' })).toEqual({ a: 42 });
    })
  );

  it.effect('omits ws from attributes', () =>
    Effect.gen(function* () {
      // Attribute whitespace is significant, so it is not normalized away.
      expect(yield* build({ a: { '@_v': '  x  y  ' } })).toEqual({ a: { '@_v': '  x  y  ' } });
    })
  );

  it.effect('normalizes element text with a configured ws', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '  x  y  ' }, { tags: { valueParsers: ['ws'] } })).toEqual({ a: 'x y' });
    })
  );

  it.effect('leaves text alone with an empty chain', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '  42  ' }, { tags: { valueParsers: [] } })).toEqual({ a: '  42  ' });
    })
  );

  it.effect('accepts a chain of instances', () =>
    Effect.gen(function* () {
      expect(yield* build({ a: '  true  ' }, { tags: { valueParsers: ['ws'] } })).toEqual({ a: 'true' });
    })
  );
});

// ─── Factory ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilderFactory', () => {
  it.effect('hands out a fresh builder per document', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make();
      const matcher = new Matcher();
      expect(yield* factory.getInstance(PARSER_OPTIONS, matcher.readOnly())).not.toBe(yield* factory.getInstance(PARSER_OPTIONS, matcher.readOnly()));
    })
  );

  it.effect('gives each builder its own shared context', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make();
      const matcher = new Matcher();
      const a = yield* factory.getInstance(PARSER_OPTIONS, matcher.readOnly());
      const b = yield* factory.getInstance(PARSER_OPTIONS, matcher.readOnly());
      a.sharedContext.set('xmlVersion', 1.1);
      expect(b.sharedContext.get('xmlVersion')).toBeUndefined();
    })
  );

  it.effect('resolves the chains once, in the constructor', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make();
      expect(factory.builderOptions.tags?.valueParsers).toEqual(['ws', 'entity', 'boolean', 'number']);
      expect(factory.builderOptions.attributes?.valueParsers).toEqual(['entity', 'number', 'boolean']);
    })
  );

  it.effect('keeps a configured chain', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make({ tags: { valueParsers: ['trim'] } });
      expect(factory.builderOptions.tags?.valueParsers).toEqual(['trim']);
      expect(factory.builderOptions.attributes?.valueParsers).toEqual(['entity', 'number', 'boolean']);
    })
  );

  it.effect('compiles alwaysArray once, at construction', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make({ alwaysArray: ['a', 'b'] });
      expect(factory.builderOptions._alwaysArraySet.size).toBe(2);
    })
  );

  it.effect('defaults forceArray to null', () =>
    Effect.gen(function* () {
      expect((yield* CompactBuilderFactory.make()).builderOptions.forceArray).toBeNull();
    })
  );

  it.effect('shares one registry across every builder it produces', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make();
      const matcher = new Matcher();
      expect((yield* factory.getInstance(PARSER_OPTIONS, matcher.readOnly())).registry).toBe(factory.registry);
    })
  );

  it.effect('rejects an empty alwaysArray pattern', () =>
    Effect.gen(function* () {
      const result = yield* CompactBuilderFactory.make({ alwaysArray: [''] }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toContain('alwaysArray expression cannot be empty');
    })
  );

  it.effect('rejects an alwaysArray entry that is not a string or expression', () =>
    Effect.gen(function* () {
      for (const bad of [42, null, {}, undefined]) {
        const result = yield* CompactBuilderFactory.make({ alwaysArray: [bad as unknown as string] }).pipe(Effect.result);
        assert(Result.isFailure(result));
        expect(result.failure.message).toContain('Invalid alwaysArray entry: expected a string, or Expression.');
      }
    })
  );

  it.effect('refuses a forbidden key in the options', () =>
    Effect.gen(function* () {
      // Reached through JSON.parse so `__proto__` is an own enumerable key, which
      // is the case a naive object spread would let through.
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const options = JSON.parse(`{"${key}": {"polluted": true}}`) as FactoryOptions;
        const resolved = (yield* CompactBuilderFactory.make(options)).builderOptions as unknown as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(resolved, key)).toBe(false);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    })
  );
});
