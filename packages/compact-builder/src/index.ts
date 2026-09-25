/**
 * @description Builds a minimal JavaScript object from an XML document. A tag with only text becomes that string; a tag with children or attributes becomes an
 * object; a repeated tag becomes an array. Two options exist because that last rule makes a key's shape depend on how many times the tag occurred:
 * {@link FactoryOptions.alwaysArray} and {@link FactoryOptions.forceArray} fix it where it matters.
 *
 * @example
 *   ```typescript
 *   import { CompactBuilderFactory } from '@endevops/compact-builder';
 *
 *   const builder = new CompactBuilderFactory();
 *   builder.build({ root: { item: ['a', 'b'] } }); // { root: { item: ['a', 'b'] } }
 *   ```;
 */

import type { CloseMetaLike, TagDetailLike } from '@endevops/base-output-builder';

import type { CompactParserOptions, CompactValue } from './compact-builder.ts';
import type { FactoryOptions, ForceArrayPredicate, ResolvedFactoryOptions } from './options.ts';

import CompactBuilderFactory, { CompactBuilder } from './compact-builder.ts';

export { CompactBuilder, CompactBuilderFactory };
export type { CloseMetaLike, CompactParserOptions, CompactValue, FactoryOptions, ForceArrayPredicate, ResolvedFactoryOptions, TagDetailLike };
export default CompactBuilderFactory;
