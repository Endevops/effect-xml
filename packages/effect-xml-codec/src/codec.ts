// The codec: a schema, and the XML text that carries it.
//
// `toCodecXml` is this package's counterpart to `Schema.toCodecJson`. It
// returns a `Schema` whose `Type` is the source schema's `Type` and whose
// `Encoded` is XML text, so a value is written with `Schema.encodeSync(codec)`
// and read back with `Schema.decodeSync(codec)` — one call each, the way the
// JSON codec works. There is no value tree at the call site and no second call
// to a renderer or a parser.
//
// The derivation underneath is Effect's own `Schema.toCodecStringTree`, so
// every schema feature Effect supports composes here without this package
// re-implementing the walk over a schema AST. On the way out the codec runs the
// value tree through `renderXml`; on the way back in it runs the document
// through `parseXml`. Both are the same text layer this package exports on
// their own, and both failures — an illegal name, a document that is not
// well-formed — arrive as the `SchemaIssue.Issue` a schema is expected to
// report, with the underlying message preserved.
//
// The conventions stay in the keys: a key starting with `@` is an attribute,
// `#text` is character data, and every other key is a child element. The root
// element is named from the schema's `identifier` or `title` annotation when it
// has one, and from the `rootName` option otherwise; it defaults to `'root'`,
// the same name Effect's own XML encoder uses.

import { Effect, Predicate, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from 'effect';

import type { XmlParseOptions } from './parse.ts';
import type { XmlRenderOptions } from './render.ts';
import type { XmlValue } from './xml-value.ts';

import { DEFAULT_ROOT_NAME } from './conventions.ts';
import { decodeNames, encodeNames, namespacePlan, ROOT_ELEMENT } from './namespaces.ts';
import { parseXml } from './parse.ts';
import { renderXml } from './render.ts';

/**
 * @description Options for {@link toCodecXml}. The render options name and shape the document; the parse options decide how strictly it is read back. `rootName` is
 * the one the codec resolves for itself when the caller leaves it out, taking it from the schema's `identifier` or `title` annotation and falling
 * back to `'root'`.
 */
export type XmlCodecOptions = XmlRenderOptions & XmlParseOptions;

/**
 * @description The XML codec for a schema, as a `Schema`. `Type` is the schema's own `Type` and `Encoded` is XML text, so it encodes a value to a document and
 * decodes a document to a value in one step each. The service requirements of the source schema are preserved.
 */
export interface toCodecXml<S extends Schema.Constraint> extends Schema.decodeTo<Schema.toCodecStringTree<S>, Schema.String> {
  readonly Rebuild: toCodecXml<S>;
}

/**
 * @description Derives the XML codec for a schema: a `Schema` whose `Encoded` is an XML document, so `Schema.encodeSync(codec)` writes text and
 * `Schema.decodeSync(codec)` reads it back. The derivation is Effect's `Schema.toCodecStringTree`; the text layer is this package's {@link renderXml}
 * and {@link parseXml}.
 *
 * @example
 *   ```typescript
 *   import { Schema } from 'effect';
 *   import { toCodecXml } from '@endevops/effect-xml-codec';
 *
 *   const Book = Schema.Struct({ '@id': Schema.String, title: Schema.String, pages: Schema.Number });
 *   const codec = toCodecXml(Book, { rootName: 'book' });
 *
 *   const value = { '@id': '1', title: 'Dune', pages: 412 };
 *
 *   Schema.encodeSync(codec)(value);
 *   // => '<book id="1"><title>Dune</title><pages>412</pages></book>'
 *
 *   Schema.decodeSync(codec)('<book id="1"><title>Dune</title><pages>412</pages></book>');
 *   // => { '@id': '1', title: 'Dune', pages: 412 }
 *   ```;
 *
 * @param schema - The schema describing the value.
 * @param options - Render and parse options. `rootName` defaults to the schema's `identifier` or `title` annotation, then to `'root'`.
 *
 * @returns The codec, with the source schema's `Type` and the same service requirements.
 */
export const toCodecXml = <S extends Schema.Constraint>(schema: S, options: XmlCodecOptions = {}): toCodecXml<S> => {
  const tree = Schema.toCodecStringTree(schema);

  // A schema that annotates a namespace or a node name gets text-bound
  // rewriting: its local names are written with the annotated prefixes and
  // names, and a document written with any prefix for the same URI reads back.
  // A schema with no annotation takes the plain path, byte for byte as before.
  const planned = namespacePlan(schema);
  if (Predicate.hasProperty(planned, 'error')) {
    throw new Error(`Invalid XML namespace annotation:\n\t- ${planned.error}.`);
  }
  const plan = planned.plan;
  const active =
    plan.byKey.size > 0 ||
    plan.nameByKey.size > 0 ||
    plan.attributeKeys.size > 0 ||
    plan.valueByElement.size > 0 ||
    plan.root !== undefined ||
    plan.rootName !== undefined;

  const rootName =
    options.rootName ?? plan.rootName ?? SchemaAST.resolveIdentifier(schema.ast) ?? SchemaAST.resolveTitle(schema.ast) ?? DEFAULT_ROOT_NAME;
  const wireRootName = plan.root !== undefined && plan.root.prefix !== '' && !rootName.includes(':') ? `${plan.root.prefix}:${rootName}` : rootName;

  const renderOptions: XmlRenderOptions = { ...options, rootName: wireRootName };

  return Schema.String.pipe(
    Schema.decodeTo(
      tree,
      SchemaTransformation.transformEffect<Schema.StringTree, string>({
        // The transformation bridges the document and the value tree: on the
        // way in the text becomes the tree `tree` decodes from, and on the way
        // out the tree `tree` encoded becomes text. A failure from either text
        // step becomes the `InvalidValue` a schema reports, carrying the XML
        // error's own message rather than a generic one.
        decode: (text, parseOptions) =>
          parseXml(text, options).pipe(
            Effect.map(value => (active ? decodeNames(value, plan, {}, ROOT_ELEMENT) : value)),
            Effect.mapError(error => new SchemaIssue.InvalidValue({ message: error.message }, text, parseOptions))
          ),
        encode: (value, parseOptions) => {
          if (active && Array.isArray(value) && (plan.root !== undefined || plan.rootName !== undefined)) {
            // A root array has no element of its own to carry the root's
            // declaration or name; renderXml wraps it, so there is nowhere to
            // put them.
            return Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: 'An array at the root of a namespaced schema cannot carry the root namespace or name.' },
                value,
                parseOptions
              )
            );
          }
          const wire = active ? encodeNames(value as XmlValue, plan, plan.root, {}, ROOT_ELEMENT) : (value as XmlValue);
          return renderXml(wire, renderOptions).pipe(
            Effect.mapError(error => new SchemaIssue.InvalidValue({ message: error.message }, value, parseOptions))
          );
        },
      })
    )
  );
};
