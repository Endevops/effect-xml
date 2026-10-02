/**
 * @description A round-trip Effect Schema codec for XML. `toCodecXml(schema)` returns a `Schema` whose `Encoded` is XML text, so `Schema.encodeSync` writes a
 * document and `Schema.decodeSync` reads one back, the way `Schema.toCodecJson` works for JSON. Attributes are the fields whose names start with `@`,
 * so `@xmlns` is written as `xmlns="…"`, and `#text` holds an element's character data. A schema node annotated with `xmlNamespace` is placed in that
 * namespace, and the codec resolves the document's own prefixes back to it. `renderXml` and `parseXml` are the text layer the codec runs underneath,
 * and remain available on their own.
 *
 * @example
 *   ```typescript
 *   import { Schema } from 'effect';
 *   import { toCodecXml } from '@endevops/effect-xml-codec';
 *
 *   const Book = Schema.Struct({
 *     '@id': Schema.String,
 *     title: Schema.String,
 *     tag: Schema.Array(Schema.String),
 *   });
 *
 *   const codec = toCodecXml(Book, { rootName: 'book' });
 *   const value = { '@id': '1', title: 'Dune', tag: ['sci-fi'] };
 *
 *   const text = Schema.encodeSync(codec)(value);
 *   // => '<book id="1"><title>Dune</title><tag>sci-fi</tag></book>'
 *
 *   Schema.decodeSync(codec)(text); // => value
 *   ```;
 *
 * @packageDocumentation
 */

export { toCodecXml } from './codec.ts';
export type { XmlCodecOptions } from './codec.ts';

export {
  ATTRIBUTE_PREFIX,
  DEFAULT_ITEM_NAME,
  DEFAULT_ROOT_NAME,
  TEXT_KEY,
  attributeName,
  isAttributeKey,
  isReservedKey,
  isTextKey,
  resolveName,
} from './conventions.ts';
export type { NameMode, ResolveNameOptions } from './conventions.ts';

export { XmlParseError, XmlRenderError } from './errors.ts';

export { ATTRIBUTE_KEY, NAME_KEY, NAMESPACE_KEY, PREFIX_KEY } from './namespaces.ts';
export type { NamespacePlan, XmlNamespace } from './namespaces.ts';

export { parseXml } from './parse.ts';
export type { XmlDocument, XmlParseOptions } from './parse.ts';

export { escapeAttribute, escapeText, renderXml } from './render.ts';
export type { XmlRenderOptions } from './render.ts';

export { XmlValue as XmlValueSchema, isXmlValue } from './xml-value.ts';
export type { XmlRecord, XmlValue } from './xml-value.ts';
