// The codec: a schema, and the XML text that carries it.
//
// `toCodecXml` is this package's counterpart to `Schema.toCodecJson`. It
// returns a `Schema` whose `Type` is the source schema's `Type` and whose
// `Encoded` is XML text, so a value is written with `Schema.encodeSync(codec)`
// and read back with `Schema.decodeSync(codec)`. That is one call each, as with
// the JSON codec. There is no value tree at the call site and no second call to
// a renderer or a parser.
//
// The derivation underneath is Effect's own `Schema.toCodecStringTree`, so
// every schema feature Effect supports composes here without this package
// re-implementing the walk over a schema AST. On encode the codec runs the value
// tree through `renderXml`; on decode it runs the document through `parseXml`.
// Both are the same text layer this package exports on its own, and both
// failures arrive as the `SchemaIssue.Issue` a schema is expected to report,
// with the underlying message preserved. Those failures are an illegal name and
// a document that is not well-formed.
//
// The conventions stay in the keys: a key starting with `@` is an attribute,
// `#text` is character data, and every other key is a child element. The root
// element is named from the schema's `identifier` or `title` annotation when it
// has one, and from the `rootName` option otherwise; it defaults to `'root'`,
// the same name Effect's own XML encoder uses.

import { Effect, Function, Predicate, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from 'effect';

import type { NamespacePlan } from './namespaces.ts';
import type { XmlParseOptions } from './parse.ts';
import type { XmlRenderOptions } from './render.ts';
import type { XmlValue } from './xml-value.ts';

import { DEFAULT_ROOT_NAME } from './conventions.ts';
import { decodeNames, encodeNames, namespacePlan, ROOT_ELEMENT } from './namespaces.ts';
import { parseXml } from './parse.ts';
import { renderXml } from './render.ts';

/**
 * @description Options for {@link toCodecXml}.\
 * The render options name and shape the document; the parse options decide how strictly it is read back.\
 * `rootName` is the one the codec resolves for itself when the caller leaves it out. The codec takes it from the schema's `identifier` or `title` annotation and
 * falls back to `'root'`.
 */
export type XmlCodecOptions = XmlRenderOptions & XmlParseOptions;

/**
 * @description The XML codec for a schema, as a `Schema`. `Type` is the schema's own `Type` and `Encoded` is XML text, so it encodes a value to a document and
 * decodes a document to a value in one step each. The service requirements of the source schema are preserved.
 */
export interface toCodecXml<S extends Schema.Constraint> extends Schema.decodeTo<Schema.toCodecStringTree<S>, Schema.String> {
  readonly Rebuild: toCodecXml<S>;
}

// Whether the plan places any node at all: a rename, an attribute, a value, or a root namespace or name. A plan with none of these leaves the value tree
// alone on both sides, so the codec skips the name walk.
const isActivePlan = (plan: NamespacePlan): boolean =>
  plan.byKey.size > 0 ||
  plan.nameByKey.size > 0 ||
  plan.attributeKeys.size > 0 ||
  plan.valueByElement.size > 0 ||
  plan.root !== undefined ||
  plan.rootName !== undefined;

// The render options with the root name resolved and any root prefix applied. The caller's `rootName` wins, then the plan's, then the schema's `identifier`
// or `title` annotation, then `'root'`. A root namespace with a prefix qualifies the name unless the caller already wrote one.
const resolveRenderOptions = <S extends Schema.Constraint>(schema: S, plan: NamespacePlan, options: XmlCodecOptions): XmlRenderOptions => {
  const rootName =
    options.rootName ?? plan.rootName ?? SchemaAST.resolveIdentifier(schema.ast) ?? SchemaAST.resolveTitle(schema.ast) ?? DEFAULT_ROOT_NAME;
  const wireRootName = plan.root !== undefined && plan.root.prefix !== '' && !rootName.includes(':') ? `${plan.root.prefix}:${rootName}` : rootName;
  return { ...options, rootName: wireRootName };
};

/**
 * @description Derives the XML codec for a schema: a `Schema` whose `Encoded` is an XML document, so `Schema.encodeSync(codec)` writes text and
 * `Schema.decodeSync(codec)` reads it back. The derivation is Effect's `Schema.toCodecStringTree`; the text layer is this package's {@link renderXml}
 * and {@link parseXml}. Call it data-first, `toCodecXml(schema, options)`, or data-last, `toCodecXml(options)(schema)`, so it drops into `pipe` beside
 * the rest of the Effect combinators. The two forms are one function: the first argument decides the style, a schema is read as data-first and an
 * options object as data-last. `pipe(schema, toCodecXml)` carries no options and works because a schema on its own is data-first.
 *
 * @example
 *   ```typescript
 *   import { Schema, pipe } from 'effect';
 *   import { toCodecXml } from '@endevops/effect-codec-xml';
 *
 *   const Book = Schema.Struct({ '@id': Schema.String, title: Schema.String, pages: Schema.Number });
 *   const codec = toCodecXml(Book, { rootName: 'book' });
 *   const piped = pipe(Book, toCodecXml({ rootName: 'book' }));
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
 * @param schema - The schema describing the value, in the data-first form.
 * @param options - Render and parse options. `rootName` defaults to the schema's `identifier` or `title` annotation, then to `'root'`. In the
 *   data-last form this is the only argument, and the schema arrives from `pipe`.
 *
 * @returns The codec, with the source schema's `Type` and the same service requirements. In the data-last form, a function from the schema to the
 *   codec.
 */
export const toCodecXml: {
  <S extends Schema.Constraint>(schema: S, options?: XmlCodecOptions): toCodecXml<S>;
  (options?: XmlCodecOptions): <S extends Schema.Constraint>(schema: S) => toCodecXml<S>;
} = Function.dual(
  args => Schema.isSchema(args[0]),
  <S extends Schema.Constraint>(schema: S, options: XmlCodecOptions = {}): toCodecXml<S> => {
    const planned = namespacePlan(schema);
    if (Predicate.hasProperty(planned, 'error')) {
      throw new Error(`Invalid XML namespace annotation:\n\t- ${planned.error}.`);
    }
    const plan = planned.plan;
    const active = isActivePlan(plan);
    const renderOptions = resolveRenderOptions(schema, plan, options);

    return Schema.String.pipe(
      Schema.decodeTo(
        Schema.toCodecStringTree(schema),
        SchemaTransformation.transformEffect({
          decode: (text, parseOptions) => {
            if (!Predicate.isString(text)) {
              return Effect.fail(new SchemaIssue.InvalidValue({ message: `Expected a string, but received ${typeof text}.` }, text, parseOptions));
            }

            return parseXml(text, options).pipe(
              Effect.map(value => (active ? decodeNames(value, plan, {}, ROOT_ELEMENT) : value)),
              Effect.tapError(error =>
                Effect.logError(`XML parse error: ${error.message}`).pipe(Effect.annotateLogs({ cause: error, message: 'XML parse error' }))
              ),
              Effect.mapError(error => new SchemaIssue.InvalidValue({ message: error.message }, text, parseOptions))
            );
          },

          encode: (value, parseOptions) => {
            if (active && Array.isArray(value) && (plan.root !== undefined || plan.rootName !== undefined)) {
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
  }
);
