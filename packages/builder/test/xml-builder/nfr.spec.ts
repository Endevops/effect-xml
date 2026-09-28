/**
 * @description Specs for the `maxNestedTags` guard: the depth past which the builder throws `Maximum nested tags exceeded`, and that a document sitting exactly on
 * the limit still builds. Each input is produced by parsing with a higher limit, so the nesting is a real parse result rather than a hand-written
 * object. Covered in both the plain-object and the `preserveOrder` form.
 */

/**
 * @description `XMLParser` here is the **upstream** `fast-xml-parser` from npm, not `@endevops/parser`. It is used to produce input documents for the builder — a
 * real parse result rather than a hand-written object — and it is synchronous, so its `parse` returns a value and must not be passed to {@link run},
 * which only accepts an `Effect`. Only this package's own builder calls are effects. (`@endevops/parser` has since been converted to the same typed
 * channel, so the two now differ; that difference is exactly what the wrap here got wrong.)
 */
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vite-plus/test';

import { failed, makeBuilder, run } from '#/test/helpers/effect.ts';

describe('XMLBuilder', () => {
  it('should throw error for deeply nested tags', () => {
    const depth = 11;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15 });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = makeBuilder({ maxNestedTags: 10 });
    expect(failed(builder.build(jsObj)).message).toContain('Maximum nested tags exceeded');
  });

  it('should not throw error for deeply nested tags when under limit', () => {
    const depth = 10;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15 });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = makeBuilder({ maxNestedTags: 10 });
    run(builder.build(jsObj));
  });

  it('should throw error for deeply nested tags with preserveOrder', () => {
    const depth = 11;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15, preserveOrder: true });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = makeBuilder({ maxNestedTags: 10, preserveOrder: true });
    expect(failed(builder.build(jsObj)).message).toContain('Maximum nested tags exceeded');
  });

  it('should not throw error for deeply nested tags when under limit with preserveOrder', () => {
    const depth = 10;
    const xmlData = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);

    const parser = new XMLParser({ maxNestedTags: 15, preserveOrder: true });
    const jsObj: unknown = parser.parse(xmlData);
    const builder = makeBuilder({ maxNestedTags: 10, preserveOrder: true });
    run(builder.build(jsObj));
  });
});
