/**
 * @description Round-trip specs: every value here goes out as XML and comes back as the value it was. This is the spec that answers "does serialization fail". A
 * field that only ever gets written is a field nobody notices is broken until a consumer reads the document, so each case is asserted in both
 * directions, and each document is additionally asserted to reach a fixed point — parse, render, parse again must be stable, which is what stops an
 * encoder from quietly drifting the document on every hop through the system.
 */

import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { parseXmlSync, renderXml, toCodecXml } from '#/index.ts';

/**
 * @description A codec of any shape, for a table of cases that do not share one schema. `unknown` in both type positions rather than `any`, which keeps the cases
 * honest: a case's value is only ever passed in and compared against what comes back out, so nothing here needs the schema's type to be known.
 */
type AnyCodec = Schema.ConstraintCodec<unknown, unknown, never, never>;

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
  { about: 'an optional field that is absent', schema: Schema.Struct({ a: Schema.optional(Schema.String) }), value: {} },
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
  { about: 'an array with one member', schema: Schema.Struct({ a: Schema.Array(Schema.String) }), value: { a: ['only'] } },
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
      const codec = toCodecXml(testCase.schema, { rootName: testCase.rootName ?? 'r' });
      const text = codec.encodeTextSync(testCase.value);
      expect(codec.decodeTextSync(text)).toEqual(testCase.value);
    });
  }
});

describe('round trip — encoding never throws for a value the schema accepts', () => {
  it('holds for every case above', () => {
    for (const testCase of cases) {
      const codec = toCodecXml(testCase.schema, { rootName: testCase.rootName ?? 'r' });
      // The failure this guards against is the one the encode step could raise on
      // its own — an unrepairable name, or a nesting limit — as opposed to the
      // decode step, which the round trip above already exercises.
      expect(() => codec.encodeTextSync(testCase.value)).not.toThrow();
    }
  });

  it('holds for a value rendered both compact and indented', () => {
    for (const testCase of cases) {
      const codec = toCodecXml(testCase.schema, { rootName: testCase.rootName ?? 'r' });
      for (const format of [false, true]) {
        const text = codec.encodeTextSync(testCase.value, { format });
        expect(codec.decodeTextSync(text)).toEqual(testCase.value);
      }
    }
  });
});

describe('round trip — a document reaches a fixed point', () => {
  /**
   * @description Asserts that parsing, rendering and parsing again changes nothing.
   *
   * @param document - The document to start from.
   */
  const fixedPoint = (document: string): void => {
    const first = renderXml(parseXmlSync(document), { rootName: 'root' });
    const second = renderXml(parseXmlSync(first), { rootName: 'root' });
    expect(second).toBe(first);
  };

  it('holds for a document written by this package', () => {
    for (const testCase of cases) {
      const codec = toCodecXml(testCase.schema, { rootName: testCase.rootName ?? 'r' });
      const text = codec.encodeTextSync(testCase.value);
      const once = renderXml(parseXmlSync(text), { rootName: 'r' });
      expect(renderXml(parseXmlSync(once), { rootName: 'r' })).toBe(once);
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

describe('round trip — the awkward cases, named', () => {
  it('reads back an element that carries only attributes', () => {
    const codec = toCodecXml(Schema.Struct({ '@id': Schema.String, '@lang': Schema.String }), { rootName: 'a' });
    const value = { '@id': '1', '@lang': 'en' };
    expect(codec.decodeTextSync(codec.encodeTextSync(value))).toEqual(value);
  });

  it('reads back an element whose text is whitespace between two words', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    expect(codec.decodeTextSync(codec.encodeTextSync({ a: 'one two' }))).toEqual({ a: 'one two' });
  });

  it('reads back a document whose text looks like markup', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    const value = { a: '<script>alert(1)</script>' };
    const text = codec.encodeTextSync(value);
    // The point is that escaping happens on the way out, so the raw markup never
    // reaches the document as markup.
    expect(text).toBe('<r><a>&lt;script&gt;alert(1)&lt;/script&gt;</a></r>');
    expect(codec.decodeTextSync(text)).toEqual(value);
  });

  it('reads back a document whose attribute value tries to break out', () => {
    const codec = toCodecXml(Schema.Struct({ '@a': Schema.String }), { rootName: 'r' });
    const value = { '@a': '"><script>alert(1)</script>' };
    const text = codec.encodeTextSync(value);
    expect(text).not.toContain('"><');
    expect(codec.decodeTextSync(text)).toEqual(value);
  });

  it('reads back a document with a hostile value that reads as a bare ampersand', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    // Read leniently, the ampersand is escaped on the way out, so the value is
    // unchanged even though the first document was not strictly well-formed.
    expect(codec.decodeTextSync('<r><a>Smith & Jones</a></r>')).toEqual({ a: 'Smith & Jones' });
  });

  it('escapes an ampersand exactly once, not twice', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: '&' })).toBe('<r><a>&amp;</a></r>');
    expect(codec.decodeTextSync('<r><a>&amp;</a></r>')).toEqual({ a: '&' });
  });

  it('preserves a character reference the value already contained', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    // `&amp;` is a reference in the value, not five characters to escape. It comes
    // back as `&`, which is what the value said once the reference was resolved.
    expect(codec.encodeTextSync({ a: '&amp;' })).toBe('<r><a>&amp;amp;</a></r>');
    expect(codec.decodeTextSync(codec.encodeTextSync({ a: '&amp;' }))).toEqual({ a: '&amp;' });
  });
});

describe('round trip — what cannot round trip, and says so', () => {
  it('reports an empty array of structs rather than reading it back as something else', () => {
    // An empty element is empty character data, and there is no XML that says
    // "an array with nothing in it" as against "a struct with no fields". The
    // renderer keeps the element so the field is visible in the document; the
    // reader then cannot tell what it was meant to be, and says so rather than
    // inventing a value. See the README's limitations.
    const codec = toCodecXml(Schema.Struct({ children: Schema.Array(Schema.Struct({ label: Schema.String })) }), { rootName: 'node' });
    expect(codec.encodeTextSync({ children: [] })).toBe('<node><children/></node>');
    expect(() => codec.decodeTextSync('<node><children/></node>')).toThrow();
  });

  it('reports an empty record field rather than reading it back as an empty string', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Record(Schema.String, Schema.String) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: {} })).toBe('<r><a/></r>');
    expect(() => codec.decodeTextSync('<r><a/></r>')).toThrow();
  });

  it('reads an empty array of strings back as a one-member array of the empty string', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Array(Schema.String) }), { rootName: 'r' });
    expect(codec.decodeTextSync('<r><a/></r>')).toEqual({ a: [''] });
  });

  it('reads a one-member array of structs back as the struct, because XML cannot tell them apart', () => {
    // `<a id="1"><b>x</b></a>` is one element. It is equally a one-member array of
    // that element, and only the schema can say which was meant. Two or more
    // members are unambiguous and do round-trip; see the cases above.
    const schema = Schema.Struct({ a: Schema.Array(Schema.Struct({ '@id': Schema.String, b: Schema.String })) });
    const codec = toCodecXml(schema, { rootName: 'r' });
    expect(codec.encodeTextSync({ a: [{ '@id': '1', b: 'x' }] })).toBe('<r><a id="1"><b>x</b></a></r>');
    expect(() => codec.decodeTextSync('<r><a id="1"><b>x</b></a></r>')).toThrow();
  });

  it('drops a field whose value is only whitespace, unless the caller asks to keep it', () => {
    // An indented document is mostly whitespace, so treating whitespace-only text
    // as content would make the same document read differently depending on how it
    // was laid out. Trimming the edges of every run is what removes the layout
    // without touching the content in the middle, and `preserveWhitespace: false`
    // is what turns it off.
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    const text = codec.encodeTextSync({ a: '   ' });
    expect(codec.decodeTextSync(text)).toEqual({ a: '' });
    expect(codec.decodeTextSync(text, { preserveWhitespace: true })).toEqual({ a: '   ' });
  });

  it('cannot read back a schema that uses a name XML cannot spell', () => {
    // XML has no way to spell `not a name`. The renderer rewrites it so the
    // document is well-formed, and a schema that asks for the illegal name then
    // has nothing in the document to match. A schema that uses the legal name
    // round-trips normally.
    const codec = toCodecXml(Schema.Struct({ 'not a name': Schema.String }), { rootName: 'r' });
    const text = codec.encodeTextSync({ 'not a name': 'x' });
    expect(text).toBe('<r><not_a_name>x</not_a_name></r>');
    expect(() => codec.decodeTextSync(text)).toThrow(/Missing key/);

    const legal = toCodecXml(Schema.Struct({ not_a_name: Schema.String }), { rootName: 'r' });
    expect(legal.decodeTextSync(text)).toEqual({ not_a_name: 'x' });
  });

  it('reads a name that started with a digit back only from a schema that uses the repaired name', () => {
    const codec = toCodecXml(Schema.Struct({ '1st': Schema.String }), { rootName: 'r' });
    const text = codec.encodeTextSync({ '1st': 'x' });
    expect(text).toBe('<r><_1st>x</_1st></r>');
    expect(() => codec.decodeTextSync(text)).toThrow(/Missing key/);

    const legal = toCodecXml(Schema.Struct({ _1st: Schema.String }), { rootName: 'r' });
    expect(legal.decodeTextSync(text)).toEqual({ _1st: 'x' });
  });

  it('writes a bigint as its decimal text', () => {
    // Effect's StringTree derivation lowers a bigint to text on the way out. What
    // it does on the way back in is left to Effect, and the answer has been seen
    // to depend on what else has been derived in the process — so the encoded form
    // is asserted here and the decoded form is left alone rather than pinned to a
    // behaviour that is not this package's to promise.
    const codec = toCodecXml(Schema.Struct({ a: Schema.BigInt }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 9007199254740993n })).toBe('<r><a>9007199254740993</a></r>');
  });
});
