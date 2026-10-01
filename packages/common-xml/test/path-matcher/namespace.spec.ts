/**
 * @description Specs for the `ns::tag` namespace syntax, converted from the hand-rolled `namespace_test.js` script. Covers pushing and rendering namespaced paths,
 * parsing the `::` out of a pattern alongside attribute and position conditions, matching a namespaced pattern against namespaced and namespace-less
 * paths, per-namespace sibling counters, and a SOAP envelope end to end.
 */

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { Matcher } from '#/index.ts';
import Expression from '#/path-matcher/expression.ts';

describe('basic namespace handling', () => {
  it('reports the pushed namespace and includes it in the path', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('user', null, 'ns');

    expect(matcher.getCurrentTag()).toBe('user');
    expect(matcher.getCurrentNamespace()).toBe('ns');
    expect(matcher.toString()).toBe('root.ns:user');
  });

  it('reports no namespace and leaves it out of the path when pushed without one', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('user');

    expect(matcher.getCurrentTag()).toBe('user');
    expect(matcher.getCurrentNamespace()).toBeUndefined();
    expect(matcher.toString()).toBe('root.user');
  });

  it('renders a path that mixes namespaced and non-namespaced tags', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('item', null, 'ns1');
    matcher.push('data');
    matcher.push('value', null, 'ns2');

    expect(matcher.toString()).toBe('root.ns1:item.data.ns2:value');
  });

  it('includes namespaces in toString by default and omits them on request', () => {
    const matcher = new Matcher();
    matcher.push('root');
    matcher.push('user', null, 'ns');

    expect(matcher.toString('.', false)).toBe('root.user');
    expect(matcher.toString('.', true)).toBe('root.ns:user');
  });
});

describe('namespace pattern parsing', () => {
  it.effect('parses the namespace and tag out of ns::user', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('ns::user');

      expect(e.segments[0].namespace).toBe('ns');
      expect(e.segments[0].tag).toBe('user');
    })
  );

  it.effect('parses namespace, tag and attribute out of ns::user[id]', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('ns::user[id]');

      expect(e.segments[0].namespace).toBe('ns');
      expect(e.segments[0].tag).toBe('user');
      expect(e.segments[0].attrName).toBe('id');
    })
  );

  it.effect('parses namespace, tag and position out of ns::user:first', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('ns::user:first');

      expect(e.segments[0].namespace).toBe('ns');
      expect(e.segments[0].tag).toBe('user');
      expect(e.segments[0].position).toBe('first');
    })
  );

  it.effect('parses namespace, tag, attribute value and position out of ns::user[type=admin]:first', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('ns::user[type=admin]:first');

      expect(e.segments[0].namespace).toBe('ns');
      expect(e.segments[0].tag).toBe('user');
      expect(e.segments[0].attrName).toBe('type');
      expect(e.segments[0].attrValue).toBe('admin');
      expect(e.segments[0].position).toBe('first');
    })
  );

  it.effect('parses a separate namespace onto each segment of a multi-namespace pattern', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('ns1::root.ns2::items.ns3::item');

      expect(e.segments[0].namespace).toBe('ns1');
      expect(e.segments[0].tag).toBe('root');
      expect(e.segments[1].namespace).toBe('ns2');
      expect(e.segments[1].tag).toBe('items');
      expect(e.segments[2].namespace).toBe('ns3');
      expect(e.segments[2].tag).toBe('item');
    })
  );

  it.effect('leaves the namespace undefined on a pattern segment that specifies none', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('user');

      expect(e.segments[0].namespace).toBeUndefined();
      expect(e.segments[0].tag).toBe('user');
    })
  );

  it.effect('leaves the namespace undefined on the segments around a namespaced one', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('root.ns::items.item');

      expect(e.segments[0].namespace).toBeUndefined();
      expect(e.segments[1].namespace).toBe('ns');
      expect(e.segments[2].namespace).toBeUndefined();
    })
  );

  it.effect('reads ns::first as a namespace plus a tag named first, with no position selector', () =>
    Effect.gen(function* () {
      const e = yield* Expression.make('ns::first');

      expect(e.segments[0].namespace).toBe('ns');
      expect(e.segments[0].tag).toBe('first');
      expect(e.segments[0].position).toBeUndefined();
    })
  );
});

describe('namespace matching', () => {
  it.effect('matches when the pattern namespace equals the tag namespace', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', null, 'ns');

      const e = yield* Expression.make('root.ns::user');

      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('does not match a different namespace', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', null, 'ns1');

      const e = yield* Expression.make('root.ns2::user');

      expect(matcher.matches(e)).toBe(false);
    })
  );

  it.effect('matches any namespace when the pattern specifies none', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', null, 'ns');

      const e = yield* Expression.make('root.user');

      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('matches when neither the pattern nor the tag carries a namespace', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user');

      const e = yield* Expression.make('root.user');

      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('does not match a namespace-less tag against a namespaced pattern', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user');

      const e = yield* Expression.make('root.ns::user');

      expect(matcher.matches(e)).toBe(false);
    })
  );

  it.effect('matches any namespace through a wildcard namespace', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', null, 'ns1');

      const e = yield* Expression.make('root.*::user');

      expect(matcher.matches(e)).toBe(true);

      // Same tag, different namespace: the wildcard still matches.
      matcher.pop();
      matcher.push('user', null, 'ns2');

      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('matches a namespaced tag carrying the attribute the pattern requires', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', { id: '123' }, 'ns');

      const e = yield* Expression.make('root.ns::user[id]');

      expect(matcher.matches(e)).toBe(true);
    })
  );

  it.effect('matches :first against a namespaced tag only on its first occurrence', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('user', null, 'ns'); // counter = 0;

      const e = yield* Expression.make('root.ns::user:first');

      expect(matcher.matches(e)).toBe(true);

      // Second ns::user sibling, so the counter is 1.
      matcher.pop();
      matcher.push('user', null, 'ns');

      expect(matcher.matches(e)).toBe(false);
    })
  );

  it.effect('matches a namespaced tag at any depth through a deep wildcard', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('level1');
      matcher.push('level2');
      matcher.push('user', null, 'ns');

      const e1 = yield* Expression.make('..ns::user');

      expect(matcher.matches(e1)).toBe(true);

      const e2 = yield* Expression.make('root..ns::user');

      expect(matcher.matches(e2)).toBe(true);
    })
  );

  it.effect('reads ns::first unambiguously as a namespaced tag named first', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');
      matcher.push('first', null, 'ns'); // tag "first" in namespace "ns", counter = 0;

      const e = yield* Expression.make('root.ns::first');

      expect(matcher.matches(e)).toBe(true);

      // Second ns::first sibling, so :first no longer applies.
      matcher.pop();
      matcher.push('first', null, 'ns');

      const e2 = yield* Expression.make('root.ns::first:first');

      expect(matcher.matches(e2)).toBe(false);
    })
  );
});

describe('counter and position with namespaces', () => {
  it('counts same-named siblings separately per namespace', () => {
    const matcher = new Matcher();
    matcher.push('root');

    matcher.push('item', null, 'ns1'); // ns1::item counter = 0;
    expect(matcher.getCounter()).toBe(0);
    matcher.pop();

    // A different namespace starts its own counter.
    matcher.push('item', null, 'ns2'); // ns2::item counter = 0;
    expect(matcher.getCounter()).toBe(0);
    matcher.pop();

    // The second ns1::item only now sees counter = 1.
    matcher.push('item', null, 'ns1');
    expect(matcher.getCounter()).toBe(1);
  });

  it.effect('applies :first per namespace', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();
      matcher.push('root');

      matcher.push('item', null, 'ns1');
      matcher.pop();
      matcher.push('item', null, 'ns2'); // first ns2::item;

      const e = yield* Expression.make('root.ns2::item:first');

      expect(matcher.matches(e)).toBe(true);

      const e2 = yield* Expression.make('root.ns1::item:first'); // ns1::item counter = 1

      expect(matcher.matches(e2)).toBe(false);
    })
  );
});

describe('SOAP real-world example', () => {
  it.effect('builds and matches a SOAP-style namespaced path', () =>
    Effect.gen(function* () {
      const matcher = new Matcher();

      matcher.push('Envelope', null, 'soap');
      matcher.push('Body', null, 'soap');
      matcher.push('GetUser', null, 'ns');
      matcher.push('UserId', null, 'ns');

      expect(matcher.toString()).toBe('soap:Envelope.soap:Body.ns:GetUser.ns:UserId');

      const e = yield* Expression.make('soap::Envelope.soap::Body..ns::UserId');

      expect(matcher.matches(e)).toBe(true);
    })
  );
});
