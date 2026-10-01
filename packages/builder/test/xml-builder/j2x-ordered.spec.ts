/**
 * @description J2x_ordered_spec.js. The builder's `preserveOrder` path, exercised by round-tripping real XML through `fast-xml-parser` with `preserveOrder: true`
 * and rebuilding it. Covers CDATA grouping, text-only nodes, empty-node suppression, formatting, arrayed leaves and attributes, stop nodes, and the
 * non-array child crash from issue #781.
 */

import type { X2jOptions } from 'fast-xml-parser';

/**
 * @description `XMLParser` here is the **upstream** `fast-xml-parser` from npm, not `@endevops/parser`. It is used to produce input documents for the builder — a
 * real parse result rather than a hand-written object — and it is synchronous, so its `parse` returns a value and must not be passed to {@link run},
 * which only accepts an `Effect`. Only this package's own builder calls are effects. (`@endevops/parser` has since been converted to the same typed
 * channel, so the two now differ; that difference is exactly what the wrap here got wrong.)
 */
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vite-plus/test';

import { run, makeBuilder } from '#/test/helpers/effect.ts';

describe('XMLBuilder', function () {
  it('should build formatted XML from ordered JS Obj', function () {
    const XMLdata = `<root>
  <car>
      <color>purple</color>
      <type>minivan</type>
      <registration>2020-02-03</registration>
      <capacity>7</capacity>
  </car>
  <car>
      <color>orange</color>
      <type>SUV</type>
      <registration>2021-05-17</registration>
      <capacity>4</capacity>
  </car>
  <car>
      <color>green</color>
      <type>coupe</type>
      <registration>2019-11-13</registration>
      <capacity>2</capacity>
  </car>
</root>`;
    const expected = `<root><car><color>purple</color><type>minivan</type><registration>2020-02-03</registration><capacity>7</capacity></car><car><color>orange</color><type>SUV</type><registration>2021-05-17</registration><capacity>4</capacity></car><car><color>green</color><type>coupe</type><registration>2019-11-13</registration><capacity>2</capacity></car></root>`;

    const options = { preserveOrder: true, indentBy: ' ' };
    const parser = new XMLParser(options);
    let result: unknown = parser.parse(XMLdata);

    const builder = makeBuilder(options);
    result = run(builder.build(result));

    expect(result).toEqual(expected);
  });

  it('should build XML for CDATA, text property, repeated tags', function () {
    const XMLdata = `<store>
        <location>
            <![CDATA[locates in]]>
            <region>US</region>
            <![CDATA[and]]>
            <region>JAPAN</region>
            --finish--
        </location>
        <type>
            <size>
                <![CDATA[Small]]>alpha
            </size>
            <function>24x7</function>
            <empty></empty>
            <empty attr="ibute"></empty>
        </type>
    </store>`;
    const expected = `<store><location><![CDATA[locates in]]><region>US</region><![CDATA[and]]><region>JAPAN</region>--finish--</location><type><size><![CDATA[Small]]>alpha</size><function>24x7</function><empty></empty><empty attr="ibute"></empty></type></store>`;

    const options = {
      ignoreAttributes: false,
      preserveOrder: true,
      cdataPropName: '#CDATA',
      allowBooleanAttributes: true,
      //   format: true,
    };
    const parser = new XMLParser(options);
    let result: unknown = parser.parse(XMLdata);

    // `allowBooleanAttributes` is a parser option. The builder ignores keys it does not know, so its copy carries the other three.
    const builder = makeBuilder({ ignoreAttributes: false, preserveOrder: true, cdataPropName: '#CDATA' });
    result = run(builder.build(result));

    expect(result).toEqual(expected);
  });

  it('should build XML by merging CDATA to text property when CDATA tag name is not set', function () {
    const XMLdata = `<store>
        <location>
            <![CDATA[locates in]]>
            <region>US</region>
            <![CDATA[and]]>
            <region>JAPAN</region>
            --finish--
        </location>
        <type>
            <size>
                <![CDATA[Small]]>alpha
            </size>
            <function>24x7</function>
        </type>
    </store>`;
    const expected = `<store><location>locates in<region>US</region>and<region>JAPAN</region>--finish--</location><type><size>Smallalpha</size><function>24x7</function></type></store>`;

    const options = { preserveOrder: true };
    const parser = new XMLParser(options);
    let result: unknown = parser.parse(XMLdata);

    // The original read `parser.options` here. Every parser default the builder also knows matches the builder's own default, so the
    // literal above resolves to the same configuration.
    const builder = makeBuilder(options);
    result = run(builder.build(result));

    expect(result).toEqual(expected);
  });

  it('should build XML having only text', function () {
    const XMLdata = `<store>
            <![CDATA[albha]]>beta
    </store>`;
    const expected = `<store>albhabeta</store>`;

    const options = { preserveOrder: true };
    const parser = new XMLParser(options);
    let result: unknown = parser.parse(XMLdata);

    // The original read `parser.options` here, with the same equivalence.
    const builder = makeBuilder(options);
    result = run(builder.build(result));

    expect(result).toEqual(expected);
  });

  it('should build XML by suppressing empty nodes', function () {
    const XMLdata = `<store>
            <![CDATA[albha]]>beta <a/><b></b>
    </store>`;
    const expected = '<store>albhabeta<a/><b/></store>';

    const options = { preserveOrder: true, suppressEmptyNode: true };
    const parser = new XMLParser(options);
    let result: unknown = parser.parse(XMLdata);

    const builder = makeBuilder(options);
    result = run(builder.build(result));

    expect(result).toEqual(expected);
  });

  it('should build formatted XML', function () {
    const XMLdata = `<store>
        <location>
            <![CDATA[locates in]]>
            <region>US</region>
            <![CDATA[and]]>
            <region>JAPAN</region>
            --finish--
        </location>
        <type>
            <size>
                <![CDATA[Small]]>alpha
            </size>
            <function>24x7</function>
        </type>
    </store>`;
    const expected = `
<store>
  <location>
    locates in
    <region>US</region>
    and
    <region>JAPAN</region>
    --finish--
  </location>
  <type>
    <size>Smallalpha</size>
    <function>24x7</function>
  </type>
</store>`;

    const options = {
      preserveOrder: true,
      format: true,
      // cdataPropName: "#CDATA"
    };
    const parser = new XMLParser(options);
    let result: unknown = parser.parse(XMLdata);

    const builder = makeBuilder(options);
    result = run(builder.build(result));

    expect(result).toEqual(expected);
  });

  it('should build formatted XML with CDATA', function () {
    const XMLdata = `<store>
        <location>
            <![CDATA[locates in]]>
            <region>US</region>
            <![CDATA[and]]>
            <region>JAPAN</region>
            --finish--
        </location>
        <type>
            <size>
                <![CDATA[Small]]>alpha
            </size>
            <function>24x7</function>
        </type>
    </store>`;
    const expected = `
<store>
  <location>
    <![CDATA[locates in]]>
    <region>US</region>
    <![CDATA[and]]>
    <region>JAPAN</region>
    --finish--
  </location>
  <type>
    <size><![CDATA[Small]]>alpha</size>
    <function>24x7</function>
  </type>
</store>`;

    const options = { preserveOrder: true, format: true, cdataPropName: '#CDATA' };
    const parser = new XMLParser(options);
    let result: unknown = parser.parse(XMLdata);

    const builder = makeBuilder(options);
    result = run(builder.build(result));

    expect(result).toEqual(expected);
  });

  it('should build XML when leaf nodes or attributes are parsed to array', function () {
    // The prototype is not declared to carry this key, so it is written through the index signature the builder itself walks.
    const target = Object.prototype as Record<string, unknown>;
    const previous = target.something;
    target.something = 'strange';
    try {
      const XMLdata = `<report>
        <store>
            <region>US</region>
            <inventory>
                <item grade="A">
                    <name>Banana</name>
                    <count>200</count>
                </item>
                <item grade="B">
                    <name>Apple</name>
                    <count>100</count>
                </item>
            </inventory>
        </store>
        <store>
            <region>EU</region>
            <inventory>
                <item>
                    <name>Banana</name>
                    <count>100</count>
                </item>
            </inventory>
        </store>
    </report>`;
      const expected = `
<report>
  <store>
    <region>US</region>
    <inventory>
      <item grade="A">
        <name>Banana</name>
        <count>200</count>
      </item>
      <item grade="B">
        <name>Apple</name>
        <count>100</count>
      </item>
    </inventory>
  </store>
  <store>
    <region>EU</region>
    <inventory>
      <item>
        <name>Banana</name>
        <count>100</count>
      </item>
    </inventory>
  </store>
</report>`;

      const options: X2jOptions = {
        ignoreAttributes: false,
        isArray: (_tagName, _jpath, isLeafNode, _isAttribute) => {
          if (isLeafNode) return true;
          return false;
        },
        preserveOrder: true,
      };
      const parser = new XMLParser(options);
      let result: unknown = parser.parse(XMLdata);

      const builder = makeBuilder({ attributeNamePrefix: '@_', ignoreAttributes: false, format: true, preserveOrder: true });
      result = run(builder.build(result));
      expect(result).toEqual(expected);
    } finally {
      // Restored here rather than in an `afterEach`: the pollution is global, and a spec that leaves it
      // behind reaches every later file collected in the same worker under `isolate: false`.
      if (previous === undefined) delete target.something;
      else target.something = previous;
    }
  });

  it('should not process stop nodes when preserveOrder is true', function () {
    const jObj = [
      {
        html: [
          {
            head: [
              {
                script: [
                  {
                    '#text':
                      '\n              window.dataLayer = window.dataLayer || [];\n              function gtag(){dataLayer.push(arguments);}\n            ',
                  },
                ],
              },
              {
                style: [
                  {
                    '#text':
                      '\n              .CodeMirror{\n                height: 100%;\n                width: 100%;\n              }\n            ',
                  },
                ],
              },
            ],
          },
          { body: [{ h1: [{ '#text': 'Heading' }] }, { hr: [] }, { pre: [{ '#text': '\n              <h1>Nested</h1>\n            ' }] }] },
        ],
        ':@': { '@_lang': 'en' },
      },
    ];

    const builderOptions = { preserveOrder: true, stopNodes: ['..pre', '..script', '..style'] };

    const builder = makeBuilder(builderOptions);
    const output = run(builder.build(jObj));

    expect(output).toContain('window.dataLayer');
    expect(output).toContain('.CodeMirror');
    expect(output).toContain('<h1>Nested</h1>');
  });

  it('should preserve the sign of a negative zero text value', function () {
    const builder = makeBuilder({ preserveOrder: true });
    const result = run(builder.build([{ a: [{ '#text': -0 }] }]));
    expect(result).toEqual(`<a>-0</a>`);
  });

  it('should preserve the sign of a negative zero attribute value', function () {
    const builder = makeBuilder({ ignoreAttributes: false, preserveOrder: true });
    const result = run(builder.build([{ a: [{ '#text': 'v' }], ':@': { '@_x': -0 } }]));
    expect(result).toEqual(`<a x="-0">v</a>`);
  });
});

describe('XMLBuilder- array processing issue', function () {
  it('should not throw stack overflow when child value is a non-array (issue #781)', function () {
    const builder = makeBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true });
    const input = [
      {
        foo: [
          { bar: [{ '@_V': 'baz' }] },
          //{ 'fum': [{ 'qux': '' }] },
          { hello: [{ '#text': 'world' }] },
        ],
      },
    ];
    expect(function () {
      run(builder.build(input));
    }).not.toThrow();

    const result = run(builder.build(input));
    expect(result).toContain('<hello>world</hello>');
    expect(result).toContain('<foo>');
  });
});
