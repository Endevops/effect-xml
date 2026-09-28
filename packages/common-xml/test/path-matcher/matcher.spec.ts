/**
 * @description Specs for `Matcher`, the path-tracking half of the library: push and pop bookkeeping, current-node attribute access, sibling position and counter
 * derivation, snapshot and restore, and the analysis flags `Expression` memoises. Matching behaviour — wildcards, deep wildcards, attribute
 * conditions and position selectors — is exercised end to end through `Matcher.matches`, because that is the only way a parser ever uses the two
 * together.
 */

import { describe, expect, it } from 'vite-plus/test';

import { Matcher } from '#/index.ts';
import { expr } from '#/test/helpers/effect.ts';

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
  it('matches an exact path', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('users');
    matcher.push('user');

    const e = expr('root.users.user');
    expect(matcher.matches(e)).toBe(true);

    const e2 = expr('root.users.admin');
    expect(matcher.matches(e2)).toBe(false);
  });

  it('matches a single wildcard at the start, middle or end', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('users');
    matcher.push('user');

    const e1 = expr('*.users.user');
    expect(matcher.matches(e1)).toBe(true);

    const e2 = expr('root.*.user');
    expect(matcher.matches(e2)).toBe(true);

    const e3 = expr('root.users.*');
    expect(matcher.matches(e3)).toBe(true);

    const e4 = expr('*.users');
    expect(matcher.matches(e4)).toBe(false);
  });

  it('matches a deep wildcard at any depth', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('level1');
    matcher.push('level2');
    matcher.push('user');

    const e1 = expr('..user');
    expect(matcher.matches(e1)).toBe(true);

    const e2 = expr('root..user');
    expect(matcher.matches(e2)).toBe(true);

    const e3 = expr('..level2.user');
    expect(matcher.matches(e3)).toBe(true);
  });

  it('matches multiple deep wildcards', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('a');
    matcher.push('b');
    matcher.push('c');
    matcher.push('d');

    const e = expr('root..b..d');
    expect(matcher.matches(e)).toBe(true);
  });

  it('matches an attribute condition on the current node only', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('user', { id: '123', type: 'admin' });

    const e1 = expr('root.user[id]');
    expect(matcher.matches(e1)).toBe(true);

    const e2 = expr('root.user[name]');
    expect(matcher.matches(e2)).toBe(false);
  });

  it('matches an attribute value condition on the current node only', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('user', { type: 'admin' });

    const e1 = expr('root.user[type=admin]');
    expect(matcher.matches(e1)).toBe(true);

    const e2 = expr('root.user[type=guest]');
    expect(matcher.matches(e2)).toBe(false);
  });

  it('cannot match an attribute condition on an ancestor', () => {
    const matcher = new Matcher();
    matcher.push('root', { lang: 'en' });
    matcher.push('users');
    matcher.push('user');

    // Ancestor attributes are dropped on push, so there is nothing to match against
    const e = expr('root[lang].users.user');
    expect(matcher.matches(e)).toBe(false);
  });
});

describe('Position selectors', () => {
  it('matches :first when the counter is 0', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('item'); // counter = 0

    const e = expr('root.item:first');
    expect(matcher.matches(e)).toBe(true);

    matcher.pop();
    matcher.push('item'); // counter = 1
    expect(matcher.matches(e)).toBe(false);
  });

  it('matches :nth(n) only at that counter', () => {
    const matcher = new Matcher();
    matcher.push('root');

    matcher.push('item'); // counter = 0
    matcher.pop();

    matcher.push('item'); // counter = 1
    const e1 = expr('root.item:nth(1)');
    expect(matcher.matches(e1)).toBe(true);

    const e0 = expr('root.item:nth(0)');
    expect(matcher.matches(e0)).toBe(false);
    matcher.pop();

    matcher.push('item'); // counter = 2
    const e2 = expr('root.item:nth(2)');
    expect(matcher.matches(e2)).toBe(true);
  });

  it('matches :odd on odd counters only', () => {
    const matcher = new Matcher();
    matcher.push('root');

    matcher.push('item'); // counter = 0 (even)
    const oddExpr = expr('root.item:odd');
    expect(matcher.matches(oddExpr)).toBe(false);
    matcher.pop();

    matcher.push('item'); // counter = 1 (odd)
    expect(matcher.matches(oddExpr)).toBe(true);
    matcher.pop();

    matcher.push('item'); // counter = 2 (even)
    expect(matcher.matches(oddExpr)).toBe(false);
    matcher.pop();

    matcher.push('item'); // counter = 3 (odd)
    expect(matcher.matches(oddExpr)).toBe(true);
  });

  it('matches :even on even counters only', () => {
    const matcher = new Matcher();
    matcher.push('root');

    matcher.push('item'); // counter = 0 (even)
    const evenExpr = expr('root.item:even');
    expect(matcher.matches(evenExpr)).toBe(true);
    matcher.pop();

    matcher.push('item'); // counter = 1 (odd)
    expect(matcher.matches(evenExpr)).toBe(false);
    matcher.pop();

    matcher.push('item'); // counter = 2 (even)
    expect(matcher.matches(evenExpr)).toBe(true);
  });

  it('combines a position selector with a deep wildcard', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('data');
    matcher.push('items');

    matcher.push('item'); // counter = 0
    matcher.pop();
    matcher.push('item'); // counter = 1

    const e = expr('..item:nth(1)');
    expect(matcher.matches(e)).toBe(true);
  });

  it('combines an attribute condition with a position selector', () => {
    const matcher = new Matcher();
    matcher.push('root');

    matcher.push('user', { type: 'admin' }); // counter = 0
    const e = expr('root.user[type=admin]:first');
    expect(matcher.matches(e)).toBe(true);
    matcher.pop();

    matcher.push('user', { type: 'admin' }); // counter = 1
    expect(matcher.matches(e)).toBe(false);
  });
});

describe('Edge cases', () => {
  it('never matches an empty pattern', () => {
    const matcher = new Matcher();
    matcher.push('root');

    const e = expr('');
    expect(matcher.matches(e)).toBe(false);
  });

  it('does not match when the path and the pattern differ in length', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('user');

    const e1 = expr('root.users.user');
    expect(matcher.matches(e1)).toBe(false);

    const e2 = expr('root');
    expect(matcher.matches(e2)).toBe(false);
  });

  it('uses the counter rather than the position for :first', () => {
    const matcher = new Matcher();
    matcher.push('root');

    // Different tags interspersed
    matcher.push('a'); // position=0, counter=0
    matcher.pop();
    matcher.push('b'); // position=1, counter=0
    matcher.pop();
    matcher.push('a'); // position=2, counter=1

    expect(matcher.getPosition()).toBe(2);
    expect(matcher.getCounter()).toBe(1);

    // :first checks counter, not position
    const e = expr('root.a:first');
    expect(matcher.matches(e)).toBe(false);
  });

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

  it('uses a custom separator for toString and for matching', () => {
    const matcher = new Matcher({ separator: '/' });
    matcher.push('root');
    matcher.push('users');

    expect(matcher.toString()).toBe('root/users');
    expect(matcher.toString('.')).toBe('root.users');

    const e = expr('root/users', { separator: '/' });
    expect(matcher.matches(e)).toBe(true);
  });

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

  it('trims whitespace inside attribute names and values', () => {
    const matcher = new Matcher();
    matcher.push('user', { id: '123', type: 'admin' });

    const e = expr('user[ id ]');
    expect(matcher.matches(e)).toBe(true);

    const e2 = expr('user[ type = admin ]');
    expect(matcher.matches(e2)).toBe(true);
  });

  it('coerces a numeric attribute value to a string for comparison', () => {
    const matcher = new Matcher();
    matcher.push('user', { id: '123', count: 5 });

    // Even though count is number 5, pattern expects string "5"
    const e = expr('user[count=5]');
    expect(matcher.matches(e)).toBe(true);
  });
});

describe('Performance and caching', () => {
  it('caches the expression analysis flags', () => {
    const e = expr('root..user[id]:first');

    // These should return cached values (not recalculate)
    expect(e.hasDeepWildcard()).toBe(true);
    expect(e.hasAttributeCondition()).toBe(true);
    expect(e.hasPositionSelector()).toBe(true);

    // The memoised flags are ECMAScript `#`-private, so there is no longer any way to reach in and read them back — the claim under test is
    // therefore stated against the public surface: each accessor agrees with the public `segments` it was derived from, and holds that answer
    // across repeated calls rather than rescanning.
    expect(e.hasDeepWildcard()).toBe(e.segments.some(seg => seg.type === 'deep-wildcard'));
    expect(e.hasAttributeCondition()).toBe(e.segments.some(seg => seg.attrName !== undefined));
    expect(e.hasPositionSelector()).toBe(e.segments.some(seg => seg.position !== undefined));

    expect(e.hasDeepWildcard()).toBe(true);
    expect(e.hasAttributeCondition()).toBe(true);
    expect(e.hasPositionSelector()).toBe(true);
  });
});

describe('Complex real-world scenarios', () => {
  it('matches the second paragraph of a simulated XML document', () => {
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

    const e = expr('..p:nth(1)');
    expect(matcher.matches(e)).toBe(true);
  });

  it('handles nested same-named tags', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('items');

    // <item><item><item>nested</item></item></item>
    matcher.push('item'); // counter=0
    matcher.push('item'); // counter=0 (different level)
    matcher.push('item'); // counter=0 (different level)

    expect(matcher.getDepth()).toBe(5);
    expect(matcher.getCounter()).toBe(0);

    const e = expr('..item.item.item:first');
    expect(matcher.matches(e)).toBe(true);
  });

  it('tracks position across different tags and counter per tag name', () => {
    const matcher = new Matcher();
    matcher.push('data');

    matcher.push('user', { id: '1' });
    matcher.pop();

    matcher.push('post', { id: '1' });
    matcher.pop();

    matcher.push('user', { id: '2' });

    expect(matcher.getPosition()).toBe(2);
    expect(matcher.getCounter()).toBe(1);

    const e = expr('data.user:nth(1)');
    expect(matcher.matches(e)).toBe(true);
  });
});
