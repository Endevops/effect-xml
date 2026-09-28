/**
 * @description Everything that turns one JavaScript value into another XML-shaped one. Three libraries of equal standing, published as one package:
 *
 * - **`XMLBuilder`** — a JavaScript object in, an XML string out. The default export.
 * - **`BaseOutputBuilder`** / `BaseOutputBuilderFactory` — the base a parser calls as it walks a document. Whatever shape the output should take, this
 *   is where the two value-parser pipelines, the per-document shared context and the policy for comments, CDATA, declarations and stop nodes live.
 * - **`CompactBuilder`** / `CompactBuilderFactory` — a concrete `BaseOutputBuilder` that produces a minimal JavaScript object: a text-only tag becomes
 *   that string, a tag with children or attributes becomes an object, a repeated tag becomes an array. These were published separately as
 *   `@endevops/xml-builder`, `@endevops/base-output-builder` and `@endevops/compact-builder`. They were merged because the second and third are the
 *   base and the default implementation for the same parser API, and shipping them apart meant installing two packages to write one output builder.
 *   Splitting them again is a matter of moving directories back out. `XMLBuilder` is the default export. `BaseOutputBuilder` and
 *   `CompactBuilderFactory` were the default exports of the packages they came from; they are named exports here, because one module can only have
 *   one default.
 *
 * @example
 *   ```typescript
 *   import XMLBuilder, { CompactBuilderFactory, BaseOutputBuilderFactory } from '@endevops/builder';
 *   import XMLParser from '@endevops/parser';
 *
 *   // object -> XML string
 *   new XMLBuilder({ ignoreAttributes: false }).build({ a: { '@_id': '1', '#text': 'hello' } }); // '<a id="1">hello</a>'
 *
 *   // XML -> minimal object, through the parser that drives the builder
 *   new XMLParser({ OutputBuilder: new CompactBuilderFactory() }).parse('<root><item>a</item></root>');
 *   // { root: { item: 'a' } }
 *
 *   // a new output shape, on the same base the parser calls
 *   class MyFactory extends BaseOutputBuilderFactory {
 *     getInstance(parserOptions, readonlyMatcher) {
 *       return new MyBuilder(parserOptions, this.builderOptions, readonlyMatcher, this.registry);
 *     }
 *   }
 *   ```;
 *
 * @see {@link BaseOutputBuilder} for the parser-side contract, {@link CompactBuilderFactory} for the shape rules, {@link XMLBuilder} for encoding.
 */

import type { CompactParserOptions, CompactValue, FactoryOptions, ForceArrayPredicate, ResolvedFactoryOptions } from './compact-builder/index.ts';
// The base classes the parser calls, and the value-parser primitives they are built on.
import type {
  BuiltInValueParserOptions,
  BuilderParserOptions,
  CloseMetaLike,
  EntitiesValueParserOptions,
  ExitInfoLike,
  NumberParserOptions,
  TagDetailLike,
  TagNameLike,
  ToNumberOptions,
  ValueParser,
  ValueParserChainOptions,
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
  XmlBuilderOptions,
} from './xml-builder/index.ts';

import { CompactBuilder, CompactBuilderFactory } from './compact-builder/index.ts';
import { BuilderError, BuilderErrorReason } from './errors.ts';
import { XML_UNSAFE_RULES, allUnsafeXml, isUnsafeXml, whyUnsafeXml } from './output-builder/index.ts';
import { BaseOutputBuilderFactory } from './output-builder/index.ts';
import { BaseOutputBuilder } from './output-builder/index.ts';
import { Context, FinalValue, SharedContext, ValueParserPipeline, ValueParserRegistry } from './output-builder/index.ts';
import { BaseValueParser, BooleanParser, EntitiesValueParser, NumberValueParser, toNumber, Trim, WSNormalizer } from './output-builder/index.ts';
import XMLBuilder from './xml-builder/index.ts';

export { BuilderError, BuilderErrorReason };
export { XMLBuilder };
export {
  BaseOutputBuilder,
  BaseOutputBuilderFactory,
  BaseValueParser,
  BooleanParser,
  CompactBuilder,
  CompactBuilderFactory,
  Context,
  EntitiesValueParser,
  FinalValue,
  NumberValueParser,
  SharedContext,
  toNumber,
  Trim,
  ValueParserPipeline,
  ValueParserRegistry,
  XML_UNSAFE_RULES,
  WSNormalizer,
  allUnsafeXml,
  isUnsafeXml,
  whyUnsafeXml,
};
export type {
  BuiltInValueParserOptions,
  BuilderParserOptions,
  CloseMetaLike,
  CompactParserOptions,
  CompactValue,
  EntitiesValueParserOptions,
  EntityReplacement,
  ExitInfoLike,
  FactoryOptions,
  ForceArrayPredicate,
  IgnoreAttributesPredicate,
  NameResolver,
  NumberParserOptions,
  ResolvedFactoryOptions,
  ResolvedXmlBuilderOptions,
  SanitizeNameContext,
  TagDetailLike,
  TagNameLike,
  ToNumberOptions,
  ValueParser,
  ValueParserChainOptions,
  ValueParserRegistryLike,
  WSNormalizerOptions,
  XmlBuilderOptions,
  XmlUnsafeMatch,
  XmlUnsafeRule,
};
export default XMLBuilder;
