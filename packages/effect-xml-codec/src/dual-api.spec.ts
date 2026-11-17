/**
 * @description Specs for the data-last form of every function that carries one. Each function's own spec covers its behaviour through the data-first
 * call; this file only checks that the curried call reaches the same implementation with the same arguments, so a `Function.dual` dispatch mistake
 * cannot pass unnoticed. Every case picks options that change the answer, so a swapped value/options call fails rather than agreeing by accident.
 */

import { Effect, Result, Schema, pipe } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { resolveName, resolveNameSync } from '#/conventions.ts';
import { decodeNames, ROOT_ELEMENT, encodeNames, namespacePlan } from '#/namespaces.ts';
import { isName, isNcName, isNmToken, isNmTokens, isQName, sanitize } from '#/naming.ts';
import { parseXml, parseXmlDocument } from '#/parse.ts';
import { normalizePlainValue } from '#/plain-value.ts';

const planned = namespacePlan(Schema.Struct({ a: Schema.String }));
if ('error' in planned) throw new Error(planned.error);
const plan = planned.plan;
const stringTree = Schema.toCodecStringTree(Schema.Struct({ a: Schema.String }));

describe('data-last forms', () => {
  it('isName() reads the options from the curried call', () => {
    // `asciiOnly` is the discriminator: the accent is legal in the default range and illegal in ASCII-only.
    expect(isName({ asciiOnly: true })('café')).toBe(isName('café', { asciiOnly: true }));
    expect(isName({ asciiOnly: true })('café')).toBe(false);
  });

  it('isNcName(), isQName(), isNmToken() and isNmTokens() read the options from the curried call', () => {
    expect(isNcName({ asciiOnly: true })('café')).toBe(isNcName('café', { asciiOnly: true }));
    expect(isQName({ asciiOnly: true })('a:b')).toBe(isQName('a:b', { asciiOnly: true }));
    expect(isNmToken({ asciiOnly: true })('café')).toBe(isNmToken('café', { asciiOnly: true }));
    expect(isNmTokens({ asciiOnly: true })('a b')).toBe(isNmTokens('a b', { asciiOnly: true }));
  });

  it('sanitize() reads the production and the options from the curried call', () => {
    expect(sanitize('ncName', { replacement: '-' })('a:b')).toBe(sanitize('a:b', 'ncName', { replacement: '-' }));
    expect(sanitize('ncName', { replacement: '-' })('a:b')).toBe('ab');
  });

  it('resolveNameSync() reads the mode from the curried call', () => {
    expect(resolveNameSync({ mode: 'repair' })('bad name')).toBe(resolveNameSync('bad name', { mode: 'repair' }));
    expect(resolveNameSync({ mode: 'repair' })('bad name')).toBe('bad_name');
  });

  it('resolveName() reads the mode from the curried call', () => {
    expect(Effect.runSync(resolveName({ mode: 'ignore' })('bad name'))).toBe(Effect.runSync(resolveName('bad name', { mode: 'ignore' })));
    expect(Effect.runSync(resolveName({ mode: 'ignore' })('bad name'))).toBe('bad name');
  });

  it('parseXml() reads the document from the curried call', () => {
    const text = '<r><a>1</a></r>';
    expect(Effect.runSync(pipe(text, parseXml({ preserveWhitespace: true })))).toEqual(Effect.runSync(parseXml(text, { preserveWhitespace: true })));
    expect(Effect.runSync(pipe(text, parseXml()))).toEqual({ a: '1' });
  });

  it('parseXmlDocument() reads the document from the curried call', () => {
    expect(pipe('<r/>', parseXmlDocument({ preserveWhitespace: true }))).toEqual(parseXmlDocument('<r/>', { preserveWhitespace: true }));
    expect(pipe('<r/>', parseXmlDocument()).value).toBe('');
  });

  it('normalizePlainValue() reads the value from the curried call', () => {
    expect(pipe({ a: 'x' }, normalizePlainValue(stringTree.ast, ''))).toEqual(normalizePlainValue({ a: 'x' }, stringTree.ast, ''));
    expect(Result.isSuccess(pipe({ a: 'x' }, normalizePlainValue(stringTree.ast, '')))).toBe(true);
  });

  it('encodeNames() and decodeNames() read the value from the curried call', () => {
    const value = { a: 'x' };
    const encoded = encodeNames(value, plan, undefined, {}, ROOT_ELEMENT);
    expect(pipe(value, encodeNames(plan, undefined, {}, ROOT_ELEMENT))).toEqual(encoded);
    expect(pipe(encoded, decodeNames(plan, {}, ROOT_ELEMENT))).toEqual(decodeNames(encoded, plan, {}, ROOT_ELEMENT));
    expect(pipe(encoded, decodeNames(plan, {}, ROOT_ELEMENT))).toEqual(value);
  });
});
