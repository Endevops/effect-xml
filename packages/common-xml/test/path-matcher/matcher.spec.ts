/**
 * @description Specs for `Matcher`, the path-tracking half of the library: push and pop bookkeeping, current-node attribute access, sibling position and counter
 * derivation, snapshot and restore, and the analysis flags `Expression` memoises. Matching behaviour — wildcards, deep wildcards, attribute
 * conditions and position selectors — is exercised end to end through `Matcher.matches`, because that is the only way a parser ever uses the two
 * together.
 */

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { Matcher } from '#/index.ts';
import Expression from '#/path-matcher/expression.ts';

describe('Basic path tracking', () => {
  it('tracks depth, current tag and path string across a push and pop', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('users');
    matcher.push('user', { id: '123' });

    expect(matcher.getDepth()).toBe(3);
    expect(matcher.getCurrentTag()).toBe('user');
    expect(matcher.toString()).toBe('root.users.user');

    matcher.pop();
    expect(matcher.getDepth()).toBe(2);
    expect(matcher.getCurrentTag()).toBe('users');
  });

  it('reads attributes from the current node only', () => {
    const matcher = new Matcher();
    matcher.push('user', { id: '123', type: 'admin' });

    expect(matcher.getAttrValue('id')).toBe('123');
    expect(matcher.getAttrValue('type')).toBe('admin');
    expect(matcher.hasAttr('id')).toBe(true);
    expect(matcher.hasAttr('type')).toBe(true);
    expect(matcher.hasAttr('name')).toBe(false);
  });

  it('calculates position and counter automatically', () => {
    const matcher = new Matcher();
    matcher.push('root');

    // First child
    matcher.push('b');
    expect(matcher.getPosition()).toBe(0);
    expect(matcher.getCounter()).toBe(0);
    matcher.pop();

    // Second child (different tag)
    matcher.push('c');
    expect(matcher.getPosition()).toBe(1);
    expect(matcher.getCounter()).toBe(0);
    matcher.pop();

    // Third child (same tag as first)
    matcher.push('b');
    expect(matcher.getPosition()).toBe(2);
    expect(matcher.getCounter()).toBe(1);
    matcher.pop();

    // Fourth child
    matcher.push('c');
    expect(matcher.getPosition()).toBe(3);
    expect(matcher.getCounter()).toBe(1);
  });

  it('updates the current node attributes', () => {
    const matcher = new Matcher();
    matcher.push('user');
    matcher.updateCurrent({ id: '123', type: 'admin' });

    expect(matcher.getAttrValue('id')).toBe('123');
    expect(matcher.getAttrValue('type')).toBe('admin');
  });

  it('removes values from ancestors as the path descends', () => {
    const matcher = new Matcher();
    matcher.push('root', { id: '1' });
    matcher.push('user', { type: 'admin' });

    expect(matcher.path[0]?.values).toBe(undefined);
    expect(matcher.path[1]?.values?.type).toBe('admin');
  });

  it('returns undefined and keeps depth 0 when popping an empty path', () => {
    const matcher = new Matcher();
    const result = matcher.pop();
    expect(result).toBe(undefined);
    expect(matcher.getDepth()).toBe(0);
  });

  it('clears the path and the sibling stacks on reset', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('user');
    matcher.reset();

    expect(matcher.getDepth()).toBe(0);
    expect(matcher.siblingStacks.length).toBe(0);
  });
});

describe('Pattern matching', () => {
  it.effect('echoes the pattern it was built from, whatever the matcher is sitting on', () =>
    Effect.gen(function* () {
      // The pattern is kept verbatim so a log line or an error can name what was
      // configured. That only holds if it survives the segments being parsed into
      // something else, and if it is read back independently of the matcher's own
      // path — an expression built once and matched against many documents reads
      // the same every time.
      const e = yield* Expression.make('root.users.user');
      const elsewhere = yield* Expression.make('root/ns:tag[..pre]');

      expect(e.toString()).toBe('root.users.user');
      expect(elsewhere.toString()).toBe('root/ns:tag[..pre]');

      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('users');
      matcher.push('user');
      expect(matcher.matches(e)).toBe(true);
      expect(e.toString()).toBe('root.users.user');
    })
  );

  it.effect('matches an exact path', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('users');
      matcher.push('user');

      const e = yield* Expression.make('root.users.user');
      expect(matcher.matches(e)).toBe(true);

      const e2 = yield* Expression.make('root.users.admin');
      expect(matcher.matches(e2)).toBe(false);
    })
  );

  it.effect('matches a single wildcard at the start, middle or end', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('users');
      matcher.push('user');

      const e1 = yield* Expression.make('*.users.user');
      expect(matcher.matches(e1)).toBe(true);

      const e2 = yield* Expression.make('root.*.user');
      expect(matcher.matches(e2)).toBe(true);

      const e3 = yield* Expression.make('root.users.*');
      expect(matcher.matches(e3)).toBe(true);

      const e4 = yield* Expression.make('*.users');
      expect(matcher.matches(e4)).toBe(false);
    })
  );

  it.effect('matches a deep wildcard at any depth', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('level1');
      matcher.push('level2');
      matcher.push('user');

      const e1 = yield* Expression.make('..user');
      expect(matcher.matches(e1)).toBe(true);

      const e2 = yield* Expression.make('root..user');
      expect(matcher.matches(e2)).toBe(true);

      const e3 = yield* Expression.make('..level2.user');
      expect(matcher.matches(e3)).toBe(true);
    })
  );

  it.effect('matches multiple deep wildcards', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('a');
      matcher.push('b');
      matcher.push('c');
      matcher.push('d');

      const e = yield* Expression.make('root..b..d');
      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('matches an attribute condition on the current node only', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', { id: '123', type: 'admin' });

      const e1 = yield* Expression.make('root.user[id]');
      expect(matcher.matches(e1)).toBe(true);

      const e2 = yield* Expression.make('root.user[name]');
      expect(matcher.matches(e2)).toBe(false);
    })
  );

  it.effect('matches an attribute value condition on the current node only', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', { type: 'admin' });

      const e1 = yield* Expression.make('root.user[type=admin]');
      expect(matcher.matches(e1)).toBe(true);

      const e2 = yield* Expression.make('root.user[type=guest]');
      expect(matcher.matches(e2)).toBe(false);
    })
  );

  it.effect('cannot match an attribute condition on an ancestor', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root', { lang: 'en' });
      matcher.push('users');
      matcher.push('user');

      // Ancestor attributes are dropped on push, so there is nothing to match against
      const e = yield* Expression.make('root[lang].users.user');
      expect(matcher.matches(e)).toBe(false);
    })
  );
});

describe('Position selectors', () => {
  it.effect('matches :first when the counter is 0', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('item'); // counter = 0;

      const e = yield* Expression.make('root.item:first');
      expect(matcher.matches(e)).toBe(true);

      matcher.pop();
      matcher.push('item'); // counter = 1;
      expect(matcher.matches(e)).toBe(false);
    })
  );

  it.effect('matches :nth(n) only at that counter', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');

      matcher.push('item'); // counter = 0;
      matcher.pop();

      matcher.push('item'); // counter = 1;
      const e1 = yield* Expression.make('root.item:nth(1)');
      expect(matcher.matches(e1)).toBe(true);

      const e0 = yield* Expression.make('root.item:nth(0)');
      expect(matcher.matches(e0)).toBe(false);
      matcher.pop();

      matcher.push('item'); // counter = 2;
      const e2 = yield* Expression.make('root.item:nth(2)');
      expect(matcher.matches(e2)).toBe(true);
    })
  );

  it.effect('matches :odd on odd counters only', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');

      matcher.push('item'); // counter = 0 (even);
      const oddExpr = yield* Expression.make('root.item:odd');
      expect(matcher.matches(oddExpr)).toBe(false);
      matcher.pop();

      matcher.push('item'); // counter = 1 (odd);
      expect(matcher.matches(oddExpr)).toBe(true);
      matcher.pop();

      matcher.push('item'); // counter = 2 (even);
      expect(matcher.matches(oddExpr)).toBe(false);
      matcher.pop();

      matcher.push('item'); // counter = 3 (odd);
      expect(matcher.matches(oddExpr)).toBe(true);
    })
  );

  it.effect('matches :even on even counters only', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');

      matcher.push('item'); // counter = 0 (even);
      const evenExpr = yield* Expression.make('root.item:even');
      expect(matcher.matches(evenExpr)).toBe(true);
      matcher.pop();

      matcher.push('item'); // counter = 1 (odd);
      expect(matcher.matches(evenExpr)).toBe(false);
      matcher.pop();

      matcher.push('item'); // counter = 2 (even);
      expect(matcher.matches(evenExpr)).toBe(true);
    })
  );

  it.effect('combines a position selector with a deep wildcard', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('data');
      matcher.push('items');

      matcher.push('item'); // counter = 0;
      matcher.pop();
      matcher.push('item'); // counter = 1;

      const e = yield* Expression.make('..item:nth(1)');
      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('combines an attribute condition with a position selector', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');

      matcher.push('user', { type: 'admin' }); // counter = 0;
      const e = yield* Expression.make('root.user[type=admin]:first');
      expect(matcher.matches(e)).toBe(true);
      matcher.pop();

      matcher.push('user', { type: 'admin' }); // counter = 1;
      expect(matcher.matches(e)).toBe(false);
    })
  );
});

describe('Edge cases', () => {
  it.effect('never matches an empty pattern', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');

      const e = yield* Expression.make('');
      expect(matcher.matches(e)).toBe(false);
    })
  );

  it.effect('does not match when the path and the pattern differ in length', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user');

      const e1 = yield* Expression.make('root.users.user');
      expect(matcher.matches(e1)).toBe(false);

      const e2 = yield* Expression.make('root');
      expect(matcher.matches(e2)).toBe(false);
    })
  );

  it.effect('uses the counter rather than the position for :first', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');

      // Different tags interspersed
      matcher.push('a'); // position=0, counter=0;
      matcher.pop();
      matcher.push('b'); // position=1, counter=0;
      matcher.pop();
      matcher.push('a'); // position=2, counter=1;

      expect(matcher.getPosition()).toBe(2);
      expect(matcher.getCounter()).toBe(1);

      // :first checks counter, not position
      const e = yield* Expression.make('root.a:first');
      expect(matcher.matches(e)).toBe(false);
    })
  );

  it('restores the path and the sibling counts from a snapshot', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('users');

    const snapshot = matcher.snapshot();

    matcher.push('user', { id: '123' });
    expect(matcher.getDepth()).toBe(3);

    matcher.restore(snapshot);
    expect(matcher.getDepth()).toBe(2);
    expect(matcher.getCurrentTag()).toBe('users');

    // Sibling counts should be restored too
    matcher.push('user');
    expect(matcher.getCounter()).toBe(0);
  });

  it.effect('uses a custom separator for toString and for matching', () =>
    Effect.gen(function* () {
      const matcher = new Matcher({ separator: '/' });
      matcher.push('root');
      matcher.push('users');

      expect(matcher.toString()).toBe('root/users');
      expect(matcher.toString('.')).toBe('root.users');

      const e = yield* Expression.make('root/users', { separator: '/' });
      expect(matcher.matches(e)).toBe(true);
    })
  );

  it('treats null, undefined and empty attribute objects as no attributes', () => {
    const matcher = new Matcher();
    matcher.push('user', null);
    expect(matcher.hasAttr('id')).toBe(false);

    matcher.pop();
    matcher.push('user', undefined);
    expect(matcher.hasAttr('id')).toBe(false);

    matcher.pop();
    matcher.push('user', {});
    expect(matcher.hasAttr('id')).toBe(false);
  });

  it.effect('trims whitespace inside attribute names and values', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('user', { id: '123', type: 'admin' });

      const e = yield* Expression.make('user[ id ]');
      expect(matcher.matches(e)).toBe(true);

      const e2 = yield* Expression.make('user[ type = admin ]');
      expect(matcher.matches(e2)).toBe(true);
    })
  );

  it.effect('coerces a numeric attribute value to a string for comparison', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('user', { id: '123', count: 5 });

      // Even though count is number 5, pattern expects string "5"
      const e = yield* Expression.make('user[count=5]');
      expect(matcher.matches(e)).toBe(true);
    })
  );
});

describe('Performance and caching', () => {
  it.effect('caches the expression analysis flags', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('root..user[id]:first');

      // These should return cached values (not recalculate)
      expect(e.hasDeepWildcard).toBe(true);
      expect(e.hasAttributeCondition).toBe(true);
      expect(e.hasPositionSelector).toBe(true);

      // The memoised flags are ECMAScript `#`-private, so there is no longer any way to reach in and read them back — the claim under test is
      // therefore stated against the public surface: each accessor agrees with the public `segments` it was derived from, and holds that answer
      // across repeated calls rather than rescanning.
      expect(e.hasDeepWildcard).toBe(e.segments.some(seg => seg.type === 'deep-wildcard'));
      expect(e.hasAttributeCondition).toBe(e.segments.some(seg => seg.attrName !== undefined));
      expect(e.hasPositionSelector).toBe(e.segments.some(seg => seg.position !== undefined));

      expect(e.hasDeepWildcard).toBe(true);
      expect(e.hasAttributeCondition).toBe(true);
      expect(e.hasPositionSelector).toBe(true);
    })
  );
});

describe('Complex real-world scenarios', () => {
  it.effect('matches the second paragraph of a simulated XML document', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();

      // <html>
      matcher.push('html', { lang: 'en' });

      //   <head>
      matcher.push('head');
      matcher.push('title');
      matcher.pop();
      matcher.pop();

      //   <body>
      matcher.push('body');

      //     <div class="container">
      matcher.push('div', { class: 'container' });

      //       <p>First paragraph</p>
      matcher.push('p');
      expect(matcher.toString()).toBe('html.body.div.p');
      expect(matcher.getCounter()).toBe(0);
      matcher.pop();

      //       <p>Second paragraph</p>
      matcher.push('p');
      expect(matcher.getCounter()).toBe(1);

      const e = yield* Expression.make('..p:nth(1)');
      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('handles nested same-named tags', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('items');

      // <item><item><item>nested</item></item></item>
      matcher.push('item'); // counter=0;
      matcher.push('item'); // counter=0 (different level);
      matcher.push('item'); // counter=0 (different level);

      expect(matcher.getDepth()).toBe(5);
      expect(matcher.getCounter()).toBe(0);

      const e = yield* Expression.make('..item.item.item:first');
      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('tracks position across different tags and counter per tag name', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('data');

      matcher.push('user', { id: '1' });
      matcher.pop();

      matcher.push('post', { id: '1' });
      matcher.pop();

      matcher.push('user', { id: '2' });

      expect(matcher.getPosition()).toBe(2);
      expect(matcher.getCounter()).toBe(1);

      const e = yield* Expression.make('data.user:nth(1)');
      expect(matcher.matches(e)).toBe(true);
    })
  );
});
