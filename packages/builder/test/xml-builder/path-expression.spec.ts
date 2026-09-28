/**
 * @description PathExpression_spec.js. Integration tests for path-expression-matcher (PEM) in the XML builder. Covers:
 *
 * 1. Backward compatibility — the `*.tag` syntax rewritten to `..tag`, and stopNodes under preserveOrder
 * 2. Expression objects in stopNodes — pre-compiled patterns, deep wildcards, mixed string and Expression entries
 * 3. Round-trip preservation, edge cases (empty, undefined, special characters) and complex path patterns
 * 4. Formatting with stopNodes enabled
 */

import type { XmlError } from '@endevops/common-xml';

import { Expression } from '@endevops/common-xml';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
/**
 * @description Run an effect from `common-xml`, whose error channel is `XmlError` rather than this package's `BuilderError`, so the shared `run` helper does not
 * apply to it.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 */
const runXml = <A>(effect: Effect.Effect<A, XmlError>): A => Effect.runSync(effect);

import { run, makeBuilder } from '#/test/helpers/effect.ts';

describe('XMLBuilder - Path-Expression-Matcher Integration', function () {
  describe('Backward Compatibility', function () {
    it('should auto-convert old *.tag syntax to ..tag in stopNodes', function () {
      const jObj = { html: { body: { script: "alert('test');", style: '.test { color: red; }', div: 'normal content' } } };

      const builder = makeBuilder({
        stopNodes: ['*.script', '*.style'], // Old syntax
        format: false,
      });

      const xml = run(builder.build(jObj));

      // Script and style should be output as-is (stop nodes)
      expect(xml).toContain("<script>alert('test');</script>");
      expect(xml).toContain('<style>.test { color: red; }</style>');
      expect(xml).toContain('<div>normal content</div>');
    });

    it('should maintain backward compatibility with preserveOrder', function () {
      const htmlObj = [{ html: [{ head: [{ script: [{ '#text': 'var x = 1;' }] }, { style: [{ '#text': '.a{}' }] }] }] }];

      const html = `
        <html>
          <head>
            <script>var x = 1;</script>
            <style>.a{}</style>
          </head>
        </html>`;

      const builderOptions = { ignoreAttributes: false, preserveOrder: true, stopNodes: ['*.script', '*.style'] };

      const builder = makeBuilder(builderOptions);
      const output = run(builder.build(htmlObj));

      // Should contain original script and style content
      expect(output.replace(/\s+/g, '')).toEqual(html.replace(/\s+/g, ''));
    });
  });

  describe('Expression Objects in stopNodes', function () {
    it('should accept Expression objects in stopNodes', function () {
      const jObj = { root: { script: "alert('test');", pre: 'formatted code', div: 'normal' } };

      const builder = makeBuilder({ stopNodes: [runXml(Expression.make('..script')), runXml(Expression.make('..pre'))], format: false });

      const xml = run(builder.build(jObj));

      expect(xml).toContain("<script>alert('test');</script>");
      expect(xml).toContain('<pre>formatted code</pre>');
      expect(xml).toContain('<div>normal</div>');
    });

    it('should support deep wildcard patterns', function () {
      const jObj = { html: { body: { section: { script: 'nested script' } } } };

      const builder = makeBuilder({ stopNodes: [runXml(Expression.make('..script'))], format: false });

      const xml = run(builder.build(jObj));

      expect(xml).toContain('<script>nested script</script>');
    });

    it('should support mixed string and Expression in stopNodes', function () {
      const jObj = { root: { script: 'script content', style: 'style content', pre: 'pre content' } };

      const builder = makeBuilder({
        stopNodes: [
          '..script', // String
          runXml(Expression.make('..style')), // Expression
          runXml(Expression.make('root.pre')), // Exact path Expression
        ],
        format: false,
      });

      const xml = run(builder.build(jObj));

      expect(xml).toContain('<script>script content</script>');
      expect(xml).toContain('<style>style content</style>');
      expect(xml).toContain('<pre>pre content</pre>');
    });
  });

  describe('Round-trip Preservation', function () {
    it('should handle HTML with multiple stop nodes', function () {
      const htmlObj = [
        {
          html: [
            { head: [{ script: [{ '#text': '' }], ':@': { '@_src': 'app.js' } }, { style: [{ '#text': '.class{color:red;}' }] }] },
            { body: [{ pre: [{ '#text': 'code block' }] }, { div: [{ '#text': 'normal' }] }] },
          ],
        },
      ];

      const html = `
        <html>
          <head>
            <script src="app.js"></script>
            <style>.class{color:red;}</style>
          </head>
          <body>
            <pre>code block</pre>
            <div>normal</div>
          </body>
        </html>`;

      const buildOptions = { ignoreAttributes: false, preserveOrder: true, stopNodes: ['..script', '..style', '..pre'] };

      const builder = makeBuilder(buildOptions);
      const output = run(builder.build(htmlObj));

      expect(output.replace(/\s+/g, '')).toEqual(html.replace(/\s+/g, ''));
    });
  });

  describe('Edge Cases', function () {
    it('should handle empty stopNodes array', function () {
      const jObj = { root: { script: 'content' } };

      const builder = makeBuilder({ stopNodes: [] });

      const xml = run(builder.build(jObj));

      expect(xml).toContain('<script>content</script>');
    });

    it('should handle undefined stopNodes', function () {
      const jObj = { root: { script: 'content' } };

      const builder = makeBuilder({
        // stopNodes not specified
      });

      const xml = run(builder.build(jObj));

      expect(xml).toContain('<script>content</script>');
    });

    it('should handle stop nodes with special characters', function () {
      const jObj = { root: { script: '<![CDATA[special & < > content]]>' } };

      const builder = makeBuilder({ stopNodes: ['..script'], format: false });

      const xml = run(builder.build(jObj));

      // Stop node content should be preserved as-is
      expect(xml).toContain('<script><![CDATA[special & < > content]]></script>');
    });

    it('should handle nested stop nodes', function () {
      const jObj = { html: { body: { div: { script: 'nested' } } } };

      const builder = makeBuilder({ stopNodes: [runXml(Expression.make('..script'))], format: false });

      const xml = run(builder.build(jObj));

      expect(xml).toContain('<script>nested</script>');
    });
  });

  describe('Complex Patterns', function () {
    it('should handle exact path expressions', function () {
      const jObj = { root: { level1: { script: 'should stop' }, script: 'should NOT stop' } };

      const builder = makeBuilder({ stopNodes: [runXml(Expression.make('root.level1.script'))], format: false });

      const xml = run(builder.build(jObj));

      // First script is at root.level1.script - should be stop node
      expect(xml).toContain('<script>should stop</script>');
      // Second script is at root.script - should be processed normally
      expect(xml).toContain('<script>should NOT stop</script>');
    });

    it('should handle wildcard in middle of path', function () {
      const jObj = { root: { a: { script: 'match1' }, b: { script: 'match2' } } };

      const builder = makeBuilder({ stopNodes: [runXml(Expression.make('root.*.script'))], format: false });

      const xml = run(builder.build(jObj));

      expect(xml).toContain('<script>match1</script>');
      expect(xml).toContain('<script>match2</script>');
    });
  });

  describe('Formatting with stopNodes', function () {
    it('should preserve stop node content with formatting enabled', function () {
      const jObj = { html: { body: { script: 'var x = 1;\nvar y = 2;' } } };

      const builder = makeBuilder({ stopNodes: [runXml(Expression.make('..script'))], format: true, indentBy: '  ' });

      const xml = run(builder.build(jObj));

      // Should preserve script content including newlines
      expect(xml).toContain('var x = 1;');
      expect(xml).toContain('var y = 2;');
    });
  });
});
