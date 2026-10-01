/**
 * @description Every way this package can fail, as one typed error. The builder threw from eleven places across four areas — the value-parser registry, the two
 * base classes a subclass is meant to override, the XML-safety predicates, the compact-builder options, and the two recursion limits. As with
 * `@endevops/common-xml`, a caller recovering from a specific failure had to match on message text. All of it is now one {@link BuilderError} in the
 * `E` channel of the effects that can fail, with the specific cause in a `reason` field rather than parsed back out of a string.
 *
 * ## Why one error with a `reason`, and not one error per cause
 *
 * Seven causes, and they are not seven independent decisions a caller usually makes. Six of them are "this configuration is wrong" — the two
 * base-class stubs, the registry's four validations, the options check, the argument type check — and one is "this document is too deep to build".
 * The useful split a caller makes is coarse: fix the configuration, or reject the document. So there is one error and `reason` narrows to the cause,
 * which is a `catchReason` away.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { XMLBuilder } from '@endevops/builder';
 *
 *   const program = Effect.gen(function* () {
 *   const builder = yield* XMLBuilder.make({ maxNestedTags: 256 });
 *   return yield* builder.build({ a: { b: 'c' } });
 *   });
 *
 *   Effect.catchReason(program, 'BuilderError', 'MaxNestingExceeded', (reason) =>
 *   Effect.succeed(`refused at depth ${reason.depth}`)
 *   );
 *   ```
 *
 *   The messages are reproduced verbatim from what the package used to throw. Several of them are
 *   asserted by name in the test suite and are the documented contract, so none is reworded.
 */

import type { ExpressionSet, XmlError } from '@endevops/common-xml';

import { Expression } from '@endevops/common-xml';
import { Effect, Schema } from 'effect';

/**
 * @description The specific cause of a {@link BuilderError}, as a tagged union. The `_tag` on each member is the discriminant `Effect.catchReason` matches on, and
 * the payload is what a handler needs in order to decide or to report.
 */
export const BuilderErrorReason = Schema.TaggedUnion({
  /**
   * @description A value parser was registered under a name the registry cannot use, or is missing a method the pipeline requires. Validation is deliberately
   * strict, and happens at registration rather than inside a pipeline run where the stack would point at the wrong place: `reset` is required even
   * though {@link ValueParser} marks it optional, because the pipeline calls it between documents and a parser that cannot be reset leaks state.
   */
  InvalidValueParser: {
    /**
     * @description The name the caller passed, as a string. A non-string name is stringified, so the message still says what arrived.
     */
    name: Schema.String,
    /**
     * @description What was wrong, in the words the original messages used.
     */
    problem: Schema.Literals(['name must be a string', 'parser is required', 'parser must implement reset()', 'parser must implement parse()']),
  },

  /**
   * @description A pipeline referenced a parser name nothing is registered under.
   */
  ValueParserNotFound: {
    /**
     * @description The name the pipeline asked for.
     */
    name: Schema.String,
  },

  /**
   * @description A base-class member was reached that a subclass is meant to override. Always a programming error in the subclass rather than in the document,
   * which is why it is one reason rather than several: the two members that raise it — `BaseOutputBuilderFactory.getInstance` and
   * `BaseValueParser.parse` — want the same handling.
   */
  NotImplemented: {
    /**
     * @description The member that was not overridden.
     */
    member: Schema.Literals(['getInstance', 'parse']),
  },

  /**
   * @description A value that had to be a string was not. The XML-safety predicates reject rather than coerce, because a silent `String(value)` would produce
   * something the rules were never written to judge — and `String(null)` is `'null'`, which no rule flags, so the value would be allowed through
   * unchecked.
   */
  InvalidArgument: {
    /**
     * @description The function that was called.
     */
    function: Schema.Literals(['isUnsafeXml', 'whyUnsafeXml', 'allUnsafeXml']),
    /**
     * @description What the argument was, as `typeof` reports it.
     */
    received: Schema.String,
  },

  /**
   * @description An option entry was neither a usable pattern string nor a pre-compiled expression.
   */
  InvalidOptionEntry: {
    /**
     * @description The option being built, as it appears in the message — `alwaysArray`, `forceArray`, and so on.
     */
    option: Schema.String,
    /**
     * @description What was wrong with the entry.
     */
    problem: Schema.Literals(['expression cannot be empty', 'expected a string, or Expression']),
  },

  /**
   * @description A document nests deeper than `maxNestedTags` allows. A depth limit rather than a stack-overflow guard: the walk recurses once per level, so a
   * document crafted to exhaust the stack is a denial of service the caller has to be able to refuse deliberately.
   */
  MaxNestingExceeded: {
    /**
     * @description The configured ceiling.
     */
    limit: Schema.Number,
    /**
     * @description The depth that tripped it.
     */
    depth: Schema.Number,
  },

  /**
   * @description A caller-supplied `sanitizeName` callback threw. `sanitizeName` is the one place a caller's own code runs inside the walk, and it is called only
   * for names that already failed QName validation — so a document of valid names never reaches it. Its throw is captured here rather than left to
   * escape as a defect, which keeps the failure in the channel a caller is already handling.
   */
  NameResolutionFailed: {
    /**
     * @description The name the callback was given.
     */
    name: Schema.String,
    /**
     * @description The callback's own message, preserved so a caller matching on it still can.
     */
    cause: Schema.String,
  },

  /**
   * @description A path expression configured on the builder would not compile. `stopNodes`, `alwaysArray`, `forceArray` and the whitespace normalizer's `exclude`
   * are all patterns, and `@endevops/common-xml` rejects one that will not parse. That failure is an `XmlError` there, mapped into a
   * {@link BuilderError} rather than left to widen this package's error channel to a union of two types a caller would then branch on twice.
   */
  PatternCompilationFailed: {
    /**
     * @description The pattern that would not compile.
     */
    pattern: Schema.String,
    /**
     * @description The message `common-xml` produced, naming the offending segment and what was wrong with it. Carried through verbatim so nothing is lost in the
     * mapping.
     */
    cause: Schema.String,
  },

  /**
   * @description A caller-supplied value processor failed. `tagValueProcessor` and `attributeValueProcessor` are hooks, and the point of a hook is that the
   * caller's code runs inside the walk. Both return an effect, so a processor can run its own effect; a failure it reports is mapped here rather than
   * left to widen this package's channel to a union, and the caller's own message rides along in `cause`.
   */
  ValueProcessingFailed: {
    /**
     * @description Which hook was called, as it appears in the options.
     */
    hook: Schema.Literals(['tagValueProcessor', 'attributeValueProcessor']),
    /**
     * @description The tag or attribute the processor was given.
     */
    name: Schema.String,
    /**
     * @description The failure's own message, preserved so a caller matching on it still can.
     */
    cause: Schema.String,
  },

  /**
   * @description A value could not be entity-decoded. Two causes reach it, and they are not the same: a reference that is simply malformed (`&foo` with no
   * semicolon) is a document that is wrong, while an input entity the security rules refuse is a document that is hostile. `cause` is `common-xml`'s
   * own message, which distinguishes them, and it is the security case that matters — an `ENTITY_DECL` is attacker-controlled whenever the document
   * is.
   */
  EntityDecodingFailed: {
    /**
     * @description The value that could not be decoded.
     */
    value: Schema.String,
    /**
     * @description The message `common-xml`'s decoder produced.
     */
    cause: Schema.String,
  },
});

/**
 * @description The reason a build, a configuration, or a predicate failed.
 */
export type BuilderErrorReason = typeof BuilderErrorReason.Type;

/**
 * @description Every failure this package can report, in the `E` channel of the effects that can fail. Carries both a `reason` — the typed, matchable cause — and
 * a `message`, which is the human-readable form the package has always produced.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { XMLBuilder } from '@endevops/builder';
 *
 *   const program = Effect.gen(function* () {
 *     const builder = yield* XMLBuilder.make();
 *     return yield* builder.build({ a: { '@_id': '1', '#text': 'hello' } });
 *   });
 *   // '<a id="1">hello</a>'
 *   ```;
 */
export class BuilderError extends Schema.TaggedError<BuilderError>()('BuilderError', {
  /**
   * @description The specific cause. Narrow on `_tag`, or recover with `Effect.catchReason`.
   */
  reason: BuilderErrorReason,

  /**
   * @description Human-readable description, reproduced verbatim from the message the equivalent `throw` used to carry.
   */
  message: Schema.String,
}) {}

/**
 * @description Turn a pattern-compilation failure from `@endevops/common-xml` into a {@link BuilderError}. The builder's patterns — `stopNodes`, `alwaysArray`,
 * `forceArray`, a whitespace normalizer's `exclude` — are compiled by `common-xml`, which reports a bad one as its own `XmlError`. Left alone, that
 * would make this package's error channel `BuilderError | XmlError` and every caller would branch on two types. Mapping keeps one, and the underlying
 * message rides along in `cause` so the detail survives.
 *
 * @param pattern - The pattern that was being compiled.
 * @param cause - The `XmlError` `common-xml` reported.
 *
 * @returns The equivalent {@link BuilderError}.
 */
export const fromPatternError = (pattern: string, cause: XmlError): BuilderError =>
  new BuilderError({ reason: { _tag: 'PatternCompilationFailed', pattern, cause: cause.message }, message: cause.message });

/**
 * @description Compile a pattern, mapping a failure into this package's error type. The one place a `common-xml` error crosses into a `BuilderError`, so every
 * call site does the same mapping and none of them can forget.
 *
 * @param pattern - The pattern to compile.
 *
 * @returns An effect producing the expression. Fails with the `PatternCompilationFailed` reason.
 */
export const compilePattern = (pattern: string): Effect.Effect<Expression, BuilderError> =>
  Effect.mapError(Expression.make(pattern), cause => fromPatternError(pattern, cause));

/**
 * @description Add a compiled expression to a set, mapping a failure into this package's error type. `ExpressionSet.add` reports a sealed set with `common-xml`'s
 * own `XmlError`. Every builder that assembles a set of stop nodes, `alwaysArray` paths or whitespace exclusions goes through here, so none of them
 * has to remember the mapping.
 *
 * @param set - The set to add to.
 * @param expression - The compiled expression to add.
 *
 * @returns An effect producing the set. Fails with the `PatternCompilationFailed` reason.
 */
export const addToSet = (set: ExpressionSet, expression: Expression): Effect.Effect<ExpressionSet, BuilderError> =>
  Effect.mapError(set.add(expression), cause => fromPatternError(expression.pattern, cause));

/**
 * @description The depth limit tripped, as a typed failure. The one place the two recursion limits are reported, so `ordered` and `xml-builder` cannot drift into
 * describing the same refusal differently.
 *
 * @param limit - The configured `maxNestedTags` ceiling.
 * @param depth - The depth that tripped it.
 *
 * @returns An effect that always fails with the `MaxNestingExceeded` reason.
 */
export const nestingExceeded = (limit: number, depth: number): Effect.Effect<never, BuilderError> =>
  Effect.fail(new BuilderError({ reason: { _tag: 'MaxNestingExceeded', limit, depth }, message: 'Maximum nested tags exceeded' }));

/**
 * @description Run a caller-supplied name resolver, capturing a throw as a typed failure. `sanitizeName` is the one place a caller's own code runs inside the
 * walk, and it is synchronous by design — a resolver is usually `sanitize(name, 'qName')`. This is the boundary where that decision is paid for: the
 * throw is turned into the `NameResolutionFailed` reason rather than left to escape as a defect, so a rejecting resolver is something a caller
 * handles in the same channel as every other build failure.
 *
 * @param name - The name the resolver was given.
 * @param resolve - The call to make.
 *
 * @returns An effect producing the resolver's result.
 */
export const tryResolveName = <A>(name: string, resolve: () => A): Effect.Effect<A, BuilderError> =>
  Effect.try({
    try: resolve,
    catch: cause => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return new BuilderError({ reason: { _tag: 'NameResolutionFailed', name, cause: message }, message });
    },
  });

/**
 * @description The depth limit tripped, as a typed failure. The one place the two recursion limits are reported, so `ordered` and `xml-builder` cannot drift into
 * describing the same refusal differently.
 *
 * @param limit - The configured `maxNestedTags` ceiling.
 * @param depth - The depth that tripped it.
 *
 * @returns An effect that always fails with the `MaxNestingExceeded` reason.
 */

/**
 * @description Run one caller-supplied value processor, mapping a failure into this package's error. The hooks are the last place a caller's own code runs on the
 * way out, and a processor may itself be effectful. Mapping rather than letting the caller's error type leak keeps one error channel, and the message
 * rides along in `cause` so nothing is lost. Both walks need this, and neither should report a processor failure differently from the other, so it
 * lives here rather than beside either one.
 *
 * @param hook - Which processor is being run, named in the failure.
 * @param name - The tag or attribute the processor was given.
 * @param run - The call to make.
 *
 * @returns An effect producing the processor's result.
 */
export const runValueProcessor = (
  hook: 'tagValueProcessor' | 'attributeValueProcessor',
  name: string,
  run: () => Effect.Effect<string | undefined, unknown>
): Effect.Effect<string | undefined, BuilderError> =>
  Effect.mapError(run(), cause => {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new BuilderError({ reason: { _tag: 'ValueProcessingFailed', hook, name, cause: message }, message });
  });
