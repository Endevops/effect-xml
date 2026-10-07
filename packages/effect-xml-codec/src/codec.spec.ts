/**
 * @description Specs for `toCodecXml`: that it is a `Schema` whose `Encoded` is XML text, so one `Schema.encodeSync` writes a document and one `Schema.decodeSync`
 * reads one back, and that every schema shape survives the trip.
 */

// oxlint-disable effecttsgo/schema-number

import { Effect, Exit, Schema, pipe } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { toCodecXml } from '#/codec.ts';

/**
 * @description A codec of any shape, for a table of cases that do not share one schema. `unknown` in both type positions rather than `any`, which keeps the cases
 * honest: a case's value is only ever passed in and compared against what comes back out, so nothing here needs the schema's type to be known.
 */
type AnyCodec = Schema.ConstraintCodec<unknown, unknown>;

describe('toCodecXml() - the codec', () => {
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

describe('toCodecXml() - dual API', () => {
  const Book = Schema.Struct({ '@id': Schema.String, title: Schema.String }).annotate({ identifier: 'book' });
  const value = { '@id': '1', title: 'Dune' };
  const text = '<book id="1"><title>Dune</title></book>';

  it('writes the codec data-first from a schema and options', () => {
    const codec = toCodecXml(Book, { rootName: 'book' });
    expect(Schema.encodeSync(codec)(value)).toBe(text);
  });

  it('writes the codec data-last from options in a pipe', () => {
    const codec = pipe(Book, toCodecXml({ rootName: 'book' }));
    expect(Schema.encodeSync(codec)(value)).toBe(text);
  });

  it('writes the codec data-last with no options, naming the root from the schema', () => {
    const codec = pipe(Book, toCodecXml());
    expect(Schema.encodeSync(codec)(value)).toBe(text);
  });

  it('writes the codec data-last from an empty options call', () => {
    const codec = toCodecXml()(Schema.Struct({ a: Schema.String }));
    expect(Schema.encodeSync(codec)({ a: 'x' })).toBe('<root><a>x</a></root>');
  });
});

describe('toCodecXml() - schema shapes through the document', () => {
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

  it('handles one sub-schema shared by two sibling elements', () => {
    const Shared = Schema.Struct({ c: Schema.String });
    const schema = Schema.Struct({ b: Shared, d: Shared });
    const value = { b: { c: 'text' }, d: { c: 'other text' } };
    const codec = toCodecXml(schema, { rootName: 'a' });
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<a><b><c>text</c></b><d><c>other text</c></d></a>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('handles a shared sub-schema with an attribute', () => {
    const Shared = Schema.Struct({ '@id': Schema.String, c: Schema.String });
    const schema = Schema.Struct({ b: Shared, d: Shared });
    const value = { b: { '@id': '1', c: 'text' }, d: { '@id': '2', c: 'other text' } };
    const codec = toCodecXml(schema, { rootName: 'a' });
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<a><b id="1"><c>text</c></b><d id="2"><c>other text</c></d></a>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('handles a shared sub-schema in a prefixed namespace', () => {
    const Shared = Schema.Struct({ c: Schema.String }).annotate({ xmlNamespace: 'urn:shared', xmlPrefix: 's' });
    const schema = Schema.Struct({ b: Shared, d: Shared });
    const value = { b: { c: 'text' }, d: { c: 'other text' } };
    const codec = toCodecXml(schema, { rootName: 'a' });
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<a><s:b xmlns:s="urn:shared"><s:c>text</s:c></s:b><s:d xmlns:s="urn:shared"><s:c>other text</s:c></s:d></a>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('handles a shared sub-schema in the default namespace', () => {
    const Shared = Schema.Struct({ c: Schema.String }).annotate({ xmlNamespace: 'urn:shared' });
    const schema = Schema.Struct({ b: Shared, d: Shared });
    const value = { b: { c: 'text' }, d: { c: 'other text' } };
    const codec = toCodecXml(schema, { rootName: 'a' });
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<a><b xmlns="urn:shared"><c>text</c></b><d xmlns="urn:shared"><c>other text</c></d></a>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('handles a shared sub-schema renamed with xmlName', () => {
    const Shared = Schema.Struct({ c: Schema.String.annotate({ xmlName: 'value' }) });
    const schema = Schema.Struct({ b: Shared, d: Shared });
    const value = { b: { c: 'text' }, d: { c: 'other text' } };
    const codec = toCodecXml(schema, { rootName: 'a' });
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<a><b><value>text</value></b><d><value>other text</value></d></a>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('handles a shared sub-schema with an attribute, a namespace, and a rename', () => {
    const Shared = Schema.Struct({ '@id': Schema.String.annotate({ xmlName: 'ID' }), c: Schema.String.annotate({ xmlName: 'value' }) }).annotate({
      xmlNamespace: 'urn:shared',
      xmlPrefix: 's',
    });
    const schema = Schema.Struct({ b: Shared, d: Shared });
    const value = { b: { '@id': '1', c: 'text' }, d: { '@id': '2', c: 'other text' } };
    const codec = toCodecXml(schema, { rootName: 'a' });
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe(
      '<a><s:b xmlns:s="urn:shared" ID="1"><s:value>text</s:value></s:b><s:d xmlns:s="urn:shared" ID="2"><s:value>other text</s:value></s:d></a>'
    );
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
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
    // two children - a node with exactly one is a one-member array of structs, which XML cannot tell from the struct.
    const Node: Schema.Codec<Node> = Schema.suspend(() =>
      Schema.Struct({ label: Schema.String, children: Schema.optional(Schema.Array(Node)) })
    ) as Schema.Codec<Node>;
    const value: Node = { label: 'a', children: [{ label: 'b' }, { label: 'c' }] };
    expect(roundTrip(Node, value)).toEqual(value);
  });
});

describe('toCodecXml() - options', () => {
  it('pretty-prints when asked', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r', format: true });
    expect(Schema.encodeSync(codec)({ a: 'x' })).toBe('<r>\n  <a>x</a>\n</r>\n');
  });

  it('keeps leading and trailing whitespace when asked on the way back in', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r', preserveWhitespace: true });
    expect(Schema.decodeSync(codec)('<r><a>   </a></r>')).toEqual({ a: '   ' });
  });
});

class ClassSchema extends Schema.Struct({
  title: Schema.String,
  entry: Schema.Struct({ author: Schema.Struct({ name: Schema.String }).annotate({ xmlNamespace: 'urn:auth', xmlPrefix: 'auth' }) }),
}).pipe(Schema.annotate({ xmlNamespace: 'http://www.w3.org/2005/Atom', xmlPrefix: 'atom', xmlName: 'feed' }), toCodecXml) {}

class OpaqueClassSchema extends Schema.Opaque<OpaqueClassSchema>()(
  Schema.Struct({
    title: Schema.String,
    entry: Schema.Struct({ author: Schema.Struct({ name: Schema.String }).annotate({ xmlNamespace: 'urn:auth', xmlPrefix: 'auth' }) }),
  }).pipe(Schema.annotate({ xmlNamespace: 'http://www.w3.org/2005/Atom', xmlPrefix: 'atom', xmlName: 'feed' }), toCodecXml)
) {}

describe('toCodecXml() - namespaces', () => {
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

  it('encodes a document from a class schema', () => {
    const codec = ClassSchema;
    const value = { title: 'Example', entry: { author: { name: 'Ada' } } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe(
      `<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title><atom:entry><auth:author xmlns:auth="${AUTH}"><auth:name>Ada</auth:name></auth:author></atom:entry></atom:feed>`
    );
  });

  it('encodes a document from an opaque class schema', () => {
    const codec = OpaqueClassSchema;
    const value = { title: 'Example', entry: { author: { name: 'Ada' } } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe(
      `<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title><atom:entry><auth:author xmlns:auth="${AUTH}"><auth:name>Ada</auth:name></auth:author></atom:entry></atom:feed>`
    );
  });

  it('decodes a document from a class schema', () => {
    const codec = ClassSchema;
    const value = { title: 'Example', entry: { author: { name: 'Ada' } } };
    const text = Schema.decodeSync(codec)(
      `<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title><atom:entry><auth:author xmlns:auth="${AUTH}"><auth:name>Ada</auth:name></auth:author></atom:entry></atom:feed>`
    );
    expect(text).toEqual(value);
  });

  it('decodes a document from an opaque class schema', () => {
    const codec = OpaqueClassSchema;
    const value = { title: 'Example', entry: { author: { name: 'Ada' } } };
    const text = Schema.decodeSync(codec)(
      `<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title><atom:entry><auth:author xmlns:auth="${AUTH}"><auth:name>Ada</auth:name></auth:author></atom:entry></atom:feed>`
    );
    expect(text).toEqual(value);
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

  it('encodes and decodes with name mapping', () => {
    const codec = Schema.Struct({
      title: Schema.String,
      entry: Schema.Struct({
        author: Schema.Struct({ name: Schema.String.pipe(Schema.annotate({ xmlName: 'Name' })) }).annotate({ xmlNamespace: AUTH, xmlPrefix: 'auth' }),
      }),
    }).pipe(Schema.annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom', xmlName: 'feed' }), toCodecXml);
    const value = { title: 'Example', entry: { author: { name: 'Ada' } } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe(
      `<atom:feed xmlns:atom="${ATOM}"><atom:title>Example</atom:title><atom:entry><auth:author xmlns:auth="${AUTH}"><auth:Name>Ada</auth:Name></auth:author></atom:entry></atom:feed>`
    );
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('decodes a document whose prefix is not the one configured in the schema', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }), { rootName: 'feed' });
    expect(Schema.decodeSync(codec)(`<x:feed xmlns:x="${ATOM}"><x:title>Example</x:title></x:feed>`)).toEqual({ title: 'Example' });
  });

  it('maps names to their fields when each element binds the same URI to a different prefix', () => {
    const codec = toCodecXml(
      Schema.Struct({
        title: Schema.String,
        entry: Schema.Struct({ author: Schema.Struct({ name: Schema.String }).annotate({ xmlNamespace: AUTH, xmlPrefix: 'auth' }) }),
      }).annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }),
      { rootName: 'feed' }
    );
    const document = `<q:feed xmlns:q="${ATOM}"><q:title>Example</q:title><q:entry><z:author xmlns:z="${AUTH}"><z:name>Ada</z:name></z:author></q:entry></q:feed>`;
    expect(Schema.decodeSync(codec)(document)).toEqual({ title: 'Example', entry: { author: { name: 'Ada' } } });
  });

  it('maps a differently-prefixed child when the URI is bound on the root alone', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }).annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }), { rootName: 'feed' });
    // One prefix bound once, then used for both the root and its child, while the schema's own prefix is `atom`.
    expect(Schema.decodeSync(codec)(`<q:feed xmlns:q="${ATOM}"><q:title>Example</q:title></q:feed>`)).toEqual({ title: 'Example' });
  });

  it('maps a shared sub-schema whose URI arrives under a different prefix', () => {
    const Shared = Schema.Struct({ c: Schema.String }).annotate({ xmlNamespace: 'urn:shared', xmlPrefix: 's' });
    const codec = toCodecXml(Schema.Struct({ b: Shared, d: Shared }), { rootName: 'a' });
    const document = `<a><q:b xmlns:q="urn:shared"><q:c>text</q:c></q:b><r:d xmlns:r="urn:shared"><r:c>other text</r:c></r:d></a>`;
    expect(Schema.decodeSync(codec)(document)).toEqual({ b: { c: 'text' }, d: { c: 'other text' } });
  });

  it('maps a differently-prefixed namespaced attribute', () => {
    const codec = toCodecXml(Schema.Struct({ '@id': Schema.String.annotate({ xmlNamespace: 'urn:meta', xmlPrefix: 'meta' }), a: Schema.String }), {
      rootName: 'r',
    });
    expect(Schema.decodeSync(codec)(`<r xmlns:q="urn:meta" q:id="7"><a>x</a></r>`)).toEqual({ '@id': '7', a: 'x' });
  });

  it('maps a prefixed document to a schema whose namespace is the default', () => {
    const codec = toCodecXml(Schema.Struct({ c: Schema.String }).annotate({ xmlNamespace: 'urn:shared' }), { rootName: 'b' });
    expect(Schema.decodeSync(codec)(`<b xmlns:q="urn:shared"><q:c>text</q:c></b>`)).toEqual({ c: 'text' });
  });

  it('maps a default-namespaced document to a schema whose namespace is prefixed', () => {
    const codec = toCodecXml(Schema.Struct({ c: Schema.String }).annotate({ xmlNamespace: 'urn:shared', xmlPrefix: 's' }), { rootName: 'b' });
    expect(Schema.decodeSync(codec)(`<b xmlns="urn:shared"><c>text</c></b>`)).toEqual({ c: 'text' });
  });

  it('falls back to the local name when the URI does not match the schema', () => {
    // The plan keys a field by its local name, so an element whose URI differs from the annotated one still resolves by its
    // local name. This documents that the URI is what a matching prefix is checked against, and that it is not a rejection.
    const codec = toCodecXml(Schema.Struct({ author: Schema.Struct({ name: Schema.String }).annotate({ xmlNamespace: AUTH, xmlPrefix: 'auth' }) }), {
      rootName: 'feed',
    });
    expect(Schema.decodeSync(codec)(`<feed><q:author xmlns:q="urn:other"><q:name>Ada</q:name></q:author></feed>`)).toEqual({
      author: { name: 'Ada' },
    });
  });
});

describe('toCodecXml() - xmlName', () => {
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

  it('sets an element xmlName through annotateKey', () => {
    const codec = toCodecXml(Schema.Struct({ mimeType: Schema.String.pipe(Schema.annotateKey({ xmlName: 'mime-type' })) }), { rootName: 'r' });
    const text = Schema.encodeSync(codec)({ mimeType: 'text/plain' });
    expect(text).toBe('<r><mime-type>text/plain</mime-type></r>');
    expect(Schema.decodeSync(codec)(text)).toEqual({ mimeType: 'text/plain' });
  });

  it('sets an attribute xmlName through annotateKey', () => {
    const codec = toCodecXml(Schema.Struct({ '@mimeType': Schema.String.pipe(Schema.annotateKey({ xmlName: 'mime-type' })) }), { rootName: 'r' });
    const text = Schema.encodeSync(codec)({ '@mimeType': 'text/plain' });
    expect(text).toBe('<r mime-type="text/plain"/>');
    expect(Schema.decodeSync(codec)(text)).toEqual({ '@mimeType': 'text/plain' });
  });

  it('round-trips a renamed attribute and a renamed root', () => {
    const attribute = toCodecXml(Schema.Struct({ '@mimeType': Schema.String.annotate({ xmlName: 'mime-type' }) }), { rootName: 'r' });
    expect(Schema.decodeSync(attribute)('<r mime-type="text/plain"/>')).toEqual({ '@mimeType': 'text/plain' });

    const root = toCodecXml(Schema.Struct({ a: Schema.String }).annotate({ xmlName: 'feed' }));
    expect(Schema.decodeSync(root)('<feed><a>x</a></feed>')).toEqual({ a: 'x' });
  });

  it('wraps a renamed array element as a one-member array on decode', () => {
    const codec = toCodecXml(Schema.Struct({ items: Schema.Array(Schema.Struct({ v: Schema.String })).pipe(Schema.annotate({ xmlName: 'item' })) }), {
      rootName: 'r',
    });
    // The wire name is `item`, so a single occurrence is read as the one-member array the schema describes.
    expect(Schema.encodeSync(codec)({ items: [{ v: 'a' }] })).toBe('<r><item><v>a</v></item></r>');
    expect(Schema.decodeSync(codec)('<r><item><v>a</v></item></r>')).toEqual({ items: [{ v: 'a' }] });
    expect(Schema.decodeSync(codec)('<r><item><v>a</v></item><item><v>b</v></item></r>')).toEqual({ items: [{ v: 'a' }, { v: 'b' }] });
  });

  it('maps a renamed element whose namespace arrives under a different prefix', () => {
    const codec = toCodecXml(
      Schema.Struct({ payload: Schema.String.annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom', xmlName: 'Body' }) }).annotate({
        xmlNamespace: ATOM,
        xmlPrefix: 'atom',
      }),
      { rootName: 'feed' }
    );
    // The wire local name `Body` is what resolves, and it is resolved by the URI even though the prefix differs.
    expect(Schema.decodeSync(codec)(`<q:feed xmlns:q="${ATOM}"><q:Body>x</q:Body></q:feed>`)).toEqual({ payload: 'x' });
  });

  describe('with a namespace prefix mismatch', () => {
    const META = 'urn:meta';

    it('maps a renamed field and its renamed namespaced attribute under different prefixes', () => {
      const codec = toCodecXml(
        Schema.Struct({
          node: Schema.Struct({
            '@id': Schema.String.annotate({ xmlNamespace: META, xmlPrefix: 'meta', xmlName: 'ID' }),
            c: Schema.String.annotate({ xmlName: 'value' }),
          }).annotate({ xmlNamespace: 'urn:shared', xmlPrefix: 's', xmlName: 'node' }),
        }),
        { rootName: 'a' }
      );
      const value = { node: { '@id': '1', c: 'text' } };
      expect(Schema.encodeSync(codec)(value)).toBe(
        `<a><s:node xmlns:s="urn:shared" xmlns:meta="${META}" meta:ID="1"><s:value>text</s:value></s:node></a>`
      );
      // Both the renamed element (`b` vs `s`) and the renamed attribute (`m` vs `meta`) arrive under a different prefix.
      expect(Schema.decodeSync(codec)(`<a><b:node xmlns:b="urn:shared" xmlns:m="${META}" m:ID="1"><b:value>text</b:value></b:node></a>`)).toEqual(
        value
      );
    });

    it('maps a shared renamed sub-schema when each node binds the URI to a different prefix', () => {
      const Shared = Schema.Struct({
        '@id': Schema.String.annotate({ xmlNamespace: META, xmlPrefix: 'meta', xmlName: 'ID' }),
        c: Schema.String.annotate({ xmlName: 'value' }),
      }).annotate({ xmlNamespace: 'urn:shared', xmlPrefix: 's' });
      // The two nodes carry distinct wire names, because two siblings cannot share one local name under the same element.
      const codec = toCodecXml(Schema.Struct({ b: Shared.annotate({ xmlName: 'nodeB' }), d: Shared.annotate({ xmlName: 'nodeD' }) }), {
        rootName: 'a',
      });
      const value = { b: { '@id': '1', c: 'text' }, d: { '@id': '2', c: 'other text' } };
      expect(Schema.encodeSync(codec)(value)).toBe(
        `<a><s:nodeB xmlns:s="urn:shared" xmlns:meta="${META}" meta:ID="1"><s:value>text</s:value></s:nodeB>` +
          `<s:nodeD xmlns:s="urn:shared" xmlns:meta="${META}" meta:ID="2"><s:value>other text</s:value></s:nodeD></a>`
      );
      // `b` binds `urn:shared` to `q` and `urn:meta` to `m`; `d` binds them to `r` and `n`. Each renamed name resolves by URI.
      expect(
        Schema.decodeSync(codec)(
          `<a><q:nodeB xmlns:q="urn:shared" xmlns:m="${META}" m:ID="1"><q:value>text</q:value></q:nodeB>` +
            `<r:nodeD xmlns:r="urn:shared" xmlns:n="${META}" n:ID="2"><r:value>other text</r:value></r:nodeD></a>`
        )
      ).toEqual(value);
    });

    it('maps a renamed element when the schema binds the default namespace and the document a prefix', () => {
      const codec = toCodecXml(
        Schema.Struct({ payload: Schema.String.annotate({ xmlNamespace: ATOM, xmlName: 'Body' }) }).annotate({ xmlNamespace: ATOM }),
        { rootName: 'feed' }
      );
      expect(Schema.encodeSync(codec)({ payload: 'x' })).toBe(`<feed xmlns="${ATOM}"><Body>x</Body></feed>`);
      // The schema has no prefix (a default namespace); the document renames the element and binds the URI to `q`.
      expect(Schema.decodeSync(codec)(`<feed xmlns:q="${ATOM}"><q:Body>x</q:Body></feed>`)).toEqual({ payload: 'x' });
    });

    it('refuses two siblings renamed to the same xmlName', () => {
      // A local name resolves to one field under one element, so two siblings cannot share a wire name.
      const Shared = Schema.Struct({ c: Schema.String }).annotate({ xmlName: 'node' });
      expect(() => toCodecXml(Schema.Struct({ b: Shared, d: Shared }))).toThrow(/both resolve to "node" under the same element/);
    });
  });
});

describe('toCodecXml() - xmlAttribute', () => {
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

describe('toCodecXml() - elements with only attributes', () => {
  it('writes a nested element with one attribute as self-closing and reads it back', () => {
    const codec = toCodecXml(Schema.Struct({ item: Schema.Struct({ '@id': Schema.String }) }), { rootName: 'r' });
    const value = { item: { '@id': '1' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<r><item id="1"/></r>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes a nested element with several attributes as self-closing and reads it back', () => {
    const codec = toCodecXml(Schema.Struct({ item: Schema.Struct({ '@id': Schema.String, '@type': Schema.String, '@ref': Schema.String }) }), {
      rootName: 'r',
    });
    const value = { item: { '@id': '1', '@type': 'x', '@ref': 'y' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<r><item id="1" type="x" ref="y"/></r>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes a root element with only attributes as self-closing and reads it back', () => {
    const codec = toCodecXml(Schema.Struct({ '@id': Schema.String, '@type': Schema.String }), { rootName: 'r' });
    const value = { '@id': '1', '@type': 'x' };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<r id="1" type="x"/>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes an attribute-only element marked with xmlAttribute and reads it back', () => {
    const codec = toCodecXml(Schema.Struct({ item: Schema.Struct({ id: Schema.String.annotate({ xmlAttribute: true }) }) }), { rootName: 'r' });
    const value = { item: { id: '1' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<r><item id="1"/></r>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes a namespaced attribute-only element and reads it back', () => {
    const codec = toCodecXml(
      Schema.Struct({ item: Schema.Struct({ '@id': Schema.String }).annotate({ xmlNamespace: 'urn:items', xmlPrefix: 'i' }) }),
      { rootName: 'r' }
    );
    const value = { item: { '@id': '1' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<r><i:item xmlns:i="urn:items" id="1"/></r>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('writes a repeated attribute-only element and reads it back', () => {
    const codec = toCodecXml(Schema.Struct({ item: Schema.Array(Schema.Struct({ '@id': Schema.String })) }), { rootName: 'r' });
    const value = { item: [{ '@id': '1' }, { '@id': '2' }] };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe('<r><item id="1"/><item id="2"/></r>');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });
});

describe('toCodecXml() - xmlValue', () => {
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

describe('toCodecXml() - plain values with attributes', () => {
  it('reads a plain string from an element that also carries attributes, discarding them', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }), { rootName: 'book' });
    expect(Schema.decodeSync(codec)('<book><title lang="en">Dune</title></book>')).toEqual({ title: 'Dune' });
  });

  it('reads a plain number from an element that also carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ weight: Schema.Number }), { rootName: 'item' });
    expect(Schema.decodeSync(codec)('<item><weight unit="kg">1.5</weight></item>')).toEqual({ weight: 1.5 });
  });

  it('reads every member of a repeated plain field that carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ tag: Schema.Array(Schema.String) }), { rootName: 'book' });
    expect(Schema.decodeSync(codec)('<book><tag id="1">a</tag><tag id="2">b</tag></book>')).toEqual({ tag: ['a', 'b'] });
  });

  it('reads a plain value through a nullable field that carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.NullOr(Schema.String) }), { rootName: 'book' });
    expect(Schema.decodeSync(codec)('<book><title lang="en">Dune</title></book>')).toEqual({ title: 'Dune' });
  });

  it('keeps the attributes a struct schema declares', () => {
    const codec = toCodecXml(Schema.Struct({ '@href': Schema.String, '#text': Schema.String }), { rootName: 'a' });
    expect(Schema.decodeSync(codec)('<a href="/a">link</a>')).toEqual({ '@href': '/a', '#text': 'link' });
  });

  it('fails when a plain value element also carries a child element', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }), { rootName: 'book' });
    const exit = Effect.runSyncExit(Schema.decodeEffect(codec)('<book><title lang="en">Dune<subtitle>Messiah</subtitle></title></book>'));
    expect(Exit.isSuccess(exit)).toBe(false);
  });

  it('fails when a plain value element carries only children', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String }), { rootName: 'book' });
    const exit = Effect.runSyncExit(Schema.decodeEffect(codec)('<book><title><subtitle>Messiah</subtitle></title></book>'));
    expect(Exit.isSuccess(exit)).toBe(false);
  });
});

describe('toCodecXml() - plain values with attributes and annotations', () => {
  const ATOM = 'http://www.w3.org/2005/Atom';

  it('reads a plain value renamed with xmlName while dropping its attributes', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String.annotate({ xmlName: 'Title' }) }), { rootName: 'book' });
    expect(Schema.decodeSync(codec)('<book><Title lang="en">Dune</Title></book>')).toEqual({ title: 'Dune' });
  });

  it('reads a namespaced plain value while dropping its element attributes', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String.annotate({ xmlNamespace: ATOM, xmlPrefix: 'atom' }) }), { rootName: 'feed' });
    expect(Schema.decodeSync(codec)(`<feed xmlns:atom="${ATOM}"><atom:title lang="en">Dune</atom:title></feed>`)).toEqual({ title: 'Dune' });
  });

  it('reads a namespaced plain value set through annotateKey while dropping its attributes', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String.pipe(Schema.annotateKey({ xmlNamespace: ATOM, xmlPrefix: 'atom' })) }), {
      rootName: 'feed',
    });
    expect(Schema.decodeSync(codec)(`<feed xmlns:atom="${ATOM}"><atom:title lang="en">Dune</atom:title></feed>`)).toEqual({ title: 'Dune' });
  });

  it('keeps an attribute marked with xmlAttribute beside a plain value that drops its own', () => {
    const codec = toCodecXml(Schema.Struct({ id: Schema.String.annotate({ xmlAttribute: true }), title: Schema.String }), { rootName: 'book' });
    expect(Schema.decodeSync(codec)('<book id="1"><title lang="en">Dune</title></book>')).toEqual({ id: '1', title: 'Dune' });
  });

  it('fails when a plain value renamed with xmlName also carries a child element', () => {
    const codec = toCodecXml(Schema.Struct({ title: Schema.String.annotate({ xmlName: 'Title' }) }), { rootName: 'book' });
    const exit = Effect.runSyncExit(Schema.decodeEffect(codec)('<book><Title lang="en">Dune<subtitle>Messiah</subtitle></Title></book>'));
    expect(Exit.isSuccess(exit)).toBe(false);
  });
});

describe('toCodecXml() - plain values with attributes and literals', () => {
  it('reads a literal from an element that also carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ status: Schema.Literal('ok') }), { rootName: 'r' });
    expect(Schema.decodeSync(codec)('<r><status code="200">ok</status></r>')).toEqual({ status: 'ok' });
  });

  it('reads Schema.Literals from an element that also carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ status: Schema.Literals(['ok', 'warn', 'error']) }), { rootName: 'r' });
    expect(Schema.decodeSync(codec)('<r><status code="200">ok</status></r>')).toEqual({ status: 'ok' });
  });

  it('reads numeric literals from an element that also carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ code: Schema.Literals([200, 404, 500]) }), { rootName: 'r' });
    expect(Schema.decodeSync(codec)('<r><code scope="http">404</code></r>')).toEqual({ code: 404 });
  });

  it('reads boolean literals from an element that also carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ active: Schema.Literals([true, false]) }), { rootName: 'r' });
    expect(Schema.decodeSync(codec)('<r><active kind="flag">false</active></r>')).toEqual({ active: false });
  });

  it('reads a mixed-kind literal union from an element that also carries attributes', () => {
    const codec = toCodecXml(Schema.Struct({ flag: Schema.Literals(['on', 'off', true, false]) }), { rootName: 'r' });
    expect(Schema.decodeSync(codec)('<r><flag kind="switch">true</flag></r>')).toEqual({ flag: true });
  });

  it('fails when a Schema.Literals element also carries a child element', () => {
    const codec = toCodecXml(Schema.Struct({ status: Schema.Literals(['ok', 'warn']) }), { rootName: 'r' });
    const exit = Effect.runSyncExit(Schema.decodeEffect(codec)('<r><status code="200">ok<why>x</why></status></r>'));
    expect(Exit.isSuccess(exit)).toBe(false);
  });
});

describe('toCodecXml() - plain values read through structures', () => {
  it('reads a struct with a value field from an element reduced to bare character data', () => {
    const codec = toCodecXml(
      Schema.Struct({
        price: Schema.Struct({
          amount: Schema.Number.annotate({ xmlValue: true }),
          currency: Schema.String.pipe(Schema.annotate({ xmlAttribute: true, xmlName: 'currency' }), Schema.optional),
        }),
      }),
      { rootName: 'r' }
    );
    expect(Schema.decodeSync(codec)('<r><price>1.5</price></r>')).toEqual({ price: { amount: 1.5 } });
  });

  it('reads a plain value from a field inside a union member', () => {
    const allowance = Schema.Struct({ kind: Schema.Literal('allowance'), id: Schema.Literals(['x', 'y']) });
    const charge = Schema.Struct({ kind: Schema.Literal('charge'), id: Schema.Literals(['x', 'y']) });
    const codec = toCodecXml(Schema.Struct({ item: Schema.Union([allowance, charge], { mode: 'oneOf' }) }), { rootName: 'r' });
    expect(Schema.decodeSync(codec)('<r><item><kind>allowance</kind><id schemeID="c">x</id></item></r>')).toEqual({
      item: { kind: 'allowance', id: 'x' },
    });
  });

  it('reads a plain value from each member of an optional repeated field', () => {
    const codec = toCodecXml(Schema.Struct({ tag: Schema.Array(Schema.Literals(['x', 'y'])).pipe(Schema.optional) }), { rootName: 'r' });
    expect(Schema.decodeSync(codec)('<r><tag schemeID="c">x</tag><tag schemeID="c">y</tag></r>')).toEqual({ tag: ['x', 'y'] });
  });
});

describe('toCodecXml() - failures', () => {
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
