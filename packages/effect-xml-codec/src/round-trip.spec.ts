// oxlint-disable vitest/expect-expect effecttsgo/schema-number
// oxlint-disable vitest/valid-title
/**
 * @description Round-trip specs: every value here goes out as XML and comes back as the value it was. This is the spec that answers "does serialization fail". The
 * codec is a single step. `toCodecXml` returns a `Schema` whose `Encoded` is XML text, so `Schema.encodeSync` writes a document and
 * `Schema.decodeSync` reads one back, the way `Schema.toCodecJson` works for JSON. Each document is additionally asserted to reach a fixed point,
 * where parse, render and parse again must be stable. That check stops an encoder from quietly drifting the document on every hop through the
 * system.
 */

import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { toCodecXml } from '#/codec.ts';
import { parseXmlDocument } from '#/parse.ts';
import { renderXml } from '#/render.ts';

/**
 * @description The codec's text path: a value to a document in one call.
 *
 * @param schema - The schema the value is described by.
 * @param value - The value to encode.
 * @param rootName - Name for the root element. Defaults to `r`.
 *
 * @returns The XML document.
 */
const encode = (schema: AnyCodec, value: unknown, rootName = 'r'): string => Schema.encodeSync(toCodecXml(schema, { rootName }))(value) as string;

/**
 * @description The codec's text path the other way: a document to a value in one call.
 *
 * @param schema - The schema the value is described by.
 * @param text - The document to read.
 * @param rootName - Name the document was written under. Defaults to `r`.
 *
 * @returns The decoded value.
 */
const decode = (schema: AnyCodec, text: string, rootName = 'r'): unknown => Schema.decodeSync(toCodecXml(schema, { rootName }))(text);

/**
 * @description The whole text path: value to document to value.
 *
 * @param schema - The schema the value is described by.
 * @param value - The value to write and read back.
 * @param rootName - Name for the root element. Defaults to `r`.
 *
 * @returns The decoded value.
 */
const roundTrip = (schema: AnyCodec, value: unknown, rootName = 'r'): unknown => decode(schema, encode(schema, value, rootName), rootName);

/**
 * @description A codec of any shape, for a table of cases that do not share one schema. `unknown` in both type positions rather than `any`, which keeps the cases
 * accurate: a case's value is only ever passed in and compared against what comes back out, so nothing here needs the schema's type to be known.
 */
type AnyCodec = Schema.ConstraintCodec<unknown, unknown>;

/**
 * @description One schema-and-value pair to be taken through a full round trip.
 */
interface Case {
  /**
   * @description What the case is about, used as the test name.
   */
  readonly about: string;

  /**
   * @description The schema the value is described by.
   */
  readonly schema: AnyCodec;

  /**
   * @description The value to serialize and read back.
   */
  readonly value: unknown;

  /**
   * @description Name for the root element. Defaults to `r`.
   */
  readonly rootName?: string | undefined;
}

const cases: ReadonlyArray<Case> = [
  { about: 'a string field', schema: Schema.Struct({ a: Schema.String }), value: { a: 'x' } },
  { about: 'an empty string field', schema: Schema.Struct({ a: Schema.String }), value: { a: '' } },
  { about: 'a field with an apostrophe', schema: Schema.Struct({ a: Schema.String }), value: { a: "it's" } },
  { about: 'a field with a double quote', schema: Schema.Struct({ a: Schema.String }), value: { a: 'say "hi"' } },
  { about: 'a field with angle brackets', schema: Schema.Struct({ a: Schema.String }), value: { a: '<b>bold</b>' } },
  { about: 'a field with an ampersand', schema: Schema.Struct({ a: Schema.String }), value: { a: 'Smith & Jones' } },
  { about: 'a field with a pre-escaped entity', schema: Schema.Struct({ a: Schema.String }), value: { a: '&amp;' } },
  { about: 'a field with all five unsafe characters', schema: Schema.Struct({ a: Schema.String }), value: { a: '<&>"\'' } },
  { about: 'a field with a newline', schema: Schema.Struct({ a: Schema.String }), value: { a: 'line one\nline two' } },
  { about: 'a field with a tab', schema: Schema.Struct({ a: Schema.String }), value: { a: 'a\tb' } },
  { about: 'a field with accented characters', schema: Schema.Struct({ a: Schema.String }), value: { a: 'café naïve' } },
  { about: 'a field with CJK characters', schema: Schema.Struct({ a: Schema.String }), value: { a: '日本語のテキスト' } },
  { about: 'a field with an emoji', schema: Schema.Struct({ a: Schema.String }), value: { a: 'ship it 🚀' } },
  { about: 'a field with a right-to-left script', schema: Schema.Struct({ a: Schema.String }), value: { a: 'مرحبا' } },
  { about: 'a long field', schema: Schema.Struct({ a: Schema.String }), value: { a: 'x'.repeat(5000) } },
  { about: 'a number field', schema: Schema.Struct({ a: Schema.Number }), value: { a: 1.5 } },
  { about: 'a negative number field', schema: Schema.Struct({ a: Schema.Number }), value: { a: -0.125 } },
  { about: 'a very small number field', schema: Schema.Struct({ a: Schema.Number }), value: { a: 1e-7 } },
  { about: 'a zero field', schema: Schema.Struct({ a: Schema.Number }), value: { a: 0 } },
  { about: 'an integer field', schema: Schema.Struct({ a: Schema.Int }), value: { a: -42 } },
  { about: 'a boolean field', schema: Schema.Struct({ a: Schema.Boolean }), value: { a: true } },
  { about: 'a false field', schema: Schema.Struct({ a: Schema.Boolean }), value: { a: false } },
  { about: 'a null field', schema: Schema.Struct({ a: Schema.Null }), value: { a: null } },
  { about: 'a nullable field holding null', schema: Schema.Struct({ a: Schema.NullOr(Schema.String) }), value: { a: null } },
  { about: 'a nullable field holding a value', schema: Schema.Struct({ a: Schema.NullOr(Schema.String) }), value: { a: 'x' } },
  { about: 'a literal field', schema: Schema.Struct({ a: Schema.Literal('fixed') }), value: { a: 'fixed' } },
  { about: 'a transformed field', schema: Schema.Struct({ a: Schema.NumberFromString }), value: { a: 42 } },
  { about: 'an optional field that is present', schema: Schema.Struct({ a: Schema.optional(Schema.String) }), value: { a: 'x' } },
  { about: 'an attribute', schema: Schema.Struct({ '@id': Schema.String }), value: { '@id': '1' } },
  { about: 'a namespace declaration', schema: Schema.Struct({ '@xmlns': Schema.String }), value: { '@xmlns': 'urn:books' } },
  { about: 'an attribute with a hostile value', schema: Schema.Struct({ '@a': Schema.String }), value: { '@a': '" onload="alert(1)' } },
  { about: 'an attribute with a newline', schema: Schema.Struct({ '@a': Schema.String }), value: { '@a': 'x\ny' } },
  { about: 'an attribute with a tab and a carriage return', schema: Schema.Struct({ '@a': Schema.String }), value: { '@a': 'x\ty\rz' } },
  {
    about: 'an element with attributes and text',
    schema: Schema.Struct({ '@id': Schema.String, '#text': Schema.String }),
    value: { '@id': '1', '#text': 'hello' },
  },
  {
    about: 'an element with attributes, text and children',
    schema: Schema.Struct({ '@id': Schema.String, '#text': Schema.String, a: Schema.String }),
    value: { '@id': '1', '#text': 'hello', a: 'x' },
  },
  {
    about: 'many attributes',
    schema: Schema.Struct({ '@a': Schema.String, '@b': Schema.String, '@c': Schema.String }),
    value: { '@a': '1', '@b': '2', '@c': '3' },
  },
  { about: 'an array of strings', schema: Schema.Struct({ a: Schema.Array(Schema.String) }), value: { a: ['x', 'y', 'z'] } },
  {
    about: 'an array with many members',
    schema: Schema.Struct({ a: Schema.Array(Schema.String) }),
    value: { a: Array.from({ length: 200 }, (_, i) => `item ${i}`) },
  },
  { about: 'an array of numbers', schema: Schema.Struct({ a: Schema.Array(Schema.Number) }), value: { a: [1, 2, 3] } },
  {
    about: 'an array of structs',
    schema: Schema.Struct({ a: Schema.Array(Schema.Struct({ b: Schema.String })) }),
    value: { a: [{ b: '1' }, { b: '2' }] },
  },
  { about: 'a record field', schema: Schema.Struct({ a: Schema.Record(Schema.String, Schema.String) }), value: { a: { x: '1', y: '2' } } },
  { about: 'a union of string and number', schema: Schema.Struct({ a: Schema.Union([Schema.String, Schema.Number]) }), value: { a: 'text' } },
  { about: 'a union holding the other member', schema: Schema.Struct({ a: Schema.Union([Schema.String, Schema.Number]) }), value: { a: 5 } },
  {
    about: 'a nested struct',
    schema: Schema.Struct({ a: Schema.Struct({ b: Schema.Struct({ c: Schema.String }) }) }),
    value: { a: { b: { c: 'deep' } } },
  },
  {
    about: 'a wide struct',
    schema: Schema.Struct(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, Schema.String])) as Record<string, Schema.Codec<string>>),
    value: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `v${i}`])),
  },
  { about: 'a namespaced field name', schema: Schema.Struct({ 'soap:Envelope': Schema.String }), value: { 'soap:Envelope': 'x' } },
  {
    about: 'every scalar kind side by side',
    schema: Schema.Struct({ s: Schema.String, n: Schema.Number, b: Schema.Boolean, l: Schema.Literal('lit') }),
    value: { s: 'text', n: 1.5, b: true, l: 'lit' },
  },
  {
    about: 'attributes alongside arrays and nesting',
    schema: Schema.Struct({
      '@id': Schema.String,
      title: Schema.String,
      tag: Schema.Array(Schema.String),
      meta: Schema.Struct({ created: Schema.String, '@lang': Schema.String }),
    }),
    value: { '@id': '7', title: 'A Title', tag: ['a', 'b'], meta: { created: '2026-01-01', '@lang': 'en' } },
  },
];

describe('round trip — a value survives being written and read', () => {
  for (const testCase of cases) {
    it(testCase.about, () => {
      expect(roundTrip(testCase.schema, testCase.value, testCase.rootName ?? 'r')).toEqual(testCase.value);
    });
  }
});

describe('round trip — encoding never throws for a value the schema accepts', () => {
  it('holds for every case above', () => {
    for (const testCase of cases) {
      // The failure this guards against is the one the encode step could raise on
      // its own, such as an unrepairable name or a nesting limit, as opposed to the
      // decode step, which the round trip above already exercises.
      expect(() => encode(testCase.schema, testCase.value, testCase.rootName ?? 'r')).not.toThrow();
    }
  });

  it('holds for a value rendered both compact and indented', () => {
    for (const testCase of cases) {
      const rootName = testCase.rootName ?? 'r';
      for (const format of [false, true]) {
        const text = Schema.encodeSync(toCodecXml(testCase.schema, { rootName, format }))(testCase.value) as string;
        expect(Schema.decodeSync(toCodecXml(testCase.schema, { rootName }))(text)).toEqual(testCase.value);
      }
    }
  });
});

describe('round trip — a document reaches a fixed point', () => {
  /**
   * @description Asserts that parsing, rendering and parsing again changes nothing. This exercises the text layer directly, below the codec, which is where a
   * drifting encoder would show.
   *
   * @param document - The document to start from.
   */
  const fixedPoint = (document: string): void => {
    const render = (value: Parameters<typeof renderXml>[0]): string => Effect.runSync(renderXml(value, { rootName: 'root' }));
    const first = render(parseXmlDocument(document).value);
    const second = render(parseXmlDocument(first).value);
    expect(second).toBe(first);
  };

  it('holds for a document written by this package', () => {
    for (const testCase of cases) {
      const rootName = testCase.rootName ?? 'r';
      const once = Schema.encodeSync(toCodecXml(testCase.schema, { rootName }))(testCase.value) as string;
      const rendered = Effect.runSync(renderXml(parseXmlDocument(once).value, { rootName }));
      expect(Effect.runSync(renderXml(parseXmlDocument(rendered).value, { rootName }))).toBe(rendered);
    }
  });

  it('holds for a document with a prolog, comments and a doctype', () => {
    fixedPoint('<?xml version="1.0"?><!DOCTYPE r><r><!-- note --><a>1</a></r>');
  });

  it('holds for a document with CDATA', () => {
    fixedPoint('<r><a><![CDATA[<raw> & stuff]]></a></r>');
  });

  it('holds for a document with a processing instruction inside an element', () => {
    fixedPoint('<r><a>1</a><?target data?></r>');
  });

  it('holds for a pretty-printed document', () => {
    fixedPoint('<r>\n  <a>1</a>\n  <b>\n    <c>2</c>\n  </b>\n</r>\n');
  });

  it('holds for a document that uses every escape', () => {
    fixedPoint('<r><a>&lt;&amp;&gt;&quot;&apos;</a><b x="&lt;&amp;&quot;"/></r>');
  });

  it('holds for a document with repeated elements', () => {
    fixedPoint('<r><a>1</a><a>2</a><a>3</a></r>');
  });

  it('holds for a document with an empty element', () => {
    fixedPoint('<r><a/><b></b></r>');
  });

  it('holds for a document that is only an empty element', () => {
    fixedPoint('<r/>');
  });
});

describe('round trip — what XML cannot spell, and the caller settles', () => {
  it('reads a one-member array back when the caller asks the codec to accept a single value', () => {
    // XML cannot tell `<a>x</a>` from a one-member array of that element. The
    // plain codec reads it as the bare value; a caller that wants the array
    // composes Effect's `toCodecArrayFromSingle` into the schema, which is where
    // that leniency lives now, and derives the XML codec from the result.
    const schema = Schema.Struct({ a: Schema.Array(Schema.String) });
    const text = encode(schema, { a: ['only'] });
    expect(text).toBe('<r><a>only</a></r>');
    const tolerant = toCodecXml(Schema.toCodecArrayFromSingle(schema), { rootName: 'r' });
    expect(Schema.decodeSync(tolerant)(text)).toEqual({ a: ['only'] });
  });

  it('does not read a one-member array back without it, which is the plain codec’s behaviour', () => {
    const schema = Schema.Struct({ a: Schema.Array(Schema.String) });
    expect(() => roundTrip(schema, { a: ['only'] })).toThrow();
  });

  it('leaves an empty root element to the caller, because XML cannot say what it was meant to be', () => {
    // `<r/>` is empty character data. A struct with every field absent has
    // nothing to decode from it, and the plain codec reports that rather than
    // inventing `{}`.
    const schema = Schema.Struct({ a: Schema.optional(Schema.String) });
    expect(encode(schema, {})).toBe('<r/>');
    expect(parseXmlDocument('<r/>').value).toBe('');
    expect(() => decode(schema, '<r/>')).toThrow();
  });

  it('reads a root array only when the caller accounts for the wrapper element', () => {
    // The renderer wraps a root array in the root element and names each member.
    // Reading that back yields a record of the members, so the caller maps it
    // back to the array; the codec does not.
    const schema = Schema.Array(Schema.String);
    const codec = toCodecXml(schema, { rootName: 'tags' });
    expect(Schema.encodeSync(codec)(['a', 'b'])).toBe('<tags><item>a</item><item>b</item></tags>');
    expect(parseXmlDocument('<tags><item>a</item><item>b</item></tags>').value).toEqual({ item: ['a', 'b'] });
    expect(() => Schema.decodeSync(codec)('<tags><item>a</item><item>b</item></tags>')).toThrow();
  });

  it('drops a field whose value is only whitespace, unless the caller asks to keep it', () => {
    // An indented document is mostly whitespace, so treating whitespace-only text
    // as content would make the same document read differently depending on how it
    // was laid out. Trimming the edges of every run is what removes the layout
    // without touching the content in the middle, and `preserveWhitespace: false`
    // is what turns it off.
    const schema = Schema.Struct({ a: Schema.String });
    const text = encode(schema, { a: '   ' });
    expect(decode(schema, text)).toEqual({ a: '' });
    expect(Schema.decodeSync(toCodecXml(schema, { rootName: 'r', preserveWhitespace: true }))(text)).toEqual({ a: '   ' });
  });

  it('cannot read back a schema that uses a name XML cannot spell', () => {
    // XML has no way to spell `not a name`. The renderer rewrites it so the
    // document is well-formed, and a schema that asks for the illegal name then
    // has nothing in the document to match. A schema that uses the legal name
    // round-trips normally.
    const illegal = Schema.Struct({ 'not a name': Schema.String });
    const text = encode(illegal, { 'not a name': 'x' });
    expect(text).toBe('<r><not_a_name>x</not_a_name></r>');
    expect(() => decode(illegal, text)).toThrow(/Missing key/);

    const legal = Schema.Struct({ not_a_name: Schema.String });
    expect(decode(legal, text)).toEqual({ not_a_name: 'x' });
  });

  it('writes a bigint as its decimal text', () => {
    // Effect's StringTree derivation lowers a bigint to text on the way out. What
    // it does on the way back in is left to Effect, and the answer has been seen
    // to depend on what else has been derived in the process, so the encoded form
    // is asserted here and the decoded form is left alone rather than pinned to a
    // behaviour that is not this package's to promise.
    const schema = Schema.Struct({ a: Schema.BigInt });
    expect(encode(schema, { a: 9007199254740993n })).toBe('<r><a>9007199254740993</a></r>');
  });
});
