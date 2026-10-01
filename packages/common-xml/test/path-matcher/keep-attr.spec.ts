/**
 * @description Specs for the `push(tag, attrs, ns, { keep: [...] })` option on `Matcher`: attributes named at push time stay reachable from descendants through
 * `getAnyParentAttr` / `hasAnyParentAttr` after the node that declared them stops being the current node. Covers lookup and shadowing, lifetime
 * across `pop` / `reset` / `snapshot` / `restore`, the `MatcherView` mirror, and the fact that current-node reads and expression matching are left
 * untouched.
 */

import { describe, expect, it } from 'vite-plus/test';

import { Matcher } from '#/index.ts';
import type { MatcherView } from '#/index.ts';
import { expr } from '#/test/helpers/effect.ts';

describe('kept-attribute lookup', () => {
  it('is readable from the node that declared the attribute and from deeper descendants', () => {
    const m = new Matcher();
    m.push('Envelope', null, 'soap');
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });

    expect(m.hasAnyParentAttr('version')).toBe(true);
    expect(m.getAnyParentAttr('version')).toBe('1.1');
    expect(m.hasAnyParentAttr('missing')).toBe(false);

    m.push('GetUserRequest', { id: '42' }, 'ns');
    m.push('UserId', null, 'ns');

    expect(m.hasAnyParentAttr('version')).toBe(true);
    expect(m.getAnyParentAttr('version')).toBe('1.1');
    expect(m.getAttrValue('version')).toBe(undefined);
    expect(m.hasAnyParentAttr('id')).toBe(false);
  });

  it('leaves current-node attribute access untouched', () => {
    const m = new Matcher();
    m.push('Body', { version: '1.1', extra: 'x' }, 'soap', { keep: ['version'] });

    expect(m.getAttrValue('version')).toBe('1.1');
    expect(m.getAttrValue('extra')).toBe('x');
    expect(m.hasAttr('extra')).toBe(true);
  });

  it('resolves to the nearest value when the same name is kept at several depths', () => {
    const m = new Matcher();
    m.push('Outer', { version: 'A' }, null, { keep: ['version'] });
    m.push('Inner', { version: 'B' }, null, { keep: ['version'] });

    expect(m.getAnyParentAttr('version')).toBe('B');

    m.pop();
    expect(m.getAnyParentAttr('version')).toBe('A');
  });

  it('keeps distinct attributes from different ancestors side by side', () => {
    const m = new Matcher();
    m.push('Envelope', { version: '1.1', xmlns: 'soap-env' }, 'soap', { keep: ['version', 'xmlns'] });
    m.push('Body', { lang: 'en' }, null, { keep: ['lang'] });
    m.push('Deep');

    expect(m.getAnyParentAttr('version')).toBe('1.1');
    expect(m.getAnyParentAttr('xmlns')).toBe('soap-env');
    expect(m.getAnyParentAttr('lang')).toBe('en');
  });

  it('ignores a keep name the pushed node does not carry', () => {
    const m = new Matcher();
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['version', 'doesNotExist'] });
    expect(m.hasAnyParentAttr('version')).toBe(true);
    expect(m.hasAnyParentAttr('doesNotExist')).toBe(false);
  });

  it('creates no entry when the pushed node has null attributes', () => {
    const m = new Matcher();
    m.push('Body', null, 'soap', { keep: ['version'] });
    expect(m.hasAnyParentAttr('version')).toBe(false);
  });

  it('resolves an unknown keep name to undefined and falls back as repeated names are popped', () => {
    const m = new Matcher();
    m.push('Envelope', null, 'soap');
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['lang'] });
    expect(m.getAnyParentAttr('lang')).toBe(undefined);
    m.push('parent', { space: 'preserve' }, null, { keep: ['space'] });
    expect(m.getAnyParentAttr('space')).toBe('preserve');
    m.push('child', { space: 'default' }, null, { keep: ['space'] });
    expect(m.getAnyParentAttr('space')).toBe('default');

    m.push('GetUserRequest', { id: '42' }, 'ns');
    m.pop(); // GetUserRequest;
    m.pop(); // child;
    expect(m.getAnyParentAttr('space')).toBe('preserve');
    m.push('UserId', null, 'ns');
    expect(m.getAnyParentAttr('space')).toBe('preserve');
    m.pop(); // UserId;
    expect(m.getAnyParentAttr('space')).toBe('preserve');
    m.pop(); // parent;
    expect(m.getAnyParentAttr('space')).toBe(undefined);
  });
});

describe('kept-attribute lifetime', () => {
  it('drops the kept attributes owned by a popped subtree, and only those', () => {
    const m = new Matcher();
    m.push('Envelope', null, 'soap');
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
    m.push('Inner', { mode: 'strict' }, null, { keep: ['mode'] });

    expect(m.hasAnyParentAttr('version')).toBe(true);
    expect(m.hasAnyParentAttr('mode')).toBe(true);

    m.pop(); // pop Inner;

    expect(m.hasAnyParentAttr('version')).toBe(true);
    expect(m.hasAnyParentAttr('mode')).toBe(false);

    m.pop(); // pop Body;

    expect(m.hasAnyParentAttr('version')).toBe(false);
  });

  it('clears every kept attribute on reset', () => {
    const m = new Matcher();
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
    expect(m.hasAnyParentAttr('version')).toBe(true);
    m.reset();
    expect(m.hasAnyParentAttr('version')).toBe(false);
  });

  it('round-trips kept attributes through snapshot() and restore()', () => {
    const m = new Matcher();
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
    const snap = m.snapshot();

    m.push('Child');
    m.pop();
    m.pop(); // pop Body -> kept attr should be gone now;
    expect(m.hasAnyParentAttr('version')).toBe(false);

    m.restore(snap);
    expect(m.hasAnyParentAttr('version')).toBe(true);
    expect(m.getAnyParentAttr('version')).toBe('1.1');
  });
});

describe('MatcherView', () => {
  it('mirrors the ancestor-attribute methods of the matcher it wraps', () => {
    const m = new Matcher();
    const view: MatcherView = m.readOnly();
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
    m.push('Child');

    expect(view.hasAnyParentAttr('version')).toBe(true);
    expect(view.getAnyParentAttr('version')).toBe('1.1');
    expect(view.hasAnyParentAttr('nope')).toBe(false);
  });
});

describe('compatibility', () => {
  it('builds the path the same way when push is called without options', () => {
    const m = new Matcher();
    m.push('root');
    m.push('child', { a: '1' });
    m.push('grandchild', { b: '2' }, 'ns');
    expect(m.toString()).toBe('root.child.ns:grandchild');
    expect(m.hasAnyParentAttr('a')).toBe(false);
  });

  it('leaves expression matching unaffected', () => {
    const m = new Matcher();
    m.push('Envelope', null, 'soap');
    m.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
    m.push('UserId');

    const userExpr = expr('soap::Envelope.soap::Body.UserId');
    expect(m.matches(userExpr)).toBe(true);

    const deepExpr = expr('..UserId');
    expect(m.matches(deepExpr)).toBe(true);

    // "[^version]" is NOT special syntax here - parsed as a literal attribute
    // name "^version" on the current node, which won't exist, so this
    // correctly does not match. Confirms no new syntax leaked in.
    const literalCaret = expr('UserId[^version]');
    expect(m.matches(literalCaret)).toBe(false);
  });
});
