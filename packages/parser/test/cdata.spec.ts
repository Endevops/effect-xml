import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import { XMLParser } from '#/xml-parser.ts';

describe('CDATA', function () {
  it.effect('should parse CDATA and store it separately when nameFor.cdata is set', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <script><![CDATA[
          function test() {
            if (a < b && c > d) {
              return true;
            }
          }
        ]]></script>
      </root>`;

      const parser = yield* XMLParser.make({ nameFor: { cdata: '#cdata' } });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.script['#cdata']).toBeDefined();
      expect(result.root.script['#cdata']).toContain('function test()');
    })
  );

  it.effect('should merge CDATA with text content when nameFor.cdata is empty string (default)', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <data><![CDATA[Some <raw> data & more]]></data>
      </root>`;

      const parser = yield* XMLParser.make(); // nameFor.cdata defaults to ''
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.data).toBe('Some <raw> data & more');
    })
  );

  it.effect('should handle multiple CDATA sections', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <content>
          <![CDATA[First CDATA]]>
          Some text
          <![CDATA[Second CDATA]]>
        </content>
      </root>`;

      const parser = yield* XMLParser.make({ nameFor: { cdata: '#cdata' } });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.content['#cdata']).toBeDefined();
    })
  );

  it.effect('should preserve special characters in CDATA without parsing', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <xml><![CDATA[<tag attr="value">text & more</tag>]]></xml>
      </root>`;

      const parser = yield* XMLParser.make({ nameFor: { cdata: '#cdata' } });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.xml['#cdata']).toContain('<tag attr="value">');
      expect(result.root.xml['#cdata']).toContain('&');
    })
  );

  it.effect('should handle empty CDATA sections', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <empty><![CDATA[]]></empty>
      </root>`;

      const parser = yield* XMLParser.make({ nameFor: { cdata: '#cdata' } });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.empty['#cdata']).toBeDefined();
    })
  );

  it.effect('should exclude CDATA entirely when skip.cdata is true', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <script><![CDATA[some code here]]></script>
      </root>`;

      const parser = yield* XMLParser.make({ skip: { cdata: true } });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      // CDATA skipped — tag is empty
      expect(result.root.script).toBe('');
    })
  );

  it.effect('should join text without space by default', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      yield* parser.feed(`<root><a><![CDATA[hel]]>`);
      yield* parser.feed(`<![CDATA[lo]]></a>`);
      yield* parser.feed(`<b>hel<![CDATA[lo`);
      yield* parser.feed(`]]></b>`);
      yield* parser.feed(`<c><![CDATA[hel]]>lo</c>`);
      yield* parser.feed(`</root>`);
      const result = (yield* parser.end()) as ParsedNode;
      const expected = { root: { a: 'hello', b: 'hello', c: 'hello' } };
      expect(result).toEqual(expected);
    })
  );
});
