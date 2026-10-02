/**
 * @description Specs for `toCodecXml`: that it is a `Schema` whose `Encoded` is XML text, so one `Schema.encodeSync` writes a document and one `Schema.decodeSync`
 * reads one back, and that every schema shape survives the trip.
 */

// oxlint-disable effecttsgo/schema-number

import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { toCodecXml } from '#/codec.ts';

/**
 * @description A codec of any shape, for a table of cases that do not share one schema. `unknown` in both type positions rather than `any`, which keeps the cases
 * honest: a case's value is only ever passed in and compared against what comes back out, so nothing here needs the schema's type to be known.
 */
type AnyCodec = Schema.ConstraintCodec<unknown, unknown>;

describe('toCodecXml() — the codec', () => {
  it('returns a Schema whose encoded side is XML text', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ a: 'x' })).toBe('<r><a>x</a></r>');
    expect(Schema.decodeSync(codec)('<r><a>x</a></r>')).toEqual({ a: 'x' });
    expect(Effect.runSync(Schema.encodeEffect(codec)({ a: 'x' }))).toBe('<r><a>x</a></r>');
    expect(Effect.runSync(Schema.decodeEffect(codec)('<r><a>x</a></r>'))).toEqual({ a: 'x' });
  });

  it('lowers every scalar to its text form in the document', () => {
    const codec = toCodecXml(Schema.Struct({ s: Schema.String, n: Schema.Number, b: Schema.Boolean, l: Schema.Literal('lit') }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ s: 'text', n: 1.5, b: false, l: 'lit' })).toBe('<r><s>text</s><n>1.5</n><b>false</b><l>lit</l></r>');
  });

  it('names the root from the schema identifier when no option is given', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ identifier: 'book' }));
    expect(Schema.encodeSync(codec)({ title: 'Dune' })).toBe('<book><title>Dune</title></book>');
  });

  it('names the root from the title annotation when there is no identifier', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ title: 'Book' }));
    expect(Schema.encodeSync(codec)({ title: 'Dune' })).toBe('<Book><title>Dune</title></Book>');
  });

  it('falls back to root when the schema carries no name', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }));
    expect(Schema.encodeSync(codec)({ a: 'x' })).toBe('<root><a>x</a></root>');
  });

  it('keeps an @-prefixed key as an attribute and #text as character data', () => {
    const codec = toCodecXml(Schema.Struct({ '@href': Schema.String, '#text': Schema.String }), { rootName: 'a' });
    const value = { '@href': '/a', '#text': 'link' };
    expect(Schema.encodeSync(codec)(value)).toBe('<a href="/a">link</a>');
    expect(Schema.decodeSync(codec)('<a href="/a">link</a>')).toEqual(value);
  });
});

describe('toCodecXml() — schema shapes through the document', () => {
  const roundTrip = (schema: AnyCodec, value: unknown): unknown =>
    Schema.decodeSync(toCodecXml(schema, { rootName: 'r' }))(Schema.encodeSync(toCodecXml(schema, { rootName: 'r' }))(value));

  it('handles a number field, as decimal text', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Number }), { a: 1.5 })).toEqual({ a: 1.5 });
  });

  it('handles an integer field', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Int }), { a: 42 })).toEqual({ a: 42 });
  });

  it('handles a boolean field', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Boolean }), { a: false })).toEqual({ a: false });
  });

  it('handles a null field', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Null }), { a: null })).toEqual({ a: null });
  });

  it('handles a nullable field holding a value', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.NullOr(Schema.String) }), { a: 'x' })).toEqual({ a: 'x' });
  });

  it('handles a literal field', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Literal('fixed') }), { a: 'fixed' })).toEqual({ a: 'fixed' });
  });

  it('handles a transformed field, through the transformation', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.NumberFromString }), { a: 42 })).toEqual({ a: 42 });
  });

  it('handles an optional field that is present', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.optional(Schema.String) }), { a: 'x' })).toEqual({ a: 'x' });
  });

  it('handles a nested struct', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Struct({ b: Schema.String }) }), { a: { b: 'x' } })).toEqual({ a: { b: 'x' } });
  });

  it('handles an array field with two or more members', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Array(Schema.String) }), { a: ['x', 'y'] })).toEqual({ a: ['x', 'y'] });
  });

  it('handles an array of structs with two or more members', () => {
    const schema = Schema.Struct({ a: Schema.Array(Schema.Struct({ b: Schema.String })) });
    expect(roundTrip(schema, { a: [{ b: '1' }, { b: '2' }] })).toEqual({ a: [{ b: '1' }, { b: '2' }] });
  });

  it('handles a record field', () => {
    expect(roundTrip(Schema.Struct({ a: Schema.Record(Schema.String, Schema.String) }), { a: { x: '1', y: '2' } })).toEqual({
      a: { x: '1', y: '2' },
    });
  });

  it('handles a union field', () => {
    const schema = Schema.Struct({ a: Schema.Union([Schema.String, Schema.Number]) });
    expect(roundTrip(schema, { a: 'text' })).toEqual({ a: 'text' });
    expect(roundTrip(schema, { a: 5 })).toEqual({ a: 5 });
  });

  it('handles a recursive schema', () => {
    interface Node {
      readonly label: string;
      readonly children?: ReadonlyArray<Node>;
    }
    // `children` is optional so a leaf can be written with no element of its own, and every node that does have one has
    // two children — a node with exactly one is a one-member array of structs, which XML cannot tell from the struct.
    const Node: Schema.Codec<Node> = Schema.suspend(() =>
      Schema.Struct({ label: Schema.String, children: Schema.optional(Schema.Array(Node)) })
    ) as Schema.Codec<Node>;
    const value: Node = { label: 'a', children: [{ label: 'b' }, { label: 'c' }] };
    expect(roundTrip(Node, value)).toEqual(value);
  });
});

describe('toCodecXml() — options', () => {
  it('pretty-prints when asked', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r', format: true });
    expect(Schema.encodeSync(codec)({ a: 'x' })).toBe('<r>\n  <a>x</a>\n</r>\n');
  });

  it('keeps leading and trailing whitespace when asked on the way back in', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r', preserveWhitespace: true });
    expect(Schema.decodeSync(codec)('<r><a>   </a></r>')).toEqual({ a: '   ' });
  });
});

describe('toCodecXml() — namespaces', () => {
  const ATOM = 'http://www.w3.org/2005/Atom';
  const AUTH = 'urn:auth';

  it('writes an element namespace as the default declaration', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ xmlNamespace: ATOM }), { rootName: 'feed' });
    expect(Schema.encodeSync(codec)({ title: 'Example' })).toBe(`<feed xmlns="${ATOM}"><title>Example</title></feed>`);
  });

  it('writes a namespace with a custom prefix on the element', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }), { rootName: 'feed' });
    expect(Schema.encodeSync(codec)({ title: 'Example' })).toBe(`<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title></atom:feed>`);
  });

  it('decodes a document whose namespace has no prefix', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ xmlNamespace: ATOM }), { rootName: 'feed' });
    expect(Schema.decodeSync(codec)(`<feed xmlns="${ATOM}"><title>Example</title></feed>`)).toEqual({ title: 'Example' });
  });

  it('decodes a document whose namespace uses the schema prefix', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }), { rootName: 'feed' });
    expect(Schema.decodeSync(codec)(`<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title></atom:feed>`)).toEqual({ title: 'Example' });
  });

  it('encodes and decodes nested namespaces', () => {
    const codec = toCodecXml(
      Schema.Struct({
        title: Schema.String,
        entry: Schema.Struct({ author: Schema.Struct({ name: Schema.String }).annotate({ xmlNamespace: AUTH, xmlPrefix: 'auth' }) }),
      }).annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }),
      { rootName: 'feed' }
    );
    const value = { title: 'Example', entry: { author: { name: 'Ada' } } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe(
      `<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title><atom:entry><auth:author xmlns:auth="${AUTH}"><auth:name>Ada</auth:name></auth:author></atom:entry></atom:feed>`
    );
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('decodes a document whose prefix is not the one configured in the schema', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }), { rootName: 'feed' });
    expect(Schema.decodeSync(codec)(`<x:feed xmlns:x="${ATOM}"><x:title>Example</x:title></x:feed>`)).toEqual({ title: 'Example' });
  });
});

describe('toCodecXml() — xmlName', () => {
  const ATOM = 'http://www.w3.org/2005/Atom';

  it('writes an element name that differs from the schema field', () => {
    const codec = toCodecXml(Schema.Struct({ mimeType: Schema.String.annotate({ xmlName: 'mime-type' }) }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ mimeType: 'text/plain' })).toBe('<r><mime-type>text/plain</mime-type></r>');
    expect(Schema.decodeSync(codec)('<r><mime-type>text/plain</mime-type></r>')).toEqual({ mimeType: 'text/plain' });
  });

  it('writes an attribute name that differs from the schema field', () => {
    const codec = toCodecXml(Schema.Struct({ '@mimeType': Schema.String.annotate({ xmlName: 'mime-type' }) }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ '@mimeType': 'text/plain' })).toBe('<r mime-type="text/plain"/>');
    expect(Schema.decodeSync(codec)('<r mime-type="text/plain"/>')).toEqual({ '@mimeType': 'text/plain' });
  });

  it('names the root element from the annotation', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }).annotate({ xmlName: 'feed' }));
    expect(Schema.encodeSync(codec)({ a: 'x' })).toBe('<feed><a>x</a></feed>');
  });

  it('combines xmlName with a namespace prefix', () => {
    const codec = toCodecXml(
      Schema.Struct({ payload: Schema.String.annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom', xmlName: 'Body' }) }).annotate({
        xmlNamespace: ATOM,
        xmlPrefix: 'atom',
      }),
      { rootName: 'feed' }
    );
    const value = { payload: 'x' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe(`<atom:feed xmlns:atom="${ATOM}"><atom:Body>x</atom:Body></atom:feed>`);
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('combines xmlName with a namespaced attribute', () => {
    const codec = toCodecXml(
      Schema.Struct({ '@format': Schema.String.annotate({ xmlName: 'mime-type', xmlNamespace: 'urn:meta', xmlPrefix: 'meta' }) }),
      { rootName: 'note' }
    );
    expect(Schema.encodeSync(codec)({ '@format': 'text/plain' })).toBe('<note xmlns:meta="urn:meta" meta:mime-type="text/plain"/>');
    expect(Schema.decodeSync(codec)('<note xmlns:meta="urn:meta" meta:mime-type="text/plain"/>')).toEqual({ '@format': 'text/plain' });
  });

  it('renames nested elements inside a namespace', () => {
    const codec = toCodecXml(
      Schema.Struct({ order: Schema.Struct({ total: Schema.String.annotate({ xmlName: 'Total' }) }).annotate({ xmlName: 'Order' }) }).annotate({
        xmlNamespace: 'urn:shop',
      }),
      { rootName: 'shop' }
    );
    const value = { order: { total: '10' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<shop xmlns="urn:shop"><Order><Total>10</Total></Order></shop>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('refuses an xmlName that carries a prefix', () => {
    expect(() => toCodecXml(Schema.Struct({ a: Schema.String.annotate({ xmlName: 'soap:a' }) }))).toThrow(/must be a local name/);
  });
});

describe('toCodecXml() — xmlAttribute', () => {
  it('marks a field as an attribute without the @ prefix', () => {
    const codec = toCodecXml(Schema.Struct({ version: Schema.String.annotate({ xmlAttribute: true }) }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ version: '1' })).toBe('<r version="1"/>');
    expect(Schema.decodeSync(codec)('<r version="1"/>')).toEqual({ version: '1' });
  });

  it('combines xmlAttribute with xmlName', () => {
    const codec = toCodecXml(Schema.Struct({ format: Schema.String.annotate({ xmlAttribute: true, xmlName: 'mime-type' }) }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ format: 'text/plain' })).toBe('<r mime-type="text/plain"/>');
    expect(Schema.decodeSync(codec)('<r mime-type="text/plain"/>')).toEqual({ format: 'text/plain' });
  });

  it('writes a namespaced attribute marked with xmlAttribute', () => {
    const codec = toCodecXml(
      Schema.Struct({ version: Schema.String.annotate({ xmlAttribute: true, xmlNamespace: 'urn:meta', xmlPrefix: 'meta' }) }),
      { rootName: 'note' }
    );
    const value = { version: '1' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<note xmlns:meta="urn:meta" meta:version="1"/>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('keeps an element and an attribute of the same local name apart', () => {
    const codec = toCodecXml(
      Schema.Struct({
        '@id': Schema.String.annotate({ xmlNamespace: 'urn:meta', xmlPrefix: 'meta' }),
        id: Schema.String.annotate({ xmlNamespace: 'urn:meta', xmlPrefix: 'meta' }),
      }),
      { rootName: 'r' }
    );
    const value = { '@id': 'a', id: 'e' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<r xmlns:meta="urn:meta" meta:id="a"><meta:id>e</meta:id></r>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('marks an attribute through annotateKey', () => {
    const codec = toCodecXml(Schema.Struct({ version: Schema.String.pipe(Schema.annotateKey({ xmlAttribute: true })) }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ version: '1' })).toBe('<r version="1"/>');
    expect(Schema.decodeSync(codec)('<r version="1"/>')).toEqual({ version: '1' });
  });

  it('refuses a namespaced attribute marked with xmlAttribute but no prefix', () => {
    expect(() => toCodecXml(Schema.Struct({ version: Schema.String.annotate({ xmlAttribute: true, xmlNamespace: 'urn:meta' }) }))).toThrow(
      /needs xmlPrefix/
    );
  });
});

describe('toCodecXml() — xmlValue', () => {
  it('writes a field marked xmlValue as the element character data', () => {
    const codec = toCodecXml(Schema.Struct({ '@currency': Schema.String, amount: Schema.String.annotate({ xmlValue: true }) }), {
      rootName: 'price',
    });
    const value = { '@currency': 'USD', amount: '19.99' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<price currency="USD">19.99</price>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes xmlValue alongside child elements', () => {
    const codec = toCodecXml(Schema.Struct({ content: Schema.String.annotate({ xmlValue: true }), em: Schema.String }), { rootName: 'p' });
    const value = { content: 'hi', em: '' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<p>hi<em/></p>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes xmlValue inside a namespaced element', () => {
    const codec = toCodecXml(
      Schema.Struct({ '@id': Schema.String, amount: Schema.String.annotate({ xmlValue: true }) }).annotate({
        xmlNamespace: 'urn:price',
        xmlPrefix: 'p',
      }),
      { rootName: 'price' }
    );
    const value = { '@id': '1', amount: '19.99' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<p:price xmlns:p="urn:price" id="1">19.99</p:price>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('marks the value through annotateKey', () => {
    const codec = toCodecXml(Schema.Struct({ '@id': Schema.String, amount: Schema.String.pipe(Schema.annotateKey({ xmlValue: true })) }), {
      rootName: 'price',
    });
    const value = { '@id': '1', amount: '19.99' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<price id="1">19.99</price>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('refuses a field marked as both an attribute and the value', () => {
    expect(() => toCodecXml(Schema.Struct({ a: Schema.String.annotate({ xmlValue: true, xmlAttribute: true }) }))).toThrow(
      /both an attribute and the element's value/
    );
  });

  it('refuses a value field with an xmlName', () => {
    expect(() => toCodecXml(Schema.Struct({ a: Schema.String.annotate({ xmlValue: true, xmlName: 'x' }) }))).toThrow(/cannot have an xmlName/);
  });

  it('writes a value field for each of two sibling elements', () => {
    const codec = toCodecXml(
      Schema.Struct({
        first: Schema.Struct({ '@id': Schema.String, title: Schema.String.annotate({ xmlValue: true }) }),
        second: Schema.Struct({ '@id': Schema.String, body: Schema.String.annotate({ xmlValue: true }) }),
      }),
      { rootName: 'root' }
    );
    const value = { first: { '@id': '1', title: 'a' }, second: { '@id': '2', body: 'b' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<root><first id="1">a</first><second id="2">b</second></root>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes the same value field for two sibling elements', () => {
    const codec = toCodecXml(
      Schema.Struct({
        first: Schema.Struct({ '@id': Schema.String, text: Schema.String.annotate({ xmlValue: true }) }),
        second: Schema.Struct({ '@id': Schema.String, text: Schema.String.annotate({ xmlValue: true }) }),
      }),
      { rootName: 'root' }
    );
    const value = { first: { '@id': '1', text: 'a' }, second: { '@id': '2', text: 'b' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<root><first id="1">a</first><second id="2">b</second></root>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes a value field for the same name nested differently', () => {
    const codec = toCodecXml(
      Schema.Struct({
        items: Schema.Array(Schema.Struct({ '@id': Schema.String, title: Schema.String.annotate({ xmlValue: true }) })).pipe(
          Schema.annotate({ xmlName: 'item' })
        ),
        group: Schema.Struct({
          item: Schema.Struct({ '@id': Schema.String, note: Schema.String.annotate({ xmlValue: true }) }).pipe(Schema.annotate({ xmlName: 'item' })),
        }),
      }),
      { rootName: 'root' }
    );
    const value = { items: [{ '@id': '1', title: 'a' }], group: { item: { '@id': '2', note: 'b' } } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<root><item id="1">a</item><group><item id="2">b</item></group></root>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('refuses two value fields on the same element', () => {
    expect(() => toCodecXml(Schema.Struct({ a: Schema.String.annotate({ xmlValue: true }), b: Schema.String.annotate({ xmlValue: true }) }))).toThrow(
      /more than one value field/
    );
  });
});

describe('toCodecXml() — failures', () => {
  it('reports a malformed document as a schema failure with the parse message', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    expect(() => Schema.decodeSync(codec)('<r><a>x</r>')).toThrow(/Closing tag/);
  });

  it('reports a schema mismatch as a failure, not as a render or parse error', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Number }), { rootName: 'r' });
    const exit = Effect.runSyncExit(Schema.decodeEffect(codec)('<r><a>not a number</a></r>'));
    expect(Exit.isSuccess(exit)).toBe(false);
  });

  it('refuses a name it cannot spell when the render is in error mode', () => {
    const codec = toCodecXml(Schema.Struct({ 'not a name': Schema.String }), { rootName: 'r', name: 'error' });
    expect(() => Schema.encodeSync(codec)({ 'not a name': 'x' })).toThrow(/Invalid XML name/);
  });

  it('repairs a name it cannot spell by default', () => {
    const codec = toCodecXml(Schema.Struct({ 'not a name': Schema.String }), { rootName: 'r' });
    expect(Schema.encodeSync(codec)({ 'not a name': 'x' })).toBe('<r><not_a_name>x</not_a_name></r>');
  });
});
