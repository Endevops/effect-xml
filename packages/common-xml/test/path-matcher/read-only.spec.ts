/**
 * @description The read-only guarantee behind `Matcher.readOnly()`. The view serves every read and match method the matcher does, and reads the matcher's live
 * state rather than a copy of it. What it must never do is move the parse position, so `push`, `pop`, `reset`, `updateCurrent`, `restore`, `path` and
 * `snapshot` are absent from `MatcherView` outright — a fact the type system already enforces, and the runtime shape these specs pin down through an
 * untyped reference.
 */

import { describe, expect, it } from 'vite-plus/test';

import type { PathNode } from '#/index.ts';

import { Matcher } from '#/index.ts';
import { expr, run } from '#/test/helpers/effect.ts';

describe('readOnly() hands back a view rather than the matcher itself', () => {
  it('returns an object', () => {
    const matcher = new Matcher();
    const ro = run(matcher.readOnly());

    expect(ro !== null && typeof ro === 'object').toBe(true);
  });

  it('returns a view, not the original instance', () => {
    const matcher = new Matcher();
    // `MatcherView` and `Matcher` share no members, so the identity check has to step outside the type system.
    const view: unknown = run(matcher.readOnly());

    expect(view !== matcher).toBe(true);
  });

  it('returns the same view on every call, so it is safe to cache and to hand out', () => {
    const matcher = new Matcher();
    const ro1 = run(matcher.readOnly());
    const ro2 = run(matcher.readOnly());

    expect(ro1 === ro2).toBe(true);
  });
});

describe('the view serves every read and match method the matcher does', () => {
  it('reads the separator the matcher was configured with', () => {
    const matcher = new Matcher({ separator: '/' });
    const ro = run(matcher.readOnly());

    expect(ro.separator).toBe('/');
  });

  it('reads the current tag', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));
    run(matcher.push('user', { id: '42' }));

    const ro = run(matcher.readOnly());

    expect(run(ro.getCurrentTag())).toBe('user');
  });

  it('reads the current namespace', () => {
    const matcher = new Matcher();
    run(matcher.push('element', {}, 'ns'));

    const ro = run(matcher.readOnly());

    expect(run(ro.getCurrentNamespace())).toBe('ns');
  });

  it('reads any attribute of the current node, and undefined for a missing one', () => {
    const matcher = new Matcher();
    run(matcher.push('user', { id: '99', role: 'editor' }));

    const ro = run(matcher.readOnly());

    expect(run(ro.getAttrValue('id'))).toBe('99');
    expect(run(ro.getAttrValue('role'))).toBe('editor');
    expect(run(ro.getAttrValue('missing'))).toBe(undefined);
  });

  it('reports which attributes the current node carries', () => {
    const matcher = new Matcher();
    run(matcher.push('user', { id: '1' }));

    const ro = run(matcher.readOnly());

    expect(run(ro.hasAttr('id'))).toBe(true);
    expect(!run(ro.hasAttr('name'))).toBe(true);
  });

  it('reads the current node position among its siblings', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('a'));
    run(matcher.pop());
    run(matcher.push('b'));
    run(matcher.pop());
    run(matcher.push('a')); // position = 2;

    const ro = run(matcher.readOnly());

    expect(run(ro.getPosition())).toBe(2);
  });

  it('reads the current node counter among same-named siblings', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('item'));
    run(matcher.pop());
    run(matcher.push('item')); // counter = 1;

    const ro = run(matcher.readOnly());

    expect(run(ro.getCounter())).toBe(1);
  });

  it('still reads the deprecated getIndex() alias', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('a'));
    run(matcher.pop());
    run(matcher.push('b')); // position = 1;

    const ro = run(matcher.readOnly());

    expect(run(ro.getIndex())).toBe(1);
  });

  it('reads the current depth', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));
    run(matcher.push('user'));

    const ro = run(matcher.readOnly());

    expect(run(ro.getDepth())).toBe(3);
  });

  it('joins the path into a string, with the matcher separator or a given one', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));
    run(matcher.push('user'));

    const ro = run(matcher.readOnly());

    expect(run(ro.toString())).toBe('root.users.user');
    expect(run(ro.toString('/'))).toBe('root/users/user');
  });

  it('lists the path as tag names, root first', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));
    run(matcher.push('user'));

    const ro = run(matcher.readOnly());
    const arr = run(ro.toArray());

    expect(arr.length).toBe(3);
    expect(arr[0]).toBe('root');
    expect(arr[2]).toBe('user');
  });

  it('matches exact paths, deep wildcards and attribute conditions', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));
    run(matcher.push('user', { id: '5' }));

    const ro = run(matcher.readOnly());

    expect(run(ro.matches(expr('root.users.user')))).toBe(true);
    expect(run(ro.matches(expr('..user')))).toBe(true);
    expect(run(ro.matches(expr('root.users.user[id]')))).toBe(true);
    expect(run(ro.matches(expr('root.users.user[id=5]')))).toBe(true);
    expect(!run(ro.matches(expr('root.users.admin')))).toBe(true);
  });

  it('carries no snapshot of its own, so nothing can be rewound through the view', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));

    const ro = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof ro.snapshot).toBe('undefined');

    // A snapshot taken from the matcher is frozen at the moment it is taken; the view has none to take.
    const snap = run(matcher.snapshot());
    run(matcher.push('user'));

    expect(snap.path.length).toBe(2);
    expect(run(matcher.getDepth())).toBe(3);
  });
});

describe('the view tracks the matcher as it moves', () => {
  it('reflects every push made on the original matcher', () => {
    const matcher = new Matcher();
    const ro = run(matcher.readOnly());

    run(matcher.push('root'));

    expect(run(ro.getDepth())).toBe(1);
    expect(run(ro.getCurrentTag())).toBe('root');

    run(matcher.push('users'));

    expect(run(ro.getDepth())).toBe(2);
  });

  it('reflects a pop made on the original matcher', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));

    const ro = run(matcher.readOnly());

    run(matcher.pop());

    expect(run(ro.getDepth())).toBe(1);
    expect(run(ro.getCurrentTag())).toBe('root');
  });

  it('reflects a reset made on the original matcher', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));

    const ro = run(matcher.readOnly());
    run(matcher.reset());

    expect(run(ro.getDepth())).toBe(0);
    expect(run(ro.getCurrentTag())).toBe(undefined);
  });

  it('reflects an updateCurrent made on the original matcher', () => {
    const matcher = new Matcher();
    run(matcher.push('user'));

    const ro = run(matcher.readOnly());

    expect(!run(ro.hasAttr('id'))).toBe(true);

    run(matcher.updateCurrent({ id: '77' }));

    expect(run(ro.hasAttr('id'))).toBe(true);
    expect(run(ro.getAttrValue('id'))).toBe('77');
  });
});

describe('the view cannot move the parse position', () => {
  it('has no push(), so a callback cannot descend', () => {
    const matcher = new Matcher();
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof view.push).toBe('undefined');
  });

  it('has no pop(), so a callback cannot ascend', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof view.pop).toBe('undefined');
  });

  it('has no reset(), so a callback cannot rewind to the root', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof view.reset).toBe('undefined');
  });

  it('has no updateCurrent(), so a callback cannot rewrite the current node', () => {
    const matcher = new Matcher();
    run(matcher.push('user'));
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof view.updateCurrent).toBe('undefined');
  });

  it('has no restore(), so a callback cannot rewind from a snapshot', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.snapshot());
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof view.restore).toBe('undefined');
  });

  it('leaves the matcher untouched when push, pop and reset are aimed at the view', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    // Each call throws — the view has none of the three — so none of them reaches the matcher.
    try {
      (view.push as (tag: string) => void)('child');
    } catch {
      // blocked before the matcher is reached
    }
    try {
      (view.pop as () => void)();
    } catch {
      // blocked before the matcher is reached
    }
    try {
      (view.reset as () => void)();
    } catch {
      // blocked before the matcher is reached
    }

    expect(run(matcher.getDepth())).toBe(1);
    expect(run(matcher.getCurrentTag())).toBe('root');
  });
});

describe('the view refuses writes to its own properties', () => {
  it('throws a TypeError when a property is assigned on it', () => {
    const matcher = new Matcher();
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    // `separator` is a getter with no setter, so the assignment fails before it can land.
    let thrown: unknown;
    try {
      view.separator = '/';
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TypeError);
  });

  it('leaves its properties in place when one is deleted from it', () => {
    const matcher = new Matcher();
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    // `separator` lives on the prototype, so deleting it from the view is a no-op rather than a throw.
    delete view.separator;

    expect(view.separator).toBe('.');
  });

  it("leaves the matcher's own separator alone when a write is aimed at the view", () => {
    const matcher = new Matcher({ separator: '.' });
    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    try {
      view.separator = '/';
    } catch {
      // the write never lands, on the view or on the matcher
    }

    expect(matcher.separator).toBe('.');
  });
});

describe('the view exposes neither the path array nor its nodes', () => {
  it('has no path property, not even a frozen copy', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user'));

    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof view.path).toBe('undefined');
  });

  it('leaves the matcher untouched when a push is aimed at where its path would be', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user'));

    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    try {
      (view.path as PathNode[]).push({ tag: 'injected', position: 99, counter: 99 });
    } catch {
      // there is no path to push onto
    }

    expect(run(matcher.getDepth())).toBe(2);
    expect(run(matcher.getCurrentTag())).toBe('user');
  });

  it('reaches no path node, so there is nothing to freeze', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', { id: '1' }));

    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect((view.path as PathNode[] | undefined)?.[1]).toBeUndefined();
  });

  it('leaves the current tag untouched when a node rewrite is aimed at the view', () => {
    const matcher = new Matcher();
    run(matcher.push('user', { id: '1' }));

    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    try {
      (view.path as PathNode[])[0].tag = 'hacked';
    } catch {
      // there is no node to rewrite
    }

    expect(run(matcher.getCurrentTag())).toBe('user');
  });
});

describe('the view handles an empty matcher, namespaces and deep wildcards', () => {
  it('reports an empty path on a matcher that has been pushed nothing', () => {
    const matcher = new Matcher();
    const ro = run(matcher.readOnly());

    expect(run(ro.getDepth())).toBe(0);
    expect(run(ro.getCurrentTag())).toBe(undefined);
    expect(run(ro.getPosition())).toBe(-1);
    expect(run(ro.getCounter())).toBe(-1);
    expect(!run(ro.hasAttr('id'))).toBe(true);
  });

  it('leaves snapshot and restore to the matcher alone', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));

    const view = run(matcher.readOnly()) as unknown as Record<string, unknown>;

    expect(typeof view.snapshot).toBe('undefined');

    // Only the matcher can rewind, so the snapshot that rewinds it comes from the matcher.
    const snap = run(matcher.snapshot());
    run(matcher.push('user', { id: '1' }));

    expect(run(matcher.getDepth())).toBe(3);

    run(matcher.restore(snap));

    expect(run(matcher.getDepth())).toBe(2);
    expect(run(matcher.getCurrentTag())).toBe('users');
  });

  it('keeps namespaces readable through the view', () => {
    const matcher = new Matcher();
    run(matcher.push('root', {}, 'ns1'));
    run(matcher.push('child', {}, 'ns2'));

    const ro = run(matcher.readOnly());

    expect(run(ro.getCurrentNamespace())).toBe('ns2');
    expect(run(ro.toString('.', true))).toBe('ns1:root.ns2:child');
  });

  it('matches a deep wildcard only against the current tag', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('users'));

    const ro = run(matcher.readOnly());

    expect(!run(ro.matches(expr('..user')))).toBe(true);
    expect(run(ro.matches(expr('..users')))).toBe(true);
  });
});
