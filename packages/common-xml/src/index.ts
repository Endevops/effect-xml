/**
 * @description The primitives every other package in this workspace shares: XML and HTML entity encoding and decoding, path tracking and pattern matching, and
 * validation of the XML name productions. Three standalone packages, one package. These used to be published separately as `@endevops/common-xml`,
 * `@endevops/common-xml` and `@endevops/common-xml`. They were merged because they are always installed together — the parser needs all three, and so
 * does the builder — and none of them has a use without the other two nearby. A consumer that wanted `sanitize` from `xml-naming` had to know that
 * `@endevops/common-xml` and `@endevops/common-xml` also existed. None of the three exports a name the other two use, so the root export is flat and
 * there is nothing to disambiguate. The source is still split into `src/entities/`, `src/naming/` and `src/path-matcher/`, each with its own barrel,
 * and the specs sit under the matching `test/` subdirectory.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { COMMON_HTML, EntityDecoder, Expression, Matcher, createValidator, sanitize } from '@endevops/common-xml';
 *
 *   // Infallible operations are plain synchronous functions — a regex test cannot fail.
 *   const isQName = createValidator('qName');
 *   isQName('svg:circle'); // true
 *   sanitize('not a name', 'ncName'); // 'not_a_name'
 *
 *   // The entity decoder can fail on an expansion limit, so it reports through an Effect.
 *   const decoder = new EntityDecoder({ namedEntities: COMMON_HTML });
 *   Effect.runSync(decoder.decode('caf&eacute; &#233;')); // decoded text
 *
 *   // Compile patterns once at config time; construction is Expression.make, not `new`.
 *   const script = Effect.runSync(Expression.make('..script'));
 *   const matcher = new Matcher();
 *   matcher.push('root', {});
 *   matcher.push('user', { type: 'admin' });
 *   matcher.matches(script); // false — `user` is not a `script`
 *   ```
 *
 * @see {@link EntityDecoder} for the entity half, {@link Matcher} for the path half, {@link createValidator} for the naming half, and
 *   {@link XmlError} for the single error every fallible operation here reports.
 */

import type {
  ApplyLimitsTo,
  EntityDecoderLimitOptions,
  EntityDecoderNCROptions,
  EntityDecoderOptions,
  EntityEncoderOptions,
  EntityHookAction,
  EntityRegistrationHook,
  EntityTable,
  EntityValFn,
} from './entities/index.ts';
// The single error every fallible operation in this package reports, and the tagged union of causes it carries. Exported from the root because a caller
// that handles a failure has to name the type, and because `Effect.catchReason` needs the reason's `_tag` values to be reachable from the import.
import type { XmlErrorReason as XmlErrorReasonType } from './errors.ts';
import type {
  CreateValidatorOptions,
  MemoizedValidator,
  Production,
  SanitizeOptions,
  ValidationOptions,
  ValidationResult,
  XmlVersion,
} from './naming/index.ts';
import type {
  ExpressionOptions,
  KeptAttrEntry,
  MatcherOptions,
  MatcherSnapshot,
  PathNode,
  PositionSelector,
  PushOptions,
  ReadOnlyMatcher,
  Segment,
  SiblingLevel,
} from './path-matcher/index.ts';

import { EntityDecoder, EntityEncoder, ENTITY_ACTION } from './entities/index.ts';
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
} from './entities/index.ts';
import { XmlError, XmlErrorReason } from './errors.ts';
import { createValidator, isName, isNcName, isNmToken, isNmTokens, isQName, sanitize, validate, validateAll } from './naming/index.ts';
import { Expression, ExpressionSet, Matcher, MatcherView } from './path-matcher/index.ts';

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
export { createValidator, isName, isNcName, isNmToken, isNmTokens, isQName, sanitize, validate, validateAll };
export { Expression, ExpressionSet, Matcher, MatcherView };
export { XmlError, XmlErrorReason };
export type { XmlErrorReasonType };
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
export type { CreateValidatorOptions, MemoizedValidator, Production, SanitizeOptions, ValidationOptions, ValidationResult, XmlVersion };
export type {
  ExpressionOptions,
  KeptAttrEntry,
  MatcherOptions,
  MatcherSnapshot,
  PathNode,
  PositionSelector,
  PushOptions,
  ReadOnlyMatcher,
  Segment,
  SiblingLevel,
};

// No default export. This module is three libraries of equal standing — the decoder, the path matcher and the name validators — and there is no defensible
// way to pick one of them as the default in a way a caller would be expected to remember.
