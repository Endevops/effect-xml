/**
 * @description Everything that turns one JavaScript value into another XML-shaped one. Three libraries of equal standing, published as one package:
 *
 * - **`XMLBuilder`** — a JavaScript object in, an XML string out. The default export.
 * - **`OutputBuilder`** / `makeBaseOutputBuilder` — the per-document builder a parser calls as it walks a document. Whatever shape the output should
 *   take, this is where the two value-parser pipelines, the per-document shared context and the policy for comments, CDATA, declarations and stop
 *   nodes live.
 * - **`CompactBuilderFactory`** — the service that produces a compact `OutputBuilder` per document: a text-only tag becomes that string, a tag with
 *   children or attributes becomes an object, a repeated tag becomes an array.
 *
 * @example
 *   ```typescript
 *   import XMLBuilder, { CompactBuilderFactory } from '@endevops/builder';
 *   import XMLParser from '@endevops/parser';
 *
 *   // object -> XML string
 *   const builder = yield* XMLBuilder.make({ ignoreAttributes: false });
 *   yield* builder.build({ a: { '@_id': '1', '#text': 'hello' } }); // '<a id="1">hello</a>'
 *
 *   // XML -> minimal object, through the parser that drives the builder
 *   const factory = yield* CompactBuilderFactory.make();
 *   const parser = yield* XMLParser.make({ OutputBuilder: factory });
 *   yield* parser.parse('<root><item>a</item></root>'); // { root: { item: 'a' } }
 *
 *   // a new output shape, on the same base the parser calls
 *   const getInstance = (parserOptions, matcher) => Effect.succeed({
 *     ...makeBaseOutputBuilder(parserOptions, builderOptions, matcher, registry),
 *     // shape methods here
 *   });
 *   ```;
 *
 * @see {@link OutputBuilder} for the parser-side contract, {@link CompactBuilderFactory} for the shape rules, {@link XMLBuilder} for encoding.
 */

import type {
  CompactBuilder,
  CompactParserOptions,
  CompactValue,
  FactoryOptions,
  ForceArrayPredicate,
  OutputBuilderFactory,
  ResolvedFactoryOptions,
  TagFrame,
} from './compact-builder/index.ts';
// The per-document builder the parser calls, and the value-parser primitives it is built on.
import type {
  BuiltInValueParserOptions,
  BuilderParserOptions,
  CloseMetaLike,
  Context,
  EntitiesValueParserOptions,
  ExitInfoLike,
  FinalValue,
  NumberParserOptions,
  OutputBuilder,
  SharedContext,
  TagDetailLike,
  TagNameLike,
  ToNumberOptions,
  ValueParser,
  ValueParserChainOptions,
  ValueParserPipeline,
  ValueParserRegistry,
  ValueParserRegistryLike,
  WSNormalizerOptions,
  XmlUnsafeMatch,
  XmlUnsafeRule,
} from './output-builder/index.ts';
// The XML builder, which is this package's default export.
import type {
  EntityReplacement,
  IgnoreAttributesPredicate,
  NameResolver,
  ResolvedXmlBuilderOptions,
  SanitizeNameContext,
  XmlBuilder,
  XmlBuilderOptions,
} from './xml-builder/index.ts';

import { CompactBuilderFactory, makeCompactBuilder } from './compact-builder/index.ts';
import { BuilderError, BuilderErrorReason } from './errors.ts';
import { XML_UNSAFE_RULES, allUnsafeXml, isUnsafeXml, whyUnsafeXml } from './output-builder/index.ts';
import {
  defaultValParsers,
  finalValue,
  isFinalValue,
  makeBaseOutputBuilder,
  makeBooleanParser,
  makeContext,
  makeEntitiesValueParser,
  makeNumberValueParser,
  makeSharedContext,
  makeTrim,
  makeValueParserPipeline,
  makeValueParserRegistry,
  makeWSNormalizer,
  toNumber,
  wsNormalizerBuiltin,
} from './output-builder/index.ts';
import XMLBuilder from './xml-builder/index.ts';

export { BuilderError, BuilderErrorReason };
export { XMLBuilder };
export {
  CompactBuilderFactory,
  defaultValParsers,
  finalValue,
  isFinalValue,
  makeBaseOutputBuilder,
  makeBooleanParser,
  makeCompactBuilder,
  makeContext,
  makeEntitiesValueParser,
  makeNumberValueParser,
  makeSharedContext,
  makeTrim,
  makeValueParserPipeline,
  makeValueParserRegistry,
  makeWSNormalizer,
  toNumber,
  wsNormalizerBuiltin,
  XML_UNSAFE_RULES,
  allUnsafeXml,
  isUnsafeXml,
  whyUnsafeXml,
};
export type {
  BuiltInValueParserOptions,
  BuilderParserOptions,
  CloseMetaLike,
  CompactBuilder,
  CompactParserOptions,
  CompactValue,
  Context,
  EntitiesValueParserOptions,
  EntityReplacement,
  ExitInfoLike,
  FactoryOptions,
  FinalValue,
  ForceArrayPredicate,
  IgnoreAttributesPredicate,
  NameResolver,
  NumberParserOptions,
  OutputBuilder,
  OutputBuilderFactory,
  ResolvedFactoryOptions,
  ResolvedXmlBuilderOptions,
  SanitizeNameContext,
  SharedContext,
  TagDetailLike,
  TagFrame,
  TagNameLike,
  ToNumberOptions,
  ValueParser,
  ValueParserChainOptions,
  ValueParserPipeline,
  ValueParserRegistry,
  ValueParserRegistryLike,
  WSNormalizerOptions,
  XmlBuilder,
  XmlBuilderOptions,
  XmlUnsafeMatch,
  XmlUnsafeRule,
};
export default XMLBuilder;
