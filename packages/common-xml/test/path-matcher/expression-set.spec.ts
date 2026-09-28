/**
 * @description Behaviour of `ExpressionSet`, the indexed collection of parsed `Expression` patterns. Covers construction, deduplication and sealing; `matchesAny`
 * across every pattern form the parser accepts (exact paths, `*` and `..` wildcards, attribute conditions, position selectors and namespaces); the
 * bucket routing that keeps a lookup off a full scan; and `findMatch` handing back the matched expression together with its data payload.
 */

import { describe, expect, it } from 'vite-plus/test';

import { Expression, ExpressionSet, Matcher } from '#/index.ts';

/**
 * @description Build a matcher positioned at the given path.
 *
 * @param tags - The tag names, root first.
 *
 * @returns A matcher sitting on that exact path.
 */
function matcherAt(...tags: string[]): Matcher {
  const m = new Matcher();
  for (const t of tags) m.push(t);
  return m;
}

/**
 * @description Build a matcher positioned at the given path, carrying attributes on its current tag.
 *
 * @param attrs - Attribute values for the terminal tag.
 * @param tags - The tag names, root first.
 *
 * @returns A matcher whose current node holds `attrs`.
 */
function matcherAtWithAttrs(attrs: Record<string, unknown>, ...tags: string[]): Matcher {
  const m = new Matcher();
  for (let i = 0; i < tags.length - 1; i++) m.push(tags[i]);
  m.push(tags[tags.length - 1], attrs);
  return m;
}

describe('ExpressionSet', () => {
  describe('construction, mutation and sealing', () => {
    it('a new set is empty and unsealed', () => {
      const set = new ExpressionSet();
      expect(set.size).toBe(0);
      expect(!set.isSealed).toBe(true);
    });

    it('adds an expression, growing the size and reporting it through has()', () => {
      const set = new ExpressionSet();
      const expr = new Expression('root.users.user');

      set.add(expr);
      expect(set.size).toBe(1);
      expect(set.has(expr)).toBe(true);
      expect(set.has(new Expression('root.other'))).toBe(false);
    });

    it('ignores a second expression carrying an already-known pattern', () => {
      // Deduplication
      const set = new ExpressionSet();
      const e1 = new Expression('root.users.user');
      const e2 = new Expression('root.users.user'); // same pattern, different object

      set.add(e1).add(e2);
      expect(set.size).toBe(1);
    });

    it('returns itself from add() so calls can be chained', () => {
      // Chaining
      const set = new ExpressionSet();
      const result = set.add(new Expression('a.b'));
      expect(result === set).toBe(true);
    });

    it('addAll() registers every expression and returns itself for chaining', () => {
      const set = new ExpressionSet();
      set.addAll([new Expression('root.a'), new Expression('root.b'), new Expression('root.c')]);
      expect(set.size).toBe(3);
      const result = new ExpressionSet().addAll([new Expression('x.y')]);
      expect(result instanceof ExpressionSet).toBe(true);
    });

    it('seal() blocks further additions and leaves the size untouched', () => {
      const set = new ExpressionSet();
      set.add(new Expression('root.a'));
      set.seal();

      expect(set.isSealed).toBe(true);
      expect(() => set.add(new Expression('root.b'))).toThrow('sealed');
      expect(() => set.addAll([new Expression('root.c')])).toThrow('sealed');
      expect(set.size).toBe(1);
    });
  });

  describe('matchesAny()', () => {
    it('matches exact paths and rejects partial, retagged and re-rooted ones', () => {
      const set = new ExpressionSet();
      set.addAll([new Expression('root.users.user'), new Expression('root.config.setting'), new Expression('root.orders.order')]);

      expect(set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'config', 'setting'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'orders', 'order'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'users'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
      expect(!set.matchesAny(matcherAt('other', 'users', 'user'))).toBe(true);
    });

    it('reads a * segment as any one tag, never as a shorter path', () => {
      const set = new ExpressionSet();
      set.add(new Expression('root.users.*'));

      expect(set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'users'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'other', 'user'))).toBe(true);
    });

    it('matches ..user at depth 2 and deeper but never at depth 1', () => {
      const set = new ExpressionSet();
      set.add(new Expression('..user'));

      // ..user requires at least one ancestor (the '..' consumes ≥1 levels before the tag)
      expect(set.matchesAny(matcherAt('root', 'user'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
      expect(set.matchesAny(matcherAt('a', 'b', 'c', 'user'))).toBe(true);
      expect(!set.matchesAny(matcherAt('user'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
    });

    it('matches an attribute condition only when the current node carries that value', () => {
      const set = new ExpressionSet();
      set.add(new Expression('root.users.user[type=admin]'));

      expect(set.matchesAny(matcherAtWithAttrs({ type: 'admin' }, 'root', 'users', 'user'))).toBe(true);
      expect(!set.matchesAny(matcherAtWithAttrs({ type: 'guest' }, 'root', 'users', 'user'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
    });

    it('matches a :first selector only against the first sibling of that name', () => {
      const set = new ExpressionSet();
      set.add(new Expression('root.items.item:first'));

      const m = new Matcher();
      m.push('root');
      m.push('items');
      m.push('item'); // first item, counter=0
      expect(set.matchesAny(m)).toBe(true);
      m.pop();

      m.push('item'); // second item, counter=1
      expect(!set.matchesAny(m)).toBe(true);
    });

    it('resolves a realistic config mixing exact, wildcard, deep and attribute expressions', () => {
      const stopNodes = new ExpressionSet();
      stopNodes.addAll([
        new Expression('root.users.user'), // exact
        new Expression('root.config.*'), // depth + wildcard tag
        new Expression('..script'), // deep wildcard
        new Expression('root.data.item[id=42]'), // attribute condition
      ]);

      expect(stopNodes.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
      expect(stopNodes.matchesAny(matcherAt('root', 'config', 'setting'))).toBe(true);
      expect(stopNodes.matchesAny(matcherAt('root', 'config', 'feature'))).toBe(true);
      expect(stopNodes.matchesAny(matcherAt('root', 'head', 'script'))).toBe(true);
      expect(!stopNodes.matchesAny(matcherAt('script'))).toBe(true);
      expect(stopNodes.matchesAny(matcherAtWithAttrs({ id: '42' }, 'root', 'data', 'item'))).toBe(true);
      expect(!stopNodes.matchesAny(matcherAtWithAttrs({ id: '99' }, 'root', 'data', 'item'))).toBe(true);
      expect(!stopNodes.matchesAny(matcherAt('root', 'users', 'admin'))).toBe(true);
    });

    it('never matches when the set is empty', () => {
      const set = new ExpressionSet();
      expect(!set.matchesAny(matcherAt('root', 'users', 'user'))).toBe(true);
    });

    it('matches through a read-only matcher view', () => {
      const set = new ExpressionSet();
      set.add(new Expression('root.users.user'));

      const m = new Matcher();
      m.push('root');
      m.push('users');
      m.push('user');

      expect(set.matchesAny(m.readOnly())).toBe(true);
    });

    it('matches a namespaced tag only inside its own namespace', () => {
      const set = new ExpressionSet();
      set.add(new Expression('root.ns::user'));

      const m = new Matcher();
      m.push('root');
      m.push('user', null, 'ns');

      expect(set.matchesAny(m)).toBe(true);

      const m2 = new Matcher();
      m2.push('root');
      m2.push('user', null, 'other');

      expect(!set.matchesAny(m2)).toBe(true);
    });
  });

  describe('findMatch()', () => {
    it('returns the matched expression so its data payload comes back with it', () => {
      const set = new ExpressionSet();
      const expressions = [
        new Expression('root.users.user', {}, { extra: 'property' }),
        new Expression('root.config.setting'),
        new Expression('root.orders.order'),
      ];
      set.addAll(expressions);

      const match1 = set.findMatch(matcherAt('root', 'users', 'user'));
      expect(match1?.data).toBe(expressions[0].data);

      const match2 = set.findMatch(matcherAt('root', 'config', 'setting'));
      expect(match2?.data).toBe(expressions[1].data);

      const match3 = set.findMatch(matcherAt('root', 'orders', 'order'));
      expect(match3?.data).toBe(expressions[2].data);
    });
  });

  describe('deep wildcard indexing', () => {
    it('routes ..title through its terminal tag at depths 2, 3 and 5', () => {
      // ..tag should be indexed by terminal tag and match at various depths
      const set = new ExpressionSet();
      set.add(new Expression('..title'));

      expect(set.matchesAny(matcherAt('root', 'title'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'channel', 'title'))).toBe(true);
      expect(set.matchesAny(matcherAt('a', 'b', 'c', 'd', 'title'))).toBe(true);
      expect(!set.matchesAny(matcherAt('title'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'other'))).toBe(true);
    });

    it('leaves ..* unindexed, matching any tag at any depth above 1', () => {
      // ..* should be unindexed and match any tag at any depth > 1
      const set = new ExpressionSet();
      set.add(new Expression('..*'));

      expect(set.matchesAny(matcherAt('root', 'anything'))).toBe(true);
      expect(set.matchesAny(matcherAt('a', 'b', 'c'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root'))).toBe(true);
    });

    it('leaves a trailing .. unindexed, so root.. covers every descendant of root', () => {
      // root.. — terminal segment is a deep-wildcard itself, should go to unindexed
      const set = new ExpressionSet();
      set.add(new Expression('root..'));

      expect(set.matchesAny(matcherAt('root', 'anything'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'a', 'b'))).toBe(true);
      expect(!set.matchesAny(matcherAt('other', 'anything'))).toBe(true);
    });

    it('indexes ..ns::user by its tag and checks the namespace during the full match', () => {
      // ..ns::tag — indexed by "tag", namespace checked during full match
      const set = new ExpressionSet();
      set.add(new Expression('..ns::user'));

      const m1 = new Matcher();
      m1.push('root');
      m1.push('user', null, 'ns');
      expect(set.matchesAny(m1)).toBe(true);

      const m2 = new Matcher();
      m2.push('root');
      m2.push('user', null, 'other');
      expect(!set.matchesAny(m2)).toBe(true);

      expect(!set.matchesAny(matcherAt('root', 'user'))).toBe(true);
    });

    it('matches multiple deep wildcards against their literal segments', () => {
      // root..b..d — multiple deep wildcards, indexed by terminal "d"
      const set = new ExpressionSet();
      set.add(new Expression('root..b..d'));

      expect(set.matchesAny(matcherAt('root', 'b', 'd'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'x', 'b', 'y', 'd'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'x', 'd'))).toBe(true);
      expect(!set.matchesAny(matcherAt('other', 'b', 'd'))).toBe(true);
    });

    it('resolves a mix of indexed and unindexed deep wildcards together', () => {
      // Mix of indexed and unindexed deep wildcards should all work together
      const set = new ExpressionSet();
      set.add(new Expression('..script')); // indexed by "script"
      set.add(new Expression('..*')); // unindexed (terminal *)
      set.add(new Expression('root..')); // unindexed (terminal ..)

      expect(set.matchesAny(matcherAt('root', 'script'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'anything'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'deep', 'path'))).toBe(true);
      expect(!set.matchesAny(matcherAt('other'))).toBe(true);
    });

    it('matches correctly across a set of 30 expressions', () => {
      const set = new ExpressionSet();
      const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];

      // 10 exact two-level paths
      for (const t of tags) set.add(new Expression(`root.${t}`));

      // 10 exact three-level paths
      for (const t of tags) set.add(new Expression(`root.items.${t}`));

      // 5 deep wildcards
      for (const t of tags.slice(0, 5)) set.add(new Expression(`..${t}`));

      // 5 wildcard-tag
      for (let i = 1; i <= 5; i++) set.add(new Expression(`root.level${i}.*`));

      expect(set.size).toBe(30);

      // Spot checks
      expect(set.matchesAny(matcherAt('root', 'alpha'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'items', 'gamma'))).toBe(true);
      expect(set.matchesAny(matcherAt('a', 'b', 'c', 'beta'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'level3', 'anything'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'unknown'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'items', 'unknown'))).toBe(true);
    });

    it('holds 300 indexed deep wildcards and still matches only the configured tags', () => {
      // Large set — 300 deep wildcards, correctness spot checks
      const set = new ExpressionSet();
      for (let i = 0; i < 300; i++) {
        set.add(new Expression(`..tag${i}`));
      }
      expect(set.size).toBe(300);

      expect(set.matchesAny(matcherAt('root', 'child', 'tag0'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'child', 'tag150'))).toBe(true);
      expect(set.matchesAny(matcherAt('root', 'child', 'tag299'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'child', 'tag300'))).toBe(true);
      expect(!set.matchesAny(matcherAt('root', 'child', 'nonexistent'))).toBe(true);
    });
  });
});
