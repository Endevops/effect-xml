import { makeNumberValueParser } from '@endevops/builder';
import type { Context, ValueParser } from '@endevops/builder';
import { CompactBuilderFactory } from '@endevops/builder';
import type { BuilderError } from '@endevops/builder';
import { COMMON_HTML, CURRENCY } from '@endevops/common-xml';
import { Effect } from 'effect';
import { describe, it, expect } from 'vite-plus/test';

import EntityParser from '#/test/helpers/custom-entity-parser.ts';
import { makeParser, parseDoc, runParser } from '#/test/helpers/test-runner.ts';

describe('Value Parsers', function () {
  // ── Default chain behaviour ───────────────────────────────────────────────

  it('should parse numbers with the default chain', function () {
    const xmlData = `
      <root>
        <integer>42</integer>
        <float>3.14</float>
        <negative>-100</negative>
        <hex>0x1F</hex>
      </root>`;

    const parser = makeParser();
    const result = parseDoc(parser, xmlData);

    expect(result.root.integer).toBe(42);
    expect(result.root.float).toBe(3.14);
    expect(result.root.negative).toBe(-100);
    expect(result.root.hex).toBe(31);
  });

  it('should parse booleans with the default chain', function () {
    const xmlData = `
      <root>
        <trueVal>true</trueVal>
        <falseVal>false</falseVal>
        <notBoolean>maybe</notBoolean>
      </root>`;

    const parser = makeParser();
    const result = parseDoc(parser, xmlData);

    expect(result.root.trueVal).toBe(true);
    expect(result.root.falseVal).toBe(false);
    expect(result.root.notBoolean).toBe('maybe');
  });

  it("should NOT trim values if 'trim' is not in valueParsers", function () {
    const xmlData = `
      <root>
        <tag>  padded  </tag>
      </root>`;

    const parser = makeParser({ OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['boolean', 'number'] } })) });
    const result = parseDoc(parser, xmlData);

    // No 'trim' in the default chain — whitespace is preserved
    expect(result.root.tag).toBe('  padded  ');
  });

  it('should trim values by default', function () {
    const xmlData = `
      <root>
        <tag>  trimmed  </tag>
      </root>`;

    const parser = makeParser({ OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['trim', 'boolean', 'number'] } })) });
    const result = parseDoc(parser, xmlData);

    expect(result.root.tag).toBe('trimmed');
  });

  // ── Entity expansion via ValueParser ─────────────────────────────────────
});

describe('Entity Parser', function () {
  it("should expand XML entities via the 'entity' ValueParser (default)", function () {
    const parser = makeParser();
    const result = parseDoc(parser, `<root><tag>&lt;hello&gt;</tag></root>`);
    expect(result.root.tag).toBe('<hello>');
  });

  it("should expand DOCTYPE entities via the 'entity' ValueParser (default)", function () {
    const evp = new EntityParser();
    const builder = runParser(CompactBuilderFactory.make());
    runParser(builder.registerValueParser('entity', evp));

    const parser = makeParser({ doctypeOptions: { enabled: true }, OutputBuilder: builder });
    const result = parseDoc(
      parser,
      `<!DOCTYPE root [
      <!ENTITY brand "FlexParser">
    ]><root><name>&brand;</name></root>`
    );
    expect(result.root.name).toBe('FlexParser');
  });

  it("should leave entities unexpanded when 'entity' is removed from valueParsers", function () {
    const parser = makeParser({ OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['boolean', 'number'] } })) });
    const result = parseDoc(parser, `<root><tag>&lt;raw&gt;</tag></root>`);
    expect(result.root.tag).toBe('&lt;raw&gt;');
  });

  it('should expand HTML entities when entityParseOptions.html is true', function () {
    const evp = new EntityParser({ namedEntities: { ...COMMON_HTML, ...CURRENCY } });
    const builder = runParser(
      CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        tags: { valueParsers: [evp, 'number'] },
        // tags: { valueParsers: ["entity", "number"] }
      })
    );

    //this is need so that doctype entities can be set and xml version at runtime
    runParser(builder.registerValueParser('entity', evp));

    const parser = makeParser({ skip: { attributes: false }, OutputBuilder: builder });
    const result = parseDoc(parser, `<root><c>&copy;</c><p>&pound;</p></root>`);
    // console.log(result)
    expect(result.root.c).toBe('©');
    expect(result.root.p).toBe('£');
  });

  it('should expand HTML entities in attributes when entityParseOptions.html is true', function () {
    const evp = new EntityParser({ namedEntities: { ...COMMON_HTML, ...CURRENCY } });
    const builder = runParser(
      CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        attributes: { valueParsers: [evp] },
      })
    );

    // builder.registerValueParser("entity", evp);

    const parser = makeParser({ skip: { attributes: false }, OutputBuilder: builder });
    const result = parseDoc(parser, `<root label="&copy; 2024"/>`);
    expect(result.root['@_label']).toBe('© 2024');
  });

  it('should expand NCR entities as per XML version 1.0', function () {
    // U+0001 is an illegal character in XML 1.0, so an NCR that decodes to it
    // must be dropped, leaving only the rest of the attribute value.
    const evp = new EntityParser({ ncr: { xmlVersion: 1.0, onNCR: 'allow' } });
    const builder = runParser(
      CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        attributes: { valueParsers: [evp] },
      })
    );

    runParser(builder.registerValueParser('entity', evp));

    const parser = makeParser({ skip: { attributes: false }, OutputBuilder: builder });
    const result = parseDoc(parser, `<?xml version="1.0"?><root label="&#x1;2024"/>`);
    expect(result.root['@_label']).toBe('2024');
  });

  it('should expand NCR entities as per XML version 1.1', function () {
    // The same NCR under XML 1.1 is legal, so it survives verbatim.
    const evp = new EntityParser({ ncr: { xmlVersion: 1.1, onNCR: 'allow' } });
    const builder = runParser(
      CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        attributes: { valueParsers: [evp] },
      })
    );

    runParser(builder.registerValueParser('entity', evp));

    const parser = makeParser({ skip: { attributes: false }, OutputBuilder: builder });
    const result = parseDoc(parser, `<?xml version="1.1"?><root label="&#x1;2024"/>`);

    expect((result.root['@_label'] as unknown as string).charCodeAt(0)).toBe(1); // U+0001 (SOH)
    expect((result.root['@_label'] as unknown as string).substring(1)).toBe('2024'); // Rest of the string
  });
});

describe('Custom chain', () => {
  it('should use a fully custom valueParsers chain with replaceEntities', function () {
    const xmlData = `
      <root>
        <val1>42</val1>
        <val2>true</val2>
        <val3>text</val3>
      </root>`;

    const parser = makeParser({ OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['entity', 'boolean', 'number'] } })) });
    const result = parseDoc(parser, xmlData);

    expect(result.root.val1).toBe(42);
    expect(result.root.val2).toBe(true);
    expect(result.root.val3).toBe('text');
  });

  it('should use a custom number parser instance with specific options', function () {
    const xmlData = `
      <root>
        <leadingZeros>007</leadingZeros>
        <hex>0xFF</hex>
        <eNotation>1.5e3</eNotation>
      </root>`;

    const parser = makeParser({
      OutputBuilder: runParser(
        CompactBuilderFactory.make({ tags: { valueParsers: [makeNumberValueParser({ hex: true, leadingZeros: false, eNotation: true })] } })
      ),
    });
    const result = parseDoc(parser, xmlData);

    expect(result.root.leadingZeros).toBe('007'); // preserved — leadingZeros: false
    expect(result.root.hex).toBe(255);
    expect(result.root.eNotation).toBe(1500);
  });

  it('should disable all value parsing with an empty valueParsers array', function () {
    const parser = makeParser({
      OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: [] }, attributes: { valueParsers: [] } })),
    });
    const result = parseDoc(parser, `<root><n>42</n></root>`);
    expect(result.root.n).toBe('42');
    expect(typeof result.root.n).toBe('string');
  });

  it('should parse attribute values with the default chain', function () {
    const xmlData = `<root><tag num="42" bool="true" text="hello">value</tag></root>`;

    const parser = makeParser({ skip: { attributes: false } });
    const result = parseDoc(parser, xmlData);

    expect(result.root.tag['@_num']).toBe(42);
    expect(result.root.tag['@_bool']).toBe(true);
    expect(result.root.tag['@_text']).toBe('hello');
  });

  it('should parse attribute values with a custom chain', function () {
    const parser = makeParser({
      skip: { attributes: false },
      OutputBuilder: runParser(CompactBuilderFactory.make({ attributes: { valueParsers: ['number'] } })),
    });
    const result = parseDoc(parser, `<root><tag n="42" s="hello"/></root>`);
    expect(result.root.tag['@_n']).toBe(42);
    expect(result.root.tag['@_s']).toBe('hello');
  });

  // ── Context-aware custom parser ───────────────────────────────────────────

  it('should pass context object to custom value parsers', function () {
    // The context minus its matcher (not plain-serialisable), plus a note of
    // whether one was supplied at all.
    const seenContexts: Array<Record<string, unknown> & { hasMatcher: boolean }> = [];

    class ContextCapture implements ValueParser {
      parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
        if (context) {
          const { matcher, ...rest } = context;
          seenContexts.push({ ...rest, hasMatcher: matcher != null });
        }
        return Effect.succeed(val);
      }
    }

    const parser = makeParser({ OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: [new ContextCapture()] } })) });
    runParser(parser.parse(`<root><price>9.99</price></root>`));

    expect(seenContexts.length).toBeGreaterThan(0);
    // New context shape
    expect(seenContexts[0].elementName).toBe('price');
    expect(seenContexts[0].isLeafNode).toBe(true);
    expect(seenContexts[0].hasMatcher).toBe(true);
  });

  // ── Registering a named custom parser ────────────────────────────────────

  it('should support registering and referencing a named custom parser', function () {
    class UpperCaseParser implements ValueParser {
      parse(val: unknown): Effect.Effect<unknown, BuilderError> {
        return Effect.succeed(typeof val === 'string' ? val.toUpperCase() : val);
      }
      reset(): void {}
    }

    const builder = runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['uppercase'] } }));
    runParser(builder.registerValueParser('uppercase', new UpperCaseParser()));

    const parser = makeParser({ OutputBuilder: builder });
    const result = parseDoc(parser, `<root><tag>hello world</tag></root>`);
    expect(result.root.tag).toBe('HELLO WORLD');
  });
});
