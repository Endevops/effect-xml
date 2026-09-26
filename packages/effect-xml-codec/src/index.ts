/**
 * @description A round-trip Effect Schema codec for XML. `toCodecXml` derives an XML representation from any Effect schema and reads it back. Attributes are the
 * fields whose names start with `@`, so `@xmlns` is written as `xmlns="…"`.
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
 *   const book = toCodecXml(Book, { rootName: 'book' });
 *   const value = { '@id': '1', title: 'Dune', tag: ['sci-fi'] };
 *
 *   const text = book.encodeTextSync(value);
 *   // => '<book id="1"><title>Dune</title><tag>sci-fi</tag></book>'
 *
 *   book.decodeTextSync(text); // => value
 *   ```;
 *
 * @packageDocumentation
 */

export type { XmlCodec, XmlCodecOptions } from './codec.ts';
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
  isValidName,
  resolveName,
  TEXT_KEY,
} from './conventions.ts';

export { XmlNameError, XmlParseError } from './errors.ts';

export type { XmlDocument, XmlParseOptions } from './parse.ts';
export { parseXml, parseXmlDocument, parseXmlSync } from './parse.ts';

export type { XmlRenderOptions } from './render.ts';
export { escapeAttribute, escapeText, renderXml } from './render.ts';

export type { XmlRecord, XmlValue } from './xml-value.ts';
export { isXmlArray, isXmlRecord, isXmlValue, XmlValue as XmlValueSchema } from './xml-value.ts';
