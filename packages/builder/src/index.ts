/**
 * @description Builds an XML string from a JavaScript object.
 *
 * @example
 *   ```typescript
 *   import { XMLBuilder } from '@endevops/xml-builder';
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
