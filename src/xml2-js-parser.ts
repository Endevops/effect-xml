import type { MatcherView, PushOptions } from 'path-expression-matcher';
import type { Production } from 'xml-naming';

import { ExpressionSet, Matcher } from 'path-expression-matcher';
import { createValidator } from 'xml-naming';

import type { InputSourceLike } from './input-source/input-source.ts';
import type {
  CloseMeta,
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

import AutoCloseHandler from './auto-close-handler.ts';
import { readDocType } from './doc-type-reader.ts';
import { buildProfileForBuffer } from './encoding/encoding-profile.ts';
import BufferSource from './input-source/buffer-source.ts';
import StringSource from './input-source/string-source.ts';
import { ErrorCode, ParseError } from './parse-error.ts';
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
 * @description Returns the cached result of `computeFn(rawName)` if present, otherwise calls `computeFn()`, caches the result, and returns it. If `computeFn()`
 * throws (invalid name, restricted name, prototype-pollution attempt, etc.) nothing is cached — the next occurrence of the same bad name re-runs the
 * full check and throws again from scratch. These are rare error paths where correctness matters, not speed. A plain `Map` is used (not a plain
 * object) so a legitimately falsy cached value (`resolveNsPrefix` returns `false` for a dropped `xmlns` declaration) is never confused with "not
 * cached" — `Map.get()` only returns `undefined` when the key is genuinely absent.
 */
function getCachedName<T>(cache: Map<string, T>, rawName: string, computeFn: () => T): T {
  // `has()` is what actually proves a hit: `processAttrName` caches `false` for a
  // dropped xmlns declaration, and `get()` alone would re-run computeFn for it.
  if (cache.has(rawName)) return cache.get(rawName) as T;
  const result = computeFn();
  if (cache.size >= NAME_CACHE_LIMIT) cache.clear();
  cache.set(rawName, result);
  return result;
}

/**
 * @description One open tag: where it is, what it is called, and where its expression ended.
 *
 * @implements {TagDetailLike}
 */
export class TagDetail implements TagDetailLike {
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
type TagConfigPredicate = () => TagExpressionConfig | null | undefined;

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
  tagsStack: TagDetailLike[];
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
  stopNodeExpressionsSet: ExpressionSet;
  /**
   * @description Sealed `skip.tags` expression set, same shape as {@link stopNodeExpressionsSet}.
   */
  skipTagExpressionsSet: ExpressionSet;
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
  _exitIf: (matcher: MatcherView) => boolean;
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
   */
  initializeParser(): void {
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

    this.outputBuilder = this._createOutputBuilder();

    this.root = { root: true, name: '', index: 0, openEnd: undefined, rawName: undefined };
    this.currentTagDetail = this.root;
  }

  /**
   * @description Create an OutputBuilder instance for this parse run. The output builder owns all value parser registration, including EntitiesValueParser — no
   * injection needed from the parser side.
   */
  _createOutputBuilder(): OutputBuilderLike {
    return this.options.OutputBuilder.getInstance(this.options, this.readonlyMatcher);
  }

  /**
   * @description Returns true if the last parse call was terminated early by exitIf. Useful when the caller needs to know whether parsing completed or stopped.
   */
  wasExited(): boolean {
    return this._exitIfTriggered === true;
  }

  /**
   * @description Parse an XML string and return the built output.
   *
   * @param strData - The whole document as a string.
   */
  parse(strData: string): unknown {
    this.source = new StringSource(strData) as InputSourceLike;
    this.initializeParser();
    this._parseAndFinalize();
    return this.outputBuilder.getOutput();
  }

  /**
   * @description Parse raw bytes and return the built output, resolving the encoding first (see `encoding/encoding-profile.ts`).
   *
   * @param data - The whole document as bytes.
   */
  parseBytesArr(data: Buffer): unknown {
    const registry = this.options.decoding?._registry;
    const profile = buildProfileForBuffer(data, this.options.decoding as DecodingOptions, registry);
    this.source = new BufferSource(data, {}, profile);
    this.initializeParser();
    this._parseAndFinalize();
    return this.outputBuilder.getOutput();
  }

  /**
   * @description Advance the parser state machine as far as the source buffer allows. Stops naturally when `canRead()` returns false — no EOF handling here. Call
   * {@link finalizeXml} once all input is consumed to validate end-of-document. `parseStream()` and `feed()`/`end()` call this per chunk;
   * {@link _parseAndFinalize} (used by `parse()` / `parseBytesArr()`) calls it then `finalizeXml()` immediately.
   *
   * @throws {ParseError} `UNEXPECTED_END` when a token is cut short by a chunk boundary. The caller is expected to rewind and retry on the next
   *   chunk.
   */
  parseXml(): void {
    while (this.source.canRead()) {
      // exitIf triggered in this iteration — stop consuming input immediately.
      if (this._exitIfTriggered) break;

      // Level-0 outer mark: set before consuming any character so that if a
      // '<' dispatch throws UNEXPECTED_END (chunk boundary mid-tag), feed()
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
        const tagStart = preReadPos;

        const nextChar = this.source.readChAt(0);
        if (nextChar === '' || nextChar === undefined)
          throw new ParseError("Unexpected end of source after '<'", ErrorCode.UNEXPECTED_END, errorPositionOf(this.source));

        //sorted frequency wise
        if (nextChar === '/') {
          this.source.updateBufferBoundary();
          this.readClosingTag(tagStart);
        } else if (nextChar === '!') {
          this.source.updateBufferBoundary();
          this.addTextNode();
          this.readSpecialTag(nextChar);
        } else if (nextChar === '?') {
          this.source.updateBufferBoundary();
          this.addTextNode();
          readPiTag(this);
        } else {
          this.readOpeningTag(tagStart);
        }
      } else {
        // ch is already consumed. Peek ahead for more non-'<' chars and grab
        // the whole run in one readStr call rather than concatenating one char
        // at a time through every loop iteration.
        let runLen = 0;
        while (true) {
          const c = this.source.readChAt(runLen);
          if (c === '<' || c === undefined || c === '') break;
          runLen++;
        }
        if (runLen > 0) {
          this.tagTextData += ch + this.source.readStr(runLen, this.source.startIndex);
          this.source.updateBufferBoundary(runLen);
        } else {
          this.tagTextData += ch;
        }

        //TODO: why does below code doesn't work
        // const text = this.source.readUptoChar("<");
        // this.tagTextData += text;
      }
    }
  }

  /**
   * @description Validate end-of-document state and apply autoClose recovery if configured. Must be called exactly once after all input has been consumed.
   *
   * @throws {ParseError} `UNEXPECTED_TRAILING_DATA` when tags are still open (or trailing text remains) and no autoClose recovery is configured.
   */
  finalizeXml(): void {
    // When exitIf fired, the parser already closed all open tags and notified
    // the builder — treat the partial parse as complete and skip EOF checks.
    if (this._exitIfTriggered) return;

    const hasOpenTags = this.tagsStack.length > 0 || !!(this.currentTagDetail && !this.currentTagDetail.root);

    const hasTrailingText = !hasOpenTags && this.tagTextData !== undefined && this.tagTextData.trimEnd().length > 0;

    if (hasOpenTags || hasTrailingText) {
      if (this.autoCloseHandler && hasOpenTags && !hasTrailingText) {
        this.autoCloseHandler.handleEof(this._parserState());
      } else {
        throw new ParseError('Unexpected data in the end of document', ErrorCode.UNEXPECTED_TRAILING_DATA, errorPositionOf(this.source));
      }
    }
  }

  /**
   * @description One-shot helper used by `parse()` and `parseBytesArr()`. Runs `parseXml()` with autoClose partial-tag recovery, then `finalizeXml()`.
   *
   * @private
   */
  _parseAndFinalize(): void {
    let partialTagError: unknown = null;
    if (this.autoCloseHandler) this.autoCloseHandler.reset();

    try {
      this.parseXml();
    } catch (err) {
      if (this.autoCloseHandler && isSourceExhaustedError(err)) {
        partialTagError = err;
      } else {
        throw err;
      }
    }

    if (partialTagError) {
      this.autoCloseHandler?.handlePartialTag(partialTagError as Error, this._parserState());
      return;
    }

    this.finalizeXml();
  }

  /**
   * @description Read and dispatch a closing tag.
   *
   * @param tagStart - Document position of this closing tag's `<`, captured by `parseXml()` before the character was consumed.
   *
   * @throws {ParseError} `UNEXPECTED_CLOSE_TAG` for a closing tag with no opener, `MISMATCHED_CLOSE_TAG` when it doesn't match and no recovery is
   *   configured.
   */
  readClosingTag(tagStart: { index: number }): void {
    // ── Fast path ────────────────────────────────────────────────────────────
    // The overwhelming majority of closing tags match the tag already sitting
    // on top of the stack. Try that directly, character-by-character, before
    // reading the name into a fresh string and re-validating/re-sanitizing a
    // name we've already validated once (see
    // SAVEPOINT_closing_tag_and_double_scan.md). Peek-only — a mismatch or a
    // buffer that runs out mid-check costs nothing to abandon, so any failure
    // here falls straight through to the exact original slow path below.
    //
    // Skipping isUnpaired()/isStopNode() on this path is safe by construction,
    // not just by observation: only pushTag() ever sets currentTagDetail, and
    // pushTag() is never reached for an unpaired tag or a stop-node/skip-tag
    // match (both close themselves inline in readOpeningTag) — so whenever
    // currentTagDetail is a real open tag, both checks are guaranteed false.
    const current = this.currentTagDetail;
    if (current && !current.root && current.rawName !== undefined) {
      const consumed = tryMatchClosingTagName(this.source, current.rawName);
      if (consumed !== -1) {
        this.source.updateBufferBoundary(consumed);
        const closeMeta: CloseMeta = { name: current.name, index: tagStart.index, closeEnd: absolutePosition(this.source) };
        this.addTextNode();
        this.popTag(closeMeta);
        return;
      }
    }

    // ── Slow path — unchanged ────────────────────────────────────────────────
    const tagName = this.processTagName(readClosingTagName(this.source));
    // closeMeta: position of this closing tag's '</' (tagStart, passed in from
    // parseXml's dispatch) plus the offset right after its '>' (closeEnd) —
    // mirrors tagDetail.index / tagDetail.openEnd for the opening-tag side.
    const closeMeta: CloseMeta = { name: tagName, index: tagStart.index, closeEnd: absolutePosition(this.source) };

    if (this.isUnpaired(tagName) || this.isStopNode()) {
      throw new ParseError(`Unexpected closing tag '${tagName}'`, ErrorCode.UNEXPECTED_CLOSE_TAG, errorPositionOf(this.source));
    }

    if (tagName !== this.currentTagDetail?.name) {
      if (!this.autoCloseHandler) {
        throw new ParseError(
          `Unexpected closing tag '${tagName}' expecting '${this.currentTagDetail?.name}'`,
          ErrorCode.MISMATCHED_CLOSE_TAG,
          errorPositionOf(this.source)
        );
      }

      const decision = this.autoCloseHandler.handleMismatch(tagName, this._parserState());

      if (decision.action === 'discard') return;
      // 'close-matched': handler updated currentTagDetail; fall through to normal close
    }

    if (!this.currentTagDetail?.root) this.addTextNode();
    this.popTag(closeMeta);
  }

  /**
   * @description Read and dispatch an opening tag, including the stop-node / skip-tag / unpaired / self-closing / `exitIf` branches.
   *
   * @param tagStart - Document position of this tag's `<`, captured by `parseXml()` before the character was consumed.
   *
   * @throws {ParseError} `LIMIT_MAX_NESTED_TAGS`, plus whatever the tag-expression and attribute readers throw.
   */
  readOpeningTag(tagStart: { index: number }): void {
    const options = this.options;
    this.addTextNode();

    // ── Stop-node resume ─────────────────────────────────────────────────────
    // When a chunk boundary fell inside StopNodeProcessor.collect(), feed() caught
    // UNEXPECTED_END and rewound the source to the '<' of the stop node's
    // opening tag. On the next feed() we re-enter here with the processor active.
    // Re-consume the opening tag (source was rewound to its '<'), then resume
    // collection — the processor remembers all accumulated content and depth.
    if (this._stopNodeProcessor && this._stopNodeProcessor.isActive()) {
      const { tagDetail, isSkip } = this._stopNodeProcessorMeta as StopNodeMeta;
      this._stopNodeProcessor.resumeAfterOpenTag();
      readTagExp(this); // re-consume the opening tag from the rewound source
      // openEnd reflects the offset right after this opening tag's '>' — stable
      // across retries since the opening tag is fully re-read every time.
      tagDetail.openEnd = absolutePosition(this.source);
      const { content, end: stopEnd } = this._stopNodeProcessor.collect(this.source);
      if (!isSkip) {
        this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
        this.outputBuilder.onStopNode?.(tagDetail, content, this.readonlyMatcher, stopEnd);
        this.outputBuilder.addValue(content, this.readonlyMatcher);
        this.outputBuilder.closeElement(this.readonlyMatcher, { name: tagDetail.name, closeEnd: stopEnd.index });
      }
      this.matcher.pop();
      this._stopNodeProcessor = null;
      this._stopNodeProcessorMeta = null;
      return;
    }

    const tagExp = readTagExp(this);
    const processedTagName = this.processTagName(tagExp.tagName);
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

    // ── Limit: maxNestedTags ─────────────────────────────────────────────────
    const maxNested = options.limits?.maxNestedTags;
    if (maxNested !== undefined && maxNested !== null) {
      const depth = this.tagsStack.length + 1;
      if (depth > maxNested) {
        throw new ParseError(`Nesting depth ${depth} exceeds limit of ${maxNested} (tag: '${processedTagName}')`, ErrorCode.LIMIT_MAX_NESTED_TAGS, {
          index: tagDetail.index,
        });
      }
    }

    // ── Two-pass attribute handling ──────────────────────────────────────────
    const rawAttributes = tagExp.rawAttributes;
    const raeAttrLen = tagExp.rawAttributesLen;
    if (raeAttrLen > 0) {
      this.matcher.push(matcherTagName, rawAttributes, tagNamespace, keepSpace);
      // this.matcher.updateCurrent(rawAttributes);
    } else {
      this.matcher.push(matcherTagName, {}, tagNamespace);
    }

    // Resolve skip/stop BEFORE touching the output builder
    const stopNodeConfig = this.isStopNode();
    const skipTagConfig = stopNodeConfig ? null : this.isSkipTag();

    if (!options.skip.attributes && !skipTagConfig) {
      flushAttributes(tagExp._parsedAttrs, this, tagExp._attrsExpStart, tagExp._rawAttrMatchCount);
    }

    // Stop-node and skip-tag checks AFTER attributes are set so attribute conditions work.
    // const stopNodeConfig = this.isStopNode();
    // Skip tag is only checked when this tag is not already a stop node — they are mutually exclusive.
    // const skipTagConfig = stopNodeConfig ? null : this.isSkipTag();

    if (this.isUnpaired(processedTagName)) {
      this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
      // Unpaired tags (e.g. <br>, <img>) have no separate closing tag — the
      // close position is the same as the open tag's end.
      this.outputBuilder.closeElement(this.readonlyMatcher, this._closeMetaFor(tagDetail));
      this.matcher.pop();
    } else if (tagExp.selfClosing) {
      if (!skipTagConfig) {
        this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
        // Self-closing tags (<tag/>) likewise have no distinct closing tag.
        this.outputBuilder.closeElement(this.readonlyMatcher, this._closeMetaFor(tagDetail));
      }
      this.matcher.pop();
    } else if (stopNodeConfig) {
      // Create a fresh processor with the matching nested + skipEnclosures config.
      // Raw tag name (tagExp.tagName) is used — the processor scans the source
      // character-by-character and must match the prefix-as-written (e.g. "ns:code"),
      // independent of what skip.nsPrefix does to the processed output name.
      this._stopNodeProcessor = new StopNodeProcessor(tagExp.tagName, {
        nested: stopNodeConfig.nested,
        skipEnclosures: stopNodeConfig.skipEnclosures,
      });
      this._stopNodeProcessorMeta = { tagDetail, isSkip: false };
      this._stopNodeProcessor.activate();
      const { content, end: stopEnd } = this._stopNodeProcessor.collect(this.source);
      this.outputBuilder.addElement(tagDetail, this.readonlyMatcher);
      this.outputBuilder.onStopNode?.(tagDetail, content, this.readonlyMatcher, stopEnd);
      this.outputBuilder.addValue(content, this.readonlyMatcher);
      // closeMeta for a stop node carries only `closeEnd` (offset right after
      // the matched </tagname> was consumed) — StopNodeProcessor scans the
      // closing tag opaquely and doesn't track where '</tagname' itself starts,
      // so unlike the normal close path we don't have a real index
      // for the close tag's own start, only its end.
      this.outputBuilder.closeElement(this.readonlyMatcher, { name: tagDetail.name, closeEnd: stopEnd.index });
      this.matcher.pop();
      this._stopNodeProcessor = null;
      this._stopNodeProcessorMeta = null;
    } else if (skipTagConfig) {
      // Skip tag: collect raw content (to advance the source past the closing tag)
      // but call no output builder methods — the tag is silently dropped.
      // Raw tag name used for the same reason as the stop-node branch above.
      this._stopNodeProcessor = new StopNodeProcessor(tagExp.tagName, { nested: skipTagConfig.nested, skipEnclosures: skipTagConfig.skipEnclosures });
      this._stopNodeProcessorMeta = { tagDetail, isSkip: true };
      this._stopNodeProcessor.activate();
      this._stopNodeProcessor.collect(this.source); // advance source; content discarded
      this.matcher.pop();
      this._stopNodeProcessor = null;
      this._stopNodeProcessorMeta = null;
    } else if (this._exitIf(this.readonlyMatcher)) {
      // ── exitIf ───────────────────────────────────────────────────────────────
      // Checked BEFORE addElement so the triggering tag is never added to the
      // output builder. The matcher is already positioned (push + updateCurrent
      // above), so attribute-based predicates work correctly.
      //
      // We pop the matcher entry for this tag (it was never added to the builder),
      // then close all already-open ancestors so the builder can finalise its tree.

      const exitDepth = this.tagsStack.length; // number of ancestors open before this tag
      this.matcher.pop(); // undo the push for the triggering tag

      while (this.currentTagDetail && !this.currentTagDetail.root) {
        this.addTextNode();
        this.popTag();
      }

      // Notify the output builder that parsing was intentionally truncated.
      if (typeof this.outputBuilder.onExit === 'function') {
        this.outputBuilder.onExit({ tagDetail, matcher: this.readonlyMatcher, depth: exitDepth });
      }

      this._exitIfTriggered = true;
    } else {
      this.pushTag(tagDetail);
    }
  }

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
   */
  popTag(closeMeta?: CloseMeta): void {
    this.outputBuilder.closeElement(this.readonlyMatcher, closeMeta ?? { name: this.currentTagDetail?.name as string });
    this.matcher.pop();
    this.currentTagDetail = this.tagsStack.pop() ?? null;
  }

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
   * @throws {ParseError} `INVALID_TAG` for anything that isn't a comment, CDATA, or DOCTYPE; `UNEXPECTED_END` on a chunk boundary.
   */
  readSpecialTag(startCh: string): void {
    if (startCh === '!') {
      const nextChar = this.source.readCh();
      if (nextChar === null || nextChar === undefined)
        throw new ParseError("Unexpected end of source after '<!'", ErrorCode.UNEXPECTED_END, errorPositionOf(this.source));

      if (nextChar === '-') {
        readComment(this);
      } else if (nextChar === '[') {
        readCdata(this);
      } else if (nextChar === 'D') {
        // DOCTYPE is always read to consume its content and advance the cursor.
        // Entities are forwarded to the output builder only when doctypeOptions.enabled is true.
        const docTypeEntities = readDocType(this);
        if (this.doctypeFound) {
          throw new ParseError('Multiple DOCTYPE declarations found.', ErrorCode.INVALID_INPUT, errorPositionOf(this.source));
        }
        this.doctypeFound = true;
        if (this.options.doctypeOptions.enabled && docTypeEntities && Object.keys(docTypeEntities).length > 0) {
          this.outputBuilder.addInputEntities(docTypeEntities);
        }
      }
    } else {
      throw new ParseError(`Invalid tag '<${startCh}'`, ErrorCode.INVALID_TAG, errorPositionOf(this.source));
    }
  }

  /**
   * @description Flush any accumulated text to the output builder, then reset the accumulator. Normalization and illegal-control-character rejection happen here,
   * once per complete text run (never mid-chunk — see `util.sanitizeContent`). Whitespace-only runs are dropped entirely when `skip.whitespaceText`
   * is on.
   */
  addTextNode(): void {
    if (this.tagTextData !== undefined && this.tagTextData !== '') {
      // Line-ending normalization + illegal-control-character rejection,
      // applied once per complete text run (never mid-chunk — see util.js).
      this.tagTextData = sanitizeContent(this.tagTextData, this.source);
      // Pass raw text — entity expansion is handled by 'entities' ValueParser in the chain
      if (!this.options.skip.whitespaceText || this.tagTextData.trim().length > 0) {
        this.outputBuilder.addValue(this.tagTextData, this.readonlyMatcher);
      }
      this.tagTextData = '';
    }
  }

  /**
   * @description Cached wrapper around `getNameValidator('qName')` — shape-validating a tag name is a pure function of the name string alone (for a fixed XML
   * version, itself fixed for the whole document), so a name seen once and found valid never needs the regex re-run for its later occurrences. Only
   * opening tag names go through this (see `buildTagExpObj` in `XmlPartReader`); closing tags are checked by exact-match against the
   * already-validated opening name instead (`readClosingTag`), so they never need shape validation of their own. Only valid names are cached — an
   * invalid name throws every time it's seen, never silently let through after a first failure.
   */
  isValidQName(name: string): boolean {
    const cache = this._validQNames;
    if (cache.has(name)) return true;
    const ok = this.getNameValidator('qName')(name);
    if (ok) {
      if (cache.size >= NAME_CACHE_LIMIT) cache.clear();
      cache.add(name);
    }
    return ok;
  }

  /**
   * @description Returns a memoized xml-naming validator for the given production (`'qName'` for tag/attribute names, `'name'` for DOCTYPE entity/element names),
   * built lazily on first use and cached per parser instance for the rest of the document/session. `xmlDec.version` is stored as a number (1 / 1.1)
   * but xml-naming's `xmlVersion` option is the string `'1.0'` / `'1.1'` — normalized here rather than changing `xmlDec`'s public shape (it's
   * forwarded as-is to `outputBuilder.addDeclaration()`, so its type is part of the builder contract, not just an internal detail).
   */
  getNameValidator(production: Production): NameValidator {
    let validator = this._nameValidators[production];
    if (!validator) {
      const xmlVersion = this.xmlDec.version === 1.1 ? '1.1' : '1.0';
      validator = createValidator(production, { xmlVersion });
      this._nameValidators[production] = validator;
    }
    return validator;
  }

  /**
   * @description Process a raw attribute name: resolve its namespace prefix, validate it, sanitize it, and apply the reserved-name check. Cached.
   *
   * @returns The processed name, or `false` when the attribute was a dropped `xmlns:` declaration.
   *
   * @throws {ParseError} `INVALID_ATTRIBUTE_NAME`, `SECURITY_RESTRICTED_NAME`, `SECURITY_PROTOTYPE_POLLUTION`, `MULTIPLE_NAMESPACES`.
   */
  processAttrName(rawAttrName: string): string | false {
    return getCachedName(this._nameCache.attrs, rawAttrName, () => {
      const options = this.options;
      let attrName = resolveNsPrefix(rawAttrName, options.skip.nsPrefix, this.source);
      if (attrName === false) return false;
      if (!this.getNameValidator('qName')(attrName)) {
        //TODO: make it optional
        throw new ParseError(`Invalid attribute name: ${attrName}`, ErrorCode.INVALID_ATTRIBUTE_NAME, errorPositionOf(this.source));
      }
      attrName = sanitizeName(attrName, options.onDangerousProperty, options.sanitizeNames, this.source);
      if (options.strictReservedNames && attrName === options.attributes.groupBy) {
        throw new ParseError(`Restricted attribute name: ${attrName}`, ErrorCode.SECURITY_RESTRICTED_NAME, errorPositionOf(this.source));
      }
      return attrName;
    });
  }

  /**
   * @description Process a raw tag name: resolve its namespace prefix, sanitize it, and apply the reserved-name check. Cached.
   *
   * @throws {ParseError} `SECURITY_RESTRICTED_NAME`, `SECURITY_PROTOTYPE_POLLUTION`, `MULTIPLE_NAMESPACES`.
   */
  processTagName(rawTagName: string): string {
    return getCachedName(this._nameCache.tags, rawTagName, () => {
      const options = this.options;
      const nameFor = options.nameFor;
      let tagName = resolveNsPrefix(rawTagName, options.skip.nsPrefix, this.source);
      if (tagName === false) tagName = rawTagName;
      tagName = sanitizeName(tagName, options.onDangerousProperty, options.sanitizeNames, this.source);
      if (options.strictReservedNames && (tagName === nameFor.comment || tagName === nameFor.cdata || tagName === nameFor.text)) {
        throw new ParseError(`Restricted tag name: ${tagName}`, ErrorCode.SECURITY_RESTRICTED_NAME, errorPositionOf(this.source));
      }
      return tagName;
    });
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
 * @returns The local name, the original name when prefix-stripping is off or the name has no prefix, or `false` for a dropped `xmlns` declaration.
 *
 * @throws {ParseError} `MULTIPLE_NAMESPACES` when a name carries more than one colon.
 */
function resolveNsPrefix(name: string, skipNsPrefix: boolean | undefined, source: InputSourceLike): string | false {
  if (skipNsPrefix) {
    const parts = name.split(':');
    if (parts.length === 2) {
      if (parts[0] === 'xmlns') return false; // drop xmlns declarations
      return parts[1] as string;
    } else if (parts.length > 2) {
      throw new ParseError(`Multiple namespaces in name: ${name}`, ErrorCode.MULTIPLE_NAMESPACES, errorPositionOf(source));
    }
  }
  return name;
}

/**
 * @description Reject prototype-polluting names and optionally rename shadowing ones. `criticalProperties` (`__proto__`, `constructor`, `prototype`) guard against
 * an actual prototype-pollution vulnerability in the output object, not just a naming collision — this check always runs and `sanitizeNames` cannot
 * turn it off. Only the `DANGEROUS_PROPERTY_NAMES` rename step (a milder, cosmetic shadowing concern) is skippable for trusted input.
 *
 * @throws {ParseError} `SECURITY_PROTOTYPE_POLLUTION` for a critical name.
 */
function sanitizeName(name: string, onDangerousProperty: (n: string) => string, sanitizeNames: boolean | undefined, source: InputSourceLike): string {
  if (criticalProperties.includes(name)) {
    throw new ParseError(
      `[SECURITY] Invalid name: "${name}" is a reserved JavaScript keyword that could cause prototype pollution`,
      ErrorCode.SECURITY_PROTOTYPE_POLLUTION,
      errorPositionOf(source)
    );
  }
  if (sanitizeNames === false) return name;
  if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
    return onDangerousProperty(name);
  }
  return name;
}

/**
 * @description Returns true for errors thrown by read functions when the source ran out mid-token — i.e. the document was truncated inside a tag. These are the
 * only errors intercepted for autoClose recovery. Syntax errors (unclosed quotes) are NOT intercepted — they rethrow.
 */
function isSourceExhaustedError(err: unknown): boolean {
  // Accept both ParseError (with codes) and plain Error from lower-level readers
  if (err instanceof ParseError) {
    return err.code === ErrorCode.UNEXPECTED_END;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith('Unexpected end of source') || message.startsWith('Unexpected closing of source');
}

/**
 * @description Returns the matched stop-node config `{ nested, skipEnclosures }` (from `Expression.data`) if the current matcher position matches any stop-node
 * expression, or `null` if not. Uses `ExpressionSet.findMatch()` for O(1) indexed lookup. Installed as an instance property and called as
 * `this.isStopNode()`, so the receiver is the parser.
 */
function isStopNode(this: Xml2JsParser): TagExpressionConfig | null {
  if (this.stopNodeExpressionsSet.size === 0) return null;
  const matched = this.stopNodeExpressionsSet.findMatch(this.matcher);
  return matched ? (matched.data ?? null) : null;
}

/**
 * @description Returns the matched skip-tag config `{ nested, skipEnclosures }` (from `Expression.data`) if the current matcher position matches any `skip.tags`
 * expression, or `null` if not. Uses `ExpressionSet.findMatch()` for O(1) indexed lookup. Installed as an instance property and called as
 * `this.isSkipTag()`, so the receiver is the parser.
 */
function isSkipTag(this: Xml2JsParser): TagExpressionConfig | null {
  if (this.skipTagExpressionsSet.size === 0) return null;
  const matched = this.skipTagExpressionsSet.findMatch(this.matcher);
  return matched ? (matched.data ?? null) : null;
}
