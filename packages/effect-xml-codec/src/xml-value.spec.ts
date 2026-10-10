import { Predicate, Result, Schema } from 'effect';
import { assert, describe, expect, it } from 'vite-plus/test';

import type { XmlRecord } from '#/xml-value.ts';

import { isXmlValue, XmlValue } from '#/xml-value.ts';

describe('isXmlValue()', () => {
  it.each([
    '',
    'hello',
    '<not markup>',
    undefined,
    {},
    [],
    { a: { b: 'x' } },
    { '@id': '1', '#text': 'x', child: { n: '1' } },
    ['a', 'b'],
    [{ a: '1' }, { a: '2' }],
    ['a', ['b', ['c']]],
    { a: undefined, b: '1' },
    [['a']],
  ] as const)('accepts character data (%o)', value => {
    expect(isXmlValue(value)).toBe(true);
  });

  it.each([
    1,
    true,
    null,
    10n,
    Symbol('s'),
    { a: 1 },
    { a: null },
    { a: { b: 1 } },
    // new Date(),
    // new Set(),
    // new Map()
  ] as const)('rejects a scalar that is not character data (%o)', value => {
    expect(isXmlValue(value)).toBe(false);
  });

  it('rejects a value nested past its depth limit rather than exhausting the stack', () => {
    let deep: XmlValue = 'x';
    for (let i = 0; i < 2000; i++) deep = { nest: deep };
    expect(isXmlValue(deep)).toBe(false);
  });

  it('rejects a self-referential value rather than walking it forever', () => {
    const cyclic: Record<string, unknown> = { a: 'x' };
    cyclic['self'] = cyclic;
    expect(isXmlValue(cyclic)).toBe(false);
  });

  it('rejects a self-referential array rather than walking it forever', () => {
    const cyclic: Array<unknown> = ['a'];
    cyclic.push(cyclic);
    expect(isXmlValue(cyclic)).toBe(false);
  });
});

describe('the XmlValue schema', () => {
  it('accepts a value that is one', () => {
    expect(Schema.decodeSync(XmlValue)({ book: { '@id': '1', title: 'Dune' } })).toEqual({ book: { '@id': '1', title: 'Dune' } });
  });

  it('rejects a value that is not one', () => {
    const result = Schema.decodeUnknownResult(XmlValue)({ book: 42 });
    assert(Result.isFailure(result));
  });
});

describe('the XmlRecord type', () => {
  it('describes a document, so a value can be written without a cast', () => {
    const document: XmlRecord = { book: { '@id': '1', title: 'Dune', tag: ['a', 'b'] } };
    expect(Predicate.isReadonlyObject(document)).toBe(true);
  });
});
