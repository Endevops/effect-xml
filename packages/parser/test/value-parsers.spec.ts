import type { Context, ValueParser } from '@endevops/builder';
import type { BuilderError } from '@endevops/builder';

import { describe, expect, it } from '@effect/vitest';
import { makeNumberValueParser } from '@endevops/builder';
import { CompactBuilderFactory } from '@endevops/builder';
import { COMMON_HTML, CURRENCY } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import EntityParser from '#/test/helpers/custom-entity-parser.ts';
import { XMLParser } from '#/xml-parser.ts';

describe('Value Parsers', function () {
  // ── Default chain behaviour ───────────────────────────────────────────────

  it.effect('should parse numbers with the default chain', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <integer>42</integer>
        <float>3.14</float>
        <negative>-100</negative>
        <hex>0x1F</hex>
      </root>`;

      const parser = yield* XMLParser.make();
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.integer).toBe(42);
      expect(result.root.float).toBe(3.14);
      expect(result.root.negative).toBe(-100);
      expect(result.root.hex).toBe(31);
    })
  );

  it.effect('should parse booleans with the default chain', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <trueVal>true</trueVal>
        <falseVal>false</falseVal>
        <notBoolean>maybe</notBoolean>
      </root>`;

      const parser = yield* XMLParser.make();
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.trueVal).toBe(true);
      expect(result.root.falseVal).toBe(false);
      expect(result.root.notBoolean).toBe('maybe');
    })
  );

  it.effect("should NOT trim values if 'trim' is not in valueParsers", () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <tag>  padded  </tag>
      </root>`;

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: ['boolean', 'number'] } }) });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      // No 'trim' in the default chain — whitespace is preserved
      expect(result.root.tag).toBe('  padded  ');
    })
  );

  it.effect('should trim values by default', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <tag>  trimmed  </tag>
      </root>`;

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: ['trim', 'boolean', 'number'] } }) });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.tag).toBe('trimmed');
    })
  );

  // ── Entity expansion via ValueParser ─────────────────────────────────────
});

describe('Entity Parser', function () {
  it.effect("should expand XML entities via the 'entity' ValueParser (default)", () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parse(`<root><tag>&lt;hello&gt;</tag></root>`)) as ParsedNode;
      expect(result.root.tag).toBe('<hello>');
    })
  );

  it.effect("should expand DOCTYPE entities via the 'entity' ValueParser (default)", () =>
    Effect.gen(function* () {
      const evp = new EntityParser();
      const builder = yield* CompactBuilderFactory.make();
      yield* builder.registerValueParser('entity', evp);

      const parser = yield* XMLParser.make({ doctypeOptions: { enabled: true }, OutputBuilder: builder });
      const result = (yield* parser.parse(
        `<!DOCTYPE root [
      <!ENTITY brand "FlexParser">
    ]><root><name>&brand;</name></root>`
      )) as ParsedNode;
      expect(result.root.name).toBe('FlexParser');
    })
  );

  it.effect("should leave entities unexpanded when 'entity' is removed from valueParsers", () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: ['boolean', 'number'] } }) });
      const result = (yield* parser.parse(`<root><tag>&lt;raw&gt;</tag></root>`)) as ParsedNode;
      expect(result.root.tag).toBe('&lt;raw&gt;');
    })
  );

  it.effect('should expand HTML entities when entityParseOptions.html is true', () =>
    Effect.gen(function* () {
      const evp = new EntityParser({ namedEntities: { ...COMMON_HTML, ...CURRENCY } });
      const builder = yield* CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        tags: { valueParsers: [evp, 'number'] },
        // tags: { valueParsers: ["entity", "number"] }
      });

      //this is need so that doctype entities can be set and xml version at runtime
      yield* builder.registerValueParser('entity', evp);

      const parser = yield* XMLParser.make({ skip: { attributes: false }, OutputBuilder: builder });
      const result = (yield* parser.parse(`<root><c>&copy;</c><p>&pound;</p></root>`)) as ParsedNode;
      // console.log(result)
      expect(result.root.c).toBe('©');
      expect(result.root.p).toBe('£');
    })
  );

  it.effect('should expand HTML entities in attributes when entityParseOptions.html is true', () =>
    Effect.gen(function* () {
      const evp = new EntityParser({ namedEntities: { ...COMMON_HTML, ...CURRENCY } });
      const builder = yield* CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        attributes: { valueParsers: [evp] },
      });

      // builder.registerValueParser("entity", evp);

      const parser = yield* XMLParser.make({ skip: { attributes: false }, OutputBuilder: builder });
      const result = (yield* parser.parse(`<root label="&copy; 2024"/>`)) as ParsedNode;
      expect(result.root['@_label']).toBe('© 2024');
    })
  );

  it.effect('should expand NCR entities as per XML version 1.0', () =>
    Effect.gen(function* () {
      // U+0001 is an illegal character in XML 1.0, so an NCR that decodes to it
      // must be dropped, leaving only the rest of the attribute value.
      const evp = new EntityParser({ ncr: { xmlVersion: 1.0, onNCR: 'allow' } });
      const builder = yield* CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        attributes: { valueParsers: [evp] },
      });

      yield* builder.registerValueParser('entity', evp);

      const parser = yield* XMLParser.make({ skip: { attributes: false }, OutputBuilder: builder });
      const result = (yield* parser.parse(`<?xml version="1.0"?><root label="&#x1;2024"/>`)) as ParsedNode;
      expect(result.root['@_label']).toBe('2024');
    })
  );

  it.effect('should expand NCR entities as per XML version 1.1', () =>
    Effect.gen(function* () {
      // The same NCR under XML 1.1 is legal, so it survives verbatim.
      const evp = new EntityParser({ ncr: { xmlVersion: 1.1, onNCR: 'allow' } });
      const builder = yield* CompactBuilderFactory.make({
        // attributes: { valueParsers: ['entity'] }
        attributes: { valueParsers: [evp] },
      });

      yield* builder.registerValueParser('entity', evp);

      const parser = yield* XMLParser.make({ skip: { attributes: false }, OutputBuilder: builder });
      const result = (yield* parser.parse(`<?xml version="1.1"?><root label="&#x1;2024"/>`)) as ParsedNode;

      expect((result.root['@_label'] as unknown as string).charCodeAt(0)).toBe(1); // U+0001 (SOH)
      expect((result.root['@_label'] as unknown as string).substring(1)).toBe('2024'); // Rest of the string
    })
  );
});

describe('Custom chain', () => {
  it.effect('should use a fully custom valueParsers chain with replaceEntities', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <val1>42</val1>
        <val2>true</val2>
        <val3>text</val3>
      </root>`;

      const parser = yield* XMLParser.make({
        OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: ['entity', 'boolean', 'number'] } }),
      });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.val1).toBe(42);
      expect(result.root.val2).toBe(true);
      expect(result.root.val3).toBe('text');
    })
  );

  it.effect('should use a custom number parser instance with specific options', () =>
    Effect.gen(function* () {
      const xmlData = `
      <root>
        <leadingZeros>007</leadingZeros>
        <hex>0xFF</hex>
        <eNotation>1.5e3</eNotation>
      </root>`;

      const parser = yield* XMLParser.make({
        OutputBuilder: CompactBuilderFactory.make({
          tags: { valueParsers: [makeNumberValueParser({ hex: true, leadingZeros: false, eNotation: true })] },
        }),
      });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.leadingZeros).toBe('007'); // preserved — leadingZeros: false
      expect(result.root.hex).toBe(255);
      expect(result.root.eNotation).toBe(1500);
    })
  );

  it.effect('should disable all value parsing with an empty valueParsers array', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({
        OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [] }, attributes: { valueParsers: [] } }),
      });
      const result = (yield* parser.parse(`<root><n>42</n></root>`)) as ParsedNode;
      expect(result.root.n).toBe('42');
      expect(typeof result.root.n).toBe('string');
    })
  );

  it.effect('should parse attribute values with the default chain', () =>
    Effect.gen(function* () {
      const xmlData = `<root><tag num="42" bool="true" text="hello">value</tag></root>`;

      const parser = yield* XMLParser.make({ skip: { attributes: false } });
      const result = (yield* parser.parse(xmlData)) as ParsedNode;

      expect(result.root.tag['@_num']).toBe(42);
      expect(result.root.tag['@_bool']).toBe(true);
      expect(result.root.tag['@_text']).toBe('hello');
    })
  );

  it.effect('should parse attribute values with a custom chain', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({
        skip: { attributes: false },
        OutputBuilder: CompactBuilderFactory.make({ attributes: { valueParsers: ['number'] } }),
      });
      const result = (yield* parser.parse(`<root><tag n="42" s="hello"/></root>`)) as ParsedNode;
      expect(result.root.tag['@_n']).toBe(42);
      expect(result.root.tag['@_s']).toBe('hello');
    })
  );

  // ── Context-aware custom parser ───────────────────────────────────────────

  it.effect('should pass context object to custom value parsers', () =>
    Effect.gen(function* () {
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

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new ContextCapture()] } }) });
      yield* parser.parse(`<root><price>9.99</price></root>`);

      expect(seenContexts.length).toBeGreaterThan(0);
      // New context shape
      expect(seenContexts[0].elementName).toBe('price');
      expect(seenContexts[0].isLeafNode).toBe(true);
      expect(seenContexts[0].hasMatcher).toBe(true);
    })
  );

  // ── Registering a named custom parser ────────────────────────────────────

  it.effect('should support registering and referencing a named custom parser', () =>
    Effect.gen(function* () {
      class UpperCaseParser implements ValueParser {
        parse(val: unknown): Effect.Effect<unknown, BuilderError> {
          return Effect.succeed(typeof val === 'string' ? val.toUpperCase() : val);
        }
        reset(): void {}
      }

      const builder = yield* CompactBuilderFactory.make({ tags: { valueParsers: ['uppercase'] } });
      yield* builder.registerValueParser('uppercase', new UpperCaseParser());

      const parser = yield* XMLParser.make({ OutputBuilder: builder });
      const result = (yield* parser.parse(`<root><tag>hello world</tag></root>`)) as ParsedNode;
      expect(result.root.tag).toBe('HELLO WORLD');
    })
  );
});
