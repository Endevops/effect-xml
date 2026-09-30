// The codec: a schema, and the XML value that carries it.
//
// `toCodecXml` is this package's name for Effect's own StringTree derivation,
// `Schema.toCodecStringTree`. It is the same shape as `Schema.toCodecJson`: the
// returned value is a `Schema` whose `Type` is the source schema's `Type` and
// whose `Encoded` is the canonical value tree, so it composes with the rest of
// Schema — `Schema.encodeSync`, `Schema.decodeSync`, `Schema.toFormatter` — the
// same way the JSON codec does. The schema's service requirements are preserved
// rather than narrowed, and the derivation is Effect's, not a walk this package
// keeps in step with a release candidate.
//
// XML *text* is a separate step, the way `JSON.stringify` and `JSON.parse` are
// separate from `Schema.toCodecJson`. `renderXml` writes the encoded tree as a
// document and `parseXml` reads one back:
//
//   const codec = toCodecXml(Book);
//
//   const document = renderXml(Schema.encodeSync(codec)(value), { rootName: 'book' });
//   const value = Schema.decodeSync(codec)(parseXmlSync(document));
//
// The conventions are in the keys, not in a transformation: a key starting with
// `@` is an attribute, `#text` is character data, and every other key is a child
// element. `toCodecStringTree` preserves the schema's property names, so those
// keys arrive at `renderXml` unchanged.

import { Schema } from 'effect';

/**
 * @description The XML codec for a schema, as a `Schema`. `Type` is the schema's own `Type` and `Encoded` is Effect's `StringTree`, the value tree `renderXml`
 * writes and `parseXml` produces. It is `Schema.toCodecStringTree`, so the derivation and the encoder and decoder are Effect's; this package supplies
 * the text layer and the `@`/`#text` conventions on top.
 *
 * @example
 *   ```typescript
 *   import { Schema } from 'effect';
 *   import { parseXmlSync, renderXml, toCodecXml } from '@endevops/effect-xml-codec';
 *
 *   const Book = Schema.Struct({ '@id': Schema.String, title: Schema.String, pages: Schema.Number });
 *   const codec = toCodecXml(Book);
 *
 *   const value = { '@id': '1', title: 'Dune', pages: 412 };
 *
 *   renderXml(Schema.encodeSync(codec)(value), { rootName: 'book' });
 *   // => '<book id="1"><title>Dune</title><pages>412</pages></book>'
 *
 *   Schema.decodeSync(codec)(parseXmlSync('<book id="1"><title>Dune</title><pages>412</pages></book>'));
 *   // => { '@id': '1', title: 'Dune', pages: 412 }
 *   ```;
 */
export const toCodecXml = Schema.toCodecStringTree;
