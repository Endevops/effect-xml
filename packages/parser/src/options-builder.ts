import type { BuilderError } from '@endevops/builder';
import type { Expression as PathExpression } from '@endevops/common-xml';

import { CompactBuilderFactory } from '@endevops/builder';
import { Expression, ExpressionSet } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { OutputBuilderFactoryLike } from './internal/parser-types.ts';
import type { TagExpressionConfig } from './internal/tag-expression.ts';
import type { AutoCloseInput, AutoCloseOptions, ResolvedOptions, X2jOptions } from './options.ts';
import type { ParseError } from './parse-error.ts';

import { ErrorCode, fromUpstreamError, parseError, runBuilder } from './parse-error.js';
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
export const defaultOptions: ResolvedOptions = {
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
  exitIf: () => Effect.succeed(false),

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
export { ALL_RESERVED as RESERVED_JS_NAMES };

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
    return parseError(
      { _tag: ErrorCode.SECURITY_RESERVED_OPTION, option: optionName, value },
      `SECURITY: '${value}' is a reserved JavaScript keyword and cannot be used as ${optionName}`
    );
  }
  return Effect.void;
};

/**
 * @description Validate, merge, and normalize the caller's options into the {@link ResolvedOptions} the parser reads. Three things happen here that the parser must
 * not have to do per-document: security-sensitive values are rejected, every default is filled in, and stop-node / skip-tag patterns are compiled
 * once into sealed `ExpressionSet`s. All of that can fail — a reserved option name, a malformed `limits`, a stop-node pattern that will not compile —
 * and all of it happens once, at construction. That is why construction itself is an effect (`XMLParser.make`) rather than a constructor: a
 * configuration the parser cannot honour is a typed failure, and a constructor has nowhere to put one.
 *
 * @param options - Caller options. Omit for pure defaults.
 *
 * @returns An effect producing a fresh options object. Never the same reference as `defaultOptions`, and never shared between parsers. Fails with
 *   `SECURITY_RESERVED_OPTION` for a reserved option name, `INVALID_INPUT` for a malformed `limits`, `exitIf`, or stop-node entry, and
 *   `DEPENDENCY_ERROR` for a path expression `common-xml` refuses to compile.
 */
export const buildOptions = (options?: X2jOptions | null): Effect.Effect<ResolvedOptions, ParseError> =>
  Effect.gen(function* () {
    // Validate security-sensitive option values BEFORE merging
    if (options) {
      if (options.nameFor?.text) yield* validatePropertyName(options.nameFor.text, 'nameFor.text');
      if (options.nameFor?.cdata) yield* validatePropertyName(options.nameFor.cdata, 'nameFor.cdata');
      if (options.nameFor?.comment) yield* validatePropertyName(options.nameFor.comment, 'nameFor.comment');
      if (options.attributes?.prefix) yield* validatePropertyName(options.attributes.prefix, 'attributes.prefix');
      if (options.attributes?.groupBy) yield* validatePropertyName(options.attributes.groupBy, 'attributes.groupBy');

      // Validate limits option
      if (options.limits !== undefined && options.limits !== null) {
        if (typeof options.limits !== 'object') {
          return yield* parseError(
            { _tag: ErrorCode.INVALID_INPUT, option: 'limits', received: typeof options.limits },
            `'limits' must be an object, got ${typeof options.limits}`
          );
        }
        const { maxNestedTags, maxAttributesPerTag } = options.limits;
        if (
          maxNestedTags !== undefined &&
          maxNestedTags !== null &&
          (typeof maxNestedTags !== 'number' || !Number.isInteger(maxNestedTags) || maxNestedTags < 1)
        ) {
          return yield* parseError(
            { _tag: ErrorCode.INVALID_INPUT, option: 'limits.maxNestedTags', received: `${maxNestedTags}` },
            `'limits.maxNestedTags' must be a positive integer, got ${maxNestedTags}`
          );
        }
        if (
          maxAttributesPerTag !== undefined &&
          maxAttributesPerTag !== null &&
          (typeof maxAttributesPerTag !== 'number' || !Number.isInteger(maxAttributesPerTag) || maxAttributesPerTag < 0)
        ) {
          return yield* parseError(
            { _tag: ErrorCode.INVALID_INPUT, option: 'limits.maxAttributesPerTag', received: `${maxAttributesPerTag}` },
            `'limits.maxAttributesPerTag' must be a non-negative integer, got ${maxAttributesPerTag}`
          );
        }
      }
    }

    const finalOptions = deepClone(defaultOptions) as ResolvedOptions;

    if (options) {
      copyProperties(finalOptions as unknown as Record<string, unknown>, options as unknown as Record<string, unknown>);
    }

    if (!finalOptions.OutputBuilder) {
      // `CompactBuilderFactory.make` rather than `new CompactBuilderFactory`:
      // the factory resolves its own options — a value-parser chain, an
      // `alwaysArray` pattern — on the way in, and that can fail, so its
      // constructor is private. Constructing one here with no arguments left
      // `builderOptions` undefined, which surfaced much later as a missing
      // `forceTextNode` on the first tag rather than as the configuration
      // failure it was.
      finalOptions.OutputBuilder = runBuilder(DefaultOutputBuilderFactory.make());
    }

    // Normalize stopNodes and skip.tags entries into Expression objects with config embedded
    // in Expression.data as { nested, skipEnclosures }. Build a sealed ExpressionSet for
    // O(1) hot-path matching in the parser.
    //
    // Accepted entry forms (identical for both stopNodes and skip.tags):
    //   "..script"
    //     → Expression("..script", {}, { nested: false, skipEnclosures: [] })
    //
    //   Expression instance
    //     → re-wrapped with { nested: false, skipEnclosures: [] } in data
    //
    //   { expression: "..script", nested?: boolean, skipEnclosures?: [] }
    //   { expression: Expression,  nested?: boolean, skipEnclosures?: [] }
    //     → Expression with the given config embedded in .data
    //
    // `nested` defaults to false; `skipEnclosures` defaults to [].
    // The two flags are fully independent — any combination is valid.
    //
    // Normalizing every form into one shape here is what lets the parser's hot
    // path be a single findMatch() followed by `.data` — no per-entry branch.
    //
    // A caller-supplied `Expression` is re-wrapped rather than reused: its payload
    // is `unknown` and only this parser's config by convention, and `readTagConfig`
    // checks the shape rather than trusting it.
    if (Array.isArray(finalOptions.tags?.stopNodes)) {
      const stopSet = new ExpressionSet<TagExpressionConfig>();
      const entries: ConfigExpression[] = [];
      for (const entry of finalOptions.tags.stopNodes) {
        entries.push(yield* normalizeTagEntry(entry, 'stopNodes', stopSet));
      }
      finalOptions.tags.stopNodes = entries;
      yield* Effect.mapError(stopSet.seal(), fromUpstreamError);
      finalOptions.tags.stopNodesSet = stopSet;
    }

    if (Array.isArray(finalOptions.skip?.tags)) {
      const skipSet = new ExpressionSet<TagExpressionConfig>();
      const entries: ConfigExpression[] = [];
      for (const entry of finalOptions.skip.tags) {
        entries.push(yield* normalizeTagEntry(entry, 'skip.tags', skipSet));
      }
      finalOptions.skip.tags = entries;
      yield* Effect.mapError(skipSet.seal(), fromUpstreamError);
      finalOptions.skip.tagsSet = skipSet;
    }

    if (finalOptions.onDangerousProperty === null) {
      finalOptions.onDangerousProperty = defaultOnDangerousProperty;
    }

    // Validate exitIf
    if (finalOptions.exitIf !== null && finalOptions.exitIf !== undefined) {
      if (typeof finalOptions.exitIf !== 'function') {
        return yield* parseError(
          { _tag: ErrorCode.INVALID_INPUT, option: 'exitIf', received: typeof finalOptions.exitIf },
          `'exitIf' must be a function, got ${typeof finalOptions.exitIf}`
        );
      }
    }

    // Resolve autoClose: expand the 'html' preset and normalise to an object
    finalOptions.autoClose = resolveAutoClose(finalOptions.autoClose, finalOptions);

    return finalOptions;
  });

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
 * in `set`. Accepted forms: a plain string pattern, a pre-compiled `Expression` (re-wrapped with the defaults, keeping any config it already
 * carried), or a `{ expression, nested?, skipEnclosures? }` object whose `expression` may be either a string or an `Expression`. A caller's
 * `Expression` is read through its `pattern` field rather than `toString()`. The two held the same value before `common-xml` made every question
 * answerable an effect; the field is still a plain `readonly string`, and reading it needs no run.
 *
 * @param entry - The caller's entry, in any accepted form.
 * @param optionName - Used in error messages (`'stopNodes'` or `'skip.tags'`).
 * @param set - The set to register the resulting expression into.
 *
 * @returns An effect producing the compiled expression. Fails with `INVALID_INPUT` for an empty pattern or an unrecognised entry form, and with
 *   `DEPENDENCY_ERROR` for a pattern `common-xml` will not compile.
 */
const normalizeTagEntry = (
  entry: string | Expression | { expression: string | Expression; nested?: boolean; skipEnclosures?: TagExpressionConfig['skipEnclosures'] },
  optionName: string,
  set: ExpressionSet<TagExpressionConfig>
): Effect.Effect<ConfigExpression, ParseError> =>
  Effect.gen(function* () {
    let pattern: string;
    let nested: boolean;
    let skipEnclosures: TagExpressionConfig['skipEnclosures'];

    if (typeof entry === 'string') {
      if (entry.length === 0)
        return yield* parseError({ _tag: ErrorCode.INVALID_INPUT, option: optionName }, `${optionName} expression cannot be empty`);
      pattern = entry;
      nested = false;
      skipEnclosures = [];
    } else if (entry instanceof Expression) {
      // Bare Expression — keep its pattern, apply defaults for missing data fields.
      // A caller-supplied Expression is `Expression<unknown>`, so its payload is
      // this parser's config only by convention. readTagConfig checks the shape
      // rather than trusting it, which is also what a caller who attached
      // something else entirely needs.
      pattern = entry.pattern;
      const carried = readTagConfig(entry.data);
      nested = carried.nested;
      skipEnclosures = carried.skipEnclosures;
    } else if (entry && typeof entry === 'object' && entry.expression !== undefined) {
      const raw = entry.expression;
      if (typeof raw === 'string') {
        if (raw.length === 0)
          return yield* parseError({ _tag: ErrorCode.INVALID_INPUT, option: optionName }, `${optionName} expression cannot be empty`);
        pattern = raw;
      } else if (raw instanceof Expression) {
        pattern = raw.pattern;
      } else {
        return yield* parseError(
          { _tag: ErrorCode.INVALID_INPUT, option: optionName, received: typeof raw },
          `${optionName} expression must be a string or Expression instance`
        );
      }
      nested = entry.nested === true;
      skipEnclosures = Array.isArray(entry.skipEnclosures) ? entry.skipEnclosures : [];
    } else {
      return yield* parseError(
        { _tag: ErrorCode.INVALID_INPUT, option: optionName, received: typeof entry },
        `Invalid ${optionName} entry: expected a string, Expression, or { expression, nested?, skipEnclosures? } object.`
      );
    }

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
 * @description Recursively merge `source` over `target`, one level of nesting at a time. The hand-rolled walk is deliberate: it must copy functions by reference
 * (a builder factory or a user callback is not cloneable), and it must refuse `__proto__` / `constructor` / `prototype` as keys, since options come
 * from user code and the merge target is a plain object.
 */
function copyProperties(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    // Guard against prototype pollution via option keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    const value = source[key];
    if (key === 'OutputBuilder') {
      target[key] = value;
    } else if (typeof value === 'function') {
      target[key] = value;
    } else if (value instanceof RegExp) {
      // ← guard, before the generic object check
      target[key] = value;
    } else if (Array.isArray(value)) {
      target[key] = value;
    } else if (typeof value === 'object' && value !== null) {
      if (typeof target[key] !== 'object' || target[key] === null) {
        target[key] = {};
      }
      copyProperties(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}
