/**
 * @description Base classes and value-parsing primitives for XML parser output builders. A parser calls a fixed set of methods on a builder as it walks a
 * document; the builder decides what structure comes out. Everything a builder needs regardless of that shape — the two value-parser pipelines, the
 * per-document shared context, and the policy for comments, CDATA, declarations and stop nodes — lives here. The value parsers and the shared data
 * structures are plain values built by factory functions, not classes: `makeContext`, `makeSharedContext`, `finalValue`, `makeValueParserPipeline`
 * and `makeValueParserRegistry`.
 *
 * @example
 *   ```typescript
 *   import { makeValueParserPipeline, makeValueParserRegistry } from '@endevops/builder';
 *
 *   const registry = makeValueParserRegistry();
 *   const pipeline = makeValueParserPipeline(['ws', 'boolean', 'number'], registry);
 *   pipeline.run('  true  '); // → true
 *   ```;
 */

import type { CloseMetaLike, ExitInfoLike, TagDetailLike, TagNameLike } from './base-output-builder.ts';
import type { BuiltInValueParserOptions, BuilderParserOptions, ValueParserChainOptions } from './options.ts';
import type { XmlUnsafeMatch, XmlUnsafeRule } from './security/xml-unsafe.ts';
import type { ValueParserRegistry } from './value-parser-registry.ts';
import type { Context, FinalValue, SharedContext, ValueParser, ValueParserPipeline, ValueParserRegistryLike } from './value-parser.ts';
import type { EntitiesValueParserOptions } from './value-parsers/entity-parser.ts';
import type { NumberParserOptions } from './value-parsers/number.ts';
import type { ToNumberOptions } from './value-parsers/to-number.ts';
import type { WSNormalizerOptions } from './value-parsers/ws-normalizer.ts';

import BaseOutputBuilderFactory from './base-output-builder-factory.ts';
import BaseOutputBuilder from './base-output-builder.ts';
import { XML_UNSAFE_RULES, allUnsafeXml, isUnsafeXml, whyUnsafeXml } from './security/xml-unsafe.ts';
import { defaultValParsers, makeValueParserRegistry } from './value-parser-registry.ts';
import { finalValue, isFinalValue, makeContext, makeSharedContext, makeValueParserPipeline } from './value-parser.ts';
import { makeBooleanParser } from './value-parsers/boolean-parser.ts';
import { makeEntitiesValueParser } from './value-parsers/entity-parser.ts';
import { makeNumberValueParser } from './value-parsers/number.ts';
import toNumber from './value-parsers/to-number.ts';
import { makeTrim } from './value-parsers/trim.ts';
import { makeWSNormalizer, wsNormalizerBuiltin } from './value-parsers/ws-normalizer.ts';

export {
  BaseOutputBuilder,
  BaseOutputBuilderFactory,
  defaultValParsers,
  finalValue,
  isFinalValue,
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
  XML_UNSAFE_RULES,
  allUnsafeXml,
  isUnsafeXml,
  whyUnsafeXml,
};
export type {
  BuiltInValueParserOptions,
  BuilderParserOptions,
  Context,
  EntitiesValueParserOptions,
  CloseMetaLike,
  ExitInfoLike,
  FinalValue,
  NumberParserOptions,
  SharedContext,
  TagDetailLike,
  ToNumberOptions,
  TagNameLike,
  ValueParser,
  ValueParserChainOptions,
  ValueParserPipeline,
  ValueParserRegistry,
  ValueParserRegistryLike,
  WSNormalizerOptions,
  XmlUnsafeMatch,
  XmlUnsafeRule,
};
