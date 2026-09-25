/**
 * @description XML and HTML entity encoding and decoding. The decoder is the interesting half. It is a parser for the reference syntax XML inherits from HTML —
 * `&name;`, `&#NNN;`, `&#xHH;` — with three things layered on top that a naive expander does not have:
 *
 * - **Expansion limits.** A document can define an entity that references another entity ten times over. Ten references deep is a denial of service; a
 *   hundred is a fork bomb written in XML. `limit` caps how many references expand and how many characters they may add, per document.
 * - **Registration hooks.** Entities can arrive two ways: from the parser's own configuration (`namedEntities`), which is trusted, or from the document
 *   being parsed (`addInputEntities`), which is not. A hook decides per entity whether to accept it, and the document's entities are the ones worth
 *   being careful about.
 * - **A numeric-reference policy.** `&#0;` and `&#xD800;` are parseable and are not valid text. `ncr` decides whether they are dropped, left alone, or
 *   made to fail the parse. The encoder is the plain counterpart: escape what has to be escaped, and optionally name every non-ASCII character it
 *   recognises.
 *
 * @example
 *   ```typescript
 *   import { COMMON_HTML, EntityDecoder, EntityEncoder } from '@endevops/entities';
 *
 *   const decoder = new EntityDecoder({ namedEntities: COMMON_HTML });
 *   decoder.decode('caf&eacute; &#233;'); // 'café é'
 *
 *   new EntityEncoder().encode('<a href="x">& é'); // '&lt;a href=&QUOT;x&QUOT;&gt;&amp; &COPY; é'
 *   ```;
 */

import type {
  ApplyLimitsTo,
  EntityDecoderLimitOptions,
  EntityDecoderNCROptions,
  EntityDecoderOptions,
  EntityHookAction,
  EntityRegistrationHook,
  EntityValFn,
} from './entity-decoder.ts';
import type { EntityEncoderOptions } from './entity-encoder.ts';
import type { EntityTable } from './entity-tables.ts';

import { EntityDecoder, ENTITY_ACTION } from './entity-decoder.ts';
import { EntityEncoder } from './entity-encoder.ts';
import {
  ALL_ENTITIES,
  ARROWS,
  BASIC_LATIN,
  COMMON_HTML,
  CURRENCY,
  CYRILLIC,
  FRACTIONS,
  GREEK,
  LATIN_ACCENTS,
  LATIN_EXTENDED,
  MATH,
  MATH_ADVANCED,
  MISC_SYMBOLS,
  PUNCTUATION,
  SHAPES,
  XML,
} from './entity-tables.ts';

export { EntityDecoder, EntityEncoder, ENTITY_ACTION };
export {
  ALL_ENTITIES,
  ARROWS,
  BASIC_LATIN,
  COMMON_HTML,
  CURRENCY,
  CYRILLIC,
  FRACTIONS,
  GREEK,
  LATIN_ACCENTS,
  LATIN_EXTENDED,
  MATH,
  MATH_ADVANCED,
  MISC_SYMBOLS,
  PUNCTUATION,
  SHAPES,
  XML,
};
export type {
  ApplyLimitsTo,
  EntityDecoderLimitOptions,
  EntityDecoderNCROptions,
  EntityDecoderOptions,
  EntityEncoderOptions,
  EntityHookAction,
  EntityRegistrationHook,
  EntityTable,
  EntityValFn,
};

// No default export, matching the original. This module has two classes of
// equal standing — the decoder and the encoder — and picking one as the default
// would be arbitrary in a way a named import makes the caller state.
