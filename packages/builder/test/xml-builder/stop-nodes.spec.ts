/**
 * @description StopNodes_spec.js. Verbatim stop-node behaviour in the XML builder, in both the plain-object and preserveOrder forms: raw content and attributes
 * passing through unencoded, entity encoding still applied to non-matching tags, deep wildcards, attribute-selected matches and negative zero.
 */

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { XMLBuilder } from '#/index.ts';

describe('stopNodes Builder - Basic Tests', function () {
  describe('preserveOrder: false', function () {
    it.effect('should preserve raw content when stopNode matches (simple case)', () =>
      Effect.gen(function* () {
        const jsObj = { issue: { title: 'test 1', fix1: '<p>p 1</p><div class="show">div 1</div>' } };

        const options = { ignoreAttributes: false, stopNodes: ['issue.fix1'], preserveOrder: false };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        // stopNode content should NOT be entity-encoded
        expect(output).toContain('<fix1><p>p 1</p><div class="show">div 1</div></fix1>');
      })
    );

    it.effect('should preserve raw content with attributes (parser output format)', () =>
      Effect.gen(function* () {
        const jsObj = { issue: { title: 'test 1', fix1: { '#text': '<p>p 1</p><div class="show">div 1</div>', '@_lang': 'en' } } };

        const options = { ignoreAttributes: false, stopNodes: ['issue.fix1'], preserveOrder: false };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        // stopNode content should NOT be entity-encoded, attributes preserved
        expect(output).toContain('<fix1 lang="en"><p>p 1</p><div class="show">div 1</div></fix1>');
      })
    );

    it.effect('should select with attribute expression', () =>
      Effect.gen(function* () {
        const jsObj = {
          issue: {
            title: 'test 1',
            fix1: [
              { '#text': '<p>p 1</p><div class="show">div 1</div>', '@_lang': 'en' },
              { '#text': '<p>p 1</p><div class="show">div 1</div>', '@_lang': 'hi' },
            ],
          },
        };

        const options = {
          ignoreAttributes: false,
          stopNodes: ['issue.fix1[lang=hi]'], //"..fix1[lang=hi]"
          preserveOrder: false,
          format: true,
        };

        const expected = `<issue>
  <title>test 1</title>
  <fix1 lang="en">&lt;p&gt;p 1&lt;/p&gt;&lt;div class=&quot;show&quot;&gt;div 1&lt;/div&gt;</fix1>
  <fix1 lang="hi">
<p>p 1</p><div class="show">div 1</div>  </fix1>
</issue>`;
        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        // stopNode content should NOT be entity-encoded, attributes preserved
        // expect(output).toContain('<fix1 lang="en"><p>p 1</p><div class="show">div 1</div></fix1>');
        expect(output.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
      })
    );

    it.effect('should preserve special characters in stopNode', () =>
      Effect.gen(function* () {
        const jsObj = { root: { div: { pre: 'test > < &', '@_class': 'code' } } };

        const options = { ignoreAttributes: false, stopNodes: ['..div'], preserveOrder: false };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        // Both content and attributes should be raw
        expect(output).toContain('class="code"');
        expect(output).toContain('<pre>test > < &</pre>');
      })
    );

    it.effect('should encode when NOT a stopNode', () =>
      Effect.gen(function* () {
        const jsObj = { root: { div: { pre: 'test > < &', '@_class': 'code' } } };

        const options = {
          ignoreAttributes: false,
          stopNodes: ['..script'], // Different pattern, won't match div
          preserveOrder: false,
        };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        // Should be entity-encoded
        expect(output).toContain('<pre>test &gt; &lt; &amp;</pre>');
      })
    );

    it.effect('should handle array of same tag with stopNode', () =>
      Effect.gen(function* () {
        const jsObj = { root: { fix1: ['<p>first</p>', '<p>second</p>'] } };

        const options = { ignoreAttributes: false, stopNodes: ['..fix1'], preserveOrder: false };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        expect(output).toContain('<fix1><p>first</p></fix1>');
        expect(output).toContain('<fix1><p>second</p></fix1>');
      })
    );

    it.effect('should handle deep wildcard pattern', () =>
      Effect.gen(function* () {
        const jsObj = { root: { fix1: '<p>p 1</p>', another: { fix1: '<nested>str</nested>' } } };

        const options = { ignoreAttributes: false, stopNodes: ['..fix1'], preserveOrder: false };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        // Both fix1 nodes should preserve raw content
        expect(output).toContain('<fix1><p>p 1</p></fix1>');
        expect(output).toContain('<fix1><nested>str</nested></fix1>');
      })
    );

    it.effect('should preserve the sign of a negative zero value in raw stopNode content', () =>
      Effect.gen(function* () {
        const options = { stopNodes: ['a'], preserveOrder: false };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build({ a: -0 });

        expect(output).toEqual('<a>-0</a>');
      })
    );
  });

  describe('preserveOrder: true', function () {
    it.effect('should preserve raw content when stopNode matches', () =>
      Effect.gen(function* () {
        const jsObj = [{ issue: [{ title: [{ '#text': 'test 1' }] }, { fix1: [{ '#text': '<p>p 1</p><div class="show">div 1</div>' }] }] }];

        const options = { ignoreAttributes: false, stopNodes: ['issue.fix1'], preserveOrder: true };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        // stopNode content should NOT be entity-encoded
        expect(output).toContain('<fix1><p>p 1</p><div class="show">div 1</div></fix1>');
      })
    );

    it.effect('should preserve raw content with attributes', () =>
      Effect.gen(function* () {
        const jsObj = [{ issue: [{ fix1: [{ '#text': '<p>p 1</p><div class="show">div 1</div>' }], ':@': { '@_lang': 'en' } }] }];

        const options = { ignoreAttributes: false, stopNodes: ['issue.fix1'], preserveOrder: true };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        expect(output).toContain('<fix1 lang="en"><p>p 1</p><div class="show">div 1</div></fix1>');
      })
    );

    it.effect('should preserve special characters in stopNode', () =>
      Effect.gen(function* () {
        const jsObj = [{ root: [{ div: [{ pre: [{ '#text': 'test > < &' }] }], ':@': { '@_class': 'code' } }] }];

        const options = { ignoreAttributes: false, stopNodes: ['..div'], preserveOrder: true };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build(jsObj);

        expect(output).toContain('class="code"');
        expect(output).toContain('<pre>test > < &</pre>');
      })
    );

    it.effect('should preserve the sign of a negative zero value in raw stopNode content', () =>
      Effect.gen(function* () {
        const options = { stopNodes: ['a'], preserveOrder: true };

        const builder = yield* XMLBuilder.make(options);
        const output = yield* builder.build([{ a: [{ '#text': -0 }] }]);

        expect(output).toEqual('<a>-0</a>');
      })
    );
  });
});
