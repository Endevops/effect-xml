/**
 * @description Behaviour of `ExpressionSet`, the indexed collection of parsed `Expression` patterns. Covers construction, deduplication and sealing; `matchesAny`
 * across every pattern form the parser accepts (exact paths, `*` and `..` wildcards, attribute conditions, position selectors and namespaces); the
 * bucket routing that keeps a lookup off a full scan; and `findMatch` handing back the matched expression together with its data payload.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { XmlError } from '#/errors.ts';

import { ExpressionSet, Matcher } from '#/index.ts';
import { run, failed, expr } from '#/test/helpers/effect.ts';

/**
 * @description Build a matcher positioned at the given path.
 *
 * @param tags - The tag names, root first.
 *
 * @returns An effect producing a matcher sitting on that exact path. It has to be one because `push` is.
 */
const matcherAt = (...tags: string[]): Effect.Effect<Matcher, XmlError> =>
  Effect.gen(function* () {
    const m = new Matcher();
    for (const t of tags) yield* m.push(t);
    return m;
  });

/**
 * @description Build a matcher positioned at the given path, carrying attributes on its current tag.
 *
 * @param attrs - Attribute values for the terminal tag.
 * @param tags - The tag names, root first.
 *
 * @returns An effect producing a matcher whose current node holds `attrs`.
 */
const matcherAtWithAttrs = (attrs: Record<string, unknown>, ...tags: string[]): Effect.Effect<Matcher, XmlError> =>
  Effect.gen(function* () {
    const m = new Matcher();
    for (let i = 0; i < tags.length - 1; i++) yield* m.push(tags[i]);
    yield* m.push(tags[tags.length - 1], attrs);
    return m;
  });

describe('ExpressionSet', () => {
  describe('construction, mutation and sealing', () => {
    it('a new set is empty and unsealed', () => {
      const set = new ExpressionSet();
      expect(run(set.size())).toBe(0);
      expect(!run(set.isSealed())).toBe(true);
    });

    it('adds an expression, growing the size and reporting it through has()', () => {
      const set = new ExpressionSet();
      const userExpr = expr('root.users.user');

      run(set.add(userExpr));
      expect(run(set.size())).toBe(1);
      expect(run(set.has(userExpr))).toBe(true);
      expect(run(set.has(expr('root.other')))).toBe(false);
    });

    it('ignores a second expression carrying an already-known pattern', () => {
      // Deduplication
      const set = new ExpressionSet();
      const e1 = expr('root.users.user');
      const e2 = expr('root.users.user'); // same pattern, different object

      run(set.addAll([e1, e2]));
      expect(run(set.size())).toBe(1);
    });

    it('produces the set itself, so a caller can keep a reference to it', () => {
      const set = new ExpressionSet();
      const result = run(set.add(expr('a.b')));
      expect(result === set).toBe(true);
    });

    it('addAll() registers every expression and produces the set', () => {
      const set = new ExpressionSet();
      run(set.addAll([expr('root.a'), expr('root.b'), expr('root.c')]));
      expect(run(set.size())).toBe(3);
      const result = run(new ExpressionSet().addAll([expr('x.y')]));
      expect(result instanceof ExpressionSet).toBe(true);
    });

    it('seal() blocks further additions and leaves the size untouched', () => {
      const set = new ExpressionSet();
      run(set.add(expr('root.a')));
      run(set.seal());

      expect(run(set.isSealed())).toBe(true);
      expect(failed(set.add(expr('root.b'))).message).toContain('sealed');
      expect(failed(set.addAll([expr('root.c')])).message).toContain('sealed');
      expect(run(set.size())).toBe(1);
    });
  });

  describe('matchesAny()', () => {
    it('matches exact paths and rejects partial, retagged and re-rooted ones', () => {
      const set = new ExpressionSet();
      run(set.addAll([expr('root.users.user'), expr('root.config.setting'), expr('root.orders.order')]));

      expect(run(set.matchesAny(run(matcherAt('root', 'users', 'user'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'config', 'setting'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'orders', 'order'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'users'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'users', 'admin'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('other', 'users', 'user'))))).toBe(true);
    });

    it('reads a * segment as any one tag, never as a shorter path', () => {
      const set = new ExpressionSet();
      run(set.add(expr('root.users.*')));

      expect(run(set.matchesAny(run(matcherAt('root', 'users', 'user'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'users', 'admin'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'users'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'other', 'user'))))).toBe(true);
    });

    it('matches ..user at depth 2 and deeper but never at depth 1', () => {
      const set = new ExpressionSet();
      run(set.add(expr('..user')));

      // ..user requires at least one ancestor (the '..' consumes ≥1 levels before the tag)
      expect(run(set.matchesAny(run(matcherAt('root', 'user'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'users', 'user'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('a', 'b', 'c', 'user'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('user'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'users', 'admin'))))).toBe(true);
    });

    it('matches an attribute condition only when the current node carries that value', () => {
      const set = new ExpressionSet();
      run(set.add(expr('root.users.user[type=admin]')));

      expect(run(set.matchesAny(run(matcherAtWithAttrs({ type: 'admin' }, 'root', 'users', 'user'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAtWithAttrs({ type: 'guest' }, 'root', 'users', 'user'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'users', 'user'))))).toBe(true);
    });

    it('matches a :first selector only against the first sibling of that name', () => {
      const set = new ExpressionSet();
      run(set.add(expr('root.items.item:first')));

      const m = new Matcher();
      run(m.push('root'));
      run(m.push('items'));
      run(m.push('item')); // first item, counter=0;
      expect(run(set.matchesAny(m))).toBe(true);
      run(m.pop());

      run(m.push('item')); // second item, counter=1;
      expect(!run(set.matchesAny(m))).toBe(true);
    });

    it('resolves a realistic config mixing exact, wildcard, deep and attribute expressions', () => {
      const stopNodes = new ExpressionSet();
      run(
        stopNodes.addAll([
          expr('root.users.user'), // exact
          expr('root.config.*'), // depth + wildcard tag
          expr('..script'), // deep wildcard
          expr('root.data.item[id=42]'), // attribute condition
        ])
      );

      expect(run(stopNodes.matchesAny(run(matcherAt('root', 'users', 'user'))))).toBe(true);
      expect(run(stopNodes.matchesAny(run(matcherAt('root', 'config', 'setting'))))).toBe(true);
      expect(run(stopNodes.matchesAny(run(matcherAt('root', 'config', 'feature'))))).toBe(true);
      expect(run(stopNodes.matchesAny(run(matcherAt('root', 'head', 'script'))))).toBe(true);
      expect(!run(stopNodes.matchesAny(run(matcherAt('script'))))).toBe(true);
      expect(run(stopNodes.matchesAny(run(matcherAtWithAttrs({ id: '42' }, 'root', 'data', 'item'))))).toBe(true);
      expect(!run(stopNodes.matchesAny(run(matcherAtWithAttrs({ id: '99' }, 'root', 'data', 'item'))))).toBe(true);
      expect(!run(stopNodes.matchesAny(run(matcherAt('root', 'users', 'admin'))))).toBe(true);
    });

    it('never matches when the set is empty', () => {
      const set = new ExpressionSet();
      expect(!run(set.matchesAny(run(matcherAt('root', 'users', 'user'))))).toBe(true);
    });

    it('matches through a read-only matcher view', () => {
      const set = new ExpressionSet();
      run(set.add(expr('root.users.user')));

      const m = new Matcher();
      run(m.push('root'));
      run(m.push('users'));
      run(m.push('user'));

      expect(run(set.matchesAny(run(m.readOnly())))).toBe(true);
    });

    it('matches a namespaced tag only inside its own namespace', () => {
      const set = new ExpressionSet();
      run(set.add(expr('root.ns::user')));

      const m = new Matcher();
      run(m.push('root'));
      run(m.push('user', null, 'ns'));

      expect(run(set.matchesAny(m))).toBe(true);

      const m2 = new Matcher();
      run(m2.push('root'));
      run(m2.push('user', null, 'other'));

      expect(!run(set.matchesAny(m2))).toBe(true);
    });
  });

  describe('findMatch()', () => {
    it('returns the matched expression so its data payload comes back with it', () => {
      const set = new ExpressionSet();
      const expressions = [expr('root.users.user', {}, { extra: 'property' }), expr('root.config.setting'), expr('root.orders.order')];
      run(set.addAll(expressions));

      const match1 = run(set.findMatch(run(matcherAt('root', 'users', 'user'))));
      expect(match1?.data).toBe(expressions[0].data);

      const match2 = run(set.findMatch(run(matcherAt('root', 'config', 'setting'))));
      expect(match2?.data).toBe(expressions[1].data);

      const match3 = run(set.findMatch(run(matcherAt('root', 'orders', 'order'))));
      expect(match3?.data).toBe(expressions[2].data);
    });
  });

  describe('deep wildcard indexing', () => {
    it('routes ..title through its terminal tag at depths 2, 3 and 5', () => {
      // ..tag should be indexed by terminal tag and match at various depths
      const set = new ExpressionSet();
      run(set.add(expr('..title')));

      expect(run(set.matchesAny(run(matcherAt('root', 'title'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'channel', 'title'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('a', 'b', 'c', 'd', 'title'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('title'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'other'))))).toBe(true);
    });

    it('leaves ..* unindexed, matching any tag at any depth above 1', () => {
      // ..* should be unindexed and match any tag at any depth > 1
      const set = new ExpressionSet();
      run(set.add(expr('..*')));

      expect(run(set.matchesAny(run(matcherAt('root', 'anything'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('a', 'b', 'c'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root'))))).toBe(true);
    });

    it('leaves a trailing .. unindexed, so root.. covers every descendant of root', () => {
      // root.. — terminal segment is a deep-wildcard itself, should go to unindexed
      const set = new ExpressionSet();
      run(set.add(expr('root..')));

      expect(run(set.matchesAny(run(matcherAt('root', 'anything'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'a', 'b'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('other', 'anything'))))).toBe(true);
    });

    it('indexes ..ns::user by its tag and checks the namespace during the full match', () => {
      // ..ns::tag — indexed by "tag", namespace checked during full match
      const set = new ExpressionSet();
      run(set.add(expr('..ns::user')));

      const m1 = new Matcher();
      run(m1.push('root'));
      run(m1.push('user', null, 'ns'));
      expect(run(set.matchesAny(m1))).toBe(true);

      const m2 = new Matcher();
      run(m2.push('root'));
      run(m2.push('user', null, 'other'));
      expect(!run(set.matchesAny(m2))).toBe(true);

      expect(!run(set.matchesAny(run(matcherAt('root', 'user'))))).toBe(true);
    });

    it('matches multiple deep wildcards against their literal segments', () => {
      // root..b..d — multiple deep wildcards, indexed by terminal "d"
      const set = new ExpressionSet();
      run(set.add(expr('root..b..d')));

      expect(run(set.matchesAny(run(matcherAt('root', 'b', 'd'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'x', 'b', 'y', 'd'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'x', 'd'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('other', 'b', 'd'))))).toBe(true);
    });

    it('resolves a mix of indexed and unindexed deep wildcards together', () => {
      // Mix of indexed and unindexed deep wildcards should all work together
      const set = new ExpressionSet();
      run(set.add(expr('..script'))); // indexed by "script"
      run(set.add(expr('..*'))); // unindexed (terminal *)
      run(set.add(expr('root..'))); // unindexed (terminal ..)

      expect(run(set.matchesAny(run(matcherAt('root', 'script'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'anything'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'deep', 'path'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('other'))))).toBe(true);
    });

    it('matches correctly across a set of 30 expressions', () => {
      const set = new ExpressionSet();
      const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];

      // 10 exact two-level paths
      for (const t of tags) run(set.add(expr(`root.${t}`)));

      // 10 exact three-level paths
      for (const t of tags) run(set.add(expr(`root.items.${t}`)));

      // 5 deep wildcards
      for (const t of tags.slice(0, 5)) run(set.add(expr(`..${t}`)));

      // 5 wildcard-tag
      for (let i = 1; i <= 5; i++) run(set.add(expr(`root.level${i}.*`)));

      expect(run(set.size())).toBe(30);

      // Spot checks
      expect(run(set.matchesAny(run(matcherAt('root', 'alpha'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'items', 'gamma'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('a', 'b', 'c', 'beta'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'level3', 'anything'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'unknown'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'items', 'unknown'))))).toBe(true);
    });

    it('holds 300 indexed deep wildcards and still matches only the configured tags', () => {
      // Large set — 300 deep wildcards, correctness spot checks
      const set = new ExpressionSet();
      for (let i = 0; i < 300; i++) {
        run(set.add(expr(`..tag${i}`)));
      }
      expect(run(set.size())).toBe(300);

      expect(run(set.matchesAny(run(matcherAt('root', 'child', 'tag0'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'child', 'tag150'))))).toBe(true);
      expect(run(set.matchesAny(run(matcherAt('root', 'child', 'tag299'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'child', 'tag300'))))).toBe(true);
      expect(!run(set.matchesAny(run(matcherAt('root', 'child', 'nonexistent'))))).toBe(true);
    });
  });
});
