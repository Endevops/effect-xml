/**
 * @description Specs for the `ns::tag` namespace syntax, converted from the hand-rolled `namespace_test.js` script. Covers pushing and rendering namespaced paths,
 * parsing the `::` out of a pattern alongside attribute and position conditions, matching a namespaced pattern against namespaced and namespace-less
 * paths, per-namespace sibling counters, and a SOAP envelope end to end.
 */

import { describe, expect, it } from 'vite-plus/test';

import { Matcher } from '#/index.ts';
import { expr, run } from '#/test/helpers/effect.ts';

describe('basic namespace handling', () => {
  it('reports the pushed namespace and includes it in the path', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', null, 'ns'));

    expect(run(matcher.getCurrentTag())).toBe('user');
    expect(run(matcher.getCurrentNamespace())).toBe('ns');
    expect(run(matcher.toString())).toBe('root.ns:user');
  });

  it('reports no namespace and leaves it out of the path when pushed without one', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user'));

    expect(run(matcher.getCurrentTag())).toBe('user');
    expect(run(matcher.getCurrentNamespace())).toBeUndefined();
    expect(run(matcher.toString())).toBe('root.user');
  });

  it('renders a path that mixes namespaced and non-namespaced tags', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('item', null, 'ns1'));
    run(matcher.push('data'));
    run(matcher.push('value', null, 'ns2'));

    expect(run(matcher.toString())).toBe('root.ns1:item.data.ns2:value');
  });

  it('includes namespaces in toString by default and omits them on request', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', null, 'ns'));

    expect(run(matcher.toString('.', false))).toBe('root.user');
    expect(run(matcher.toString('.', true))).toBe('root.ns:user');
  });
});

describe('namespace pattern parsing', () => {
  it('parses the namespace and tag out of ns::user', () => {
    const e = expr('ns::user');

    expect(e.segments[0].namespace).toBe('ns');
    expect(e.segments[0].tag).toBe('user');
  });

  it('parses namespace, tag and attribute out of ns::user[id]', () => {
    const e = expr('ns::user[id]');

    expect(e.segments[0].namespace).toBe('ns');
    expect(e.segments[0].tag).toBe('user');
    expect(e.segments[0].attrName).toBe('id');
  });

  it('parses namespace, tag and position out of ns::user:first', () => {
    const e = expr('ns::user:first');

    expect(e.segments[0].namespace).toBe('ns');
    expect(e.segments[0].tag).toBe('user');
    expect(e.segments[0].position).toBe('first');
  });

  it('parses namespace, tag, attribute value and position out of ns::user[type=admin]:first', () => {
    const e = expr('ns::user[type=admin]:first');

    expect(e.segments[0].namespace).toBe('ns');
    expect(e.segments[0].tag).toBe('user');
    expect(e.segments[0].attrName).toBe('type');
    expect(e.segments[0].attrValue).toBe('admin');
    expect(e.segments[0].position).toBe('first');
  });

  it('parses a separate namespace onto each segment of a multi-namespace pattern', () => {
    const e = expr('ns1::root.ns2::items.ns3::item');

    expect(e.segments[0].namespace).toBe('ns1');
    expect(e.segments[0].tag).toBe('root');
    expect(e.segments[1].namespace).toBe('ns2');
    expect(e.segments[1].tag).toBe('items');
    expect(e.segments[2].namespace).toBe('ns3');
    expect(e.segments[2].tag).toBe('item');
  });

  it('leaves the namespace undefined on a pattern segment that specifies none', () => {
    const e = expr('user');

    expect(e.segments[0].namespace).toBeUndefined();
    expect(e.segments[0].tag).toBe('user');
  });

  it('leaves the namespace undefined on the segments around a namespaced one', () => {
    const e = expr('root.ns::items.item');

    expect(e.segments[0].namespace).toBeUndefined();
    expect(e.segments[1].namespace).toBe('ns');
    expect(e.segments[2].namespace).toBeUndefined();
  });

  it('reads ns::first as a namespace plus a tag named first, with no position selector', () => {
    const e = expr('ns::first');

    expect(e.segments[0].namespace).toBe('ns');
    expect(e.segments[0].tag).toBe('first');
    expect(e.segments[0].position).toBeUndefined();
  });
});

describe('namespace matching', () => {
  it('matches when the pattern namespace equals the tag namespace', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', null, 'ns'));

    const e = expr('root.ns::user');

    expect(run(matcher.matches(e))).toBe(true);
  });

  it('does not match a different namespace', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', null, 'ns1'));

    const e = expr('root.ns2::user');

    expect(run(matcher.matches(e))).toBe(false);
  });

  it('matches any namespace when the pattern specifies none', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', null, 'ns'));

    const e = expr('root.user');

    expect(run(matcher.matches(e))).toBe(true);
  });

  it('matches when neither the pattern nor the tag carries a namespace', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user'));

    const e = expr('root.user');

    expect(run(matcher.matches(e))).toBe(true);
  });

  it('does not match a namespace-less tag against a namespaced pattern', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user'));

    const e = expr('root.ns::user');

    expect(run(matcher.matches(e))).toBe(false);
  });

  it('matches any namespace through a wildcard namespace', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', null, 'ns1'));

    const e = expr('root.*::user');

    expect(run(matcher.matches(e))).toBe(true);

    // Same tag, different namespace: the wildcard still matches.
    run(matcher.pop());
    run(matcher.push('user', null, 'ns2'));

    expect(run(matcher.matches(e))).toBe(true);
  });

  it('matches a namespaced tag carrying the attribute the pattern requires', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', { id: '123' }, 'ns'));

    const e = expr('root.ns::user[id]');

    expect(run(matcher.matches(e))).toBe(true);
  });

  it('matches :first against a namespaced tag only on its first occurrence', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('user', null, 'ns')); // counter = 0;

    const e = expr('root.ns::user:first');

    expect(run(matcher.matches(e))).toBe(true);

    // Second ns::user sibling, so the counter is 1.
    run(matcher.pop());
    run(matcher.push('user', null, 'ns'));

    expect(run(matcher.matches(e))).toBe(false);
  });

  it('matches a namespaced tag at any depth through a deep wildcard', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('level1'));
    run(matcher.push('level2'));
    run(matcher.push('user', null, 'ns'));

    const e1 = expr('..ns::user');

    expect(run(matcher.matches(e1))).toBe(true);

    const e2 = expr('root..ns::user');

    expect(run(matcher.matches(e2))).toBe(true);
  });

  it('reads ns::first unambiguously as a namespaced tag named first', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));
    run(matcher.push('first', null, 'ns')); // tag "first" in namespace "ns", counter = 0;

    const e = expr('root.ns::first');

    expect(run(matcher.matches(e))).toBe(true);

    // Second ns::first sibling, so :first no longer applies.
    run(matcher.pop());
    run(matcher.push('first', null, 'ns'));

    const e2 = expr('root.ns::first:first');

    expect(run(matcher.matches(e2))).toBe(false);
  });
});

describe('counter and position with namespaces', () => {
  it('counts same-named siblings separately per namespace', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));

    run(matcher.push('item', null, 'ns1')); // ns1::item counter = 0;
    expect(run(matcher.getCounter())).toBe(0);
    run(matcher.pop());

    // A different namespace starts its own counter.
    run(matcher.push('item', null, 'ns2')); // ns2::item counter = 0;
    expect(run(matcher.getCounter())).toBe(0);
    run(matcher.pop());

    // The second ns1::item only now sees counter = 1.
    run(matcher.push('item', null, 'ns1'));
    expect(run(matcher.getCounter())).toBe(1);
  });

  it('applies :first per namespace', () => {
    const matcher = new Matcher();
    run(matcher.push('root'));

    run(matcher.push('item', null, 'ns1'));
    run(matcher.pop());
    run(matcher.push('item', null, 'ns2')); // first ns2::item;

    const e = expr('root.ns2::item:first');

    expect(run(matcher.matches(e))).toBe(true);

    const e2 = expr('root.ns1::item:first'); // ns1::item counter = 1

    expect(run(matcher.matches(e2))).toBe(false);
  });
});

describe('SOAP real-world example', () => {
  it('builds and matches a SOAP-style namespaced path', () => {
    const matcher = new Matcher();

    run(matcher.push('Envelope', null, 'soap'));
    run(matcher.push('Body', null, 'soap'));
    run(matcher.push('GetUser', null, 'ns'));
    run(matcher.push('UserId', null, 'ns'));

    expect(run(matcher.toString())).toBe('soap:Envelope.soap:Body.ns:GetUser.ns:UserId');

    const e = expr('soap::Envelope.soap::Body..ns::UserId');

    expect(run(matcher.matches(e))).toBe(true);
  });
});
