import type { BuilderError } from '@endevops/builder';
import type { Expression as PathExpression } from '@endevops/common-xml';

import { CompactBuilderFactory } from '@endevops/builder';
import { Expression, ExpressionSet } from '@endevops/common-xml';
import { Effect, Predicate } from 'effect';

import type { OutputBuilderFactoryLike } from './internal/parser-types.ts';
import type { TagExpressionConfig } from './internal/tag-expression.ts';
import type { AutoCloseInput, AutoCloseOptions, ResolvedOptions, StopNodeEntry, X2jOptions } from './options.ts';

import { InvalidInput, SecurityReservedOption, fromUpstreamError, type ParseError } from './parse-error.js';
import { DANGEROUS_PROPERTY_NAMES, criticalProperties } from './util.js';

/**
 * @description A path expression carrying this parser's per-entry stop-node/skip-tag config. `@endevops/common-xml` is generic over the payload, so the type
 * argument is all that is needed to keep `.data` typed from construction through to `findMatch()`. The alias exists because the type appears on both
 * sides of this file and the full instantiation is noisy.
 */
type ConfigExpression = PathExpression<TagExpressionConfig>;

/**
 * @description The default output builder factory, adapted to the structural contract the parser drives. `CompactBuilderFactory` already implements the right
 * shape at runtime, but `@nodable/compact-builder`'s published typings declare `onStopNode()` and `onExit()` as taking `{ name, line, col, index }`
 * while FXP reports positions index-only and never produces `line` / `col` (see `BufferSource`'s doc on why line/column tracking was dropped).
 * Nominal compatibility is therefore unattainable without changing the dependency, so the adaptation is done once, here, where it can be explained —
 * rather than at every builder call site. `make` rather than a constructor because resolving a factory's own options can fail.
 */
const DefaultOutputBuilderFactory = CompactBuilderFactory as unknown as { make: () => Effect.Effect<OutputBuilderFactoryLike, BuilderError> };

/**
 * @description Default rename applied to a dangerous (but not prototype-polluting) property name. Anything not on the list is returned unchanged, so this is safe
 * to call for every name in the document.
 */
const defaultOnDangerousProperty = (name: string): string => {
  if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
    return '__' + name;
  }
  return name;
};

/**
 * @description Every option, with its default. `buildOptions()` deep-clones this, merges the caller's options over it, then normalizes the derived fields.
 * Documented per field where the reasoning isn't obvious from the code; the comments that were purely historical (why an option exists at all) are
 * kept, because they are the only record of why the default is what it is.
 */
const defaultOptions: ResolvedOptions = {
  // --- skip group ---
  // Controls which node types are excluded from output
  skip: {
    declaration: false, // Skip <?xml ... ?> declaration
    pi: false, // Skip processing instructions (other than declaration)
    attributes: true, // Skip all attributes
    cdata: false, // Exclude CDATA sections from output entirely
    comment: false, // Exclude comments from output entirely
    nsPrefix: false, // Strip namespace prefixes (e.g. ns:tag → tag)
    tags: [], // Tag paths to skip entirely — content is silently dropped from output
    whitespaceText: true, // addValue() of a builder would not be called if text is only whitespaces
    tagsSet: new ExpressionSet(), // populated by buildOptions(); empty here so the object is a complete ResolvedOptions
  },

  // --- nameFor group ---
  // Property names used when including special nodes in output.
  nameFor: {
    text: '#text', // Property for mixed text content
    cdata: '', // '' = merge CDATA into text value
    comment: '', // '' = omit comments from output
  },

  // --- attributes group ---
  attributes: {
    // 'allow' (default) keeps a valueless attribute (e.g. <e flag/>) as `true`.
    // 'ignore' drops it silently; 'throw' rejects the document as soon as one
    // is found. Replaces a previous same-named boolean option that had no
    // effect on parsing (it was never read anywhere in the parsing code).
    booleanType: 'allow',
    // 'overwrite' (default) — last occurrence of a repeated attribute name wins.
    // 'ignore' — first occurrence wins, later ones are dropped entirely.
    // 'throw' — reject the document as soon as a repeated name is found on one tag.
    duplicate: 'overwrite',
    groupBy: '', // Group all attributes under this key; '' = inline with tag
    prefix: '@_', // Prepended to attribute names in output
    suffix: '', // Appended to attribute names in output
  },

  // --- tags group ---
  tags: {
    unpaired: [], // Tags that never have a closing tag (e.g. br, img, hr)
    stopNodes: [], // Tag paths whose content is captured raw without parsing
    stopNodesSet: new ExpressionSet(), // populated by buildOptions(); empty here so the object is a complete ResolvedOptions
  },

  // --- security ---
  strictReservedNames: false,
  onDangerousProperty: defaultOnDangerousProperty,
  // sanitizeNames: false skips the dangerous-property rename step only
  // (hasOwnProperty, toString, valueOf, ... pass through unprefixed,
  // onDangerousProperty is never called for them). It does NOT disable the
  // critical-property check (__proto__, constructor, prototype) — that
  // guards against actual prototype pollution and always runs. Only for
  // trusted input — internal XML-to-XML pipelines, generated documents —
  // where the source is known not to contain hostile names. Does NOT affect
  // strictReservedNames, which is a separate, independent check.
  sanitizeNames: true,

  // --- filtering (path-expression-matcher) ---
  only: [], // for future

  // --- DOCTYPE parsing ---
  // Controls whether DOCTYPE entities are collected and read-time security limits.
  //
  //   enabled         — false (default) → DOCTYPE is read (to consume it) but entities
  //                                        are discarded and never forwarded to output builders
  //                     true → collect DOCTYPE entities and forward them to the output builder
  //                     Note: the output builder must have an EntitiesValueParser registered
  //                     under 'entity' and 'entity' must be in its
  //                     valueParsers chain for replacement to actually happen.
  //
  // Read-time security limits (enforced by DocTypeReader at declaration time):
  //   maxEntityCount  — max entities declared in a DOCTYPE (default: 100)
  //   maxEntitySize   — max bytes per entity definition value (default: 10000)
  //
  // Replacement-time limits (maxTotalExpansions, maxExpandedLength) are configured
  // on EntitiesValueParser directly — they are not part of doctypeOptions.
  doctypeOptions: { enabled: false, maxEntityCount: 100, maxEntitySize: 10000 },

  // --- autoClose ---
  // Controls parser behaviour when tags are unclosed or mismatched.
  //
  //   onEof       — what to do when EOF is reached with open tags still on the stack
  //                 'throw'    (default) → throw an error
  //                 'closeAll' → silently close all remaining open tags
  //
  //   onMismatch  — what to do when a closing tag doesn't match the current open tag
  //                 'throw'   (default) → throw an error
  //                 'recover' → pop the stack toward the nearest matching opener;
  //                             if no match is found the tag is discarded
  //                 'discard' → silently ignore the bad closing tag
  //
  //   collectErrors — when true, errors are recorded in result.__parseErrors instead
  //                   of being silently dropped.  Each entry has the shape:
  //                   { type, tag, expected, index }
  //
  // Shorthand: autoClose: 'html' sets onEof:'closeAll', onMismatch:'discard',
  // collectErrors:true, and adds the standard HTML void elements to tags.unpaired.
  autoClose: null, // null = feature disabled; throws on any malformed input

  // --- limits (DoS prevention) ---
  // Group structural limits that guard against resource exhaustion.
  //
  //   maxNestedTags     — maximum tag nesting depth; throws when exceeded.
  //                       Prevents stack-overflow attacks via deeply nested XML.
  //                       Default: null (no limit)
  //
  //   maxAttributesPerTag — maximum number of attributes on a single tag.
  //                         Throws when a tag exceeds this count.
  //                         Default: null (no limit)
  //
  limits: { maxNestedTags: null, maxAttributesPerTag: null },

  // --- feedable (feed/end and parseStream input options) ---
  // Controls buffer behaviour for the FeedableSource and StreamSource.
  //
  //   maxBufferSize  — maximum number of characters allowed in the buffer at
  //                    any one time.  Prevents memory exhaustion when a caller
  //                    feeds data faster than it is consumed.
  //                    Default: 10 MB (10 * 1024 * 1024 characters)
  //
  //   autoFlush      — when true (default), already-processed characters are
  //                    automatically discarded from the front of the buffer
  //                    whenever the processed portion exceeds flushThreshold.
  //                    Keeps memory usage flat for large documents.
  //
  //   flushThreshold — number of processed characters that triggers an auto-
  //                    flush.  Lower values free memory sooner but incur more
  //                    string-slice operations.  Default: 1024 characters (1 KB)
  //
  feedable: { maxBufferSize: 10 * 1024 * 1024, autoFlush: true, flushThreshold: 1024, bufferSize: 256 },

  // --- exitIf ---
  // Stops parsing as soon as the predicate returns true for the current tag.
  //
  // The callback receives a read-only matcher positioned at the just-opened tag:
  //   exitIf(matcher) → boolean
  //
  // When exitIf returns true the parser immediately:
  //   1. Closes all currently open tags (innermost first) by calling addTextNode()
  //      and popTag() for each, so the output builder can finalise its tree.
  //   2. Calls outputBuilder.onExit({ tagDetail, matcher, tagsStack }) so the
  //      builder can record that the parse was intentionally truncated.
  //   3. Breaks the parse loop — no further source characters are read.
  //
  // The parse call returns the partial-but-consistent output as normal.
  // No error is thrown.
  //
  // An explicit `null` from the caller means "no predicate"; the default here
  // is the always-false one so the hot path never tests for null. It answers as
  // an effect like any other, so the parser's call site has one shape.
  exitIf: () => false,

  //onStopNode(tagDetail, rawContent, matcher)
  // --- output ---
  OutputBuilder: null as unknown as OutputBuilderFactoryLike, //TODO: accept lower case; replaced by a fresh factory below when unset

  // --- decoding ---
  // Controls how raw bytes (Buffer/Uint8Array input to parse()/parseBytesArr(),
  // or chunks fed to feed()/parseStream()) are turned into text.
  //
  //   encoding — 'auto' (default) sniffs BOM + a leading <?xml ... encoding="...">
  //              declaration per XML 1.0 Appendix F, falling back to utf8 if
  //              neither is present. Set explicitly (e.g. 'utf8', 'utf16le',
  //              'latin1', 'ascii', or a custom-registered name) to skip
  //              detection entirely.
  //
  //   customDecoders — { name: descriptor } map merged into the encoding
  //                    registry before resolution, for encodings FXP doesn't
  //                    ship natively (e.g. Shift_JIS via iconv-lite). See
  //                    docs/16-encoding.md for the descriptor shape.
  //
  decoding: { encoding: 'auto', customDecoders: null, _registry: null as unknown as ResolvedOptions['decoding']['_registry'] }, // _registry set by XMLParser

  _nameCache: { tags: new Map(), attrs: new Map() },
};

// All names that should never appear as property keys
const ALL_RESERVED = new Set([...criticalProperties, ...DANGEROUS_PROPERTY_NAMES]);

/**
 * @description Reject an option value that would become a reserved JavaScript property key in the output object. Silently ignored for anything that isn't a
 * non-empty string, so an absent option (`undefined`) never trips it.
 *
 * @param value - The option value to check.
 * @param optionName - The option's name, as it appears in the error message.
 *
 * @returns An effect that fails with `SECURITY_RESERVED_OPTION` when the value is a reserved name. Infallible otherwise, so the common case — an
 *   absent option — is a call that cannot do anything.
 */
const validatePropertyName = (value: unknown, optionName: string): Effect.Effect<void, ParseError> => {
  if (typeof value !== 'string' || value === '') return Effect.void;
  if (ALL_RESERVED.has(value)) {
    return new SecurityReservedOption({
      option: optionName,
      value,
      message: `SECURITY: '${value}' is a reserved JavaScript keyword and cannot be used as ${optionName}`,
    });
  }
  return Effect.void;
};

/**
 * @description One entry from `tags.stopNodes` or `skip.tags`, in any of the forms the parser accepts. Aliased because the same three forms are legal for both
 * lists and every helper in the normalization chain below refers to the union; the alias keeps those signatures readable instead of repeating it.
 */
type TagEntry = string | Expression | StopNodeEntry;

/**
 * @description A {@link TagEntry} after its shape has been dispatched on: the pattern to compile, plus the stop-node config the compiled expression will carry in
 * `.data`. Named for the same reason as {@link TagEntry} — it appears as the return type of every step between dispatch and compilation.
 */
type TagEntryParts = {
  /**
   * @description The path expression to compile. Always a plain string by this point, even when the caller handed over an `Expression`.
   */
  pattern: string;
  /**
   * @description Whether nested same-name tags are depth-tracked during collection.
   */
  nested: boolean;
  /**
   * @description Enclosure pairs whose interiors suppress closing-tag detection.
   */
  skipEnclosures: TagExpressionConfig['skipEnclosures'];
};

/**
 * @description One compiled tag-pattern list: the normalized entries to store back on the options, and the sealed `ExpressionSet` the parser matches every tag it
 * opens against. Returned as a pair rather than written onto the options from inside the compiling step, so that a list which fails to compile or
 * seal leaves the options object exactly as the merge produced it — a half-normalized entry list is not a state the parser has any handling for.
 */
type NormalizedTagList = {
  /**
   * @description The compiled entries, one per caller-supplied entry, in the caller's order.
   */
  entries: ConfigExpression[];
  /**
   * @description The sealed set holding the same expressions, for O(1) hot-path matching.
   */
  set: ExpressionSet<TagExpressionConfig>;
};

/**
 * @description Validate, merge, and normalize the caller's options into the {@link ResolvedOptions} the parser reads. Four phases happen here, in this order, and
 * each one exists so the parser never has to do it per-document:
 *
 * 1. **Reject the caller's own values** — {@link validateSecurityNames} and {@link validateLimits}. These run on `options` before anything is merged, so
 *    a value only the defaults would have supplied is never checked, and a bad caller value cannot be masked by a later merge.
 * 2. **Merge** the caller over a deep clone of {@link defaultOptions}, so no two parsers ever share a nested option group.
 * 3. **Fill the derived fields** — the default output builder, the two compiled tag-pattern lists, the dangerous-property fallback, `autoClose`.
 * 4. **Reject the merged result** where the merge is what settled a value's type; today that is `exitIf` alone, since its default is a function and only
 *    a caller can make it something else. All of it can fail — a reserved option name, a malformed `limits`, a stop-node pattern that will not
 *    compile — and all of it happens once, at construction. That is why construction itself is an effect (`XMLParser.make`) rather than a
 *    constructor: a configuration the parser cannot honour is a typed failure, and a constructor has nowhere to put one.
 *
 * @param options - Caller options. Omit for pure defaults.
 *
 * @returns An effect producing a fresh options object. Never the same reference as `defaultOptions`, and never shared between parsers. Fails with
 *   `SECURITY_RESERVED_OPTION` for a reserved option name, `INVALID_INPUT` for a malformed `limits`, `exitIf`, or stop-node entry, and
 *   `DEPENDENCY_ERROR` for a path expression `common-xml` refuses to compile.
 */
export const buildOptions = (options?: X2jOptions | null): Effect.Effect<ResolvedOptions, ParseError> =>
  Effect.gen(function* () {
    // Phase 1 — on the caller's object, before the merge can mask anything.
    yield* validateSecurityNames(options);
    yield* validateLimits(options?.limits);

    // Phase 2
    const finalOptions = deepClone(defaultOptions) as ResolvedOptions;

    if (options) {
      copyProperties(finalOptions as unknown as Record<string, unknown>, options as unknown as Record<string, unknown>);
    }

    // Phase 3
    const outputBuilder = options?.OutputBuilder;
    if (Predicate.isNullish(finalOptions.OutputBuilder)) {
      // `CompactBuilderFactory.make` rather than `new CompactBuilderFactory`:
      // the factory resolves its own options — a value-parser chain, an
      // `alwaysArray` pattern — on the way in, and that can fail, so its
      // constructor is private. Constructing one here with no arguments left
      // `builderOptions` undefined, which surfaced much later as a missing
      // `forceTextNode` on the first tag rather than as the configuration
      // failure it was.
      finalOptions.OutputBuilder = yield* DefaultOutputBuilderFactory.make().pipe(Effect.orDie);
    } else if (Effect.isEffect(outputBuilder)) {
      finalOptions.OutputBuilder = yield* outputBuilder.pipe(Effect.orDie);
    }

    if (Array.isArray(finalOptions.tags?.stopNodes)) {
      const { entries, set } = yield* normalizeTagList(finalOptions.tags.stopNodes, 'stopNodes');
      finalOptions.tags.stopNodes = entries;
      finalOptions.tags.stopNodesSet = set;
    }

    if (Array.isArray(finalOptions.skip?.tags)) {
      const { entries, set } = yield* normalizeTagList(finalOptions.skip.tags, 'skip.tags');
      finalOptions.skip.tags = entries;
      finalOptions.skip.tagsSet = set;
    }

    if (finalOptions.onDangerousProperty === null) {
      finalOptions.onDangerousProperty = defaultOnDangerousProperty;
    }

    finalOptions.autoClose = resolveAutoClose(finalOptions.autoClose, finalOptions);

    // Phase 4 — `exitIf` defaults to a function, so its type only settles once the merge is done.
    yield* validateExitIf(finalOptions.exitIf);

    return finalOptions;
  });

/**
 * @description Collect the caller-supplied option values that become property keys in the parsed output, paired with the name each is reported under. Listed
 * rather than checked in place because the checks are identical — only the value and its label differ — and because the order of this list is the
 * order failures are reported in: the three `nameFor` keys first, because they name a node's own output key, then the two `attributes` keys, because
 * they rewrite every attribute name in the document.
 *
 * @param options - The caller's options, read before the defaults are merged in.
 *
 * @returns One `[optionName, value]` pair per security-sensitive option, whether or not it was set. Absent groups are read as empty objects so a
 *   caller who set no `nameFor` contributes `undefined` values rather than short-circuiting here; it is the falsy check in
 *   {@link validateSecurityNames} that skips them.
 */
function securitySensitiveOptionValues(options: X2jOptions): ReadonlyArray<readonly [string, unknown]> {
  const nameFor = options.nameFor ?? {};
  const attributes = options.attributes ?? {};
  return [
    ['nameFor.text', nameFor.text],
    ['nameFor.cdata', nameFor.cdata],
    ['nameFor.comment', nameFor.comment],
    ['attributes.prefix', attributes.prefix],
    ['attributes.groupBy', attributes.groupBy],
  ];
}

/**
 * @description Reject every caller-supplied option value that would become a reserved JavaScript property key in the parsed output. Runs on the caller's object
 * rather than the merged one so that a value the defaults would have supplied is never checked — only the caller can turn a default into a reserved
 * key.
 *
 * @param options - Caller options, or nothing when the parser was constructed with pure defaults.
 *
 * @returns An effect failing with `SECURITY_RESERVED_OPTION` on the first reserved value, in {@link securitySensitiveOptionValues} order. Infallible
 *   when there are no options at all, or when none of the five is set.
 */
function validateSecurityNames(options: X2jOptions | null | undefined): Effect.Effect<void, ParseError> {
  if (options === null || options === undefined) return Effect.void;
  return Effect.gen(function* () {
    for (const [optionName, value] of securitySensitiveOptionValues(options)) {
      // A falsy value falls back to its default downstream, and `''` is a legal property key in its own right, so there is nothing here to check.
      if (value) yield* validatePropertyName(value, optionName);
    }
  });
}

/**
 * @description Whether a structural limit was given a value the parser could not enforce as written. An absent limit (`undefined` or `null`) means "no limit" and
 * is always acceptable; anything present must be a whole number at or above `minimum`. A float, a `NaN`, a string that survived the merge, or a
 * negative count would each yield a limit that either never trips or trips on the wrong tag, so they are rejected at configuration time — where the
 * caller can still tell a typo from a document that genuinely broke the cap.
 *
 * @param value - The limit the caller supplied, or nothing.
 * @param minimum - The smallest acceptable value: `1` for nesting depth, `0` for attribute count, where "no attributes at all" is a legitimate cap.
 *
 * @returns `true` when `value` is present and unusable.
 */
function isUnenforceableLimit(value: unknown, minimum: number): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== 'number' || !Number.isInteger(value) || value < minimum;
}

/**
 * @description Reject a `limits` option the parser could not enforce — a non-object, or a per-limit value that is present but unusable. The group is validated as
 * a whole because `copyProperties` walks the caller's object structurally: a `limits` that arrived as a number would otherwise merge into the default
 * group field by field and leave behind something that reads as a valid limit and is not one.
 *
 * @param limits - The caller's `limits`, or nothing when unset.
 *
 * @returns An effect failing with `INVALID_INPUT` naming the offending option — `maxNestedTags` reported before `maxAttributesPerTag`, so a caller
 *   who got both wrong is told about the nesting one first. Infallible when no limits were supplied.
 */
function validateLimits(limits: X2jOptions['limits']): Effect.Effect<void, ParseError> {
  // `typeof null === 'object'`, so the absent check has to come first — otherwise an explicit `limits: null` would be reported as a malformed object.
  if (limits === null || limits === undefined) return Effect.void;
  if (typeof limits !== 'object') {
    return new InvalidInput({ option: 'limits', received: typeof limits, message: `'limits' must be an object, got ${typeof limits}` });
  }
  const { maxNestedTags, maxAttributesPerTag } = limits;
  return Effect.gen(function* () {
    if (isUnenforceableLimit(maxNestedTags, 1)) {
      return yield* new InvalidInput({
        option: 'limits.maxNestedTags',
        received: `${maxNestedTags}`,
        message: `'limits.maxNestedTags' must be a positive integer, got ${maxNestedTags}`,
      });
    }
    if (isUnenforceableLimit(maxAttributesPerTag, 0)) {
      return yield* new InvalidInput({
        option: 'limits.maxAttributesPerTag',
        received: `${maxAttributesPerTag}`,
        message: `'limits.maxAttributesPerTag' must be a non-negative integer, got ${maxAttributesPerTag}`,
      });
    }
  });
}

/**
 * @description Reject an `exitIf` that is present but not callable. Checked on the merged options rather than on the caller's, because `exitIf`'s default is a
 * function and the merge is what settles its type: without this check a non-function would reach the parse loop and fail there, once per tag opened,
 * as a `TypeError` rather than as the configuration error it is.
 *
 * @param exitIf - The merged `exitIf` value.
 *
 * @returns An effect failing with `INVALID_INPUT` when `exitIf` is present and not a function. Infallible for `null` / `undefined`, which mean "no
 *   predicate" and are left for the parser's call site to interpret.
 */
function validateExitIf(exitIf: unknown): Effect.Effect<void, ParseError> {
  if (exitIf === null || exitIf === undefined) return Effect.void;
  if (typeof exitIf !== 'function') {
    return new InvalidInput({ option: 'exitIf', received: typeof exitIf, message: `'exitIf' must be a function, got ${typeof exitIf}` });
  }
  return Effect.void;
}

/**
 * @description Compile every entry of one of the two tag-pattern lists — `tags.stopNodes` or `skip.tags` — into the parser's single normalized shape, and seal the
 * `ExpressionSet` the parser matches against for each tag it opens. The two lists have identical semantics and were once two copies of the same loop;
 * they are one function called with a different `optionName` so that a change to either reaches both. Accepted entry forms, identical for both lists
 * and dispatched by {@link readEntryParts}:
 *
 * ```txt
 * "..script"
 * → Expression("..script", {}, { nested: false, skipEnclosures: [] })
 * Expression instance
 * → re-wrapped with { nested: false, skipEnclosures: [] } in data
 * { expression: "..script", nested?: boolean, skipEnclosures?: [] }
 * { expression: Expression,  nested?: boolean, skipEnclosures?: [] }
 * → Expression with the given config embedded in .data
 * ```
 *
 * `nested` defaults to false; `skipEnclosures` defaults to `[]`. The two flags are fully independent — any combination is valid. Normalizing every
 * form into one shape here is what lets the parser's hot path be a single `findMatch()` followed by `.data` — no per-entry branch.
 *
 * @param entries - The caller's entries, in any accepted form.
 * @param optionName - Which list this is, used in error messages (`'stopNodes'` or `'skip.tags'`).
 *
 * @returns An effect producing the compiled entries together with the sealed set. Sealing is what freezes the pattern trie; an unsealed set would
 *   silently never match, so it happens before the caller is handed anything and the entries are always consistent with the set they can be found
 *   in.
 */
function normalizeTagList(entries: ReadonlyArray<TagEntry>, optionName: string): Effect.Effect<NormalizedTagList, ParseError> {
  return Effect.gen(function* () {
    const set = new ExpressionSet<TagExpressionConfig>();
    const compiled: ConfigExpression[] = [];
    for (const entry of entries) {
      compiled.push(yield* normalizeTagEntry(entry, optionName, set));
    }
    set.seal();
    return { entries: compiled, set };
  });
}

/**
 * @description The single failure both accepted entry forms report for an empty pattern. An empty expression matches nothing at all, so accepting one would leave
 * the caller with a configured stop node that can never fire — a mistake worth catching at configuration time rather than at the first document that
 * fails to stop.
 *
 * @param optionName - Which list the entry came from (`'stopNodes'` or `'skip.tags'`).
 *
 * @returns An `INVALID_INPUT` failure naming the option.
 */
function emptyPatternError(optionName: string): InvalidInput {
  return new InvalidInput({ option: optionName, message: `${optionName} expression cannot be empty` });
}

/**
 * @description Whether a non-string entry is the explicit `{ expression, nested?, skipEnclosures? }` form. A runtime check rather than a type-level one on
 * purpose: both lists are read straight off a plain options object, so a caller in JavaScript — or one whose options crossed an untyped boundary —
 * can put anything in the array. An entry with no `expression` has to be reported as a bad entry, not dereferenced.
 *
 * @param entry - The entry to test.
 *
 * @returns `true` when `entry` carries a defined `expression` field.
 */
function isTagEntryObject(entry: unknown): entry is StopNodeEntry {
  return entry !== null && typeof entry === 'object' && (entry as Partial<StopNodeEntry>).expression !== undefined;
}

/**
 * @description Resolve the `expression` field of an entry object down to a pattern string. Split from {@link readConfiguredEntry} because this is the one place
 * that can be handed something which is neither accepted form, and it owns that one rejection — including the empty-string case the bare-string form
 * shares, via {@link emptyPatternError}.
 *
 * @param raw - The `expression` field as supplied.
 * @param optionName - Used in the error message.
 *
 * @returns An effect producing the pattern. Fails with `INVALID_INPUT` for an empty string or for a value that is neither a string nor an
 *   `Expression`.
 */
function readTagPattern(raw: unknown, optionName: string): Effect.Effect<string, ParseError> {
  if (typeof raw === 'string') {
    if (raw.length === 0) return emptyPatternError(optionName);
    return Effect.succeed(raw);
  }
  // A caller's `Expression` is read through its `pattern` field rather than `toString()`. The two held the same value before `common-xml` made every question
  // answerable an effect; the field is still a plain `readonly string`, and reading it needs no run.
  if (raw instanceof Expression) return Effect.succeed(raw.pattern);
  return new InvalidInput({ option: optionName, received: typeof raw, message: `${optionName} expression must be a string or Expression instance` });
}

/**
 * @description Read the explicit `{ expression, nested?, skipEnclosures? }` form into the flat parts the compiler wants. The two flags are independent, so each is
 * read on its own terms rather than defaulted together: `nested` is true only when literally `true`, and a `skipEnclosures` that is not an array is
 * dropped for the default rather than half-used — the same defensive read {@link readTagConfig} applies to a bare `Expression`'s payload, since both
 * can carry anything a caller attached.
 *
 * @param entry - The entry, already known to carry a defined `expression`.
 * @param optionName - Used in error messages (`'stopNodes'` or `'skip.tags'`).
 *
 * @returns An effect producing the entry's pattern and config.
 */
function readConfiguredEntry(entry: StopNodeEntry, optionName: string): Effect.Effect<TagEntryParts, ParseError> {
  const nested = entry.nested === true;
  const skipEnclosures = Array.isArray(entry.skipEnclosures) ? entry.skipEnclosures : [];
  return Effect.map(readTagPattern(entry.expression, optionName), pattern => ({ pattern, nested, skipEnclosures }));
}

/**
 * @description Dispatch one raw entry onto the three forms the parser accepts and pull out its pattern and config. Split from the compilation step so that "which
 * shape is this entry in" and "can this pattern be compiled" are answered by two functions: the first is structural dispatch, the second is the
 * fallible part, and a change to the accepted forms only touches this one.
 *
 * @param entry - The caller's entry, in any accepted form.
 * @param optionName - Used in error messages (`'stopNodes'` or `'skip.tags'`).
 *
 * @returns An effect producing the entry's pattern and config. Fails with `INVALID_INPUT` for an empty pattern or for an entry that matches none of
 *   the three forms.
 */
function readEntryParts(entry: TagEntry, optionName: string): Effect.Effect<TagEntryParts, ParseError> {
  if (typeof entry === 'string') {
    if (entry.length === 0) return emptyPatternError(optionName);
    return Effect.succeed({ pattern: entry, nested: false, skipEnclosures: [] });
  }
  if (entry instanceof Expression) {
    // Bare `Expression` — keep its pattern and apply defaults for missing data fields. The payload is only this parser's config by convention, so
    // `readTagConfig` checks the shape rather than trusting it, which is also what a caller who attached something else entirely needs.
    const carried = readTagConfig(entry.data);
    return Effect.succeed({ pattern: entry.pattern, nested: carried.nested, skipEnclosures: carried.skipEnclosures });
  }
  if (isTagEntryObject(entry)) return readConfiguredEntry(entry, optionName);
  return new InvalidInput({
    option: optionName,
    received: typeof entry,
    message: `Invalid ${optionName} entry: expected a string, Expression, or { expression, nested?, skipEnclosures? } object.`,
  });
}

/**
 * @description Standard HTML void elements — never have a closing tag.
 */
const HTML_VOID_ELEMENTS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];

/**
 * @description Normalise the raw `autoClose` option value into either `null` (disabled) or a fully-resolved options object.
 *
 * @param raw - Value supplied by the user.
 * @param opts - The already-merged final options. Mutated in place for the `'html'` preset, which appends the HTML void elements to `tags.unpaired`.
 *
 * @returns A fully-resolved options object, or `null` when recovery is disabled.
 */
function resolveAutoClose(raw: AutoCloseInput, opts: ResolvedOptions): AutoCloseOptions | null {
  if (!raw) return null;

  if (raw === 'html') {
    // Apply HTML-specific tag defaults
    const existingUnpaired = opts.tags.unpaired || [];
    const merged = [...new Set([...existingUnpaired, ...HTML_VOID_ELEMENTS])];
    opts.tags = { ...opts.tags, unpaired: merged };

    return { onEof: 'closeAll', onMismatch: 'discard', collectErrors: true };
  }

  if (typeof raw === 'string') {
    // e.g. autoClose: 'closeAll' — treat as shorthand for onEof
    return { onEof: raw as AutoCloseOptions['onEof'], onMismatch: 'throw', collectErrors: false };
  }

  if (typeof raw === 'object') {
    return { onEof: raw.onEof || 'throw', onMismatch: raw.onMismatch || 'throw', collectErrors: raw.collectErrors || false };
  }

  return null;
}

/**
 * @description Normalize one entry from `tags.stopNodes` or `skip.tags` into an `Expression` whose `.data` carries `{ nested, skipEnclosures }`, and register it
 * in `set`. The entry's shape is read by {@link readEntryParts}; all this owns is turning the resulting pattern into a compiled expression and adding
 * it to the set the parser will match against.
 *
 * @param entry - The caller's entry, in any accepted form.
 * @param optionName - Used in error messages (`'stopNodes'` or `'skip.tags'`).
 * @param set - The set to register the resulting expression into.
 *
 * @returns An effect producing the compiled expression. Fails with `INVALID_INPUT` for an empty pattern or an unrecognised entry form, and with
 *   `DEPENDENCY_ERROR` for a pattern `common-xml` will not compile.
 */
const normalizeTagEntry = (
  entry: TagEntry,
  optionName: string,
  set: ExpressionSet<TagExpressionConfig>
): Effect.Effect<ConfigExpression, ParseError> =>
  Effect.gen(function* () {
    const { pattern, nested, skipEnclosures } = yield* readEntryParts(entry, optionName);

    const expr: ConfigExpression = yield* Effect.mapError(
      Expression.make<TagExpressionConfig>(pattern, {}, { nested, skipEnclosures }),
      fromUpstreamError
    );
    yield* Effect.mapError(set.add(expr), fromUpstreamError);
    return expr;
  });

/**
 * @description Read a caller-supplied `Expression`'s payload as this parser's stop-node config, falling back to the defaults field by field. A bare `Expression`
 * from a caller is `Expression<unknown>`, so its payload is only this parser's config by convention — and a caller is free to have attached something
 * else. Reading it defensively means a foreign payload degrades to the defaults rather than throwing or, worse, being spread into a config with a
 * bogus `nested`. A `skipEnclosures` that is not an array is discarded for the same reason; an array is taken as-is, since its element shape is the
 * caller's to define and `getRawContent` only reads `.open` / `.close`.
 *
 * @param data - The payload to read, if any.
 *
 * @returns The config to carry forward, with defaults filled in.
 */
function readTagConfig(data: unknown): TagExpressionConfig {
  if (data === null || typeof data !== 'object') {
    return { nested: false, skipEnclosures: [] };
  }
  const candidate = data as Partial<TagExpressionConfig>;
  return { nested: candidate.nested === true, skipEnclosures: Array.isArray(candidate.skipEnclosures) ? candidate.skipEnclosures : [] };
}

/**
 * @description Structural deep clone for plain options data. Functions and `RegExp` are shared rather than copied, and `Expression` instances are returned as-is
 * because they are immutable and carry compiled pattern data. Everything else is rebuilt recursively, which is what makes `copyProperties` below able
 * to mutate a nested group in place without touching the caller's object.
 */
function deepClone(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  if (obj instanceof RegExp) return obj; // ← guard
  if (obj instanceof Expression) return obj; // ← guard — Expression instances are immutable
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    clone[key] = typeof value === 'function' ? value : deepClone(value);
  }
  return clone;
}

/**
 * @description Whether an option's value has to be adopted by reference instead of merged into the default group. Everything matched here is either not structured
 * data, or must stay identical to what the caller passed: a callback or a builder factory has no meaningful field-by-field merge, and a `RegExp` or
 * an array would be rebuilt rather than kept. `OutputBuilder` is special-cased by key because it is a factory _object_ rather than a function or a
 * plain option group, and the generic object branch in {@link copyProperty} would walk into it and reassemble something that is no longer the
 * caller's factory.
 *
 * @param key - The option's key, which is what makes `OutputBuilder` a special case.
 * @param value - The caller's value for that key.
 *
 * @returns `true` when `target[key]` should simply become `value`.
 */
function isAdoptedByReference(key: string, value: unknown): boolean {
  return key === 'OutputBuilder' || typeof value === 'function' || value instanceof RegExp || Array.isArray(value);
}

/**
 * @description Merge one option value into `target[key]`, descending a level for a plain object and adopting everything else whole. Split out of
 * {@link copyProperties} so that the per-value decision does not sit inside the key loop, where it was interleaved with the prototype-pollution guard
 * and the two read as a single rule when they are not.
 *
 * @param target - The object being merged into. `target[key]` is written in place.
 * @param key - The option's key. Never `__proto__`, `constructor`, or `prototype` — {@link copyProperties} filters those out first.
 * @param value - The caller's value for `key`.
 */
function copyProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (isAdoptedByReference(key, value)) {
    target[key] = value;
    return;
  }
  if (typeof value === 'object' && value !== null) {
    // A group the defaults did not supply — or one the caller replaced with a primitive — starts empty rather than rejecting the merge, so that a
    // partial group still lands on an object the later reads (`finalOptions.tags.unpaired`, and friends) can use.
    if (typeof target[key] !== 'object' || target[key] === null) target[key] = {};
    copyProperties(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    return;
  }
  target[key] = value;
}

/**
 * @description Recursively merge `source` over `target`, one level of nesting at a time. The hand-rolled walk is deliberate: it must copy functions by reference
 * (a builder factory or a user callback is not cloneable), and it must refuse `__proto__` / `constructor` / `prototype` as keys, since options come
 * from user code and the merge target is a plain object. Each surviving key is then handed to {@link copyProperty}, which decides between adopting
 * the value whole and descending into it.
 */
function copyProperties(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    // Guard against prototype pollution via option keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    copyProperty(target, key, source[key]);
  }
}
