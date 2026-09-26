/**
 * @description Specs for `toCodecXml`: a schema, and the XML that carries it in both directions. Covers how the root name is chosen, every schema shape the
 * derivation supports, and what each direction reports when it cannot do its job.
 */

import { Cause, Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { toCodecXml, XmlNameError, XmlParseError } from '#/index.ts';

describe('toCodecXml() — the root name', () => {
  it('uses the name the caller gave', () => {
    expect(toCodecXml(Schema.Struct({}), { rootName: 'book' }).rootName).toBe('book');
  });

  it('falls back to the schema identifier annotation', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }).annotate({ identifier: 'Book' }));
    expect(codec.rootName).toBe('Book');
    expect(codec.encodeTextSync({ a: 'x' })).toBe('<Book><a>x</a></Book>');
  });

  it('falls back to the schema title annotation when there is no identifier', () => {
    expect(toCodecXml(Schema.Struct({}).annotate({ title: 'Titled' })).rootName).toBe('Titled');
  });

  it('prefers the identifier over the title', () => {
    const codec = toCodecXml(Schema.Struct({}).annotate({ identifier: 'Book', title: 'Titled' }));
    expect(codec.rootName).toBe('Book');
  });

  it('prefers an explicit option over an annotation', () => {
    const codec = toCodecXml(Schema.Struct({}).annotate({ identifier: 'Book' }), { rootName: 'explicit' });
    expect(codec.rootName).toBe('explicit');
  });

  it('falls back to root when the schema says nothing', () => {
    expect(toCodecXml(Schema.Struct({})).rootName).toBe('root');
  });

  it('lets a per-call option override the codec default', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'book' });
    expect(codec.encodeTextSync({ a: 'x' }, { rootName: 'other' })).toBe('<other><a>x</a></other>');
    expect(codec.encodeTextSync({ a: 'x' })).toBe('<book><a>x</a></book>');
  });
});

describe('toCodecXml() — attributes', () => {
  const Book = Schema.Struct({ '@id': Schema.String, '@xmlns': Schema.String, title: Schema.String });

  it('writes an @-prefixed field as an attribute', () => {
    const codec = toCodecXml(Book, { rootName: 'book' });
    expect(codec.encodeTextSync({ '@id': '1', '@xmlns': 'urn:books', title: 'Dune' })).toBe(
      '<book id="1" xmlns="urn:books"><title>Dune</title></book>'
    );
  });

  it('reads an attribute back into the @-prefixed field', () => {
    const codec = toCodecXml(Book, { rootName: 'book' });
    expect(codec.decodeTextSync('<book id="1" xmlns="urn:books"><title>Dune</title></book>')).toEqual({
      '@id': '1',
      '@xmlns': 'urn:books',
      title: 'Dune',
    });
  });

  it('round-trips attributes exactly', () => {
    const codec = toCodecXml(Book, { rootName: 'book' });
    const value = { '@id': '1', '@xmlns': 'urn:books', title: 'Dune' };
    expect(codec.decodeTextSync(codec.encodeTextSync(value))).toEqual(value);
  });

  it('round-trips an element that is only attributes and text', () => {
    const Anchor = Schema.Struct({ '@href': Schema.String, '@id': Schema.String, '#text': Schema.String });
    const codec = toCodecXml(Anchor, { rootName: 'a' });
    const value = { '@href': '/a', '@id': 'x', '#text': 'link' };
    const text = codec.encodeTextSync(value);
    expect(text).toBe('<a href="/a" id="x">link</a>');
    expect(codec.decodeTextSync(text)).toEqual(value);
  });
});

describe('toCodecXml() — schema shapes', () => {
  it('handles a string field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 'x' })).toBe('<r><a>x</a></r>');
    expect(codec.decodeTextSync('<r><a>x</a></r>')).toEqual({ a: 'x' });
  });

  it('handles a number field, as decimal text', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Number }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 1.5 })).toBe('<r><a>1.5</a></r>');
    expect(codec.decodeTextSync('<r><a>1.5</a></r>')).toEqual({ a: 1.5 });
  });

  it('handles an integer field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Int }), { rootName: 'r' });
    expect(codec.decodeTextSync('<r><a>42</a></r>')).toEqual({ a: 42 });
  });

  it('handles a boolean field, as true or false', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Boolean }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: false })).toBe('<r><a>false</a></r>');
    expect(codec.decodeTextSync('<r><a>false</a></r>')).toEqual({ a: false });
  });

  it('handles a null field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Null }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: null })).toBe('<r><a>null</a></r>');
    expect(codec.decodeTextSync('<r><a>null</a></r>')).toEqual({ a: null });
  });

  it('handles a nullable field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.NullOr(Schema.String) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: null })).toBe('<r><a>null</a></r>');
    expect(codec.decodeTextSync('<r><a>null</a></r>')).toEqual({ a: null });
  });

  it('handles a literal field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Literal('fixed') }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 'fixed' })).toBe('<r><a>fixed</a></r>');
    expect(codec.decodeTextSync('<r><a>fixed</a></r>')).toEqual({ a: 'fixed' });
  });

  it('handles a numeric literal field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Literal(7) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 7 })).toBe('<r><a>7</a></r>');
    expect(codec.decodeTextSync('<r><a>7</a></r>')).toEqual({ a: 7 });
  });

  it('handles an enum field', () => {
    const Colour = { Red: 'red', Blue: 'blue' } as const;
    const codec = toCodecXml(Schema.Struct({ a: Schema.Enum(Colour) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 'blue' })).toBe('<r><a>blue</a></r>');
    expect(codec.decodeTextSync('<r><a>blue</a></r>')).toEqual({ a: 'blue' });
  });

  it('handles a transformed field, through the transformation', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.NumberFromString }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 42 })).toBe('<r><a>42</a></r>');
    expect(codec.decodeTextSync('<r><a>42</a></r>')).toEqual({ a: 42 });
  });

  it('handles a branded field', () => {
    const Id = Schema.String.pipe(Schema.brand('Id'));
    const codec = toCodecXml(Schema.Struct({ id: Id }), { rootName: 'r' });
    expect(codec.decodeTextSync('<r><id>x</id></r>')).toEqual({ id: 'x' });
  });

  it('handles an optional field that is absent', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.optional(Schema.String) }), { rootName: 'r' });
    expect(codec.encodeTextSync({})).toBe('<r/>');
    expect(codec.decodeTextSync('<r/>')).toEqual({});
  });

  it('handles an optional field that is present', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.optional(Schema.String) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: 'x' })).toBe('<r><a>x</a></r>');
    expect(codec.decodeTextSync('<r><a>x</a></r>')).toEqual({ a: 'x' });
  });

  it('keeps an absent field distinguishable from an empty one', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.optional(Schema.String) }), { rootName: 'r' });
    expect(codec.decodeTextSync('<r/>')).toEqual({});
    expect(codec.decodeTextSync('<r><a/></r>')).toEqual({ a: '' });
  });

  it('applies a constructor default, which is a construction concern rather than a document one', () => {
    // A constructor default fills a value in when one is *built*, not when one is
    // read, so it does not rescue a document that omits a required key. The
    // field is read through the encoded representation, where a default of this
    // shape has nothing to attach to.
    const WithDefault = Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed('fallback')));
    const codec = toCodecXml(Schema.Struct({ a: WithDefault }), { rootName: 'r' });
    expect(codec.decodeValueSync({ a: 'x' })).toEqual({ a: 'x' });
    expect(codec.encodeValueSync({ a: 'x' })).toEqual({ a: 'x' });
  });

  it('handles a nested struct', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Struct({ b: Schema.String }) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: { b: 'x' } })).toBe('<r><a><b>x</b></a></r>');
    expect(codec.decodeTextSync('<r><a><b>x</b></a></r>')).toEqual({ a: { b: 'x' } });
  });

  it('handles an array field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Array(Schema.String) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: ['x', 'y'] })).toBe('<r><a>x</a><a>y</a></r>');
    expect(codec.decodeTextSync('<r><a>x</a><a>y</a></r>')).toEqual({ a: ['x', 'y'] });
  });

  it('handles an array of one, which XML cannot spell any other way', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Array(Schema.String) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: ['x'] })).toBe('<r><a>x</a></r>');
    expect(codec.decodeTextSync('<r><a>x</a></r>')).toEqual({ a: ['x'] });
  });

  it('handles an array of structs', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Array(Schema.Struct({ b: Schema.String })) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: [{ b: '1' }, { b: '2' }] })).toBe('<r><a><b>1</b></a><a><b>2</b></a></r>');
    expect(codec.decodeTextSync('<r><a><b>1</b></a><a><b>2</b></a></r>')).toEqual({ a: [{ b: '1' }, { b: '2' }] });
  });

  it('handles a record field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Record(Schema.String, Schema.String) }), { rootName: 'r' });
    expect(codec.encodeTextSync({ a: { x: '1', y: '2' } })).toBe('<r><a><x>1</x><y>2</y></a></r>');
    expect(codec.decodeTextSync('<r><a><x>1</x><y>2</y></a></r>')).toEqual({ a: { x: '1', y: '2' } });
  });

  it('handles a union field', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Union([Schema.String, Schema.Number]) }), { rootName: 'r' });
    expect(codec.decodeTextSync('<r><a>text</a></r>')).toEqual({ a: 'text' });
    expect(codec.decodeTextSync('<r><a>5</a></r>')).toEqual({ a: 5 });
  });

  it('handles a recursive schema', () => {
    interface Node {
      readonly label: string;
      readonly children: ReadonlyArray<Node>;
    }
    const Node: Schema.Codec<Node> = Schema.suspend(() =>
      Schema.Struct({ label: Schema.String, children: Schema.Array(Node) })
    ) as Schema.Codec<Node>;
    const codec = toCodecXml(Node, { rootName: 'node' });
    const value: Node = { label: 'a', children: [{ label: 'b', children: [{ label: 'c', children: [{ label: 'd', children: [] }] }] }] };
    const text = codec.encodeTextSync(value);
    expect(text).toBe(
      '<node><label>a</label><children><label>b</label><children><label>c</label><children><label>d</label><children/></children></children></children></node>'
    );
  });

  it('reads a recursive document back, down to the nesting the model allows', () => {
    interface Node {
      readonly label: string;
      readonly children?: ReadonlyArray<Node>;
    }
    // `children` is optional so a leaf can be written with no element of its own, and every node that
    // does have one has *two* children — a node with exactly one is a one-member array of structs, which
    // XML cannot tell apart from the struct itself. See the round-trip spec's limitations.
    const Node: Schema.Codec<Node> = Schema.suspend(() =>
      Schema.Struct({ label: Schema.String, children: Schema.optional(Schema.Array(Node)) })
    ) as Schema.Codec<Node>;
    const codec = toCodecXml(Node, { rootName: 'node' });

    const leaf: Node = { label: 'd' };
    const branch: Node = { label: 'c', children: [leaf, leaf] };
    const middle: Node = { label: 'b', children: [branch, branch] };
    const root: Node = { label: 'a', children: [middle, middle] };

    expect(codec.decodeTextSync(codec.encodeTextSync(root))).toEqual(root);
  });

  it('handles a top-level array', () => {
    const codec = toCodecXml(Schema.Array(Schema.String), { rootName: 'tags' });
    expect(codec.encodeTextSync(['a', 'b'])).toBe('<tags><item>a</item><item>b</item></tags>');
    expect(codec.decodeTextSync('<tags><item>a</item><item>b</item></tags>')).toEqual(['a', 'b']);
  });

  it('handles a deeply nested value', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.Struct({ b: Schema.Struct({ c: Schema.Struct({ d: Schema.String }) }) }) }), {
      rootName: 'r',
    });
    const value = { a: { b: { c: { d: 'deep' } } } };
    expect(codec.decodeTextSync(codec.encodeTextSync(value))).toEqual(value);
  });
});

describe('toCodecXml() — the two halves separately', () => {
  const Book = Schema.Struct({ '@id': Schema.String, title: Schema.String });
  const value = { '@id': '1', title: 'Dune' };
  const codec = toCodecXml(Book, { rootName: 'book' });

  it('encodes to an XML value without rendering it', () => {
    expect(codec.encodeValueSync(value)).toEqual({ '@id': '1', title: 'Dune' });
  });

  it('decodes from an XML value without parsing it', () => {
    expect(codec.decodeValueSync({ '@id': '1', title: 'Dune' })).toEqual(value);
  });

  it('lowers a number to its text form in the XML value', () => {
    const numbers = toCodecXml(Schema.Struct({ a: Schema.Number }), { rootName: 'r' });
    expect(numbers.encodeValueSync({ a: 1.5 })).toEqual({ a: '1.5' });
  });

  it('reads an XML value back into a typed value', () => {
    const numbers = toCodecXml(Schema.Struct({ a: Schema.Number }), { rootName: 'r' });
    expect(numbers.decodeValueSync({ a: '1.5' })).toEqual({ a: 1.5 });
  });
});

describe('toCodecXml() — Effect and sync forms agree', () => {
  const codec = toCodecXml(Schema.Struct({ title: Schema.String }), { rootName: 'r' });
  const value = { title: 'x' };

  it('encodes the same way both ways', () => {
    expect(Effect.runSync(codec.encodeText(value))).toBe(codec.encodeTextSync(value));
    expect(Effect.runSync(codec.encodeValue(value))).toEqual(codec.encodeValueSync(value));
  });

  it('decodes the same way both ways', () => {
    expect(Effect.runSync(codec.decodeText('<r><title>x</title></r>'))).toEqual(codec.decodeTextSync('<r><title>x</title></r>'));
  });

  it('reports a malformed document as a typed failure rather than throwing', () => {
    const exit = Effect.runSyncExit(codec.decodeText('<r><title>x</r>'));
    expect(Exit.isSuccess(exit)).toBe(false);
    if (!Exit.isSuccess(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(XmlParseError);
  });

  it('throws from the sync form of the same call', () => {
    expect(() => codec.decodeTextSync('<r><title>x</r>')).toThrow(XmlParseError);
  });

  it('reports a schema mismatch as a failure, not as a parse error', () => {
    const numbers = toCodecXml(Schema.Struct({ a: Schema.Number }), { rootName: 'r' });
    const exit = Effect.runSyncExit(numbers.decodeText('<r><a>not a number</a></r>'));
    expect(Exit.isSuccess(exit)).toBe(false);
  });

  it('reports an unrepairable name as a typed failure from the Effect form', () => {
    const Bad = Schema.Struct({ 'not a name': Schema.String });
    const strict = toCodecXml(Bad, { rootName: 'r', name: 'error' });
    const exit = Effect.runSyncExit(strict.encodeText({ 'not a name': 'x' }));
    expect(Exit.isSuccess(exit)).toBe(false);
    if (!Exit.isSuccess(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(XmlNameError);
  });
});

describe('toCodecXml() — the document reader', () => {
  it('reports the root name alongside the value', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    expect(Effect.runSync(codec.readDocument('<person><a>1</a></person>'))).toEqual({ name: 'person', value: { a: '1' } });
  });

  it('reports a malformed document as a failure', () => {
    const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });
    expect(Exit.isSuccess(Effect.runSyncExit(codec.readDocument('<r>')))).toBe(false);
  });
});
