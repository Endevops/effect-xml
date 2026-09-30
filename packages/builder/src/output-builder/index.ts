/**
 * @description Base classes and value-parsing primitives for XML parser output builders. A parser calls a fixed set of methods on a builder as it walks a
 * document; the builder decides what structure comes out. Everything a builder needs regardless of that shape — the two value-parser pipelines, the
 * per-document shared context, and the policy for comments, CDATA, declarations and stop nodes — lives here.
 *
 * @example
 *   ```typescript
 *   import { BaseOutputBuilder, BaseOutputBuilderFactory } from '@endevops/builder';
 *
 *   export default class MyFactory extends BaseOutputBuilderFactory {
 *     getInstance(parserOptions, readonlyMatcher) {
 *       return new MyBuilder(parserOptions, this.builderOptions, readonlyMatcher, this.registry);
 *     }
 *   }
 *   ```;
 */

import type { CloseMetaLike, ExitInfoLike, TagDetailLike, TagNameLike } from './base-output-builder.ts';
import type { BuiltInValueParserOptions, BuilderParserOptions, ValueParserChainOptions } from './options.ts';
import type { XmlUnsafeMatch, XmlUnsafeRule } from './security/xml-unsafe.ts';
import type { ValueParser, ValueParserRegistryLike } from './value-parser.ts';
import type { EntitiesValueParserOptions } from './value-parsers/entity-parser.ts';
import type { NumberParserOptions } from './value-parsers/number.ts';
import type { ToNumberOptions } from './value-parsers/to-number.ts';
import type { WSNormalizerOptions } from './value-parsers/ws-normalizer.ts';

import BaseOutputBuilderFactory from './base-output-builder-factory.ts';
import BaseOutputBuilder from './base-output-builder.ts';
import { XML_UNSAFE_RULES, allUnsafeXml, isUnsafeXml, whyUnsafeXml } from './security/xml-unsafe.ts';
import ValueParserRegistry from './value-parser-registry.ts';
import { Context, FinalValue, SharedContext, ValueParserPipeline } from './value-parser.ts';
import BaseValueParser from './value-parsers/base-value-parser.ts';
import BooleanParser from './value-parsers/boolean-parser.ts';
import EntitiesValueParser from './value-parsers/entity-parser.ts';
import NumberValueParser from './value-parsers/number.ts';
import toNumber from './value-parsers/to-number.ts';
import Trim from './value-parsers/trim.ts';
import { WSNormalizer } from './value-parsers/ws-normalizer.ts';

export {
  BaseOutputBuilder,
  BaseOutputBuilderFactory,
  BaseValueParser,
  BooleanParser,
  Context,
  EntitiesValueParser,
  FinalValue,
  NumberValueParser,
  toNumber,
  SharedContext,
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
  EntitiesValueParserOptions,
  CloseMetaLike,
  ExitInfoLike,
  NumberParserOptions,
  TagDetailLike,
  ToNumberOptions,
  TagNameLike,
  ValueParser,
  ValueParserChainOptions,
  ValueParserRegistryLike,
  WSNormalizerOptions,
  XmlUnsafeMatch,
  XmlUnsafeRule,
};
