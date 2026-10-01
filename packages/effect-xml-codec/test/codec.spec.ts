/**
 * @description Specs for `toCodecXml`: that it is Effect's `Schema.toCodecStringTree` derivation under this package's name, that the returned value is a `Schema`
 * and composes like `Schema.toCodecJson`, and that it pairs with `renderXml` and `parseXml` for the text layer.
 */

import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { XmlValue } from '#/index.ts';

import { parseXmlDocument, renderXml, toCodecXml, XmlParseError } from '#/index.ts';

/**
 * @description A codec of any shape, for a table of cases that do not share one schema. `unknown` in both type positions rather than `any`, which keeps the cases
 * honest: a case's value is only ever passed in and compared against what comes back out, so nothing here needs the schema's type to be known.
 */
type AnyCodec = Schema.ConstraintCodec<unknown, unknown>;

describe('toCodecXml() — the derivation', () => {
  it('is Effect’s toCodecStringTree derivation, unchanged', () => {
    const schema = Schema.Struct({ '@id': Schema.String, title: Schema.String, pages: Schema.Number });
    expect(toCodecXml(schema).ast).toBe(Schema.toCodecStringTree(schema).ast);
  });

  it('returns a Schema, so the whole Schema surface applies', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }));
    expect(Schema.encodeSync(codec)({ a: 'x' })).toEqual({ a: 'x' });
    expect(Schema.decodeSync(codec)({ a: 'x' })).toEqual({ a: 'x' });
    expect(Effect.runSync(Schema.encodeEffect(codec)({ a: 'x' }))).toEqual({ a: 'x' });
  });

  it('lowers every scalar to its text form in the encoded value', () => {
    const codec = toCodecXml(Schema.Struct({ s: Schema.String, n: Schema.Number, b: Schema.Boolean, l: Schema.Literal('lit') }));
    expect(Schema.encodeSync(codec)({ s: 'text', n: 1.5, b: false, l: 'lit' })).toEqual({ s: 'text', n: '1.5', b: 'false', l: 'lit' });
  });
});

describe('toCodecXml() — with the text layer', () => {
  const Book = Schema.Struct({ '@id': Schema.String, '@xmlns': Schema.String, title: Schema.String, tag: Schema.Array(Schema.String) });
  const value = { '@id': '1', '@xmlns': 'urn:books', title: 'Dune', tag: ['sci-fi', 'classic'] };
  const codec = toCodecXml(Book);
  const text = '<book id="1" xmlns="urn:books"><title>Dune</title><tag>sci-fi</tag><tag>classic</tag></book>';

  it('renders the encoded value as a document under the root name the caller gives', () => {
    expect(renderXml(Schema.encodeSync(codec)(value), { rootName: 'book' })).toBe(text);
  });

  it('parses a document into the value tree and decodes it', () => {
    expect(Schema.decodeSync(codec)(parseXmlDocument(text).value)).toEqual(value);
  });

  it('round-trips a value through text', () => {
    expect(Schema.decodeSync(codec)(parseXmlDocument(renderXml(Schema.encodeSync(codec)(value), { rootName: 'book' })).value)).toEqual(value);
  });

  it('keeps an @-prefixed key as an attribute and #text as character data', () => {
    const Anchor = Schema.Struct({ '@href': Schema.String, '#text': Schema.String });
    const anchor = toCodecXml(Anchor);
    const anchorValue = { '@href': '/a', '#text': 'link' };
    const anchorText = renderXml(Schema.encodeSync(anchor)(anchorValue), { rootName: 'a' });
    expect(anchorText).toBe('<a href="/a">link</a>');
    expect(Schema.decodeSync(anchor)(parseXmlDocument(anchorText).value)).toEqual(anchorValue);
  });
});

describe('toCodecXml() — schema shapes through the text layer', () => {
  const roundTrip = (schema: AnyCodec, value: unknown): unknown => {
    const codec = toCodecXml(schema);
    return Schema.decodeSync(codec)(parseXmlDocument(renderXml(Schema.encodeSync(codec)(value) as XmlValue, { rootName: 'r' })).value);
  };

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

describe('toCodecXml() — failures', () => {
  it('throws a typed parse error from a malformed document', () => {
    expect(() => parseXmlDocument('<r><a>x</r>').value).toThrow(XmlParseError);
  });

  it('reports a schema mismatch as a failure, not as a parse error', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Number }));
    const exit = Effect.runSyncExit(Schema.decodeUnknownEffect(codec)(parseXmlDocument('<r><a>not a number</a></r>').value));
    expect(Exit.isSuccess(exit)).toBe(false);
  });

  it('refuses a name it cannot spell when the render is in error mode', () => {
    expect(() => renderXml({ 'not a name': 'x' }, { rootName: 'r', name: 'error' })).toThrow(/Invalid XML name/);
  });

  it('repairs a name it cannot spell by default', () => {
    expect(renderXml({ 'not a name': 'x' }, { rootName: 'r' })).toBe('<r><not_a_name>x</not_a_name></r>');
  });
});
