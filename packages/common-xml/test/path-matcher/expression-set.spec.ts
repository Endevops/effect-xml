/**
 * @description Behaviour of `ExpressionSet`, the indexed collection of parsed `Expression` patterns. Covers construction, deduplication and sealing; `matchesAny`
 * across every pattern form the parser accepts (exact paths, `*` and `..` wildcards, attribute conditions, position selectors and namespaces); the
 * bucket routing that keeps a lookup off a full scan; and `findMatch` handing back the matched expression together with its data payload. `add` and
 * `addAll` still report through an `Effect` — a sealed set is a failure, not a throw — so those two calls are `yield*`ed; every read on the set and
 * the matcher is a plain method or getter and is called directly.
 */

import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import { ExpressionSet, Matcher } from '#/index.ts';
import Expression from '#/path-matcher/expression.ts';

/**
 * @description Build a matcher positioned at the given path.
 *
 * @param tags - The tag names, root first.
 *
 * @returns A matcher sitting on that exact path.
 */
const matcherAt = (...tags: Array<string>): Matcher => {
  const m = new Matcher();
  for (const t of tags) m.push(t);
  return m;
};

/**
 * @description Build a matcher positioned at the given path, carrying attributes on its current tag.
 *
 * @param attrs - Attribute values for the terminal tag.
 * @param tags - The tag names, root first.
 *
 * @returns A matcher whose current node holds `attrs`.
 */
const matcherAtWithAttrs = (attrs: Record<string, unknown>, ...tags: Array<string>): Matcher => {
  const m = new Matcher();
  for (let i = 0; i < tags.length - 1; i++) m.push(tags[i]);
  m.push(tags[tags.length - 1], attrs);
  return m;
};

describe('ExpressionSet', () => {
  describe('construction, mutation and sealing', () => {
    it('a new set is empty and unsealed', () => {
      const set = new ExpressionSet();
      expect(set.size).toBe(0);
      expect(!set.isSealed).toBe(true);
    });

    it.effect('adds an expression, growing the size and reporting it through has()', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        const userExpr = yield* Expression.make('root.users.user');

        yield* set.add(userExpr);
        expect(set.size).toBe(1);
        expect(set.has(userExpr)).toBe(true);
        expect(set.has(yield* Expression.make('root.other'))).toBe(false);
      })
    );

    it.effect('ignores a second expression carrying an already-known pattern', () =>
      Effect.gen(function* () {
        // Deduplication
        const set = new ExpressionSet();
        const e1 = yield* Expression.make('root.users.user');
        const e2 = yield* Expression.make('root.users.user'); // same pattern, different object

        yield* set.addAll([e1, e2]);
        expect(set.size).toBe(1);
      })
    );

    it.effect('produces the set itself, so a caller can keep a reference to it', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        const result = yield* set.add(yield* Expression.make('a.b'));
        expect(result === set).toBe(true);
      })
    );

    it.effect('addAll() registers every expression and produces the set', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.addAll([yield* Expression.make('root.a'), yield* Expression.make('root.b'), yield* Expression.make('root.c')]);
        expect(set.size).toBe(3);
        const result = yield* new ExpressionSet().addAll([yield* Expression.make('x.y')]);
        expect(result instanceof ExpressionSet).toBe(true);
      })
    );

    it.effect('seal() blocks further additions and leaves the size untouched', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root.a'));
        set.seal();

        expect(set.isSealed).toBe(true);
        const addResult = yield* set.add(yield* Expression.make('root.b')).pipe(Effect.result);
        assert(Result.isFailure(addResult));
        expect(addResult.failure.message).toContain('sealed');
        const addAllResult = yield* set.addAll([yield* Expression.make('root.c')]).pipe(Effect.result);
        assert(Result.isFailure(addAllResult));
        expect(addAllResult.failure.message).toContain('sealed');
        expect(set.size).toBe(1);
      })
    );
  });

  describe('matchesAny()', () => {
    it.effect('matches exact paths and rejects partial, retagged and re-rooted ones', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.addAll([
          yield* Expression.make('root.users.user'),
          yield* Expression.make('root.config.setting'),
          yield* Expression.make('root.orders.order'),
        ]);

        expect(set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'config', 'setting'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'orders', 'order'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'users'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
        expect(!set.matchesAny(matcherAt('other', 'users', 'user'))).toBe(true);
      })
    );

    it.effect('reads a * segment as any one tag, never as a shorter path', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root.users.*'));

        expect(set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'users'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'other', 'user'))).toBe(true);
      })
    );

    it.effect('matches ..user at depth 2 and deeper but never at depth 1', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('..user'));

        // ..user requires at least one ancestor (the '..' consumes ≥1 levels before the tag)
        expect(set.matchesAny(matcherAt('root', 'user'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
        expect(set.matchesAny(matcherAt('a', 'b', 'c', 'user'))).toBe(true);
        expect(!set.matchesAny(matcherAt('user'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
      })
    );

    it.effect('matches an attribute condition only when the current node carries that value', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root.users.user[type=admin]'));

        expect(set.matchesAny(matcherAtWithAttrs({ type: 'admin' }, 'root', 'users', 'user'))).toBe(true);
        expect(!set.matchesAny(matcherAtWithAttrs({ type: 'guest' }, 'root', 'users', 'user'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
      })
    );

    it.effect('matches a :first selector only against the first sibling of that name', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root.items.item:first'));

        const m = new Matcher();
        m.push('root');
        m.push('items');
        m.push('item'); // first item, counter=0;
        expect(set.matchesAny(m)).toBe(true);
        m.pop();

        m.push('item'); // second item, counter=1;
        expect(!set.matchesAny(m)).toBe(true);
      })
    );

    it.effect('resolves a realistic config mixing exact, wildcard, deep and attribute expressions', () =>
      Effect.gen(function* () {
        const stopNodes = new ExpressionSet();
        yield* stopNodes.addAll([
          yield* Expression.make('root.users.user'), // exact
          yield* Expression.make('root.config.*'), // depth + wildcard tag
          yield* Expression.make('..script'), // deep wildcard
          yield* Expression.make('root.data.item[id=42]'), // attribute condition
        ]);

        expect(stopNodes.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
        expect(stopNodes.matchesAny(matcherAt('root', 'config', 'setting'))).toBe(true);
        expect(stopNodes.matchesAny(matcherAt('root', 'config', 'feature'))).toBe(true);
        expect(stopNodes.matchesAny(matcherAt('root', 'head', 'script'))).toBe(true);
        expect(!stopNodes.matchesAny(matcherAt('script'))).toBe(true);
        expect(stopNodes.matchesAny(matcherAtWithAttrs({ id: '42' }, 'root', 'data', 'item'))).toBe(true);
        expect(!stopNodes.matchesAny(matcherAtWithAttrs({ id: '99' }, 'root', 'data', 'item'))).toBe(true);
        expect(!stopNodes.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
      })
    );

    it('never matches when the set is empty', () => {
      const set = new ExpressionSet();
      expect(!set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
    });

    it.effect('matches through a read-only matcher view', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root.users.user'));

        const m = new Matcher();
        m.push('root');
        m.push('users');
        m.push('user');

        expect(set.matchesAny(m.readOnly())).toBe(true);
      })
    );

    it.effect('matches a namespaced tag only inside its own namespace', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root.ns::user'));

        const m = new Matcher();
        m.push('root');
        m.push('user', null, 'ns');

        expect(set.matchesAny(m)).toBe(true);

        const m2 = new Matcher();
        m2.push('root');
        m2.push('user', null, 'other');

        expect(!set.matchesAny(m2)).toBe(true);
      })
    );
  });

  describe('findMatch()', () => {
    it.effect('returns the matched expression so its data payload comes back with it', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        const expressions = [
          yield* Expression.make('root.users.user', {}, { extra: 'property' }),
          yield* Expression.make('root.config.setting'),
          yield* Expression.make('root.orders.order'),
        ];
        yield* set.addAll(expressions);

        const match1 = set.findMatch(matcherAt('root', 'users', 'user'));
        expect(match1?.data).toBe(expressions[0].data);

        const match2 = set.findMatch(matcherAt('root', 'config', 'setting'));
        expect(match2?.data).toBe(expressions[1].data);

        const match3 = set.findMatch(matcherAt('root', 'orders', 'order'));
        expect(match3?.data).toBe(expressions[2].data);
      })
    );
  });

  describe('deep wildcard indexing', () => {
    it.effect('routes ..title through its terminal tag at depths 2, 3 and 5', () =>
      Effect.gen(function* () {
        // ..tag should be indexed by terminal tag and match at various depths
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('..title'));

        expect(set.matchesAny(matcherAt('root', 'title'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'channel', 'title'))).toBe(true);
        expect(set.matchesAny(matcherAt('a', 'b', 'c', 'd', 'title'))).toBe(true);
        expect(!set.matchesAny(matcherAt('title'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'other'))).toBe(true);
      })
    );

    it.effect('leaves ..* unindexed, matching any tag at any depth above 1', () =>
      Effect.gen(function* () {
        // ..* should be unindexed and match any tag at any depth > 1
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('..*'));

        expect(set.matchesAny(matcherAt('root', 'anything'))).toBe(true);
        expect(set.matchesAny(matcherAt('a', 'b', 'c'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root'))).toBe(true);
      })
    );

    it.effect('leaves a trailing .. unindexed, so root.. covers every descendant of root', () =>
      Effect.gen(function* () {
        // root.. — terminal segment is a deep-wildcard itself, should go to unindexed
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root..'));

        expect(set.matchesAny(matcherAt('root', 'anything'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'a', 'b'))).toBe(true);
        expect(!set.matchesAny(matcherAt('other', 'anything'))).toBe(true);
      })
    );

    it.effect('indexes ..ns::user by its tag and checks the namespace during the full match', () =>
      Effect.gen(function* () {
        // ..ns::tag — indexed by "tag", namespace checked during full match
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('..ns::user'));

        const m1 = new Matcher();
        m1.push('root');
        m1.push('user', null, 'ns');
        expect(set.matchesAny(m1)).toBe(true);

        const m2 = new Matcher();
        m2.push('root');
        m2.push('user', null, 'other');
        expect(!set.matchesAny(m2)).toBe(true);

        expect(!set.matchesAny(matcherAt('root', 'user'))).toBe(true);
      })
    );

    it.effect('matches multiple deep wildcards against their literal segments', () =>
      Effect.gen(function* () {
        // root..b..d — multiple deep wildcards, indexed by terminal "d"
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('root..b..d'));

        expect(set.matchesAny(matcherAt('root', 'b', 'd'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'x', 'b', 'y', 'd'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'x', 'd'))).toBe(true);
        expect(!set.matchesAny(matcherAt('other', 'b', 'd'))).toBe(true);
      })
    );

    it.effect('resolves a mix of indexed and unindexed deep wildcards together', () =>
      Effect.gen(function* () {
        // Mix of indexed and unindexed deep wildcards should all work together
        const set = new ExpressionSet();
        yield* set.add(yield* Expression.make('..script')); // indexed by "script"
        yield* set.add(yield* Expression.make('..*')); // unindexed (terminal *)
        yield* set.add(yield* Expression.make('root..')); // unindexed (terminal ..)

        expect(set.matchesAny(matcherAt('root', 'script'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'anything'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'deep', 'path'))).toBe(true);
        expect(!set.matchesAny(matcherAt('other'))).toBe(true);
      })
    );

    it.effect('matches correctly across a set of 30 expressions', () =>
      Effect.gen(function* () {
        const set = new ExpressionSet();
        const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];

        // 10 exact two-level paths
        for (const t of tags) yield* set.add(yield* Expression.make(`root.${t}`));

        // 10 exact three-level paths
        for (const t of tags) yield* set.add(yield* Expression.make(`root.items.${t}`));

        // 5 deep wildcards
        for (const t of tags.slice(0, 5)) yield* set.add(yield* Expression.make(`..${t}`));

        // 5 wildcard-tag
        for (let i = 1; i <= 5; i++) yield* set.add(yield* Expression.make(`root.level${i}.*`));

        expect(set.size).toBe(30);

        // Spot checks
        expect(set.matchesAny(matcherAt('root', 'alpha'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'items', 'gamma'))).toBe(true);
        expect(set.matchesAny(matcherAt('a', 'b', 'c', 'beta'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'level3', 'anything'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'unknown'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'items', 'unknown'))).toBe(true);
      })
    );

    it.effect('holds 300 indexed deep wildcards and still matches only the configured tags', () =>
      Effect.gen(function* () {
        // Large set — 300 deep wildcards, correctness spot checks
        const set = new ExpressionSet();
        for (let i = 0; i < 300; i++) {
          yield* set.add(yield* Expression.make(`..tag${i}`));
        }
        expect(set.size).toBe(300);

        expect(set.matchesAny(matcherAt('root', 'child', 'tag0'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'child', 'tag150'))).toBe(true);
        expect(set.matchesAny(matcherAt('root', 'child', 'tag299'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'child', 'tag300'))).toBe(true);
        expect(!set.matchesAny(matcherAt('root', 'child', 'nonexistent'))).toBe(true);
      })
    );
  });
});
