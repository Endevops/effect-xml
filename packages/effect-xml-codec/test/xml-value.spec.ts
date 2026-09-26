/**
 * @description Specs for the `XmlValue` model: the guard that decides whether an arbitrary value is one, and the schema that wraps it.
 */

import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { XmlRecord, XmlValue } from '#/index.ts';

import { isXmlArray, isXmlRecord, isXmlValue, XmlValueSchema } from '#/index.ts';

describe('isXmlValue()', () => {
  it('accepts character data', () => {
    expect(isXmlValue('')).toBe(true);
    expect(isXmlValue('hello')).toBe(true);
    expect(isXmlValue('<not markup>')).toBe(true); // character data, whatever it looks like
  });

  it('accepts absent values, which is how an optional field stays absent', () => {
    expect(isXmlValue(undefined)).toBe(true);
  });

  it('accepts an empty array and an empty record', () => {
    expect(isXmlValue([])).toBe(true);
    expect(isXmlValue({})).toBe(true);
  });

  it('accepts a nested record', () => {
    expect(isXmlValue({ a: { b: 'x' } })).toBe(true);
    expect(isXmlValue({ '@id': '1', '#text': 'x', child: { n: '1' } })).toBe(true);
  });

  it('accepts an array of anything the model allows', () => {
    expect(isXmlValue(['a', 'b'])).toBe(true);
    expect(isXmlValue([{ a: '1' }, { a: '2' }])).toBe(true);
    expect(isXmlValue(['a', ['b', ['c']]])).toBe(true);
  });

  it('accepts absent fields inside a record', () => {
    expect(isXmlValue({ a: undefined, b: '1' })).toBe(true);
  });

  it('rejects a scalar that is not character data', () => {
    expect(isXmlValue(1)).toBe(false);
    expect(isXmlValue(true)).toBe(false);
    expect(isXmlValue(null)).toBe(false);
    expect(isXmlValue(10n)).toBe(false);
    expect(isXmlValue(Symbol('s'))).toBe(false);
  });

  it('accepts an array nested inside an array, which is what a repeated element collapses to', () => {
    expect(isXmlValue([['a']])).toBe(true);
    expect(isXmlValue(['a', ['b', ['c']]])).toBe(true);
  });

  it('rejects a value nested past its depth limit rather than exhausting the stack', () => {
    let deep: XmlValue = 'x';
    for (let i = 0; i < 2000; i++) deep = { nest: deep };
    expect(isXmlValue(deep)).toBe(false);
  });

  it('rejects a record holding something the model cannot carry', () => {
    expect(isXmlValue({ a: 1 })).toBe(false);
    expect(isXmlValue({ a: null })).toBe(false);
    expect(isXmlValue({ a: { b: 1 } })).toBe(false);
  });

  it('rejects a value built from a class, which is not a document', () => {
    expect(isXmlValue(new Date())).toBe(false);
    expect(isXmlValue(new Map())).toBe(false);
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

describe('the type guards', () => {
  it('tell an array from a record from character data', () => {
    expect(isXmlArray(['a'])).toBe(true);
    expect(isXmlArray({ a: 'x' })).toBe(false);
    expect(isXmlArray('x')).toBe(false);
    expect(isXmlArray(undefined)).toBe(false);

    expect(isXmlRecord({ a: 'x' })).toBe(true);
    expect(isXmlRecord({})).toBe(true);
    expect(isXmlRecord(['a'])).toBe(false);
    expect(isXmlRecord('x')).toBe(false);
    expect(isXmlRecord(null)).toBe(false);
  });
});

describe('the XmlValue schema', () => {
  it('accepts a value that is one', () => {
    expect(Schema.decodeUnknownSync(XmlValueSchema)({ book: { '@id': '1', title: 'Dune' } })).toEqual({ book: { '@id': '1', title: 'Dune' } });
  });

  it('rejects a value that is not one', () => {
    expect(() => Schema.decodeUnknownSync(XmlValueSchema)({ book: 42 })).toThrow();
  });

  it('names what it expected', () => {
    const issue = Schema.decodeUnknownExit(XmlValueSchema)({ book: 42 });
    expect(issue._tag).toBe('Failure');
  });
});

describe('the XmlRecord type', () => {
  it('describes a document, so a value can be written without a cast', () => {
    const document: XmlRecord = { book: { '@id': '1', title: 'Dune', tag: ['a', 'b'] } };
    expect(isXmlRecord(document)).toBe(true);
  });
});
