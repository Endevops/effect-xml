import type { Expression, ExpressionSet, MatcherView } from '@endevops/common-xml';

import type EncodingRegistry from './encoding/encoding-registry.ts';
import type { NameCache, OutputBuilderFactoryLike } from './internal/parser-types.ts';
import type { Enclosure, TagExpressionConfig } from './internal/tag-expression.ts';

// The runtime error class and its code table live in `parse-error.ts`; re-exported
// here so option documentation and error documentation can be read together
// without the two drifting apart.
export { ErrorCode, ParseError } from './parse-error.ts';
export type { ErrorCodeValue } from './parse-error.ts';
export type { Enclosure } from './internal/tag-expression.ts';

/**
 * @description Object form of a skip-tag entry — allows per-node control of nested depth tracking and enclosure skipping when scanning for the closing tag.
 *
 * ```ts
 * import { xmlEnclosures } from '@endevops/parser';
 * const parser = new XMLParser({
 *   skip: { tags: ['..secret', { expression: 'root.internal', nested: true, skipEnclosures: [...xmlEnclosures] }] },
 * });
 * ```
 */
export interface SkipTagEntry {
  /**
   * @description Path expression (same syntax as string skip-tag entries), or a pre-compiled `Expression` from `path-expression-matcher`.
   */
  expression: string | Expression;
  /**
   * @description When true, nested same-name open tags are tracked and the skip ends only when the outermost closing tag is found. Default: false.
   */
  nested?: boolean;
  /**
   * @description Enclosure pairs to skip while scanning for the closing tag. Checked in array order — first open match wins. Omit for no enclosure awareness; the
   * parser normalizes a missing entry to `[]` (plain first-match).
   */
  skipEnclosures?: Enclosure[];
}

export interface SkipOptions {
  /**
   * @description Skip XML declaration `<?xml ... ?>` from output. Default: false.
   */
  declaration?: boolean;
  /**
   * @description Skip processing instructions (other than declaration) from output. Default: false.
   */
  pi?: boolean;
  /**
   * @description Skip all attributes from output. Default: true.
   */
  attributes?: boolean;
  /**
   * @description Exclude CDATA sections entirely from output. Default: false.
   */
  cdata?: boolean;
  /**
   * @description Exclude comments entirely from output. Default: false.
   */
  comment?: boolean;
  /**
   * @description Strip namespace prefixes from tag and attribute names. E.g. `ns:tag` → `tag`, `xmlns:*` attributes are dropped. Default: false.
   */
  nsPrefix?: boolean;
  /**
   * @description Tag paths whose entire subtree is silently dropped from output. The parser advances past the closing tag using the same raw-collection mechanism
   * as stop nodes, then discards the content without calling any output builder methods. Each entry is either:
   *
   * - A plain string path expression — equivalent to `{ expression, nested: false, skipEnclosures: [] }`. The very first `</tagName>` ends collection.
   * - A `SkipTagEntry` object with optional `nested` and `skipEnclosures`. Supports path-expression-matcher syntax. Default: []
   *
   * @example
   *   import { xmlEnclosures } from '@endevops/parser';
   *
   *   skip: {
   *     tags: ['..secret', { expression: 'root.internal', nested: true, skipEnclosures: [...xmlEnclosures] }];
   *   }
   */
  tags?: Array<string | Expression | SkipTagEntry>;
  /**
   * @description Skip whitespace only text values to be passed to the builder.
   *
   * @default true
   */
  whitespaceText?: boolean;
}

export interface NameForOptions {
  /**
   * @description Property name for mixed text content when a tag contains both text and child elements. Default: '#text'
   */
  text?: string;
  /**
   * @description Property name for CDATA sections. Empty string (default) merges CDATA content into the tag's text value.
   */
  cdata?: string;
  /**
   * @description Property name for XML comments. Empty string (default) omits comments from output. Set e.g. '#comment' to capture them.
   */
  comment?: string;
}

export interface AttributeOptions {
  /**
   * @description How to handle a valueless (boolean) attribute, e.g. `<e flag/>`. 'allow' (default) — keep it, value is `true` 'ignore' — drop it silently, rest
   * of the tag is unaffected 'throw' — reject the document as soon as one is found.
   */
  booleanType?: 'allow' | 'ignore' | 'throw';
  /**
   * @description How to handle a repeated attribute name on the same tag, e.g. `<e a="1" a="2"/>`. 'overwrite' (default) — last occurrence wins 'ignore' — first
   * occurrence wins, later ones dropped entirely 'throw' — reject the document as soon as a repeat is found.
   */
  duplicate?: 'overwrite' | 'ignore' | 'throw';
  /**
   * @description Group all attributes under this property name. Empty string = inline with tag. Default: ''
   */
  groupBy?: string;
  /**
   * @description Prefix prepended to attribute names in output. Default: '@_'
   */
  prefix?: string;
  /**
   * @description Suffix appended to attribute names in output. Default: ''
   */
  suffix?: string;
}

// `Enclosure` is declared in ./internal/tag-expression.ts and re-exported at the
// top of this file, because the path-expression-matcher augmentation needs it
// too and importing the other way round would be circular.

/**
 * @description Object form of a stop-node entry — allows per-node control of which enclosures the processor should skip when scanning for the closing tag.
 *
 * ```ts
 * import { xmlEnclosures, quoteEnclosures } from '@endevops/parser';
 * const parser = new XMLParser({
 *   tags: {
 *     stopNodes: [
 *       '..script', // plain — no enclosures
 *       { expression: 'body..pre', skipEnclosures: [...xmlEnclosures] },
 *       { expression: 'head..style', skipEnclosures: [...xmlEnclosures, ...quoteEnclosures] },
 *     ],
 *   },
 * });
 * ```
 */
export interface StopNodeEntry {
  /**
   * @description Path expression (same syntax as string stop-node entries), or a pre-compiled `Expression` from `path-expression-matcher`.
   */
  expression: string | Expression;
  /**
   * @description When true, nested same-name open tags are tracked and the stop node ends only when the outermost closing tag is found. Default: false.
   */
  nested?: boolean;
  /**
   * @description Enclosure pairs to skip while scanning for the closing tag. Checked in array order — first open match wins. Omit for no enclosure skipping; the
   * parser normalizes a missing entry to `[]` (plain first-match, no depth tracking).
   */
  skipEnclosures?: Enclosure[];
}

export interface TagOptions {
  /**
   * @description Tags that never have a closing tag (e.g. ['br', 'img', 'hr']). Default: []
   */
  unpaired?: string[];
  /**
   * @description Tag paths whose content is captured raw without further XML parsing. Each entry is either:
   *
   * - A plain string path expression — equivalent to `{ expression, skipEnclosures: [] }`. The very first `</tagName>` ends collection (no depth
   *   tracking, no enclosure skipping).
   * - A `StopNodeEntry` object with an explicit `skipEnclosures` array. When `skipEnclosures` is non-empty, depth tracking is enabled and anything
   *   between an enclosure's open/close markers is skipped (so false closing tags inside comments, CDATA, string literals, etc. are ignored).
   *   Supports path-expression-matcher syntax. Default: []
   *
   * @example
   *   import { xmlEnclosures, quoteEnclosures } from '@endevops/parser';
   *
   *   stopNodes: [
   *     '..script', // plain
   *     { expression: 'body..pre', skipEnclosures: [...xmlEnclosures] },
   *     { expression: 'head..style', skipEnclosures: [...xmlEnclosures, ...quoteEnclosures] },
   *   ];
   */
  stopNodes?: Array<string | Expression | StopNodeEntry>;
}

/**
 * @description Options for DOCTYPE reading — controls whether entities are collected and enforces read-time security limits.
 */
export interface DoctypeOptions {
  /**
   * @description Whether to collect entities declared in the DOCTYPE internal subset and forward them to the output builder for replacement. The DOCTYPE block is
   * always read to consume it; this flag controls forwarding.
   */
  enabled?: boolean;

  /**
   * @description Max number of entities that may be declared in a DOCTYPE internal subset. Enforced by DocTypeReader at declaration time. Default: 100.
   */
  maxEntityCount?: number;

  /**
   * @description Max bytes per entity definition value in DOCTYPE. Enforced by DocTypeReader at declaration time. Default: 10000.
   */
  maxEntitySize?: number;
}

// ─── Error handling ────────────────────────────────────────────────────────────

// `ErrorCode`, `ErrorCodeValue` and `ParseError` are re-exported from
// `./parse-error.ts` at the top of this file — that module owns the runtime
// class and the frozen code table, so documenting them in a second place could
// only ever drift.

// ─── Limits ────────────────────────────────────────────────────────────────────

/**
 * @description Structural limits that guard against resource-exhaustion and DoS attacks. All properties default to `null` (no limit enforced). Errors thrown when
 * limits are exceeded are always `ParseError` instances with codes `LIMIT_MAX_NESTED_TAGS` or `LIMIT_MAX_ATTRIBUTES` respectively, and carry `index`
 * position information.
 */
export interface LimitsOptions {
  /**
   * @description Maximum tag nesting depth. Throws `ParseError` with code `LIMIT_MAX_NESTED_TAGS` when a tag would open at a depth greater than this value.
   * Prevents stack-overflow attacks via pathologically deep XML such as `<a><a><a>...</a></a></a>` (1 million levels deep). Must be a positive
   * integer (`>= 1`) or `null`. Default: `null` (unlimited)
   *
   * @example
   *   // Reject XML deeper than 100 tags
   *   new XMLParser({ limits: { maxNestedTags: 100 } });
   */
  maxNestedTags?: number | null;

  /**
   * @description Maximum number of attributes allowed on a single tag. Throws `ParseError` with code `LIMIT_MAX_ATTRIBUTES` when a tag has more attributes than
   * this value. Only enforced when `skip.attributes` is `false` (attributes are being parsed). Prevents attacks that use thousands of attributes to
   * exhaust memory or CPU during attribute parsing. Must be a non-negative integer (`>= 0`) or `null`. `0` means no attributes are permitted on any
   * tag. Default: `null` (unlimited)
   *
   * @example
   *   // Reject any tag with more than 50 attributes
   *   new XMLParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 50 } });
   */
  maxAttributesPerTag?: number | null;
}

/**
 * @description Buffer options for the feed()/end() and parseStream() input APIs. Passed as `feedable` inside XMLParser options.
 */
export interface FeedableOptions {
  /**
   * @description Maximum number of characters allowed in the buffer at any one time. Prevents memory exhaustion when data is fed faster than it is consumed.
   * Default: 10485760 (10 MB)
   */
  maxBufferSize?: number;

  /**
   * @description When true (default), already-processed characters are automatically discarded from the buffer once the processed portion exceeds flushThreshold.
   * Keeps memory usage flat for large documents. Default: true.
   */
  autoFlush?: boolean;

  /**
   * @description Number of processed characters that triggers an automatic flush. Lower values free memory sooner at the cost of more string-slice operations.
   * Default: 1024 (1 KB)
   */
  flushThreshold?: number;

  /**
   * @description Number of pending bytes that triggers an automatic parse pass attempt. Default: 256 (0.25 KB)
   */
  bufferSize?: number;
}

/**
 * @description Shape a custom decoder must satisfy — matches Node's own StringDecoder.
 */
export interface EncodingDecoder {
  write(chunk: Buffer): string;
  end(): string;
}

/**
 * @description Fully-resolved autoClose behaviour. Two independent decisions:
 *
 * - `onEof` — what to do when the document ends with tags still open.
 * - `onMismatch` — what to do when a closing tag doesn't match the tag on top of the stack. `collectErrors` turns the recoveries that would otherwise
 *   be silent into a readable list on `XMLParser.getParseErrors()`. Produced from the much shorter {@link AutoCloseInput} by
 *   `OptionsBuilder.resolveAutoClose()`, so the parser and `AutoCloseHandler` never see a partially-specified object.
 */
export interface AutoCloseOptions {
  /**
   * @description `'throw'` (default) — reject the document. `'closeAll'` — silently close every remaining open tag, innermost first.
   */
  onEof: 'throw' | 'closeAll';
  /**
   * @description `'throw'` (default) — reject the document. `'recover'` — pop the stack toward the nearest matching opener; discard the tag when there is none.
   * `'discard'` — ignore the bad closing tag.
   */
  onMismatch: 'throw' | 'recover' | 'discard';
  /**
   * @description Record every recovery in `XMLParser.getParseErrors()`. Default: `false`.
   */
  collectErrors: boolean;
}

/**
 * @description What a caller may pass as the `autoClose` option. A partial object is accepted because the parser fills the omitted fields: `resolveAutoClose` in
 * `OptionsBuilder` defaults each one to `'throw'` / `false`, so `{ autoClose: { onEof: 'closeAll' } }` is a complete, valid configuration — asking
 * only for EOF recovery — and requiring the caller to spell out `onMismatch` and `collectErrors` to say nothing about them would be a false
 * constraint. `null` (or omitted) disables the feature entirely and makes any malformed input a hard error. `'html'` is a preset: `onEof:
 * 'closeAll'`, `onMismatch: 'discard'`, `collectErrors: true`, plus the standard HTML void elements appended to `tags.unpaired`.
 */
/**
 * @description The `exitIf` callback: given the read-only matcher positioned at a closing tag, return `true` to stop the parse immediately. On `true` the parser
 * finalizes the output, unwinds every open ancestor with a synthetic close, and attaches a non-enumerable `__exitInfo` to the result. Any other value
 * — including `undefined` — continues parsing. See {@link Xml2JsOptions.exitIf} for the option itself.
 */
export type ExitIfPredicate = (matcher: MatcherView) => boolean;

export type AutoCloseInput = 'html' | 'closeAll' | Partial<AutoCloseOptions> | null;

/**
 * @description Descriptor for a custom encoding, registered via `decoding.customDecoders`.
 */
export interface EncodingDescriptor {
  /**
   * @description Canonical name this encoding is resolved and reported under. Lowercased on registration; also how it is matched against a `<?xml encoding="…"?>`
   * declaration.
   */
  name: string;
  /**
   * @description Factory returning a fresh stateful decoder for one parse session.
   */
  createDecoder: () => EncodingDecoder;
  /**
   * @description Set to true only if an ASCII delimiter byte (<,>,",') can never occur as part of one of this encoding's multi-byte sequences. Getting this wrong
   * causes BufferSource to misread tag/attribute boundaries. Default: false (safe, slightly slower decode-first path).
   */
  selfSynchronizing?: boolean;
  /**
   * @description Bytes-per-character varies. Informational only — position reporting is index-only, so nothing currently branches on this. Default: true.
   */
  variableWidth?: boolean;
  /**
   * @description Byte-order-mark signature for auto-detection. Omit (or pass `null`) for an encoding that has none — it is then never auto-detected, only selected
   * by name.
   */
  bomBytes?: Buffer | null;
  aliases?: string[];
}

/**
 * @description Controls how raw bytes (Buffer/Uint8Array input to parse()/parseBytesArr(), or chunks fed to feed()/parseStream()) are turned into text.
 */
export interface DecodingOptions {
  /**
   * @description 'auto' (default) sniffs a byte-order-mark and/or a leading `<?xml ... encoding="..."?>` declaration (XML 1.0 Appendix F), falling back to 'utf8'
   * if neither is present. Set explicitly to skip detection. Built-in values: 'auto' | 'utf8' | 'ascii' | 'latin1' | 'utf16le' | 'utf16be' — or any
   * name registered via `customDecoders`.
   */
  encoding?: 'auto' | 'utf8' | 'ascii' | 'latin1' | 'utf16le' | 'utf16be' | (string & {});
  /**
   * @description Encodings FXP doesn't ship natively (e.g. Shift_JIS via iconv-lite), keyed by the name used in `encoding`. Scoped to this XMLParser instance.
   */
  customDecoders?: Record<string, EncodingDescriptor>;
}

export interface X2jOptions {
  // --- node-type controls ---
  /**
   * @description Fine-grained control over which node types appear in output.
   */
  skip?: SkipOptions;

  // --- property name mapping ---
  /**
   * @description Property names used for special nodes in output.
   */
  nameFor?: NameForOptions;

  // --- attribute controls ---
  /**
   * @description Attribute parsing and representation options.
   */
  attributes?: AttributeOptions;

  // --- tag controls ---
  /**
   * @description Tag parsing options including stop nodes and value parser chain.
   */
  tags?: TagOptions;

  // --- DOCTYPE parsing ---
  /**
   * @description Controls whether DOCTYPE entities are collected and read-time security limits. Once collected will be passed to Output builder to take any
   * decision.
   */
  doctypeOptions?: DoctypeOptions;

  // --- security ---
  /**
   * @description Throw when a tag/attribute name collides with a nameFor.* or attributes.groupBy value. Default: false.
   */
  strictReservedNames?: boolean;
  /**
   * @description Custom handler for dangerous (non-critical) property names. Default: prefix with '__'
   */
  onDangerousProperty?: (name: string) => string;
  /**
   * @description Skip the dangerous-property rename step (hasOwnProperty, toString, ...) for trusted input. Does NOT disable the critical-property check
   * (**proto**, constructor, prototype), which always runs. Does not affect strictReservedNames. Default: true.
   */
  sanitizeNames?: boolean;

  // --- filtering (path-expression-matcher) ---
  select?: string[];
  only?: string[];

  // --- limits (DoS prevention) ---
  /**
   * @description Structural limits that guard against resource-exhaustion attacks. All properties default to `null` (no limit enforced).
   *
   * ```ts
   * new XMLParser({
   *   limits: {
   *     maxNestedTags: 100, // reject XML deeper than 100 levels
   *     maxAttributesPerTag: 50, // reject any tag with > 50 attributes
   *   },
   * });
   * ```
   */
  limits?: LimitsOptions | null;

  // --- feedable (feed/end and parseStream buffer options) ---
  /**
   * @description Buffer behaviour for the FeedableSource (feed/end API) and StreamSource (parseStream API). All properties have sensible defaults and only need to
   * be set when processing very large documents or operating under tight memory constraints.
   */
  feedable?: FeedableOptions;

  // --- decoding (encoding of raw byte/stream input) ---
  decoding?: DecodingOptions;

  // --- output builder ---
  /**
   * @description Pluggable output builder factory. Default: `CompactBuilderFactory`. Typed structurally rather than as `BaseOutputBuilderFactory`, because the
   * parser drives a builder through a fixed method set and nothing else. The published base factory is not usable as the nominal type here: it
   * declares `addElement(tag)` with one parameter where every real implementation takes `(tag, matcher)`, and it declares `onStopNode` / `onExit` as
   * requiring `line` / `col` on the tag detail, which this parser's index-only position model never produces. Depending on the structural contract
   * lets the bundled builders, a hand-written minimal factory, and a subclass all be passed without a cast.
   */
  OutputBuilder?: OutputBuilderFactoryLike;

  // --- autoClose (malformed-input recovery) ---
  /**
   * @description Behaviour when the document is malformed — tags left open at EOF, or a closing tag that doesn't match. `null` (default) disables recovery
   * entirely: any malformed input is a hard `ParseError`. `'html'` enables the standard lenient HTML preset. See {@link AutoCloseInput}.
   */
  autoClose?: AutoCloseInput;

  /**
   * @description Callback fired by `NodeTreeBuilder` and `CompactObjBuilder` whenever a stop node is fully collected, before the raw content is added to the
   * output tree. Receive the tag detail, the raw unparsed content, and a read-only path matcher. Useful for side-channel analysis (e.g. extracting
   * script content from HTML) without having to post-process the output tree. The callback is informational — return value is ignored. To suppress
   * the node from output, use a custom OutputBuilder subclass instead.
   *
   * @example
   *   const scripts: string[] = [];
   *   const parser = new XMLParser({
   *     tags: { stopNodes: ['..script'] },
   *     onStopNode(tagDetail, rawContent, matcher) {
   *       scripts.push(rawContent);
   *     },
   *   });
   *
   * @param tagDetail - `{ name, index }` of the stop-node opening tag.
   * @param rawContent - Raw text content between the opening and closing tags.
   * @param matcher - Read-only path matcher positioned at the stop node.
   */
  onStopNode?: (tagDetail: { name: string; index: number }, rawContent: string, matcher: any) => void;

  /**
   * @description Predicate evaluated after each non-self-closing, non-stop, non-skip opening tag is pushed onto the parser stack. When the function returns `true`
   * the parser immediately stops reading further input and returns a partial-but- consistent output object. At the moment of evaluation the read-only
   * `matcher` is positioned at the tag that triggered the exit. All tags that were open before it are cleanly closed (innermost first) so the output
   * builder can finalise its tree. The output builder's `onExit()` method is then called with the exit context. No error is thrown — the normal
   * return value of `parse()` / `feed()+end()` / `parseStream()` is returned as usual. Must be a function. Passing any other truthy value raises a
   * `ParseError` with code `INVALID_INPUT` at construction time.
   *
   * @example
   *   // Stop after the first <item> whose @id attribute equals 'stop-here'
   *   const parser = new XMLParser({
   *     skip: { attributes: false },
   *     exitIf(matcher) {
   *       return matcher.getTagName() === 'item' && matcher.getAttribute('@_id') === 'stop-here';
   *     },
   *   });
   *
   * @param matcher - Read-only path matcher positioned at the triggering tag.
   *
   * @returns `true` to stop parsing now; any other value to continue.
   */
  exitIf?: ExitIfPredicate | null | undefined;
}

// ─── Resolved options ───────────────────────────────────────────────────────────

/**
 * @description The fully-resolved option object `buildOptions()` produces and every parser reads. Distinct from {@link X2jOptions} in three ways, each of which
 * removes work from the hot path:
 *
 * 1. **No optionality.** Every branch is present with its default already applied, so no reader needs `?.` or a fallback value.
 * 2. **Stop-node / skip-tag expressions are pre-compiled.** `Expression` instances with their `{ nested, skipEnclosures }` config attached as `data`,
 *    sealed into an `ExpressionSet` for O(1) indexed lookup at each opening tag.
 * 3. **Internal-only fields are present** — the per-instance encoding registry and the shared name cache, neither of which a caller should set.
 */
export interface ResolvedOptions {
  /**
   * @description Resolved node-type filters, defaults applied.
   */
  skip: Omit<SkipOptions, 'tags'> & {
    /**
     * @description Compiled `skip.tags` expressions, each carrying its `{ nested, skipEnclosures }` config in `data`. Replaces the string/object entry forms
     * callers passed in.
     */
    tags: Expression<TagExpressionConfig>[];
    /**
     * @description The same expressions, sealed into an `ExpressionSet` so the parser's per-tag check is an O(1) indexed lookup rather than an O(E) scan.
     */
    tagsSet: ExpressionSet<TagExpressionConfig>;
  };
  /**
   * @description Resolved special-node property names, defaults applied.
   */
  nameFor: Required<NameForOptions>;
  /**
   * @description Resolved attribute behaviour, defaults applied.
   */
  attributes: Required<AttributeOptions>;
  /**
   * @description Resolved tag behaviour, defaults applied.
   */
  tags: Omit<TagOptions, 'stopNodes'> & {
    /**
     * @description Compiled `tags.stopNodes` expressions, each carrying its `{ nested, skipEnclosures }` config in `data`. Replaces the string/object entry forms
     * callers passed in.
     */
    stopNodes: Expression<TagExpressionConfig>[];
    /**
     * @description The same expressions, sealed into an `ExpressionSet` for O(1) indexed lookup at each opening tag.
     */
    stopNodesSet: ExpressionSet<TagExpressionConfig>;
  };
  /**
   * @description Resolved DOCTYPE collection settings, defaults applied.
   */
  doctypeOptions: Required<DoctypeOptions>;
  /**
   * @description Whether a name colliding with a `nameFor.*` / `attributes.groupBy` value is rejected.
   */
  strictReservedNames: boolean;
  /**
   * @description Renames dangerous-but-not-critical property names. Never `null` after resolution.
   */
  onDangerousProperty: (name: string) => string;
  /**
   * @description Whether the dangerous-property rename step runs. The critical-property check runs either way.
   */
  sanitizeNames: boolean;
  /**
   * @description Path-expression filter list. Reserved; not yet applied by the parser.
   */
  only: string[];
  /**
   * @description Path-expression select list. Reserved; not yet applied by the parser.
   */
  select?: string[];
  /**
   * @description Resolved structural limits. `null` for a limit means unlimited.
   */
  limits: Required<LimitsOptions>;
  /**
   * @description Resolved feed/stream buffer settings, defaults applied.
   */
  feedable: Required<FeedableOptions>;
  /**
   * @description Resolved exitIf predicate. Never `null` after resolution — an unset predicate is `() => false`.
   */
  exitIf: (matcher: any) => boolean;
  /**
   * @description Output builder factory, defaults applied. `getInstance()` is called once per parse run.
   */
  OutputBuilder: OutputBuilderFactoryLike;
  /**
   * @description Resolved decoding settings, defaults applied.
   */
  decoding: Omit<DecodingOptions, 'encoding' | 'customDecoders'> & {
    /**
     * @description Resolved encoding name — never `'auto'` once the registry is in place.
     */
    encoding: NonNullable<DecodingOptions['encoding']>;
    /**
     * @description Custom decoders merged into {@link _registry}, or `null` when none were supplied.
     */
    customDecoders: Record<string, EncodingDescriptor> | null;
    /**
     * @description Per-instance registry, built by `XMLParser` from `decoding.customDecoders` when any are supplied, otherwise the shared default. Scoping it to
     * the instance is what stops a custom decoder registered on one parser from leaking into every other parser in the process. Internal — set by
     * `XMLParser`, never by a caller.
     */
    _registry: EncodingRegistry;
  };
  /**
   * @description Resolved autoClose behaviour, or `null` when the feature is disabled.
   */
  autoClose: AutoCloseOptions | null;
  /**
   * @description Optional user callback fired when a stop node's raw content has been collected. Read by the output builder, not by the parser.
   */
  onStopNode?: X2jOptions['onStopNode'];
  /**
   * @description Shared tag/attribute name cache. Held on the options object rather than on a parser so it survives across `parse()` calls. Internal — set by
   * `XMLParser`, never by a caller.
   */
  _nameCache: NameCache;
}
