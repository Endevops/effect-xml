/**
 * @description A round-trip Effect Schema codec for XML. `toCodecXml` is Effect's own `Schema.toCodecStringTree` under the name this package uses: a `Schema`
 * whose `Encoded` is the XML value tree, so it composes with `Schema.encode` and `Schema.decode` the way `Schema.toCodecJson` does. `renderXml`
 * writes the encoded tree as a document and `parseXml` reads one back. Attributes are the fields whose names start with `@`, so `@xmlns` is written
 * as `xmlns="…"`.
 *
 * @example
 *   ```typescript
 *   import { Schema } from 'effect';
 *   import { parseXmlDocument, renderXml, toCodecXml } from '@endevops/effect-xml-codec';
 *
 *   const Book = Schema.Struct({
 *     '@id': Schema.String,
 *     title: Schema.String,
 *     tag: Schema.Array(Schema.String),
 *   });
 *
 *   const codec = toCodecXml(Book);
 *   const value = { '@id': '1', title: 'Dune', tag: ['sci-fi'] };
 *
 *   const text = renderXml(Schema.encodeSync(codec)(value), { rootName: 'book' });
 *   // => '<book id="1"><title>Dune</title><tag>sci-fi</tag></book>'
 *
 *   Schema.decodeSync(codec)(parseXmlDocument(text).value); // => value
 *   ```;
 *
 * @packageDocumentation
 */

export { toCodecXml } from './codec.ts';

export type { NameMode, ResolveNameOptions } from './conventions.ts';
export {
  ATTRIBUTE_PREFIX,
  attributeName,
  DEFAULT_ITEM_NAME,
  DEFAULT_ROOT_NAME,
  isAttributeKey,
  isReservedKey,
  isTextKey,
  resolveName,
  TEXT_KEY,
} from './conventions.ts';

export { XmlParseError } from './errors.ts';

export type { XmlDocument, XmlParseOptions } from './parse.ts';
export { parseXml, parseXmlDocument } from './parse.ts';

export type { XmlRenderOptions } from './render.ts';
export { escapeAttribute, escapeText, renderXml } from './render.ts';

export type { XmlRecord, XmlValue } from './xml-value.ts';
export { isXmlArray, isXmlRecord, isXmlValue, XmlValue as XmlValueSchema } from './xml-value.ts';
