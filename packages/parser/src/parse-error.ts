import type { BuilderError } from '@endevops/builder';
import type { XmlError } from '@endevops/common-xml';

import { Effect, Schema } from 'effect';

/**
 * @description The specific cause of a {@link ParseError}, as a tagged union. The `_tag` on each member is the parser's existing {@link ErrorCode} value, and is
 * the discriminant `Effect.catchReason` matches on.
 *
 * ## Why the tag is the code, and not a coarser grouping
 *
 * `@endevops/common-xml` and `@endevops/builder` both keep one error class and let `reason` narrow to the cause, because a caller recovering from
 * "any of these" should not have to enumerate classes. The same argument applies here, with one addition: `code` has been the parser's public
 * discriminant since the beginning — it is a documented field, a frozen table, and something a caller branches on. Renaming the axis or coarsening it
 * would break every existing `err.code === ErrorCode.X` and every `catchReason` a caller had already written, in exchange for grouping that grouping
 * does not buy: these are 37 conditions a caller may each want to treat differently (a limit violation is a rejection, an unclosed quote is a
 * malformed document), not facets of one decision. So the tag is the code, one for one, and what this adds over the old flat `code` is a **payload**:
 * the numbers and names a handler needs in order to decide something, which used to exist only inside an English sentence. A caller reading
 * `reason.limit` does not have to parse `"…exceeding limit of 50"` back out of `message`. Members with no data to carry — a truncated document, a
 * stream that is not a stream — carry no fields. That is deliberate: an empty payload says "there is nothing here to branch on", which is
 * information.
 */
export const ParseErrorReason = Schema.TaggedUnion({
  // ── Input type errors ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description A caller argument was not of a usable type or shape — a `limits` that is not an object, a stop-node entry that is neither a string nor an
   * `Expression`, a non-integer depth limit. `option` names the offending option when the failure is about one; `received` is its `typeof`, which is
   * what the message has always said.
   */
  INVALID_INPUT: { option: Schema.optional(Schema.String), received: Schema.optional(Schema.String) },

  /**
   * @description `parseStream` was handed something that is not a Node.js `Readable`. The check is structural, so a duck-typed stream is accepted and this is only
   * raised for a value that could not be one.
   */
  INVALID_STREAM: {},

  // ── Streaming / feed API ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description A `feed()` session is already open and the caller asked to start another.
   */
  ALREADY_STREAMING: {},

  /**
   * @description `end()` was called before any `feed()`. There is nothing to finalize, so it is refused rather than returning an empty tree that looks like a
   * successful parse of an empty document.
   */
  NOT_STREAMING: {},

  /**
   * @description `feed()` was handed something that is neither a string nor a `Buffer`. `received` is the `typeof`, which is what a caller needs to see to fix the
   * call.
   */
  DATA_MUST_BE_STRING: { received: Schema.String },

  // ── Tag structure ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description The source ran out mid-token. Almost always a chunk boundary rather than a bad document — `feed()` catches this one, rewinds to the token's start
   * and retries on the next chunk, so a caller only ever sees it from `end()`, where the document really is truncated. `reading` names what the
   * reader was waiting for, which the message has always carried.
   */
  UNEXPECTED_END: { reading: Schema.optional(Schema.String) },

  /**
   * @description A closing tag whose opener is nowhere on the stack — `</div>` with no `<div>` open. `tag` is the name as written.
   */
  UNEXPECTED_CLOSE_TAG: { tag: Schema.String },

  /**
   * @description A closing tag that does not match the tag on top of the stack. `tag` is the one that arrived, `expected` the one that was open; `expected` is
   * absent when the stack was empty.
   */
  MISMATCHED_CLOSE_TAG: { tag: Schema.String, expected: Schema.optional(Schema.String) },

  /**
   * @description The document ended with tags still open, or with trailing text, and no `autoClose` recovery is configured. Carries no field: the caller who wants
   * the detail configures `autoClose: { collectErrors: true }` and reads `getParseErrors()`, which names every unclosed tag individually. This error
   * says only that the document as a whole is incomplete.
   */
  UNEXPECTED_TRAILING_DATA: {},

  /**
   * @description Something after `<` is neither a tag, a closing tag, a comment, a CDATA section, nor a DOCTYPE. `tag` is the character that followed the `<`, so
   * the caller can see what the document actually said.
   */
  INVALID_TAG: { tag: Schema.optional(Schema.String) },

  /**
   * @description A `?>` was found inside an attribute value whose opening quote was never closed, in a processing instruction.
   */
  UNCLOSED_QUOTE: {},

  /**
   * @description A tag name failed XML's `Name` production. `name` is the name as written.
   */
  INVALID_TAG_NAME: { name: Schema.String },

  /**
   * @description An attribute name failed XML's `Name` production, or carried more than one namespace separator. `name` is as written, before any prefix
   * stripping.
   */
  INVALID_ATTRIBUTE_NAME: { name: Schema.String },

  // ── Namespace ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description A name carried more than one colon, so its namespace prefix cannot be resolved. `name` is as written.
   */
  MULTIPLE_NAMESPACES: { name: Schema.String },

  // ── Conformance ───────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description An illegal literal control character appeared where XML forbids one. `code` is the character code, and `in` says whether it was in an attribute
   * value or in document content — the two are raised from different scanners and a caller treating them differently has to know which. Note this is
   * the raw code, never a numeric character reference: `&#0;` is plain ASCII at this stage and is expanded later, by the builder's entity value
   * parser.
   */
  ILLEGAL_CHARACTER: { code: Schema.Number, in: Schema.Literals(['content', 'attribute']) },

  /**
   * @description The same attribute name appeared twice on one tag, under `attributes.duplicate: 'throw'`. `name` is the repeated name.
   */
  DUPLICATE_ATTRIBUTE: { name: Schema.String },

  /**
   * @description An attribute value was not wrapped in `"` or `'`. Never relaxed in any mode, and rejected before the value is consumed so it can never partially
   * reach the output. `name` is the attribute's name.
   */
  UNQUOTED_ATTRIBUTE_VALUE: { name: Schema.String },

  /**
   * @description A valueless (boolean) attribute was found under `attributes.booleanType: 'throw'`. `name` is the attribute's name.
   */
  BOOLEAN_ATTRIBUTE_REJECTED: { name: Schema.String },

  // ── Security ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description A name would actually pollute `Object.prototype` through the output object — `__proto__`, `constructor`, `prototype`. This check always runs and
   * `sanitizeNames` cannot turn it off; unlike the dangerous-but-cosmetic renames below, this one guards a real vulnerability. `name` is the
   * offending name.
   */
  SECURITY_PROTOTYPE_POLLUTION: { name: Schema.String },

  /**
   * @description An option value would become a reserved JavaScript property key in the output object. `option` is the option's name as a caller writes it
   * (`nameFor.text`), `value` the value that was refused.
   */
  SECURITY_RESERVED_OPTION: { option: Schema.String, value: Schema.String },

  /**
   * @description A name collided with a reserved output key under `strictReservedNames: true` — a tag named `#text` or `#comment`, or an attribute named the same
   * as `attributes.groupBy`. `name` is as written; `kind` says which collision it was.
   */
  SECURITY_RESTRICTED_NAME: { name: Schema.String, kind: Schema.Literals(['tag', 'attribute']) },

  // ── Limits (DoS prevention) ───────────────────────────────────────────────────────────────────────────────────

  /**
   * @description A tag would open deeper than `limits.maxNestedTags` allows. `limit` is the configured ceiling and `depth` the one that tripped it, so a caller
   * can tell "one level too deep" from "orders of magnitude too deep" without measuring the stack.
   */
  LIMIT_MAX_NESTED_TAGS: { limit: Schema.Number, depth: Schema.Number },

  /**
   * @description A tag carried more attributes than `limits.maxAttributesPerTag` allows. `limit` is the ceiling, `count` how many the tag had, `tag` which tag it
   * was. `count` counts every parsed attribute, including any later dropped for being a dropped `xmlns:` declaration, which is the limit's
   * long-standing semantics.
   */
  LIMIT_MAX_ATTRIBUTES: { limit: Schema.Number, count: Schema.Number, tag: Schema.String },

  // ── Entity limits ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description A DOCTYPE internal subset declared more entities than `doctypeOptions.maxEntityCount` allows. `actual` is the count that tripped it and `limit`
   * the configured ceiling.
   */
  ENTITY_MAX_COUNT: { actual: Schema.Number, limit: Schema.Number },

  /**
   * @description One entity's replacement text was longer than `doctypeOptions.maxEntitySize` allows. `actual` is that length, `limit` the ceiling, `name` the
   * entity.
   */
  ENTITY_MAX_SIZE: { actual: Schema.Number, limit: Schema.Number, name: Schema.String },

  /**
   * @description A document expanded more tracked entity references than the decoder's `maxTotalExpansions` allows. A document can define one entity that
   * references another ten times over; ten deep is a denial of service, a hundred is a fork bomb written in XML. `actual` is the true over-limit
   * total, deliberately not reset on failure. Raised by `@endevops/common-xml`'s decoder and mapped in, not by the parser itself.
   */
  ENTITY_MAX_EXPANSIONS: { actual: Schema.Number, limit: Schema.Number },

  /**
   * @description A document grew by more characters through entity expansion than the decoder's `maxExpandedLength` allows. `actual` is the surplus: only growth
   * counts, so a reference no longer than the `&token;` it replaces contributes nothing. Raised by `@endevops/common-xml`'s decoder and mapped in,
   * not by the parser itself.
   */
  ENTITY_MAX_EXPANDED_LENGTH: { actual: Schema.Number, limit: Schema.Number },

  // ── Entity registration ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description An entity name cannot be written as a reference, so it is refused at declaration. `name` is the rejected name.
   */
  ENTITY_INVALID_KEY: { name: Schema.String },

  /**
   * @description An entity's replacement text was refused — a parameter entity, an external entity, or a value the DOCTYPE reader could not accept. `name` is the
   * entity, when it was readable.
   */
  ENTITY_INVALID_VALUE: { name: Schema.optional(Schema.String) },

  // ── Encoding ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description The document declares or requests an encoding no registered decoder can handle. `encoding` is the name as asked for, which is also what the
   * caller has to register.
   */
  UNSUPPORTED_ENCODING: { encoding: Schema.String },

  /**
   * @description A registered custom decoder is not usable — a `createDecoder` that returned nothing, or a decoder missing a method the incremental path needs.
   * `encoding` is the name it was registered under.
   */
  INVALID_DECODER: { encoding: Schema.optional(Schema.String) },

  /**
   * @description The encoding a document declares contradicts the bytes it was delivered in. `declared` is what the `<?xml?>` said, `actual` what detection found.
   * A caller that trusts bytes over declarations — the usual choice — recovers by reading `actual`.
   */
  ENCODING_MISMATCH: { declared: Schema.String, actual: Schema.String },

  // ── Upstream ────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * @description A failure reported by one of the two packages the parser calls, mapped into this error so a caller has one type to branch on rather than three.
   * `package` says which one reported it, and `cause` is its message verbatim — several of those messages are documented as load-bearing and are
   * matched on by callers, so nothing is reworded on the way through.
   */
  DEPENDENCY_ERROR: { package: Schema.Literals(['@endevops/common-xml', '@endevops/builder']), cause: Schema.String },
});

/**
 * @description The reason a parse, a configuration, or a document failed.
 */
export type ParseErrorReason = typeof ParseErrorReason.Type;

/**
 * @description ParseError — the one type in the `E` channel of every effect this package returns. A caller can therefore distinguish library failures from generic
 * runtime ones, inspect the machine-readable `reason` rather than a message, and read position information without parsing prose.
 *
 * ## The three shapes a caller sees
 *
 * - `reason` — the typed, matchable cause, carrying the numbers and names a handler needs.
 * - `message` — the human-readable form the package has always produced. Kept, and kept verbatim, because it is part of the contract and the test suite
 *   asserts on it.
 * - `index` — 0-based offset from document start, absent when the failure has no position.
 *
 * ## Why the walk still throws this
 *
 * The parser's readers still _throw_ `ParseError` rather than returning it. A document is walked character by character, and routing every reader
 * through a generator would cost an allocation per tag to deliver a failure the caller has not been told about yet. The effect boundary is the public
 * API — `XMLParser.make`, `.parse`, `.end` — and `toParseError` is what converts an escaped throw into the channel. Upstream `XmlError` and
 * `BuilderError` are mapped rather than unioned, so a caller never has to branch on three types.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import XMLParser, { ParseError } from '@endevops/parser';
 *
 *   const program = Effect.gen(function* () {
 *     const parser = yield* XMLParser.make({ limits: { maxNestedTags: 100 } });
 *     return yield* parser.parse(xml);
 *   });
 *
 *   // Recover from one cause, with its payload, and let the rest through
 *   const recovered = Effect.catchReason(program, 'ParseError', 'LIMIT_MAX_NESTED_TAGS', reason =>
 *     Effect.succeed({ rejected: true, atDepth: reason.depth }),
 *   );
 *   ```;
 */
export class ParseError extends Schema.TaggedError<ParseError>()('ParseError', {
  /**
   * @description The specific cause. Narrow on `_tag`, or recover with `Effect.catchReason`.
   */
  reason: ParseErrorReason,

  /**
   * @description Human-readable description. Reproduced verbatim from the message the equivalent `throw` has always carried; several are asserted by name in the
   * test suite and are the documented contract.
   */
  message: Schema.String,

  /**
   * @description 0-based character offset from document start. Absent when the failure has no position to report — a rejected configuration, or a limit checked
   * before the document was read.
   */
  index: Schema.optional(Schema.Number),
}) {
  /**
   * @description The machine-readable code, as a convenience alias for `reason._tag`. The two cannot disagree, because the tag _is_ the code — this exists so the
   * many existing `err.code === ErrorCode.ILLEGAL_CHARACTER` comparisons, and the ones a caller has already written, keep reading the way they always
   * have.
   */
  get code(): ErrorCodeValue {
    return this.reason._tag;
  }

  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this.name} [${this.code}]${position}: ${this.message}`;
  }
}

/**
 * @description Build a {@link ParseError}. A function rather than leaving every call site to write `new ParseError({ reason, message, index })`, because the parser
 * raises this from about a hundred places and the props object would be repeated noise at every one.
 *
 * @param reason - The cause, with whatever payload that cause carries.
 * @param message - Human-readable description, kept as the package has always worded it.
 * @param index - 0-based offset from document start. Omit when the failure has no position.
 *
 * @returns The error, ready to throw or to `yield*`.
 */
export const parseError = (reason: ParseErrorReason, message: string, index?: number): ParseError =>
  new ParseError({ reason, message, ...(index === undefined ? {} : { index }) });

/**
 * @description Turn a failure from either upstream package into a {@link ParseError}. Both report through a typed channel rather than by throwing, and a caller of
 * `parse()` should not have to branch on three error types to recover from a bad document. The upstream `message` is carried across verbatim: the
 * entity-limit messages in particular are documented as something callers match on.
 *
 * @param cause - The failure one of the two dependencies reported.
 *
 * @returns The equivalent {@link ParseError}, tagged `DEPENDENCY_ERROR` and naming which package reported it.
 */
export const fromUpstreamError = (cause: XmlError | BuilderError): ParseError =>
  parseError(
    {
      _tag: ErrorCode.DEPENDENCY_ERROR,
      package: 'cause' in cause && cause.name === 'BuilderError' ? '@endevops/builder' : '@endevops/common-xml',
      cause: cause.message,
    },
    cause.message
  );

/**
 * @description Run a `common-xml` effect in the middle of a synchronous decision, mapping its failure into a thrown {@link ParseError}. Every `common-xml` call
 * the parser makes — a path match, a depth, a sibling counter, a name validator — happens inside a synchronous walk over the document, and its answer
 * is needed immediately: a stop-node check has to know _now_ whether this tag is a stop node, not two generator steps from now. So the effect is run
 * here, and an effect read as a value is exactly the bug this guards against — an `Effect` is an object, and an object is truthy, which would make
 * every match succeed and every validator pass. The `common-xml` members the parser calls cannot fail for the values it passes them — a literal
 * production, a matcher the parser owns — so reaching the failure branch would mean a defect rather than a bad document. The mapping is here anyway,
 * because leaving it out would make the next member added to `common-xml` throw a `FiberFailure` from inside the parser.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {ParseError} `DEPENDENCY_ERROR` when the effect fails.
 */
export const runXml = <A>(effect: Effect.Effect<A, XmlError>): A => Effect.runSync(Effect.mapError(effect, fromUpstreamError));

/**
 * @description Run a `@endevops/builder` effect in the middle of a synchronous decision, mapping its failure into a thrown {@link ParseError}. The builder's
 * counterpart to {@link runXml}, and for the same reason: `closeElement` and `addAttribute` are called once per tag from the synchronous walk, and
 * both can genuinely fail — on an entity expansion limit, or a value processor a caller supplied.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {ParseError} `DEPENDENCY_ERROR` when the effect fails.
 */
export const runBuilder = <A>(effect: Effect.Effect<A, BuilderError>): A => Effect.runSync(Effect.mapError(effect, fromUpstreamError));

/**
 * @description Convert anything that escaped a parser entry point into the `E` channel. The public API promises `ParseError` and nothing else, and the path into
 * it is wide open: a `ParseError` a reader threw, a `BuilderError` a builder subclass threw from a method the base declares `void`, or a genuine
 * defect in a caller's own callback. A `ParseError` passes through unchanged so its `reason` and `index` survive; anything else is wrapped rather
 * than allowed to escape as a second error type.
 *
 * @param cause - Whatever escaped.
 *
 * @returns The equivalent {@link ParseError}.
 */
export const toParseError = (cause: unknown): ParseError => {
  if (cause instanceof ParseError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return parseError({ _tag: ErrorCode.DEPENDENCY_ERROR, package: '@endevops/builder', cause: message }, message);
};

/**
 * @description All error codes thrown by the parser. Frozen, and typed as a literal map, so `err.code === ErrorCode.XXX` narrows and a typo is a compile error
 * rather than a silently-never-true comparison at runtime.
 */
export const ErrorCode = Object.freeze({
  // Input type errors
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_STREAM: 'INVALID_STREAM',

  // Streaming / feed API
  ALREADY_STREAMING: 'ALREADY_STREAMING',
  NOT_STREAMING: 'NOT_STREAMING',
  DATA_MUST_BE_STRING: 'DATA_MUST_BE_STRING',

  // Tag structure
  UNEXPECTED_END: 'UNEXPECTED_END',
  UNEXPECTED_CLOSE_TAG: 'UNEXPECTED_CLOSE_TAG',
  MISMATCHED_CLOSE_TAG: 'MISMATCHED_CLOSE_TAG',
  UNEXPECTED_TRAILING_DATA: 'UNEXPECTED_TRAILING_DATA',
  INVALID_TAG: 'INVALID_TAG',
  UNCLOSED_QUOTE: 'UNCLOSED_QUOTE',
  INVALID_TAG_NAME: 'INVALID_TAG_NAME',
  INVALID_ATTRIBUTE_NAME: 'INVALID_ATTRIBUTE_NAME',

  // Namespace
  MULTIPLE_NAMESPACES: 'MULTIPLE_NAMESPACES',

  // Conformance (illegal chars, attribute value rules)
  ILLEGAL_CHARACTER: 'ILLEGAL_CHARACTER',
  DUPLICATE_ATTRIBUTE: 'DUPLICATE_ATTRIBUTE',
  UNQUOTED_ATTRIBUTE_VALUE: 'UNQUOTED_ATTRIBUTE_VALUE',
  BOOLEAN_ATTRIBUTE_REJECTED: 'BOOLEAN_ATTRIBUTE_REJECTED',

  // Security
  SECURITY_PROTOTYPE_POLLUTION: 'SECURITY_PROTOTYPE_POLLUTION',
  SECURITY_RESERVED_OPTION: 'SECURITY_RESERVED_OPTION',
  SECURITY_RESTRICTED_NAME: 'SECURITY_RESTRICTED_NAME',

  // Limits (DoS prevention)
  LIMIT_MAX_NESTED_TAGS: 'LIMIT_MAX_NESTED_TAGS',
  LIMIT_MAX_ATTRIBUTES: 'LIMIT_MAX_ATTRIBUTES',

  // Entity limits
  ENTITY_MAX_COUNT: 'ENTITY_MAX_COUNT',
  ENTITY_MAX_SIZE: 'ENTITY_MAX_SIZE',
  ENTITY_MAX_EXPANSIONS: 'ENTITY_MAX_EXPANSIONS',
  ENTITY_MAX_EXPANDED_LENGTH: 'ENTITY_MAX_EXPANDED_LENGTH',

  // Entity registration
  ENTITY_INVALID_KEY: 'ENTITY_INVALID_KEY',
  ENTITY_INVALID_VALUE: 'ENTITY_INVALID_VALUE',

  // Encoding
  UNSUPPORTED_ENCODING: 'UNSUPPORTED_ENCODING',
  INVALID_DECODER: 'INVALID_DECODER',
  ENCODING_MISMATCH: 'ENCODING_MISMATCH',

  // Upstream
  //
  // The parser's two dependencies already report their own typed failures, and a caller
  // of `parse()` should not have to branch on three error types to handle a parse. So
  // they are mapped into this one, the upstream message is preserved verbatim in
  // `message` (several are documented as load-bearing, and the test suite matches on
  // them), and this code says where the failure actually came from.
  DEPENDENCY_ERROR: 'DEPENDENCY_ERROR',
} as const);

/**
 * @description Union of every {@link ErrorCode} value — the type of {@link ParseError.code}.
 */

/**
 * @description Union of every {@link ErrorCode} value — the type of {@link ParseError.code}, and the `_tag` of each {@link ParseErrorReason} member.
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * @description The two vocabularies are the same list, and nothing at runtime stops someone adding a code to one and forgetting the other — the table would gain a
 * name the union cannot be constructed with, or a reason no table entry documents. The compiler is what keeps them in step: a code with no reason
 * member, or a reason whose tag is not a code, fails to type-check here rather than at some call site weeks later. `Record<ErrorCodeValue, true>` for
 * the table's side (every code must be a reason) and `ParseErrorReason['_tag']` for the union's (every reason must be a code). Either direction
 * failing is a compile error; neither has a runtime cost, because this is a type and a type assertion.
 */
type _EveryCodeHasAReason = Record<ErrorCodeValue, true> extends Record<ParseErrorReason['_tag'], true> ? true : never;
type _EveryReasonHasACode = ParseErrorReason['_tag'] extends ErrorCodeValue ? true : never;

/**
 * @description Compile-time proof that {@link ErrorCode} and {@link ParseErrorReason} name the same set. Exported only so the declaration is used and the linter
 * does not read it as dead; it has no runtime effect and nothing should ever import it.
 */
export type _ErrorCodeParity = [_EveryCodeHasAReason, _EveryReasonHasACode] extends [true, true] ? true : never;

export default ParseError;
