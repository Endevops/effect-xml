/**
 * @description Specs for the `maxNestedTags` guard: the depth past which the builder throws `Maximum nested tags exceeded`, and that a document sitting exactly on
 * the limit still builds. Each input is produced by parsing with a higher limit, so the nesting is a real parse result rather than a hand-written
 * object. Covered in both the plain-object and the `preserveOrder` form.
 */

import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vite-plus/test';

import { XMLBuilder } from '#/index.ts';

describe('XMLBuilder', () => {
  it('should throw error for deeply nested tags', () => {
    const depth = 11;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15 });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = new XMLBuilder({ maxNestedTags: 10 });
    expect(() => builder.build(jsObj)).toThrowError('Maximum nested tags exceeded');
  });

  it('should not throw error for deeply nested tags when under limit', () => {
    const depth = 10;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15 });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = new XMLBuilder({ maxNestedTags: 10 });
    builder.build(jsObj);
  });

  it('should throw error for deeply nested tags with preserveOrder', () => {
    const depth = 11;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15, preserveOrder: true });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = new XMLBuilder({ maxNestedTags: 10, preserveOrder: true });
    expect(() => builder.build(jsObj)).toThrowError('Maximum nested tags exceeded');
  });

  it('should not throw error for deeply nested tags when under limit with preserveOrder', () => {
    const depth = 10;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15, preserveOrder: true });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = new XMLBuilder({ maxNestedTags: 10, preserveOrder: true });
    builder.build(jsObj);
  });
});
