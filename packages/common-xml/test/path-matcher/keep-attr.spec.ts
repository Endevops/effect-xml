/**
 * @description Specs for the `push(tag, attrs, ns, { keep: [...] })` option on `Matcher`: attributes named at push time stay reachable from descendants through
 * `getAnyParentAttr` / `hasAnyParentAttr` after the node that declared them stops being the current node. Covers lookup and shadowing, lifetime
 * across `pop` / `reset` / `snapshot` / `restore`, the `MatcherView` mirror, and the fact that current-node reads and expression matching are left
 * untouched.
 */

import { describe, expect, it } from 'vite-plus/test';

import { Matcher, type MatcherView } from '#/index.ts';
import { expr, run } from '#/test/helpers/effect.ts';

describe('kept-attribute lookup', () => {
  it('is readable from the node that declared the attribute and from deeper descendants', () => {
    const m = new Matcher();
    run(m.push('Envelope', null, 'soap'));
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] }));

    expect(run(m.hasAnyParentAttr('version'))).toBe(true);
    expect(run(m.getAnyParentAttr('version'))).toBe('1.1');
    expect(run(m.hasAnyParentAttr('missing'))).toBe(false);

    run(m.push('GetUserRequest', { id: '42' }, 'ns'));
    run(m.push('UserId', null, 'ns'));

    expect(run(m.hasAnyParentAttr('version'))).toBe(true);
    expect(run(m.getAnyParentAttr('version'))).toBe('1.1');
    expect(run(m.getAttrValue('version'))).toBe(undefined);
    expect(run(m.hasAnyParentAttr('id'))).toBe(false);
  });

  it('leaves current-node attribute access untouched', () => {
    const m = new Matcher();
    run(m.push('Body', { version: '1.1', extra: 'x' }, 'soap', { keep: ['version'] }));

    expect(run(m.getAttrValue('version'))).toBe('1.1');
    expect(run(m.getAttrValue('extra'))).toBe('x');
    expect(run(m.hasAttr('extra'))).toBe(true);
  });

  it('resolves to the nearest value when the same name is kept at several depths', () => {
    const m = new Matcher();
    run(m.push('Outer', { version: 'A' }, null, { keep: ['version'] }));
    run(m.push('Inner', { version: 'B' }, null, { keep: ['version'] }));

    expect(run(m.getAnyParentAttr('version'))).toBe('B');

    run(m.pop());
    expect(run(m.getAnyParentAttr('version'))).toBe('A');
  });

  it('keeps distinct attributes from different ancestors side by side', () => {
    const m = new Matcher();
    run(m.push('Envelope', { version: '1.1', xmlns: 'soap-env' }, 'soap', { keep: ['version', 'xmlns'] }));
    run(m.push('Body', { lang: 'en' }, null, { keep: ['lang'] }));
    run(m.push('Deep'));

    expect(run(m.getAnyParentAttr('version'))).toBe('1.1');
    expect(run(m.getAnyParentAttr('xmlns'))).toBe('soap-env');
    expect(run(m.getAnyParentAttr('lang'))).toBe('en');
  });

  it('ignores a keep name the pushed node does not carry', () => {
    const m = new Matcher();
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['version', 'doesNotExist'] }));
    expect(run(m.hasAnyParentAttr('version'))).toBe(true);
    expect(run(m.hasAnyParentAttr('doesNotExist'))).toBe(false);
  });

  it('creates no entry when the pushed node has null attributes', () => {
    const m = new Matcher();
    run(m.push('Body', null, 'soap', { keep: ['version'] }));
    expect(run(m.hasAnyParentAttr('version'))).toBe(false);
  });

  it('resolves an unknown keep name to undefined and falls back as repeated names are popped', () => {
    const m = new Matcher();
    run(m.push('Envelope', null, 'soap'));
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['lang'] }));
    expect(run(m.getAnyParentAttr('lang'))).toBe(undefined);
    run(m.push('parent', { space: 'preserve' }, null, { keep: ['space'] }));
    expect(run(m.getAnyParentAttr('space'))).toBe('preserve');
    run(m.push('child', { space: 'default' }, null, { keep: ['space'] }));
    expect(run(m.getAnyParentAttr('space'))).toBe('default');

    run(m.push('GetUserRequest', { id: '42' }, 'ns'));
    run(m.pop()); // GetUserRequest;
    run(m.pop()); // child;
    expect(run(m.getAnyParentAttr('space'))).toBe('preserve');
    run(m.push('UserId', null, 'ns'));
    expect(run(m.getAnyParentAttr('space'))).toBe('preserve');
    run(m.pop()); // UserId;
    expect(run(m.getAnyParentAttr('space'))).toBe('preserve');
    run(m.pop()); // parent;
    expect(run(m.getAnyParentAttr('space'))).toBe(undefined);
  });
});

describe('kept-attribute lifetime', () => {
  it('drops the kept attributes owned by a popped subtree, and only those', () => {
    const m = new Matcher();
    run(m.push('Envelope', null, 'soap'));
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] }));
    run(m.push('Inner', { mode: 'strict' }, null, { keep: ['mode'] }));

    expect(run(m.hasAnyParentAttr('version'))).toBe(true);
    expect(run(m.hasAnyParentAttr('mode'))).toBe(true);

    run(m.pop()); // pop Inner;

    expect(run(m.hasAnyParentAttr('version'))).toBe(true);
    expect(run(m.hasAnyParentAttr('mode'))).toBe(false);

    run(m.pop()); // pop Body;

    expect(run(m.hasAnyParentAttr('version'))).toBe(false);
  });

  it('clears every kept attribute on reset', () => {
    const m = new Matcher();
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] }));
    expect(run(m.hasAnyParentAttr('version'))).toBe(true);
    run(m.reset());
    expect(run(m.hasAnyParentAttr('version'))).toBe(false);
  });

  it('round-trips kept attributes through snapshot() and restore()', () => {
    const m = new Matcher();
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] }));
    const snap = run(m.snapshot());

    run(m.push('Child'));
    run(m.pop());
    run(m.pop()); // pop Body -> kept attr should be gone now;
    expect(run(m.hasAnyParentAttr('version'))).toBe(false);

    run(m.restore(snap));
    expect(run(m.hasAnyParentAttr('version'))).toBe(true);
    expect(run(m.getAnyParentAttr('version'))).toBe('1.1');
  });
});

describe('MatcherView', () => {
  it('mirrors the ancestor-attribute methods of the matcher it wraps', () => {
    const m = new Matcher();
    const view: MatcherView = run(m.readOnly());
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] }));
    run(m.push('Child'));

    expect(run(view.hasAnyParentAttr('version'))).toBe(true);
    expect(run(view.getAnyParentAttr('version'))).toBe('1.1');
    expect(run(view.hasAnyParentAttr('nope'))).toBe(false);
  });
});

describe('compatibility', () => {
  it('builds the path the same way when push is called without options', () => {
    const m = new Matcher();
    run(m.push('root'));
    run(m.push('child', { a: '1' }));
    run(m.push('grandchild', { b: '2' }, 'ns'));
    expect(run(m.toString())).toBe('root.child.ns:grandchild');
    expect(run(m.hasAnyParentAttr('a'))).toBe(false);
  });

  it('leaves expression matching unaffected', () => {
    const m = new Matcher();
    run(m.push('Envelope', null, 'soap'));
    run(m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] }));
    run(m.push('UserId'));

    const userExpr = expr('soap::Envelope.soap::Body.UserId');
    expect(run(m.matches(userExpr))).toBe(true);

    const deepExpr = expr('..UserId');
    expect(run(m.matches(deepExpr))).toBe(true);

    // "[^version]" is NOT special syntax here - parsed as a literal attribute
    // name "^version" on the current node, which won't exist, so this
    // correctly does not match. Confirms no new syntax leaked in.
    const literalCaret = expr('UserId[^version]');
    expect(run(m.matches(literalCaret))).toBe(false);
  });
});
