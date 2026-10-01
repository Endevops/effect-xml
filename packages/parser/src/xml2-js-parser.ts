import type { MatcherView, PushOptions } from '@endevops/common-xml';
import type { Production } from '@endevops/common-xml';

import { ExpressionSet, Matcher } from '@endevops/common-xml';
import { createValidator } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { InputSourceLike } from './input-source/input-source.ts';
import type {
  CloseMeta,
  ExitIfPredicate,
  NameCache,
  NameValidator,
  OutputBuilderLike,
  ParserState,
  StopNodeMeta,
  TagDetailLike,
  TagExpressionParser,
  XmlDeclaration,
} from './internal/parser-types.ts';
import type { TagExpressionConfig } from './internal/tag-expression.ts';
import type { DecodingOptions, ResolvedOptions } from './options.ts';
import type { ParseError } from './parse-error.ts';
import type { TagExp } from './xml-part-reader.ts';

import AutoCloseHandler from './auto-close-handler.ts';
import { readDocType } from './doc-type-reader.ts';
import { buildProfileForBuffer } from './encoding/encoding-profile.ts';
import BufferSource from './input-source/buffer-source.ts';
import StringSource from './input-source/string-source.ts';
import {
  ErrorCode,
  InvalidAttributeName,
  InvalidInput,
  InvalidTag,
  LimitMaxNestedTags,
  MismatchedCloseTag,
  MultipleNamespaces,
  SecurityPrototypePollution,
  SecurityRestrictedName,
  UnexpectedCloseTag,
  UnexpectedEnd,
  UnexpectedTrailingData,
  fromUpstreamError,
  isParseError,
  runBuilder,
} from './parse-error.ts';
import { StopNodeProcessor } from './stop-node-processor.ts';
import { DANGEROUS_PROPERTY_NAMES, absolutePosition, criticalProperties, errorPositionOf, sanitizeContent } from './util.ts';
import { flushAttributes, readClosingTagName, readTagExp, tryMatchClosingTagName } from './xml-part-reader.ts';
import { readCdata, readComment, readPiTag } from './xml-special-tags-reader.ts';

// Cap on the tag-name and attribute-name caches (each capped independently —
// see SAVEPOINT_name_cache.md for why: real documents have a small closed
// vocabulary of names, so this is a not-unbounded-growth guard for a
// pathological one-off document, not a security control (that's what
// limits.maxAttributesPerTag/maxNestedTags are for). Not user-configurable —
// an internal implementation detail, not a knob most users could tune
// meaningfully. On overflow the whole map is cleared rather than evicting
// individual entries (LRU) — simpler, and this ceiling is rare in practice.
const NAME_CACHE_LIMIT = 2000;

/**
 * @description Attributes retained for ancestor lookup at every push, regardless of the tag. `xml:space` is the one an output builder needs to honour deep inside
 * a subtree.
 */
const keepSpace: PushOptions = { keep: ['xml:space'] };

/**
 * @description Returns the cached result of `computeFn(rawName)` if present, otherwise the result of running `computeFn()` — caching it on success. If
 * `computeFn()` fails (invalid name, restricted name, prototype-pollution attempt, etc.) nothing is cached — the next occurrence of the same bad name
 * re-runs the full check and fails again from scratch. These are rare error paths where correctness matters, not speed. A plain `Map` is used (not a
 * plain object) so a legitimately falsy cached value (`resolveNsPrefix` returns `false` for a dropped `xmlns` declaration) is never confused with
 * "not cached" — `Map.get()` only returns `undefined` when the key is genuinely absent, and `undefined` is never a computed value here.
 *
 * @param cache - The name cache to consult and fill.
 * @param rawName - The name as written, the cache key.
 * @param compute - The effectful computation to run on a miss.
 *
 * @returns An effect producing the cached or freshly computed value.
 */
const getCachedNameEager = Effect.fnUntracedEager(function* <T>(
  cache: Map<string, T>,
  rawName: string,
  compute: () => Effect.Effect<T, ParseError>
): Effect.fn.Return<T, ParseError> {
  const result = yield* compute();
  if (cache.size >= NAME_CACHE_LIMIT) cache.clear();
  cache.set(rawName, result);
  return result;
});

function getCachedName<T>(cache: Map<string, T>, rawName: string, compute: () => Effect.Effect<T, ParseError>): Effect.Effect<T, ParseError> {
  // A name the shared cache has already answered is the overwhelmingly common case — real documents
  // reuse a small vocabulary — and it needs no generator at all: `Effect.succeed` is an exit the
  // caller's eager iterator inlines. Only a miss reaches the eager body that runs `compute`.
  const cached = cache.get(rawName);
  if (cached !== undefined) return Effect.succeed(cached);
  return getCachedNameEager(cache, rawName, compute);
}

/**
 * @description One open tag: where it is, what it is called, and where its expression ended.
 *
 * @implements {TagDetailLike}
 */
class TagDetail implements TagDetailLike {
  /**
   * @description Processed tag name — namespace prefix already stripped, already sanitized.
   */
  name: string;
  /**
   * @description Character offset of this tag's `<` from document start.
   */
  index: number;
  /**
   * @description Offset immediately after the opening tag's closing `>` (i.e. the end of `<tag attr="x">`). Undefined until the opening tag expression has been
   * fully read; set in `readOpeningTag()`. For self-closing tags this is the offset after `/>`.
   */
  openEnd: number | undefined;
  /**
   * @description The tag name exactly as written (before namespace-prefix stripping) — what a matching closing tag will literally contain. Used by
   * `readClosingTag()`'s fast path; `undefined` for the synthetic root node.
   */
  rawName: string | undefined;
  /**
   * @description Always false on a real tag; `true` only on the synthetic root.
   */
  root?: boolean | undefined;

  /**
   * @param name - Tag name.
   * @param index - Character offset of `<` from document start.
   * @param openEnd - Character offset immediately after the opening tag's closing `>`.
   * @param rawName - The tag name exactly as written.
   */
  constructor(name: string, index: number = 0, openEnd?: number, rawName?: string) {
    this.name = name;
    this.index = index;
    this.openEnd = openEnd;
    this.rawName = rawName;
  }
}

/**
 * @description `isStopNode` / `isSkipTag` are stored as instance properties and invoked as `this.isStopNode()`, so the receiver is part of their contract.
 */
export type TagConfigPredicate = () => TagExpressionConfig | null | undefined;

/**
 * @description Stand-in installed when no stop nodes / skip tags are configured, so the per-tag check costs one call that returns immediately instead of reaching
 * into an empty `ExpressionSet`.
 */
const noTagConfig: TagConfigPredicate = () => null;

/**
 * @description The parser state machine: reads tokens from an {@link InputSourceLike} and drives an {@link OutputBuilderLike}. One instance per parse run —
 * `XMLParser.parse()` builds a fresh one every call, which is exactly why the name cache lives on the shared options object rather than here.
 * Everything else (output builder, matcher, source) is created in {@link initializeParser}.
 *
 * @implements {TagExpressionParser}
 */
export default class Xml2JsParser implements TagExpressionParser {
  /**
   * @description Fully-resolved options, shared by reference with the `XMLParser` that created this instance.
   */
  options: ResolvedOptions;
  /**
   * @description The tag currently being built. `null` only before the first {@link initializeParser} call.
   */
  currentTagDetail: TagDetailLike | null;
  /**
   * @description Text accumulated since the last flushed node.
   */
  tagTextData: string;
  /**
   * @description Stack of open ancestors, innermost last. Index `0` is the synthetic root.
   */
  tagsStack: Array<TagDetailLike>;
  /**
   * @description Whether a DOCTYPE has been seen. A second one is a hard error.
   */
  doctypeFound: boolean;
  /**
   * @description Writable path matcher for the current position.
   */
  matcher: Matcher;
  /**
   * @description Read-only view of {@link matcher}, reused for the whole run. Passed to output builders and user callbacks, where mutation must be impossible by
   * type.
   */
  readonlyMatcher: MatcherView;
  /**
   * @description Recovery handler, or `null` when `autoClose` is disabled.
   */
  autoCloseHandler: AutoCloseHandler | null;
  /**
   * @description The live input source. Assigned by `parse()`, `parseBytesArr()`, or the caller for stream/feed sessions.
   */
  source!: InputSourceLike;
  /**
   * @description Output builder for this run, created in {@link initializeParser}.
   */
  outputBuilder!: OutputBuilderLike;
  /**
   * @description The document's `<?xml ?>` declaration.
   */
  xmlDec!: XmlDeclaration;
  /**
   * @description The synthetic root. Present so the tag stack always has a bottom entry and `popTag()` never has to special-case "nothing open".
   */
  root!: TagDetailLike;
  /**
   * @description Memoized name validators, keyed by production. Reset per document because the production set depends on the declared XML version.
   */
  _nameValidators!: Record<string, NameValidator>;
  /**
   * @description Names already checked against the document's XML version. Reset per document for the same reason as {@link _nameValidators}.
   */
  _validQNames!: Set<string>;
  /**
   * @description Sealed `tags.stopNodes` expression set, reused from the options. Each expression carries its `{ nested, skipEnclosures }` config in `.data`.
   */
  stopNodeExpressionsSet: ExpressionSet<TagExpressionConfig>;
  /**
   * @description Sealed `skip.tags` expression set, same shape as {@link stopNodeExpressionsSet}.
   */
  skipTagExpressionsSet: ExpressionSet<TagExpressionConfig>;
  /**
   * @description The active stop-node / skip-tag collector, or `null`.
   */
  _stopNodeProcessor!: StopNodeProcessor | null;
  /**
   * @description Which branch created {@link _stopNodeProcessor}, so a resumed collection knows whether to forward the content or discard it.
   */
  _stopNodeProcessorMeta!: StopNodeMeta | null;
  /**
   * @description Whether `exitIf` truncated the parse.
   */
  _exitIfTriggered!: boolean;
  /**
   * @description The `exitIf` predicate, normalized to a function at construction.
   */
  _exitIf: ExitIfPredicate;
  /**
   * @description Set of tag names that never have a closing tag. Built once from `options.tags.unpaired`.
   */
  _unpairedSet: Set<string>;
  /**
   * @description Shared tag/attribute name cache, read from `options` so it survives across `parse()` calls.
   */
  _nameCache: NameCache;
  /**
   * @description Returns the matched stop-node config `{ nested, skipEnclosures }`, or `null`. Replaced by an always-`false` predicate when no stop nodes are
   * configured, so the hot path costs one call and nothing else.
   */
  isStopNode: TagConfigPredicate;
  /**
   * @description Returns the matched skip-tag config `{ nested, skipEnclosures }`, or `null`. Same always-`false` substitution as {@link isStopNode}.
   */
  isSkipTag: TagConfigPredicate;

  constructor(options: ResolvedOptions) {
    this.options = options;

    this.currentTagDetail = null;
    this.tagTextData = '';
    this.tagsStack = [];
    this.doctypeFound = false;
    this.matcher = new Matcher();

    //create once and reuse
    this.readonlyMatcher = this.matcher.readOnly();

    // AutoClose handler — created once per parser instance, reset on each parse
    this.autoCloseHandler = options.autoClose ? new AutoCloseHandler(options.autoClose) : null;

    this._unpairedSet = new Set(this.options.tags.unpaired);

    // Reuse the sealed ExpressionSets built by OptionsBuilder.
    // Each Expression carries its config ({ nested, skipEnclosures }) in .data.
    // findMatch() returns the matched Expression directly — O(1) indexed lookup.
    //
    // `size` is a method rather than a getter, because `common-xml` answers
    // every question as an effect. Read here, once per parser instance, to
    // decide whether the hot path is worth installing a real predicate at all.
    this.stopNodeExpressionsSet = this.options.tags.stopNodesSet ?? new ExpressionSet();
    this.isStopNode = this.stopNodeExpressionsSet.size === 0 ? noTagConfig : isStopNode;
    this.skipTagExpressionsSet = this.options.skip.tagsSet ?? new ExpressionSet();
    this.isSkipTag = this.skipTagExpressionsSet.size === 0 ? noTagConfig : isSkipTag;

    // exitIf: optional predicate called after each opening tag is pushed.
    // Stored directly — it's a plain function, not an ExpressionSet.
    this._exitIf = typeof options.exitIf === 'function' ? options.exitIf : () => false;

    // Tag/attribute name cache — read from `options`, not created fresh here.
    // `XMLParser` creates a brand-new Xml2JsParser on every parse() call but
    // passes the *same* options object each time, so a cache stored on
    // `options` survives across those calls. Deliberately NOT reset in
    // initializeParser() (unlike _nameValidators) — it depends only on the
    // raw name string plus options that are fixed for this instance's
    // lifetime, never on anything document-specific like xmlVersion.
    // Guarded fallback here in case Xml2JsParser is ever constructed
    // directly (e.g. in tests) without going through XMLParser.
    this._nameCache = options._nameCache || (options._nameCache = { tags: new Map(), attrs: new Map() });
  }

  /**
   * @description Reset every per-document field and create this run's output builder. Called once per parse run, and once per feed()/parseStream() session.
   * Everything document-scoped is reset here: the tag stack, accumulated text, the memoized name validators (the declared XML version isn't final
   * until the optional `<?xml?>` is read, and that happens after this method runs), and the collected `validQNames`. The shared name cache is
   * deliberately _not_ reset — it depends only on options, not on the document.
   *
   * @returns An effect that initializes the run. Fails when the output builder cannot be created.
   */
  initializeParser = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<void, ParseError> {
    this.tagTextData = '';
    this.tagsStack = [];
    this.doctypeFound = false;
    this._stopNodeProcessor = null;
    this._exitIfTriggered = false;
    // Lazily-built, memoized xml-naming validators (v0.3.0 createValidator).
    // Lazy because xmlDec.version isn't final until the optional <?xml?>
    // declaration (if any) has been read — which happens after this method
    // runs but before any tag name is ever validated. Reset here (once per
    // document/session, see XMLParser._createParser / feed() call sites) so
    // a reused Xml2JsParser instance never validates against a stale
    // xmlVersion or leaks one document's name cache into the next.
    // this._nameValidators = Object.create(null);
    this._nameValidators = {};
    // Validity (unlike sanitize/ns-resolution in this._nameCache) depends on
    // xmlVersion, which is itself document-scoped — reset alongside
    // _nameValidators for the same reason, not on `options` with the rest of
    // _nameCache. See isValidQName().
    this._validQNames = new Set();
    this.xmlDec = { version: 1, lang: null, encoding: null, standalone: 'yes' };

    if (!this.matcher) {
      this.matcher = new Matcher();
      this.readonlyMatcher = this.matcher.readOnly();
    }

    this.outputBuilder = yield* this._createOutputBuilder();

    this.root = { root: true, name: '', index: 0, openEnd: undefined, rawName: undefined };
    this.currentTagDetail = this.root;
  });

  /**
   * @description Create an OutputBuilder instance for this parse run. The output builder owns all value parser registration, including EntitiesValueParser — no
   * injection needed from the parser side.
   *
   * @returns An effect producing the builder. Fails with a `DependencyError` when the factory refuses to build one.
   */
  _createOutputBuilder = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<OutputBuilderLike, ParseError> {
    return yield* runBuilder(this.options.OutputBuilder.getInstance(this.options, this.readonlyMatcher));
  });

  /**
   * @description Returns true if the last parse call was terminated early by exitIf. Useful when the caller needs to know whether parsing completed or stopped.
   */
  wasExited(): boolean {
    return this._exitIfTriggered;
  }

  /**
   * @description Parse an XML string and return the built output.
   *
   * @param strData - The whole document as a string.
   *
   * @returns An effect producing the built output. Fails with any `ParseError` the walk reports.
   */
  // fallow-ignore-next-line unused-class-member
  parse = Effect.fnUntracedEager(function* (this: Xml2JsParser, strData: string): Effect.fn.Return<unknown, ParseError> {
    this.source = new StringSource(strData);
    yield* this.initializeParser();
    yield* this._parseAndFinalize();
    return this.outputBuilder.getOutput();
  });

  /**
   * @description Parse raw bytes and return the built output, resolving the encoding first (see `encoding/encoding-profile.ts`).
   *
   * @param data - The whole document as bytes.
   *
   * @returns An effect producing the built output. Fails with any `ParseError` the encoding resolution or the walk reports.
   */
  // fallow-ignore-next-line unused-class-member
  parseBytesArr = Effect.fnUntracedEager(function* (this: Xml2JsParser, data: Uint8Array): Effect.fn.Return<unknown, ParseError> {
    const registry = this.options.decoding?._registry;
    const profile = yield* buildProfileForBuffer(data, this.options.decoding as DecodingOptions, registry);
    this.source = new BufferSource(data, {}, profile);
    yield* this.initializeParser();
    yield* this._parseAndFinalize();
    return this.outputBuilder.getOutput();
  });

  /**
   * @description Advance the parser state machine as far as the source buffer allows. Stops naturally when `canRead()` returns false — no EOF handling here. Call
   * {@link finalizeXml} once all input is consumed to validate end-of-document. `parseStream()` and `feed()`/`end()` call this per chunk;
   * {@link _parseAndFinalize} (used by `parse()` / `parseBytesArr()`) calls it then `finalizeXml()` immediately.
   *
   * @returns An effect that advances the walk. Fails with `UNEXPECTED_END` when a token is cut short by a chunk boundary. The caller is expected to
   *   rewind and retry on the next chunk.
   */
  parseXml = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<void, ParseError> {
    while (this.source.canRead()) {
      // exitIf triggered in this iteration — stop consuming input immediately.
      if (this._exitIfTriggered) break;

      // Level-0 outer mark: set before consuming any character so that if a
      // '<' dispatch fails with UNEXPECTED_END (chunk boundary mid-tag), feed()
      // rewinds to here and the full token — including '<', '![', '</' etc. —
      // is re-read on the next chunk. Inner reader functions use level-1 marks
      // which never overwrite this position.
      this.source.markTokenStart(0);

      // Position of the next character, captured before it's read. When that
      // character turns out to be '<', this is exactly the position of '<'
      // itself — used below as the authoritative tag-start position for both
      // TagDetail (open tags) and closeMeta (close tags), instead of deriving
      // it after the fact from source.startIndex once the tag name/attrs have
      // already been consumed (which points past the tag, not at its start).
      const preReadPos = errorPositionOf(this.source);

      const ch = this.source.readCh();
      if (ch === undefined || ch === '') break;

      if (ch === '<') {
        yield* this._dispatchTagStart(preReadPos);
      } else {
        this._accumulateTextRun(ch);
      }
    }
  });

  /**
   * @description Read the character following a `<` and route the token to the reader for its kind. The arms are ordered by frequency, so the two most common in
   * real documents (`</` closing a tag and `<` opening one) are reached with the fewest comparisons. Only `!` and `?` flush pending text first,
   * because a comment, CDATA or processing instruction cannot appear inside character data — an opening or closing tag can.
   *
   * @param tagStart - Position of the `<` itself, captured before it was read.
   *
   * @returns An effect that dispatches the token. Fails with `UNEXPECTED_END` when the `<` is the last character available.
   */
  _dispatchTagStart = Effect.fnUntracedEager(function* (this: Xml2JsParser, tagStart: { index: number }): Effect.fn.Return<void, ParseError> {
    const nextChar = this.source.readChAt(0);
    if (nextChar === '' || nextChar === undefined)
      return yield* new UnexpectedEnd({
        reading: `after '<'`,
        message: "Unexpected end of source after '<'",
        index: errorPositionOf(this.source).index,
      });

    //sorted frequency wise
    if (nextChar === '/') {
      this.source.updateBufferBoundary();
      yield* this.readClosingTag(tagStart);
    } else if (nextChar === '!') {
      this.source.updateBufferBoundary();
      yield* this.addTextNode();
      yield* this.readSpecialTag(nextChar);
    } else if (nextChar === '?') {
      this.source.updateBufferBoundary();
      yield* this.addTextNode();
      yield* readPiTag(this);
    } else {
      yield* this.readOpeningTag(tagStart);
    }
  });

  /**
   * @description Buffer character data up to the next `<`. `first` has already been consumed by the caller. The rest of the run is then taken in a single
   * `readStr` rather than one character per trip through the main loop, which is the difference between one substring per character of text content
   * and one per run.
   */
  _accumulateTextRun(first: string): void {
    let runLen = 0;
    while (true) {
      const c = this.source.readChAt(runLen);
      if (c === '<' || c === undefined || c === '') break;
      runLen++;
    }
    if (runLen === 0) {
      this.tagTextData += first;
      return;
    }

    this.tagTextData += first + this.source.readStr(runLen, this.source.startIndex);
    this.source.updateBufferBoundary(runLen);
  }

  /**
   * @description Validate end-of-document state and apply autoClose recovery if configured. Must be called exactly once after all input has been consumed.
   *
   * @returns An effect that validates end-of-document state. Fails with `UNEXPECTED_TRAILING_DATA` when tags are still open (or trailing text
   *   remains) and no autoClose recovery is configured.
   */
  finalizeXml = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<void, ParseError> {
    // When exitIf fired, the parser already closed all open tags and notified
    // the builder — treat the partial parse as complete and skip EOF checks.
    if (this._exitIfTriggered) return;

    const hasOpenTags = this._hasOpenTags();
    // Trailing text is only meaningful when nothing is open: with an open tag,
    // the text belongs to that tag and is closed by the recovery path instead.
    const hasTrailingText = !hasOpenTags && this._hasTrailingText();

    if (!hasOpenTags && !hasTrailingText) return;

    // autoClose repairs open tags only, so the `!hasTrailingText` guard this
    // branch used to carry is implied by `hasOpenTags` and is dropped: text
    // after the last `</>` is a document error no handler can make well-formed.
    if (this.autoCloseHandler && hasOpenTags) {
      yield* this.autoCloseHandler.handleEof(this._parserState());
      return;
    }

    return yield* new UnexpectedTrailingData({ message: 'Unexpected data in the end of document', index: errorPositionOf(this.source).index });
  });

  /**
   * @description Whether any real element is still open at end of input — either on the stack or as the current tag. The synthetic root node that `pushTag` starts
   * from is not an element and does not count.
   */
  _hasOpenTags(): boolean {
    return this.tagsStack.length > 0 || !!(this.currentTagDetail && !this.currentTagDetail.root);
  }

  /**
   * @description Whether text has accumulated past the last tag. Whitespace-only text does not count — it is dropped by `addTextNode` under `skip.whitespaceText`,
   * and reaching here with only whitespace is a well-formed document, not trailing data.
   */
  _hasTrailingText(): boolean {
    return this.tagTextData !== undefined && this.tagTextData.trimEnd().length > 0;
  }

  /**
   * @description One-shot helper used by `parse()` and `parseBytesArr()`. Runs `parseXml()` with autoClose partial-tag recovery, then `finalizeXml()`.
   *
   * @returns An effect that completes the run.
   */
  _parseAndFinalize = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<void, ParseError> {
    const autoClose = this.autoCloseHandler;
    if (autoClose) autoClose.reset();

    // A source-exhausted failure is the retryable truncation autoClose repairs;
    // anything else propagates unchanged. `matchEffect` is the effectful
    // spelling of the original `autoClose && isSourceExhaustedError(err)` guard:
    // a matching failure is kept as a value, everything else re-fails.
    const partialTagError = yield* this.parseXml().pipe(
      Effect.matchEffect({
        onFailure: (err: ParseError): Effect.Effect<ParseError | null, ParseError> =>
          autoClose && isSourceExhaustedError(err) ? Effect.succeed(err) : Effect.fail(err),
        onSuccess: (): Effect.Effect<ParseError | null> => Effect.succeed(null),
      })
    );

    if (partialTagError && autoClose) {
      yield* autoClose.handlePartialTag(partialTagError, this._parserState());
      return;
    }

    yield* this.finalizeXml();
  });

  /**
   * @description Read and dispatch a closing tag.
   *
   * @param tagStart - Document position of this closing tag's `<`, captured by `parseXml()` before the character was consumed.
   *
   * @returns An effect that reads and dispatches the closing tag. Fails with `UNEXPECTED_CLOSE_TAG` for a closing tag with no opener,
   *   `MISMATCHED_CLOSE_TAG` when it doesn't match and no recovery is configured.
   */
  readClosingTag = Effect.fnUntracedEager(function* (this: Xml2JsParser, tagStart: { index: number }): Effect.fn.Return<void, ParseError> {
    if (yield* this._closeAgainstOpenTag(tagStart)) return;

    // ── Slow path ────────────────────────────────────────────────────────────
    const tagName = yield* this.processTagName(yield* readClosingTagName(this.source));
    // closeMeta: position of this closing tag's '</' (tagStart, passed in from
    // parseXml's dispatch) plus the offset right after its '>' (closeEnd) —
    // mirrors tagDetail.index / tagDetail.openEnd for the opening-tag side.
    const closeMeta: CloseMeta = { name: tagName, index: tagStart.index, closeEnd: absolutePosition(this.source) };

    if (this.isUnpaired(tagName) || this.isStopNode()) {
      return yield* new UnexpectedCloseTag({
        tag: tagName,
        message: `Unexpected closing tag '${tagName}'`,
        index: errorPositionOf(this.source).index,
      });
    }

    if (tagName !== this.currentTagDetail?.name && !(yield* this._recoverMismatch(tagName))) return;

    if (!this.currentTagDetail?.root) yield* this.addTextNode();
    yield* this.popTag(closeMeta);
  });

  /**
   * @description _Fast path_: close against the tag already on the stack without reading the name at all. The overwhelming majority of closing tags match the tag
   * sitting on top of the stack. Trying that directly, character by character, avoids reading the name into a fresh string and re-validating and
   * re-sanitizing a name already validated once when the tag opened (see `SAVEPOINT_closing_tag_and_double_scan.md`). Peek-only: a mismatch, or a
   * buffer that runs out mid-check, costs nothing to abandon, so every failure here falls straight through to the unchanged slow path. Skipping
   * `isUnpaired()` / `isStopNode()` here is safe by construction, not just by observation. Only `pushTag()` ever sets `currentTagDetail`, and
   * `pushTag()` is never reached for an unpaired tag or a stop-node/skip-tag match — both of those close themselves inline in `readOpeningTag()`. So
   * whenever `currentTagDetail` is a real open tag, both checks are guaranteed false.
   *
   * @returns An effect producing `true` when the tag was matched and closed here, `false` to fall through to the slow path. Nothing is consumed on
   *   `false` — the check is a peek.
   */
  _closeAgainstOpenTag = Effect.fnUntracedEager(function* (this: Xml2JsParser, tagStart: { index: number }): Effect.fn.Return<boolean, ParseError> {
    const current = this.currentTagDetail;
    if (!current || current.root || current.rawName === undefined) return false;

    const consumed = tryMatchClosingTagName(this.source, current.rawName);
    if (consumed === -1) return false;

    this.source.updateBufferBoundary(consumed);
    const closeMeta: CloseMeta = { name: current.name, index: tagStart.index, closeEnd: absolutePosition(this.source) };
    yield* this.addTextNode();
    yield* this.popTag(closeMeta);
    return true;
  });

  /**
   * @description Offer a closing tag that does not match the open tag to the autoClose handler, when one is configured.
   *
   * @returns An effect producing `true` when the mismatch was resolved and this closing tag should close what it now matches. `false` when the
   *   closing tag is to be discarded — the handler decided it carries nothing recoverable. Fails with `MISMATCHED_CLOSE_TAG` when no autoClose
   *   handler is configured, since a mismatched closing tag is then unrecoverable. On `'close-matched'` the handler has already popped the
   *   intermediate tags and updated `currentTagDetail`, so the caller falls through to the normal close path against whatever is now on top.
   */
  _recoverMismatch = Effect.fnUntracedEager(function* (this: Xml2JsParser, tagName: string): Effect.fn.Return<boolean, ParseError> {
    const expected = this.currentTagDetail?.name;
    const autoClose = this.autoCloseHandler;
    if (!autoClose) {
      return yield* new MismatchedCloseTag({
        tag: tagName,
        expected,
        message: `Unexpected closing tag '${tagName}' expecting '${expected}'`,
        index: errorPositionOf(this.source).index,
      });
    }

    const decision = yield* autoClose.handleMismatch(tagName, this._parserState());
    return decision.action !== 'discard';
  });

  /**
   * @description Read and dispatch an opening tag, including the stop-node / skip-tag / unpaired / self-closing / `exitIf` branches.
   *
   * @param tagStart - Document position of this tag's `<`, captured by `parseXml()` before the character was consumed.
   *
   * @returns An effect that reads and dispatches the opening tag. Fails with `LIMIT_MAX_NESTED_TAGS`, plus whatever the tag-expression and attribute
   *   readers report.
   */
  readOpeningTag = Effect.fnUntracedEager(function* (this: Xml2JsParser, tagStart: { index: number }): Effect.fn.Return<void, ParseError> {
    const options = this.options;
    yield* this.addTextNode();

    // ── Stop-node resume ─────────────────────────────────────────────────────
    if (this._stopNodeProcessor && this._stopNodeProcessor.isActive()) {
      yield* this._resumeStopNode();
      return;
    }

    const tagExp = yield* readTagExp(this);
    const processedTagName = yield* this.processTagName(tagExp.tagName);
    const tagDetail = new TagDetail(
      processedTagName,
      tagStart.index,
      absolutePosition(this.source), // openEnd: offset right after this opening tag's '>'
      tagExp.tagName // rawName: exactly as written, for readClosingTag()'s fast path
    );

    // Extract namespace prefix and local name from raw tag name (e.g. "ns:tag" → "ns", "tag").
    // Always done from the raw name (tagExp.tagName), before processTagName strips the prefix,
    // so these values are stable regardless of skip.nsPrefix.
    const colonIdx = tagExp.tagName.indexOf(':');
    const tagNamespace = colonIdx !== -1 ? tagExp.tagName.slice(0, colonIdx) : undefined;
    // Local name for the matcher: prefix-free always (e.g. "code" from "ns:code").
    // The matcher library tracks namespace separately via the 3rd push() argument —
    // passing the full "ns:code" as the tag name would break ns::code expression matching.
    const matcherTagName = tagNamespace !== undefined ? tagExp.tagName.slice(colonIdx + 1) : processedTagName;

    yield* this._enforceMaxNestedTags(tagDetail);

    // ── Two-pass attribute handling ──────────────────────────────────────────
    if (tagExp.rawAttributesLen > 0) {
      this.matcher.push(matcherTagName, tagExp.rawAttributes, tagNamespace, keepSpace);
    } else {
      this.matcher.push(matcherTagName, {}, tagNamespace);
    }

    // Resolve skip/stop BEFORE touching the output builder
    const stopNodeConfig = this.isStopNode();
    const skipTagConfig = stopNodeConfig ? null : this.isSkipTag();

    if (!options.skip.attributes && !skipTagConfig) {
      yield* flushAttributes(tagExp._parsedAttrs, this, tagExp._attrsExpStart, tagExp._rawAttrMatchCount, processedTagName);
    }

    yield* this._dispatchOpenedTag(tagExp, tagDetail, stopNodeConfig, skipTagConfig);
  });

  /**
   * @description Enforce `limits.maxNestedTags` against the depth this tag would open.
   *
   * @returns An effect that passes when the depth is allowed. Fails with `LIMIT_MAX_NESTED_TAGS` when the depth exceeds the limit. No limit
   *   configured means no check.
   */
  _enforceMaxNestedTags = Effect.fnUntracedEager(function* (
    this: Xml2JsParser,
    tagDetail: TagDetailLike
  ): Effect.fn.Return<void, LimitMaxNestedTags> {
    const maxNested = this.options.limits?.maxNestedTags;
    if (maxNested === undefined || maxNested === null) return;

    const depth = this.tagsStack.length + 1;
    if (depth <= maxNested) return;

    return yield* new LimitMaxNestedTags({
      limit: maxNested,
      depth,
      message: `Nesting depth ${depth} exceeds limit of ${maxNested} (tag: '${tagDetail.name}')`,
      index: tagDetail.index,
    });
  });

  /**
   * @description Route a fully-read opening tag to the one handling that applies, in the order below. The order is load-bearing, not incidental:
   *
   * 1. Unpaired (`<br>`) and 2. self-closing (`<tag/>`) have no closing tag at all, so they complete here regardless of any later rule.
   * 2. Stop nodes and 4. skip tags are mutually exclusive by construction — `skipTagConfig` is only computed when `stopNodeConfig` came back empty.
   * 3. `exitIf` is checked last, so a tag matching both a stop node and an `exitIf` predicate resolves as the stop node. Each arm was inline here
   *    before. They are named methods so the routing reads as a table, and so each one's builder calls can be read without tracking which branch of
   *    the chain is live.
   */
  _dispatchOpenedTag = Effect.fnUntracedEager(function* (
    this: Xml2JsParser,
    tagExp: TagExp,
    tagDetail: TagDetailLike,
    stopNodeConfig: TagExpressionConfig | null | undefined,
    skipTagConfig: TagExpressionConfig | null | undefined
  ): Effect.fn.Return<void, ParseError> {
    if (this.isUnpaired(tagDetail.name)) {
      yield* this._openUnpairedTag(tagDetail);
    } else if (tagExp.selfClosing) {
      yield* this._openSelfClosingTag(tagDetail, skipTagConfig);
    } else if (stopNodeConfig) {
      yield* this._openStopNode(tagExp, tagDetail, stopNodeConfig);
    } else if (skipTagConfig) {
      yield* this._openSkipTag(tagExp, tagDetail, skipTagConfig);
    } else if (this._exitIf(this.readonlyMatcher)) {
      yield* this._triggerExitIf(tagDetail);
    } else {
      this.pushTag(tagDetail);
    }
  });

  /**
   * @description Handle an unpaired tag (`<br>`, `<img>`). There is no separate closing tag, so the element opens and closes in one step and the close position is
   * the open tag's own end.
   */
  _openUnpairedTag = Effect.fnUntracedEager(function* (this: Xml2JsParser, tagDetail: TagDetailLike): Effect.fn.Return<void, ParseError> {
    this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
    yield* runBuilder(this.outputBuilder.closeElement(this.readonlyMatcher, this._closeMetaFor(tagDetail)));
    this.matcher.pop();
  });

  /**
   * @description Handle a self-closing tag (`<tag/>`). Like an unpaired tag it has no distinct closing tag, so it opens and closes immediately — but unlike an
   * unpaired tag it can still be a skip tag, in which case it is dropped from the output entirely.
   */
  _openSelfClosingTag = Effect.fnUntracedEager(function* (
    this: Xml2JsParser,
    tagDetail: TagDetailLike,
    skipTagConfig: TagExpressionConfig | null | undefined
  ): Effect.fn.Return<void, ParseError> {
    if (!skipTagConfig) {
      this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
      yield* runBuilder(this.outputBuilder.closeElement(this.readonlyMatcher, this._closeMetaFor(tagDetail)));
    }
    this.matcher.pop();
  });

  /**
   * @description Handle an opening tag that starts a stop node: collect its content through to the matching `</tag>`, emit it, and close. The raw tag name is used
   * to construct the processor because it scans the source character by character and must match the prefix as written (`ns:code`), independent of
   * what `skip.nsPrefix` does to the output name. The `closeMeta` passed here carries only `closeEnd` (the offset just past the matched
   * `</tagname>`). `StopNodeProcessor` scans the closing tag opaquely and does not track where `</tagname>` itself starts, so unlike the normal close
   * path there is no real index for the close tag's start — only its end.
   */
  _openStopNode = Effect.fnUntracedEager(function* (
    this: Xml2JsParser,
    tagExp: TagExp,
    tagDetail: TagDetailLike,
    config: TagExpressionConfig
  ): Effect.fn.Return<void, ParseError> {
    const processor = new StopNodeProcessor(tagExp.tagName, { nested: config.nested, skipEnclosures: config.skipEnclosures });
    this._stopNodeProcessor = processor;
    this._stopNodeProcessorMeta = { tagDetail, isSkip: false };
    processor.activate();
    const { content, end: stopEnd } = yield* processor.collect(this.source);
    this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
    this.outputBuilder.onStopNode?.(tagDetail, content, this.readonlyMatcher, stopEnd);
    this.outputBuilder.addValue(content, this.readonlyMatcher);
    yield* runBuilder(this.outputBuilder.closeElement(this.readonlyMatcher, { name: tagDetail.name, closeEnd: stopEnd.index }));
    this.matcher.pop();
    this._stopNodeProcessor = null;
    this._stopNodeProcessorMeta = null;
  });

  /**
   * @description Handle an opening tag that starts a skip tag. Identical to the stop-node path except that no output builder method is called: the content is
   * collected only to advance the source past the closing tag, then discarded and the tag silently dropped.
   */
  _openSkipTag = Effect.fnUntracedEager(function* (
    this: Xml2JsParser,
    tagExp: TagExp,
    tagDetail: TagDetailLike,
    config: TagExpressionConfig
  ): Effect.fn.Return<void, ParseError> {
    const processor = new StopNodeProcessor(tagExp.tagName, { nested: config.nested, skipEnclosures: config.skipEnclosures });
    this._stopNodeProcessor = processor;
    this._stopNodeProcessorMeta = { tagDetail, isSkip: true };
    processor.activate();
    yield* processor.collect(this.source); // advance source; content discarded
    this.matcher.pop();
    this._stopNodeProcessor = null;
    this._stopNodeProcessorMeta = null;
  });

  /**
   * @description Handle an opening tag whose `exitIf` predicate fired. Checked before `addElement` so the triggering tag is never added to the output builder. The
   * matcher is already positioned from the push above, so attribute-based predicates work. The push is then undone and every open ancestor closed, so
   * the builder can finalise its tree, and the builder is told the document was truncated on purpose rather than being malformed.
   */
  _triggerExitIf = Effect.fnUntracedEager(function* (this: Xml2JsParser, tagDetail: TagDetailLike): Effect.fn.Return<void, ParseError> {
    const exitDepth = this.tagsStack.length; // number of ancestors open before this tag
    this.matcher.pop(); // undo the push for the triggering tag

    while (this.currentTagDetail && !this.currentTagDetail.root) {
      yield* this.addTextNode();
      yield* this.popTag();
    }

    if (typeof this.outputBuilder.onExit === 'function') {
      this.outputBuilder.onExit({ tagDetail, matcher: this.readonlyMatcher, depth: exitDepth });
    }

    this._exitIfTriggered = true;
  });

  /**
   * @description Finish an opening tag that a chunk boundary interrupted partway. When a boundary fell inside `StopNodeProcessor.collect()`, `feed()` caught
   * `UNEXPECTED_END` and rewound the source to the `<` of the stop node's opening tag. On the next `feed()` the parser re-enters `readOpeningTag()`
   * with the processor still active, so the opening tag is re-consumed from the rewound source and collection resumes — the processor remembers
   * everything accumulated so far and the depth it had reached. A skip tag is retried through the same path but emits nothing, which is why the
   * builder calls sit behind `isSkip`.
   */
  _resumeStopNode = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<void, ParseError> {
    const meta = this._stopNodeProcessorMeta;
    const processor = this._stopNodeProcessor;
    // Unreachable: this path is only entered while a processor is active and
    // carries its meta. Guarding rather than asserting keeps the types honest.
    if (!meta || !processor) return;
    processor.resumeAfterOpenTag();
    yield* readTagExp(this); // re-consume the opening tag from the rewound source
    // openEnd reflects the offset right after this opening tag's '>' — stable
    // across retries since the opening tag is fully re-read every time.
    meta.tagDetail.openEnd = absolutePosition(this.source);
    const { content, end: stopEnd } = yield* processor.collect(this.source);
    if (!meta.isSkip) {
      this.outputBuilder.addElement(meta.tagDetail, this.readonlyMatcher);
      this.outputBuilder.onStopNode?.(meta.tagDetail, content, this.readonlyMatcher, stopEnd);
      this.outputBuilder.addValue(content, this.readonlyMatcher);
      yield* runBuilder(this.outputBuilder.closeElement(this.readonlyMatcher, { name: meta.tagDetail.name, closeEnd: stopEnd.index }));
    }
    this.matcher.pop();
    this._stopNodeProcessor = null;
    this._stopNodeProcessorMeta = null;
  });

  /**
   * @description Push a tag onto the parser stack and notify the output builder. This is the single point of entry for opening a non-self-closing tag — both the
   * parser-side stack (`currentTagDetail` / `tagsStack`) and the output builder are updated together, keeping them in sync. Custom OutputBuilder
   * implementations that maintain their own tag stack should override `addElement()` rather than calling `pushTag()` directly.
   */
  pushTag(tagDetail: TagDetailLike): void {
    this.tagsStack.push(this.currentTagDetail as TagDetailLike);
    this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
    this.currentTagDetail = tagDetail;
  }

  /**
   * @description Pop the current tag from the parser stack and notify the output builder. This is the single point of exit for closing a tag — both stacks are
   * updated together.
   *
   * @param closeMeta - Position info for the closing tag: `{ name, index, closeEnd }`. Omitted when there is no real closing tag to report a position
   *   for — e.g. `AutoCloseHandler` synthesizing a close at EOF, or `exitIf` closing already-open ancestors. In that case a minimal `{ name }` is
   *   passed to the builder instead of nothing, so `closeElement()` never has to special-case "no second argument at all".
   *
   * @returns An effect that closes the tag. Fails with a `DependencyError` when the builder's close pipeline fails.
   */
  popTag = Effect.fnUntracedEager(function* (this: Xml2JsParser, closeMeta?: CloseMeta): Effect.fn.Return<void, ParseError> {
    yield* runBuilder(this.outputBuilder.closeElement(this.readonlyMatcher, closeMeta ?? { name: this.currentTagDetail?.name as string }));
    this.matcher.pop();
    this.currentTagDetail = this.tagsStack.pop() ?? null;
  });

  /**
   * @description Build a `closeMeta` for tags with no distinct closing token (unpaired tags like `<br>`, and self-closing tags like `<tag/>`) — the close position
   * is just the opening tag's own end.
   */
  _closeMetaFor(tagDetail: TagDetailLike): CloseMeta {
    return { name: tagDetail.name, index: tagDetail.index, closeEnd: tagDetail.openEnd };
  }

  /**
   * @description Dispatch a `<!…` construct.
   *
   * @param startCh - The character after `<`. Only `'!'` is valid here.
   *
   * @returns An effect that dispatches the construct. Fails with `INVALID_TAG` for anything that isn't a comment, CDATA, or DOCTYPE; `UNEXPECTED_END`
   *   on a chunk boundary.
   */
  readSpecialTag = Effect.fnUntracedEager(function* (this: Xml2JsParser, startCh: string): Effect.fn.Return<void, ParseError> {
    if (startCh !== '!') {
      return yield* new InvalidTag({ tag: `<${startCh}`, message: `Invalid tag '<${startCh}'`, index: errorPositionOf(this.source).index });
    }

    const nextChar = this.source.readCh();
    if (nextChar === null || nextChar === undefined)
      return yield* new UnexpectedEnd({
        reading: `after '<!'`,
        message: "Unexpected end of source after '<!'",
        index: errorPositionOf(this.source).index,
      });

    if (nextChar === '-') {
      yield* readComment(this);
    } else if (nextChar === '[') {
      yield* readCdata(this);
    } else if (nextChar === 'D') {
      yield* this._readDocTypeDeclaration();
    }
    // Any other character after `<!` is silently ignored, matching the original
    // chain: the construct is not one XML defines, but it is also not one that
    // leaves the parser in a state it cannot recover from.
  });

  /**
   * @description Handle a `<!DOCTYPE` declaration. The declaration is always read, even when `doctypeOptions.enabled` is false, because reading it is what
   * advances the cursor past the internal subset. Whether its entities reach the output builder is a separate question.
   *
   * @returns An effect that reads the declaration. Fails with `INVALID_INPUT` on a second DOCTYPE. XML allows exactly one, and accepting a second
   *   would leave entities from two subsets merged with no record of which document they came from.
   */
  _readDocTypeDeclaration = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<void, ParseError> {
    const docTypeEntities = yield* readDocType(this);
    if (this.doctypeFound) {
      return yield* new InvalidInput({
        option: 'doctypeOptions',
        message: 'Multiple DOCTYPE declarations found.',
        index: errorPositionOf(this.source).index,
      });
    }
    this.doctypeFound = true;

    if (this.options.doctypeOptions.enabled && Object.keys(docTypeEntities).length > 0) {
      this.outputBuilder.addInputEntities(docTypeEntities);
    }
  });

  /**
   * @description Flush any accumulated text to the output builder, then reset the accumulator. Normalization and illegal-control-character rejection happen here,
   * once per complete text run (never mid-chunk — see `util.sanitizeContent`). Whitespace-only runs are dropped entirely when `skip.whitespaceText`
   * is on.
   *
   * @returns An effect that flushes the text. Fails with `ILLEGAL_CHARACTER` on an illegal control code.
   */
  addTextNode(): Effect.Effect<void, ParseError> {
    // The empty case is the common one — every opening and closing tag asks, and most have no
    // pending text. It needs no generator: `Effect.void` is a shared success exit the caller's eager
    // iterator inlines, so the empty path costs a method call rather than an effect boundary.
    if (this.tagTextData === undefined || this.tagTextData === '') return Effect.void;
    return addTextNodeEager.call(this);
  }

  /**
   * @description Cached wrapper around `getNameValidator('qName')` — shape-validating a tag name is a pure function of the name string alone (for a fixed XML
   * version, itself fixed for the whole document), so a name seen once and found valid never needs the regex re-run for its later occurrences. Only
   * opening tag names go through this (see `buildTagExpObj` in `XmlPartReader`); closing tags are checked by exact-match against the
   * already-validated opening name instead (`readClosingTag`), so they never need shape validation of their own. Only valid names are cached — an
   * invalid name throws every time it's seen, never silently let through after a first failure.
   */
  isValidQName(name: string): Effect.Effect<boolean, ParseError> {
    // A name already found valid is the whole point of the cache, and it needs no generator: the
    // shared `VALID_QNAME` exit is inlined by the caller's eager iterator. Only the first occurrence
    // of each name reaches the effectful body that builds the validator.
    if (this._validQNames.has(name)) return VALID_QNAME;
    return isValidQNameEager.call(this, name);
  }

  /**
   * @description Returns a memoized xml-naming validator for the given production (`'qName'` for tag/attribute names, `'name'` for DOCTYPE entity/element names),
   * built lazily on first use and cached per parser instance for the rest of the document/session. `xmlDec.version` is stored as a number (1 / 1.1)
   * but xml-naming's `xmlVersion` option is the string `'1.0'` / `'1.1'` — normalized here rather than changing `xmlDec`'s public shape (it's
   * forwarded as-is to `outputBuilder.addDeclaration()`, so its type is part of the builder contract, not just an internal detail). Construction
   * reports an unknown production as a `common-xml` `XmlError`, mapped into `DEPENDENCY_ERROR` here.
   */
  getNameValidator = Effect.fnUntracedEager(function* (this: Xml2JsParser, production: Production): Effect.fn.Return<NameValidator, ParseError> {
    let validator = this._nameValidators[production];
    if (!validator) {
      const xmlVersion = this.xmlDec.version === 1.1 ? '1.1' : '1.0';
      validator = yield* createValidator(production, { xmlVersion }).pipe(Effect.mapError(fromUpstreamError));
      this._nameValidators[production] = validator;
    }
    return validator;
  });

  /**
   * @description Process a raw attribute name: resolve its namespace prefix, validate it, sanitize it, and apply the reserved-name check. Cached, and the cached
   * case is the common one — a real document reuses a small attribute vocabulary — so this checks the shared cache without entering a generator and
   * falls through to the effectful computation only on the first occurrence of each name.
   *
   * @returns An effect producing the processed name, or `false` when the attribute was a dropped `xmlns:` declaration. Fails with
   *   `INVALID_ATTRIBUTE_NAME`, `SECURITY_RESTRICTED_NAME`, `SECURITY_PROTOTYPE_POLLUTION`, `MULTIPLE_NAMESPACES`.
   */
  processAttrName(rawAttrName: string): Effect.Effect<string | false, ParseError> {
    const cached = this._nameCache.attrs.get(rawAttrName);
    if (cached !== undefined) return Effect.succeed(cached);
    return processAttrNameEager.call(this, rawAttrName);
  }

  /**
   * @description Process a raw tag name: resolve its namespace prefix, sanitize it, and apply the reserved-name check. Cached, with the same cache-hit fast path
   * as {@link Xml2JsParser.processAttrName}.
   *
   * @returns An effect producing the processed name. Fails with `SECURITY_RESTRICTED_NAME`, `SECURITY_PROTOTYPE_POLLUTION`, `MULTIPLE_NAMESPACES`.
   */
  processTagName(rawTagName: string): Effect.Effect<string, ParseError> {
    const cached = this._nameCache.tags.get(rawTagName);
    if (cached !== undefined) return Effect.succeed(cached);
    return processTagNameEager.call(this, rawTagName);
  }

  /**
   * @description Whether `tagName` is configured as never having a closing tag.
   */
  isUnpaired(tagName: string): boolean {
    return this._unpairedSet.has(tagName);
  }

  /**
   * @description Snapshot of mutable parser state passed to `AutoCloseHandler`. Returns a live view — properties read from it reflect current state, and the
   * handler can drive the parser through the same methods the parser itself uses.
   */
  _parserState(): ParserState {
    return parserStateView(this);
  }
}

/**
 * @description The uncached half of {@link Xml2JsParser.processAttrName}: the effectful resolve/validate/sanitize pass for a name seen for the first time.
 * `getCachedName` records the result (including `false` for a dropped `xmlns:` declaration) and memoizes a failure as nothing, so a bad name re-fails
 * on every occurrence rather than being cached.
 */
const processAttrNameEager = Effect.fnUntracedEager(function* (
  this: Xml2JsParser,
  rawAttrName: string
): Effect.fn.Return<string | false, ParseError> {
  const compute = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<string | false, ParseError> {
    const options = this.options;
    let attrName = yield* resolveNsPrefix(rawAttrName, options.skip.nsPrefix, this.source);
    if (attrName === false) return false;
    const qName = yield* this.getNameValidator('qName');
    if (!qName(attrName)) {
      //TODO: make it optional
      return yield* new InvalidAttributeName({
        name: attrName,
        message: `Invalid attribute name: ${attrName}`,
        index: errorPositionOf(this.source).index,
      });
    }
    attrName = yield* sanitizeName(attrName, options.onDangerousProperty, options.sanitizeNames, this.source);
    if (options.strictReservedNames && attrName === options.attributes.groupBy) {
      return yield* new SecurityRestrictedName({
        name: attrName,
        kind: 'attribute',
        message: `Restricted attribute name: ${attrName}`,
        index: errorPositionOf(this.source).index,
      });
    }
    return attrName;
  });
  return yield* getCachedName(this._nameCache.attrs, rawAttrName, () => compute.call(this));
});

/**
 * @description The uncached half of {@link Xml2JsParser.processTagName}: the effectful resolve/sanitize pass for a tag name seen for the first time.
 */
const processTagNameEager = Effect.fnUntracedEager(function* (this: Xml2JsParser, rawTagName: string): Effect.fn.Return<string, ParseError> {
  const compute = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<string, ParseError> {
    const options = this.options;
    const nameFor = options.nameFor;
    let tagName = yield* resolveNsPrefix(rawTagName, options.skip.nsPrefix, this.source);
    if (tagName === false) tagName = rawTagName;
    tagName = yield* sanitizeName(tagName, options.onDangerousProperty, options.sanitizeNames, this.source);
    if (options.strictReservedNames && (tagName === nameFor.comment || tagName === nameFor.cdata || tagName === nameFor.text)) {
      return yield* new SecurityRestrictedName({
        name: tagName,
        kind: 'tag',
        message: `Restricted tag name: ${tagName}`,
        index: errorPositionOf(this.source).index,
      });
    }
    return tagName;
  });
  return yield* getCachedName(this._nameCache.tags, rawTagName, () => compute.call(this));
});

/**
 * @description Flush a non-empty pending text run. Reached only from {@link Xml2JsParser.addTextNode}, which has already returned the shared `Effect.void` for the
 * empty case, so this body may assume `tagTextData` is non-empty.
 */
const addTextNodeEager = Effect.fnUntracedEager(function* (this: Xml2JsParser): Effect.fn.Return<void, ParseError> {
  // Line-ending normalization + illegal-control-character rejection, applied once per complete text
  // run (never mid-chunk — see util.js).
  this.tagTextData = yield* sanitizeContent(this.tagTextData, this.source);
  // Pass raw text — entity expansion is handled by 'entities' ValueParser in the chain
  if (!this.options.skip.whitespaceText || this.tagTextData.trim().length > 0) {
    this.outputBuilder.addValue(this.tagTextData, this.readonlyMatcher);
  }
  this.tagTextData = '';
});

/**
 * @description The shared success exit {@link Xml2JsParser.isValidQName} answers with for a name already in the cache. Exits are immutable, so one instance is safe
 * to hand to every caller and saves an allocation per name occurrence.
 */
const VALID_QNAME: Effect.Effect<boolean> = Effect.succeed(true);

/**
 * @description The uncached half of {@link Xml2JsParser.isValidQName}: build the memoized QName validator (which is the only step that can fail) and run it over
 * the name, adding it to the cache when it passes.
 */
const isValidQNameEager = Effect.fnUntracedEager(function* (this: Xml2JsParser, name: string): Effect.fn.Return<boolean, ParseError> {
  const cache = this._validQNames;
  // Building the validator is the only step here that can fail, and it is the cached one: once
  // built, validating a name is a plain regex test.
  const validator = yield* this.getNameValidator('qName');
  const ok = validator(name);
  if (ok) {
    if (cache.size >= NAME_CACHE_LIMIT) cache.clear();
    cache.add(name);
  }
  return ok;
});

/**
 * @description Build the mutable-state view handed to an {@link AutoCloseHandler}. Every property is an accessor over the live parser, so a handler that reads
 * `tagsStack` after driving the parser sees the result, not a snapshot. The accessors are declared in an object literal rather than with arrow
 * functions because an arrow in a getter would bind `this` to the returned object instead of the parser; closing over the `parser` _parameter_ gives
 * them the right receiver without aliasing `this` at the call site.
 *
 * @param parser - The parser the view forwards to.
 *
 * @returns A live view of the parser's mutable state.
 */
function parserStateView(parser: Xml2JsParser): ParserState {
  return {
    get tagsStack() {
      return parser.tagsStack;
    },
    get currentTagDetail() {
      return parser.currentTagDetail;
    },
    set currentTagDetail(v: TagDetailLike | null) {
      parser.currentTagDetail = v;
    },
    get outputBuilder() {
      return parser.outputBuilder;
    },
    get readonlyMatcher() {
      return parser.readonlyMatcher;
    },
    get matcher() {
      return parser.matcher;
    },
    get source() {
      return parser.source;
    },
    get tagTextData() {
      return parser.tagTextData;
    },
    set tagTextData(v: string) {
      parser.tagTextData = v;
    },
    addTextNode: parser.addTextNode.bind(parser),
    popTag: parser.popTag.bind(parser),
  };
}

/**
 * @description Strip a namespace prefix from a name, when `skip.nsPrefix` asks for it.
 *
 * @returns An effect producing the local name, the original name when prefix-stripping is off or the name has no prefix, or `false` for a dropped
 *   `xmlns` declaration. Fails with `MULTIPLE_NAMESPACES` when a name carries more than one colon.
 */
function resolveNsPrefix(
  name: string,
  skipNsPrefix: boolean | undefined,
  source: InputSourceLike
): Effect.Effect<string | false, MultipleNamespaces> {
  if (skipNsPrefix) {
    const parts = name.split(':');
    if (parts.length === 2) {
      if (parts[0] === 'xmlns') return Effect.succeed(false); // drop xmlns declarations
      return Effect.succeed(parts[1] as string);
    } else if (parts.length > 2) {
      return Effect.fail(new MultipleNamespaces({ name, message: `Multiple namespaces in name: ${name}`, index: errorPositionOf(source).index }));
    }
  }
  return Effect.succeed(name);
}

/**
 * @description Reject prototype-polluting names and optionally rename shadowing ones. `criticalProperties` (`__proto__`, `constructor`, `prototype`) guard against
 * an actual prototype-pollution vulnerability in the output object, not just a naming collision — this check always runs and `sanitizeNames` cannot
 * turn it off. Only the `DANGEROUS_PROPERTY_NAMES` rename step (a milder, cosmetic shadowing concern) is skippable for trusted input.
 *
 * @returns An effect producing the sanitized name. Fails with `SECURITY_PROTOTYPE_POLLUTION` for a critical name.
 */
function sanitizeName(
  name: string,
  onDangerousProperty: (n: string) => string,
  sanitizeNames: boolean | undefined,
  source: InputSourceLike
): Effect.Effect<string, SecurityPrototypePollution> {
  if (criticalProperties.includes(name)) {
    return Effect.fail(
      new SecurityPrototypePollution({
        name,
        message: `[SECURITY] Invalid name: "${name}" is a reserved JavaScript keyword that could cause prototype pollution`,
        index: errorPositionOf(source).index,
      })
    );
  }
  if (sanitizeNames === false) return Effect.succeed(name);
  if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
    return Effect.succeed(onDangerousProperty(name));
  }
  return Effect.succeed(name);
}

/**
 * @description Returns true for errors thrown by read functions when the source ran out mid-token — i.e. the document was truncated inside a tag. These are the
 * only errors intercepted for autoClose recovery. Syntax errors (unclosed quotes) are NOT intercepted — they rethrow.
 */
function isSourceExhaustedError(err: unknown): boolean {
  // Accept both ParseError (with codes) and plain Error from lower-level readers
  if (isParseError(err)) {
    return err._tag === ErrorCode.UNEXPECTED_END;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith('Unexpected end of source') || message.startsWith('Unexpected closing of source');
}

/**
 * @description Returns the matched stop-node config `{ nested, skipEnclosures }` (from `Expression.data`) if the current matcher position matches any stop-node
 * expression, or `null` if not. Uses `ExpressionSet.findMatch()` for O(1) indexed lookup. Installed as an instance property and called as
 * `this.isStopNode()`, so the receiver is the parser. No emptiness guard here on purpose: the constructor reads `size()` once and installs this
 * function only when the set is non-empty, substituting the always-`null` predicate otherwise. Re-checking it per tag would be a second `runXml` on
 * the hot path answering a question already settled — and `size` is a method now, so it is not even free.
 */
function isStopNode(this: Xml2JsParser): TagExpressionConfig | null {
  const matched = this.stopNodeExpressionsSet.findMatch(this.matcher);
  return matched ? (matched.data ?? null) : null;
}

/**
 * @description Returns the matched skip-tag config `{ nested, skipEnclosures }` (from `Expression.data`) if the current matcher position matches any `skip.tags`
 * expression, or `null` if not. Uses `ExpressionSet.findMatch()` for O(1) indexed lookup. Installed as an instance property and called as
 * `this.isSkipTag()`, so the receiver is the parser. See {@link isStopNode} for why there is no emptiness check here.
 */
function isSkipTag(this: Xml2JsParser): TagExpressionConfig | null {
  const matched = this.skipTagExpressionsSet.findMatch(this.matcher);
  return matched ? (matched.data ?? null) : null;
}
