/**
 * @description Builds a minimal JavaScript object from an XML document. A tag with only text becomes that string; a tag with children or attributes becomes an
 * object; a repeated tag becomes an array. Two options exist because that last rule makes a key's shape depend on how many times the tag occurred:
 * {@link FactoryOptions.alwaysArray} and {@link FactoryOptions.forceArray} fix it where it matters.
 *
 * @example
 *   ```typescript
 *   import { CompactBuilderFactory } from '@endevops/builder';
 *   import XMLParser from '@endevops/parser';
 *
 *   const factory = yield* CompactBuilderFactory.make({ alwaysArray: ['..item'] });
 *   const parser = yield* XMLParser.make({ OutputBuilder: factory });
 *   yield* parser.parse('<root><item>a</item><item>b</item></root>'); // { root: { item: ['a', 'b'] } }
 *   ```;
 */

import type { CompactBuilder, CompactParserOptions, CompactValue, OutputBuilderFactory, TagFrame } from './compact-builder.ts';
import type { FactoryOptions, ForceArrayPredicate, ResolvedFactoryOptions } from './options.ts';

import { CompactBuilderFactory, makeCompactBuilder } from './compact-builder.ts';

export { CompactBuilderFactory, makeCompactBuilder };
export type {
  CompactBuilder,
  CompactParserOptions,
  CompactValue,
  FactoryOptions,
  ForceArrayPredicate,
  OutputBuilderFactory,
  ResolvedFactoryOptions,
  TagFrame,
};
