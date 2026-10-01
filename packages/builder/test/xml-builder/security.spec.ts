/**
 * @description Output-side hardening: values that could break out of the construct they are written into. A CDATA payload carrying `]]>`, a comment carrying `--`,
 * a comment body assembled from a multi-key object, and an attribute value carrying a double quote — each in the plain-object form, the
 * `preserveOrder` form, and inside a `stopNodes` subtree where content is otherwise copied through raw. A quote in a raw subtree must still be
 * escaped, since escaping it is structural rather than encoding.
 */

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { XMLBuilder } from '#/index.ts';

describe('XMLBuilder', function () {
  it.effect('should parse to XML with malicious CDATA', () =>
    Effect.gen(function* () {
      const jObj = { a: { $cdata: null }, b: { $cdata: 'Content]]>script<![CDATA[more' } };
      const expected = `<a></a><b><![CDATA[Content]]]]><![CDATA[>script<![CDATA[more]]></b>`;
      const builder = yield* XMLBuilder.make({ cdataPropName: '$cdata' });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
    })
  );
  it.effect('should parse to XML with malicious comment', () =>
    Effect.gen(function* () {
      const jObj = { a: { $comment: null }, b: { $comment: 'comment-->script<!--more' } };
      const expected = `<a></a><b><!--comment- ->script<!- -more--></b>`;
      const builder = yield* XMLBuilder.make({ commentPropName: '$comment' });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
    })
  );
  it.effect('should parse to XML with malicious comment with 3 dashes', () =>
    Effect.gen(function* () {
      const jObj = { a: { $comment: null }, b: { $comment: 'comment--->script<!---more' } };
      const expected = `<a></a><b><!--comment- - ->script<!- - -more--></b>`;
      const builder = yield* XMLBuilder.make({ commentPropName: '$comment' });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
    })
  );
  it.effect('should neutralize double hyphen in multi-key comment object', () =>
    Effect.gen(function* () {
      const jObj = { root: { $comment: { '#text': 'a--b', note: 'x' } } };
      // The string/single-key comment path already neutralizes "--" via safeComment.
      // The multi-key object path must produce the same well-formed comment body so
      // the output cannot contain the literal "--" forbidden by XML 1.0 5e §2.5.
      const expected = `<root><!--a- -b<note>x</note>--></root>`;
      const builder = yield* XMLBuilder.make({ commentPropName: '$comment', format: false });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
      expect(result).not.toContain('--b');
    })
  );
  it.effect('should esxape double quote in attribute value', () =>
    Effect.gen(function* () {
      const jObj = { a: { '@_attr': '" onClick="alert(1)' } };
      const expected = `<a attr="&quot; onClick=&quot;alert(1)"></a>`;
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false, processEntities: false });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
    })
  );

  it.effect('should esxape double quote in attribute value', () =>
    Effect.gen(function* () {
      const jObj = { a: { '@_attr': '\\" onClick=\\"alert(1)' } };
      const expected = `<a attr="\\&quot; onClick=\\&quot;alert(1)"></a>`;
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false, processEntities: false });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
    })
  );

  it.effect('should esxape double quote in attribute value when order was preserrved', () =>
    Effect.gen(function* () {
      const jObj = [{ a: [], ':@': { '@_attr': '" onClick="alert(1)' } }];
      const expected = `<a attr="&quot; onClick=&quot;alert(1)"></a>`;
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, preserveOrder: true });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
    })
  );

  it.effect('should escape quote in a stopNode attribute value', () =>
    Effect.gen(function* () {
      const jObj = { root: { div: { '#text': '<b>raw</b>', '@_class': '" onmouseover="alert(1)' } } };
      const expected = `<root><div class="&quot; onmouseover=&quot;alert(1)"><b>raw</b></div></root>`;
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false, stopNodes: ['..div'], processEntities: false });
      const result = yield* builder.build(jObj);
      // stopNode content stays raw, but the quote delimiter must still be escaped
      // (same output as preserveOrder: true below)
      expect(result).toEqual(expected);
    })
  );

  it.effect('should escape quote in a stopNode attribute value when order was preserved', () =>
    Effect.gen(function* () {
      const jObj = [{ root: [{ div: [{ '#text': '<b>raw</b>' }], ':@': { '@_class': '" onmouseover="alert(1)' } }] }];
      const expected = `<root><div class="&quot; onmouseover=&quot;alert(1)"><b>raw</b></div></root>`;
      const builder = yield* XMLBuilder.make({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        stopNodes: ['root.div'],
        processEntities: false,
        preserveOrder: true,
      });
      const result = yield* builder.build(jObj);
      expect(result).toEqual(expected);
    })
  );
});
