/**
 * @description Every way this package can fail, as one typed error. The package used to throw plain `Error` and `TypeError` from ten places spread across three
 * areas. A caller had to match on message text, and there was nothing to narrow on. All of it is now a single {@link XmlError} in the `E` channel of
 * the effects that can fail, with the specific cause in a `reason` field rather than parsed back out of a string.
 *
 * ## Why one error with a `reason`, and not one error per cause
 *
 * Eight distinct causes would mean eight classes, and a caller handling "any of these" would need `catchTags` with all eight. The causes are not
 * independent decisions a caller usually wants to make separately — they are all "this XML input was not acceptable", and the useful split is coarse:
 * a bad _configuration_ versus a bad _document_. So there is one error, and `reason` narrows to the specific cause. Recovery is a `catchReason`
 * away:
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { Expression, XmlError } from '@endevops/common-xml';
 *
 *   // A typo in a configured pattern is a programmer error and should not be swallowed.
 *   const strict = Expression.make('root..user::').pipe(
 *   Effect.catchReason('XmlError', 'InvalidPattern', () => Effect.succeed(null)),
 *   Effect.orElseSucceed(() => null),
 *   );
 *   ```
 *
 *   The message is kept alongside `reason` and is part of the schema, because the text is load-bearing: the
 *   `[EntityReplacer]` prefix in particular is documented as something callers match on, so it is reproduced exactly
 *   rather than reworded.
 */

import { Schema } from 'effect';

/**
 * @description The specific cause of an {@link XmlError}, as a tagged union. The `_tag` on each member is the discriminant `Effect.catchReason` matches on, and
 * the payload is what a handler needs in order to decide or to report. Every member is a case the package actually raises — there is no catch-all
 * member, so an exhaustive `match` stays exhaustive as causes are added.
 */
export const XmlErrorReason = Schema.TaggedUnion({
  /**
   * @description A required argument was `null` or another non-value where the package requires a real one. Raised by the factories that compile caller-supplied
   * input — {@link EntityDecoder.make} among them — when they are handed `null` for an options object that has no meaningful default. It is a
   * distinct case from the rest because the argument is not _wrong_, it is _absent_, and a caller who wrote `make(null)` meant something the type
   * system does not allow: a decoder with every default is `make({})`, and saying so here is more useful than silently producing one.
   */
  MissingOptions: {
    /**
     * @description The parameter that was given nothing, named as it appears in the signature.
     */
    parameter: Schema.String,
  },

  /**
   * @description A name was checked against one of the five XML name productions and given a different one. Unreachable from TypeScript, where `Production` is a
   * closed union — it is the guard for untyped JavaScript callers and for values that crossed a boundary as `unknown`.
   */
  InvalidProduction: {
    production: Schema.String,
    /**
     * @description The productions that would have been accepted, comma-separated, as they appear in the message.
     */
    expected: Schema.String,
  },

  /**
   * @description A path expression could not be parsed.
   */
  InvalidPattern: {
    /**
     * @description The whole pattern the failure came from, so a log can show the input the caller actually wrote.
     */
    pattern: Schema.String,
    /**
     * @description The individual segment within that pattern that failed to parse.
     */
    segment: Schema.String,
    /**
     * @description Which shape of pattern error it was. Distinguishes the two cases the parser raises, which read differently and mean different things to fix.
     */
    detail: Schema.Literals(['EmptyNamespace', 'MissingTag']),
  },

  /**
   * @description An expression was added to a set that has already been sealed. A sealed set is the compiled-pattern snapshot a parser consults per tag, so it is
   * frozen once configuration is done. Adding to it after sealing would mean mutating the thing the hot path reads.
   */
  SealedExpressionSet: {
    /**
     * @description How many expressions the set held when the add was refused. Carried so a caller can tell an almost-empty set from a full one, which are very
     * different mistakes.
     */
    size: Schema.Number,
  },

  /**
   * @description An entity name cannot be written as a reference, so it is refused at registration.
   */
  InvalidEntityName: {
    /**
     * @description The rejected name, as it was passed in.
     */
    name: Schema.String,
    /**
     * @description The offending character, or `#` for a name that starts with one. A leading `#` is refused by position rather than by the character sweep,
     * because a name starting with `#` is a numeric reference's token and would collide with the numeric pipeline.
     */
    character: Schema.String,
  },

  /**
   * @description A registration hook refused an entity and asked for the registration to abort.
   */
  EntityRejected: {
    /**
     * @description Which registration was in progress. Both are runtime-injected, which is why they share a tier for limit accounting.
     */
    context: Schema.Literals(['external', 'input']),
    /**
     * @description The entity name, without `&` or `;`.
     */
    name: Schema.String,
  },

  /**
   * @description A document expanded more tracked entity references than {@link EntityDecoderLimitOptions.maxTotalExpansions} allows. A document can define an
   * entity that references another ten times over. Ten deep is a denial of service; a hundred is a fork bomb written in XML.
   */
  ExpansionLimitExceeded: {
    /**
     * @description The count that tripped the limit. Deliberately not reset on failure, so this is the real over-limit total rather than the ceiling.
     */
    actual: Schema.Number,
    /**
     * @description The configured ceiling. The check is `actual > limit`, so a limit of `2` allows two expansions.
     */
    limit: Schema.Number,
  },

  /**
   * @description A document grew by more characters through entity expansion than {@link EntityDecoderLimitOptions.maxExpandedLength} allows. Only the surplus
   * counts: a reference whose replacement is no longer than the `&token;` it replaces contributes nothing, so this bounds growth rather than document
   * size.
   */
  ExpandedLengthLimitExceeded: {
    /**
     * @description The accumulated growth that tripped the limit.
     */
    actual: Schema.Number,
    /**
     * @description The configured ceiling.
     */
    limit: Schema.Number,
  },

  /**
   * @description A numeric character reference was prohibited by the configured policy.
   */
  ProhibitedCharacterReference: {
    /**
     * @description The raw token without `&` and `;`, e.g. `#38` or `#x26`.
     */
    token: Schema.String,
    /**
     * @description The codepoint the reference resolved to, so a log can name the character that was refused.
     */
    codepoint: Schema.Number,
  },
});

/**
 * @description The reason a well-formedness or policy failure occurred.
 */
export type XmlErrorReason = typeof XmlErrorReason.Type;

/**
 * @description Every failure this package can report, in the `E` channel of the effects that can fail. Carries both a `reason` — the typed, matchable cause — and
 * a `message`, which is the human-readable form the package has always produced. Both are part of the schema, so an error survives a round-trip
 * through a serialised boundary without losing either.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { Expression, XmlError } from '@endevops/common-xml';
 *
 *   const program = Effect.gen(function*() {
 *     const expression = yield* Expression.make('root.users.user');
 *     return expression.toString();
 *   });
 *   ```;
 */
export class XmlError extends Schema.TaggedError<XmlError>()('XmlError', {
  /**
   * @description The specific cause. Narrow on `_tag`, or recover with `Effect.catchReason`.
   */
  reason: XmlErrorReason,

  /**
   * @description Human-readable description. The `[EntityReplacer]` and `[EntityDecoder]` prefixes are reproduced verbatim from the original throw sites, because
   * they are documented as load-bearing for anything matching on them.
   */
  message: Schema.String,
}) {}
