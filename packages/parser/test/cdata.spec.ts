import { describe, it, expect } from 'vite-plus/test';

import { parseDoc, endDoc, makeParser, runParser } from '#/test/helpers/test-runner.ts';

describe('CDATA', function () {
  it('should parse CDATA and store it separately when nameFor.cdata is set', function () {
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

    const parser = makeParser({ nameFor: { cdata: '#cdata' } });
    const result = parseDoc(parser, xmlData);

    expect(result.root.script['#cdata']).toBeDefined();
    expect(result.root.script['#cdata']).toContain('function test()');
  });

  it('should merge CDATA with text content when nameFor.cdata is empty string (default)', function () {
    const xmlData = `
      <root>
        <data><![CDATA[Some <raw> data & more]]></data>
      </root>`;

    const parser = makeParser(); // nameFor.cdata defaults to ''
    const result = parseDoc(parser, xmlData);

    expect(result.root.data).toBe('Some <raw> data & more');
  });

  it('should handle multiple CDATA sections', function () {
    const xmlData = `
      <root>
        <content>
          <![CDATA[First CDATA]]>
          Some text
          <![CDATA[Second CDATA]]>
        </content>
      </root>`;

    const parser = makeParser({ nameFor: { cdata: '#cdata' } });
    const result = parseDoc(parser, xmlData);

    expect(result.root.content['#cdata']).toBeDefined();
  });

  it('should preserve special characters in CDATA without parsing', function () {
    const xmlData = `
      <root>
        <xml><![CDATA[<tag attr="value">text & more</tag>]]></xml>
      </root>`;

    const parser = makeParser({ nameFor: { cdata: '#cdata' } });
    const result = parseDoc(parser, xmlData);

    expect(result.root.xml['#cdata']).toContain('<tag attr="value">');
    expect(result.root.xml['#cdata']).toContain('&');
  });

  it('should handle empty CDATA sections', function () {
    const xmlData = `
      <root>
        <empty><![CDATA[]]></empty>
      </root>`;

    const parser = makeParser({ nameFor: { cdata: '#cdata' } });
    const result = parseDoc(parser, xmlData);

    expect(result.root.empty['#cdata']).toBeDefined();
  });

  it('should exclude CDATA entirely when skip.cdata is true', function () {
    const xmlData = `
      <root>
        <script><![CDATA[some code here]]></script>
      </root>`;

    const parser = makeParser({ skip: { cdata: true } });
    const result = parseDoc(parser, xmlData);

    // CDATA skipped — tag is empty
    expect(result.root.script).toBe('');
  });

  it('should join text without space by default', function () {
    const parser = makeParser();
    runParser(parser.feed(`<root><a><![CDATA[hel]]>`));
    runParser(parser.feed(`<![CDATA[lo]]></a>`));
    runParser(parser.feed(`<b>hel<![CDATA[lo`));
    runParser(parser.feed(`]]></b>`));
    runParser(parser.feed(`<c><![CDATA[hel]]>lo</c>`));
    runParser(parser.feed(`</root>`));
    const result = endDoc(parser);
    const expected = { root: { a: 'hello', b: 'hello', c: 'hello' } };
    expect(result).toEqual(expected);
  });
});
