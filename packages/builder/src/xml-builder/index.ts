/**
 * @description Builds an XML string from a JavaScript object. This is one of three libraries in this package and the one it is named after. The other two,
 * {@link BaseOutputBuilder} and {@link CompactBuilderFactory}, run the other direction — XML in, a JavaScript value out — and are re-exported from the
 * package root.
 *
 * @example
 *   ```typescript
 *   import { XMLBuilder } from '@endevops/builder';
 *
 *   const builder = new XMLBuilder({ ignoreAttributes: false });
 *   builder.build({ a: { '@_id': '1', '#text': 'hello' } }); // '<a id="1">hello</a>'
 *   ```;
 */

import type {
  EntityReplacement,
  IgnoreAttributesPredicate,
  NameResolver,
  ResolvedXmlBuilderOptions,
  SanitizeNameContext,
  XmlBuilderOptions,
} from './options.ts';

import XMLBuilder from './xml-builder.ts';

export { XMLBuilder };
export type { EntityReplacement, IgnoreAttributesPredicate, NameResolver, ResolvedXmlBuilderOptions, SanitizeNameContext, XmlBuilderOptions };
export default XMLBuilder;
