// The codec: a schema, and the XML in both directions.
//
// `toCodecXml` is the package's entry point. It pairs Effect's own
// `Schema.toCodecStringTree` derivation — which is what makes every schema
// feature Effect supports (structs, arrays, unions, records, recursion,
// refinements, branded types) work here without this package re-implementing
// the walk over a schema AST — with the XML conventions, the renderer and the
// parser from the rest of the package.
//
// On the choice of derivation: Effect's own `Schema.toEncoderXml` encodes
// through `toCodecStringTree` and stops there, so this is the same foundation
// Effect chose. What is added is the other direction, the attributes the `@`
// convention carries, and a parser, none of which Effect has.

import { Effect, Schema, SchemaAST } from 'effect';

import type { XmlDocument, XmlParseOptions } from './parse.ts';
import type { XmlRenderOptions } from './render.ts';
import type { XmlValue } from './xml-value.ts';

import { DEFAULT_ROOT_NAME } from './conventions.ts';
import { XmlNameError, XmlParseError } from './errors.ts';
import { parseXmlDocument } from './parse.ts';
import { renderXml } from './render.ts';
import { isXmlRecord } from './xml-value.ts';

/**
 * @description A schema that needs nothing from the environment to encode or decode. `Schema.toCodecStringTree` carries the source schema's service requirements
 * through unchanged, and Effect's synchronous parse and encode entry points accept only schemas whose requirements are `never` — a synchronous
 * serializer is meaningless if it may need a service to finish. Narrowing the schema parameter to this intersection states that in the type, so a
 * schema that does need a service is rejected at the call rather than throwing at runtime.
 *
 * @typeParam S - The schema being narrowed.
 */
export type ServiceFree<S extends Schema.Constraint> = S & Schema.ConstraintCodec<S['Type'], S['Encoded'], never, never>;
/**
 * @description Options every direction of a codec accepts.
 */
export interface XmlCodecOptions {
  /**
   * @description Name of the root element, overriding the one taken from the schema's `identifier` or `title` annotation. Ignored when the schema has neither, in
   * which case the document is written as `root`.
   */
  readonly rootName?: string | undefined;

  /**
   * @description Element name for the members of a document whose root value is an array. Defaults to `'item'`.
   */
  readonly itemName?: string | undefined;

  /**
   * @description Indent nested elements on their own lines. Defaults to `false`.
   */
  readonly format?: boolean | undefined;

  /**
   * @description The string one indent level is made of. Defaults to two spaces.
   */
  readonly indent?: string | undefined;

  /**
   * @description Write an element with no content as `<a/>` rather than `<a></a>`. Defaults to `true`.
   */
  readonly suppressEmptyNode?: boolean | undefined;

  /**
   * @description Sort keys so the same value always renders to the same bytes. Defaults to `false`, which keeps declaration order.
   */
  readonly sortKeys?: boolean | undefined;

  /**
   * @description Accept a bare value where the schema expects an array of one. Defaults to `true`. XML has no way to say "an array with one member": one
   * `<tag>value</tag>` and an array of one both render as `<tag>value</tag>`. Without this, a field holding a single-element array writes fine and
   * then cannot be read back, which is the one failure a round trip cannot recover from. Turning it off makes the codec stricter — an array field
   * then insists on reading a real array, which only a document written by a different encoder provides.
   */
  readonly arrayFromSingle?: boolean | undefined;

  /**
   * @description What to do with a name that is not a legal XML name. Defaults to `'repair'`.
   */
  readonly name?: 'error' | 'ignore' | 'repair' | undefined;

  /**
   * @description XML version to validate names against. Defaults to `'1.0'`.
   */
  readonly xmlVersion?: '1.0' | '1.1' | undefined;

  /**
   * @description How deep to nest before giving up, in both directions. Defaults to 256.
   */
  readonly maxDepth?: number | undefined;

  /**
   * @description Keep the whitespace at the edges of every text run when reading. Defaults to `false`, which trims it, so a document laid out on several lines
   * reads as the same value as one that was not. Set it to `true` to keep leading and trailing spaces in text exactly as written.
   */
  readonly preserveWhitespace?: boolean | undefined;
}

/**
 * @description A schema paired with the XML that carries it, in both directions. The four text methods are the ones an application that serializes usually wants:
 * {@link encodeText} and {@link decodeText} speak XML documents, and {@link encodeValue} and {@link decodeValue} speak {@link XmlValue} for when the
 * document is stored somewhere else and the parse or the render would be wasted. Every one of them has a `…Sync` form, because serialization sits on
 * hot paths where an `Effect` allocation per value is the dominant cost.
 *
 * @example
 *   ```typescript
 *   import { Schema } from 'effect';
 *   import { toCodecXml } from '@endevops/effect-xml-codec';
 *
 *   const Book = Schema.Struct({
 *     '@id': Schema.String,
 *     title: Schema.String,
 *     pages: Schema.Number,
 *     tag: Schema.Array(Schema.String),
 *   });
 *
 *   const book = toCodecXml(Book);
 *
 *   book.encodeTextSync({ '@id': '1', title: 'Dune', pages: 412, tag: ['sci-fi'] });
 *   // => '<root id="1"><title>Dune</title><pages>412</pages><tag>sci-fi</tag></root>'
 *
 *   book.decodeTextSync('<root id="1"><title>Dune</title><pages>412</pages><tag>sci-fi</tag></root>');
 *   // => { '@id': '1', title: 'Dune', pages: 412, tag: ['sci-fi'] }
 *   ```;
 */
export interface XmlCodec<S extends Schema.Constraint, A> {
  /**
   * @description The schema this codec was built from.
   */
  readonly schema: S;

  /**
   * @description The name the root element is written with, taken from `options.rootName`, else the schema's `identifier` or `title` annotation, else `'root'`.
   * Reporting it matters because a document's root name is the one part of it a codec cannot recover by itself.
   */
  readonly rootName: string;

  /**
   * @description Turns a typed value into the XML value that carries it, without rendering it to text.
   *
   * @param value - The value to encode.
   *
   * @returns The value as an {@link XmlValue}.
   */
  readonly encodeValue: (value: A) => Effect.Effect<XmlValue, Schema.SchemaError, S['EncodingServices']>;

  /**
   * @description Turns a typed value into the XML value that carries it, throwing on failure.
   *
   * @param value - The value to encode.
   *
   * @returns The value as an {@link XmlValue}.
   */
  readonly encodeValueSync: (value: A) => XmlValue;

  /**
   * @description Turns an {@link XmlValue} into a typed value, without parsing it from text.
   *
   * @param xml - The XML value to decode.
   *
   * @returns The decoded value.
   */
  readonly decodeValue: (xml: unknown) => Effect.Effect<A, Schema.SchemaError, S['DecodingServices']>;

  /**
   * @description Turns an {@link XmlValue} into a typed value, throwing on failure.
   *
   * @param xml - The XML value to decode.
   *
   * @returns The decoded value.
   */
  readonly decodeValueSync: (xml: unknown) => A;

  /**
   * @description Serializes a typed value to an XML document.
   *
   * @param value - The value to serialize.
   * @param options - Overrides for this call only.
   *
   * @returns The document as a string.
   */
  readonly encodeText: (value: A, options?: XmlRenderOptions) => Effect.Effect<string, XmlNameError, S['EncodingServices']>;

  /**
   * @description Serializes a typed value to an XML document, throwing on failure.
   *
   * @param value - The value to serialize.
   * @param options - Overrides for this call only.
   *
   * @returns The document as a string.
   */
  readonly encodeTextSync: (value: A, options?: XmlRenderOptions) => string;

  /**
   * @description Reads a typed value out of an XML document.
   *
   * @param text - The document to read.
   * @param options - Overrides for this call only.
   *
   * @returns The decoded value.
   */
  readonly decodeText: (text: string, options?: XmlParseOptions) => Effect.Effect<A, XmlParseError | Schema.SchemaError, S['DecodingServices']>;

  /**
   * @description Reads a typed value out of an XML document, throwing on failure.
   *
   * @param text - The document to read.
   * @param options - Overrides for this call only.
   *
   * @returns The decoded value.
   */
  readonly decodeTextSync: (text: string, options?: XmlParseOptions) => A;

  /**
   * @description Reads an XML document, keeping its root element's name. Useful when a caller has to check a document names what it claims to.
   *
   * @param text - The document to read.
   * @param options - Overrides for this call only.
   *
   * @returns The root element's name and content.
   */
  readonly readDocument: (text: string, options?: XmlParseOptions) => Effect.Effect<XmlDocument, XmlParseError>;
}

/**
 * @description Builds a round-trip XML codec for a schema. The XML value an `XmlValue` carries maps onto a schema like this:
 *
 * - A key starting with `@` is an attribute, and `@xmlns` becomes `xmlns="…"`;
 * - The reserved key `#text` is the element's character data;
 * - Every other key is a child element, and an array repeats the element;
 * - A scalar field is character data, so a `number` is written and read as its decimal text and a `boolean` as `true` or `false`. Which of the two
 *   shapes a field wants is the schema's decision, not the parser's. A text-only element reads as a bare string, so `Schema.Struct({ title:
 *   Schema.String })` matches `<title>Dune</title>`, and an element that also carries attributes reads as a record, so `Schema.Struct({ '@id':
 *   Schema.String, '#text': Schema.String })` matches `<a id="1">hello</a>`.
 *
 * @example
 *   ```typescript
 *   import { Schema } from 'effect';
 *   import { toCodecXml } from '@endevops/effect-xml-codec';
 *
 *   const Book = Schema.Struct({
 *     '@xmlns': Schema.String,
 *     title: Schema.String,
 *     author: Schema.Struct({ first: Schema.String, last: Schema.String }),
 *     tag: Schema.Array(Schema.String),
 *   });
 *
 *   const book = toCodecXml(Book, { rootName: 'book' });
 *
 *   const value = { '@xmlns': 'urn:books', title: 'Dune', author: { first: 'Frank', last: 'Herbert' }, tag: ['sci-fi', 'classic'] };
 *   const text = book.encodeTextSync(value);
 *   // => '<book xmlns="urn:books"><title>Dune</title><author><first>Frank</first><last>Herbert</last></author><tag>sci-fi</tag><tag>classic</tag></book>'
 *
 *   book.decodeTextSync(text); // => value
 *   ```;
 *
 * @param schema - The schema to derive the XML representation from.
 * @param options - Root name, formatting, name-resolution and depth settings.
 *
 * @returns A codec for the schema, in both directions.
 */
export const toCodecXml = <S extends Schema.Constraint>(schema: S & ServiceFree<S>, options: XmlCodecOptions = {}): XmlCodec<S, S['Type']> => {
  // Effect's own StringTree derivation is the structural half of this package:
  // it already lowers every scalar to character data and preserves arrays,
  // unions, records and recursion, none of which an XML layer can recover on
  // its own.
  const base = Schema.toCodecStringTree(schema);

  // XML cannot spell "an array of one", so a field holding a single element
  // serializes to the same bytes as a field holding that element on its own.
  // Relaxing the array here is what lets both spellings read back as the array
  // the schema asked for.
  const tree = (options.arrayFromSingle ?? true) ? Schema.toCodecArrayFromSingle(base) : base;

  const rootName = options.rootName ?? SchemaAST.resolveIdentifier(schema.ast) ?? SchemaAST.resolveTitle(schema.ast) ?? DEFAULT_ROOT_NAME;

  const renderOptions: XmlRenderOptions = {
    rootName,
    itemName: options.itemName,
    format: options.format,
    indent: options.indent,
    suppressEmptyNode: options.suppressEmptyNode,
    sortKeys: options.sortKeys,
    name: options.name,
    xmlVersion: options.xmlVersion,
    maxDepth: options.maxDepth,
  };

  const parseOptions: XmlParseOptions = {
    preserveWhitespace: options.preserveWhitespace,
    maxDepth: options.maxDepth,
    name: options.name,
    xmlVersion: options.xmlVersion,
  };

  const decode = Schema.decodeUnknownEffect(tree);
  const decodeSync = Schema.decodeUnknownSync(tree);
  const encode = Schema.encodeUnknownEffect(tree);
  const encodeSync = Schema.encodeUnknownSync(tree);

  // The root element's name is not part of the value, so a document and a schema can each hold a
  // shape the other does not. These two are the cases where that happens, and both are settled here —
  // where the schema is in hand — rather than in the parser, which cannot tell an empty element from
  // an empty document without being told which one to expect.
  const rootTag = SchemaAST.toType(schema.ast)._tag;
  const rootIsRecord = rootTag === 'Objects';
  const rootIsArray = rootTag === 'Arrays';
  const reconcile = (xml: unknown): unknown => reconcileRoot(xml, rootIsRecord, rootIsArray);

  // The options are merged once per call rather than once per codec, and only when
  // there is something to merge. Spreading them on every call would allocate an
  // object per serialize, which on a hot path is an allocation the caller cannot
  // see and the garbage collector certainly can.
  const renderFor = (overrides: XmlRenderOptions | undefined): XmlRenderOptions =>
    overrides === undefined ? renderOptions : { ...renderOptions, ...overrides };

  const parseFor = (overrides: XmlParseOptions | undefined): XmlParseOptions =>
    overrides === undefined ? parseOptions : { ...parseOptions, ...overrides };

  return {
    schema,
    rootName,
    encodeValue: value => encode(value),
    encodeValueSync: value => encodeSync(value),
    decodeValue: xml => decode(reconcile(xml)),
    decodeValueSync: xml => decodeSync(reconcile(xml)),
    encodeText: (value, overrides) => Effect.try({ try: () => renderXml(encodeSync(value), renderFor(overrides)), catch: toNameError }),
    encodeTextSync: (value, overrides) => renderXml(encodeSync(value), renderFor(overrides)),
    decodeText: (text, overrides) =>
      Effect.flatMap(Effect.try({ try: () => parseXmlDocument(text, parseFor(overrides)), catch: asParseError }), document =>
        decode(reconcile(document.value))
      ),
    decodeTextSync: (text, overrides) => decodeSync(reconcile(parseXmlDocument(text, parseFor(overrides)).value)),
    readDocument: (text, overrides) => Effect.try({ try: () => parseXmlDocument(text, parseFor(overrides)), catch: asParseError }),
  };
};

/**
 * @description Reconciles a parsed document's root value with the shape the schema's root expects. Two cases, and both come from XML rather than from the schema:
 *
 * - An empty element parses to `''`, because empty character data is what it is. A struct whose fields are all absent then has nothing to decode, and
 *   `''` is not the `{}` it asked for. Only the schema knows which of the two an empty element was meant to be, so it is decided where the schema is
 *   available. This is a root-level fix on purpose: the same ambiguity exists at every nested empty element, and settling that needs the per-field
 *   schema a derivation would provide. See the README's limitations.
 * - An array cannot be a document, so {@link renderXml} wraps one in the root element and names each member. Reading that back yields a record of the
 *   members rather than the members themselves, which is exactly what a root array needs.
 *
 * @param xml - The value the parser produced.
 * @param rootIsRecord - Whether the schema's root is a struct or a record.
 * @param rootIsArray - Whether the schema's root is an array.
 *
 * @returns The value, in the shape the schema's root expects.
 */
const reconcileRoot = (xml: unknown, rootIsRecord: boolean, rootIsArray: boolean): unknown => {
  if (rootIsRecord && xml === '') return {};
  if (rootIsArray && isXmlRecord(xml)) {
    const values = Object.values(xml);
    // A single key is the wrapper the renderer put around the members; more than one is a document written by
    // hand, and every value under it is a member.
    return values.length === 1 ? values[0] : values;
  }
  return xml;
};

/**
 * @description Turns the `TypeError` the name resolver throws into the typed error the `Effect` half of the codec reports. The throwing half of the codec lets it
 * through unchanged, because a caller using `encodeTextSync` asked for a throw.
 *
 * @param error - Whatever was thrown.
 *
 * @returns The failure to put in the error channel.
 */
const toNameError = (error: unknown): XmlNameError => {
  if (error instanceof XmlNameError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // The resolver's message quotes the name it rejected; pull it back out so the
  // error carries the field as data rather than only as prose.
  const match = /Invalid XML name (?<quoted>.*):/.exec(message);
  return new XmlNameError({ name: match?.groups?.['quoted'] ? (JSON.parse(match.groups['quoted']) as string) : '', reason: message });
};

/**
 * @description Identity for a parse failure, and a wrapper for anything else that escapes the parser.
 *
 * @param error - Whatever was thrown.
 *
 * @returns The failure to put in the error channel.
 */
const asParseError = (error: unknown): XmlParseError =>
  error instanceof XmlParseError
    ? error
    : new XmlParseError({ message: error instanceof Error ? error.message : String(error), position: -1, input: '' });
