import type { MatcherView } from '@endevops/path-expression-matcher';

import type { BuiltInValueParserOptions, BuilderParserOptions } from './options.ts';
import type { ValueParser, ValueParserRegistryLike } from './value-parser.ts';

import { Context, SharedContext, ValueParserPipeline } from './value-parser.ts';

/**
 * @description The chain a builder uses for element text when it configures nothing.
 */
const DEFAULT_TAG_PARSERS: (string | ValueParser)[] = ['ws', 'entity', 'boolean', 'number'];

/**
 * @description The chain a builder uses for attribute values when it configures nothing. Note the difference from the tag chain: no `'ws'`. Attribute whitespace
 * is significant, so normalizing it would corrupt the value.
 */
const DEFAULT_ATTR_PARSERS: (string | ValueParser)[] = ['entity', 'boolean', 'number'];

/**
 * @description The detail the parser reports for a tag, at the position it was seen.
 */
export interface TagDetailLike extends TagNameLike {
  /**
   * @description Zero-based offset from the start of the document.
   */
  index: number;
}

/**
 * @description The least a parser promises about a tag it is describing: a name. Used where a position cannot be guaranteed. Not every close has a real closing
 * token — a parser synthesizing one at EOF, or `exitIf` closing already-open ancestors, has no offset to report — so anything beyond `name` would be
 * a promise no parser could keep. A parser that does have positions passes them anyway, and a {@link TagDetailLike} is assignable to this, so a
 * builder that wants them can declare the wider type on its own method.
 */
export interface TagNameLike {
  /**
   * @description The tag name.
   */
  name: string;
}

/**
 * @description What the parser reports when a tag closes: when it closed, and where. Only `name` is guaranteed. A synthesized close — one the parser invented, at
 * EOF or to satisfy `exitIf` — has no real closing token, so the two offsets are absent. Both are typed `| undefined` rather than bare optional on
 * purpose: under `exactOptionalPropertyTypes` a bare `closeEnd?: number` rejects a parser that passes `{ closeEnd: number | undefined }`, and this
 * interface has to accept a parser's own richer `CloseMeta` unchanged.
 */
export interface CloseMetaLike {
  /**
   * @description The tag that closed.
   */
  name: string;
  /**
   * @description Zero-based offset of the closing tag's `<`. Absent for a synthesized close.
   */
  index?: number | undefined;
  /**
   * @description Zero-based offset just past the closing tag's `>`. Absent for a synthesized close.
   */
  closeEnd?: number | undefined;
}

/**
 * @description The state the parser reports when an `exitIf` predicate fires.
 */
export interface ExitInfoLike {
  /**
   * @description The tag that triggered the exit. Only a name is guaranteed — `exitIf` can close a tag that never had a closing token.
   */
  tagDetail: TagNameLike;
  /**
   * @description The path at the moment the predicate fired.
   */
  matcher: MatcherView;
  /**
   * @description Nesting depth at exit, where 0 is a root child.
   */
  depth: number;
}

/**
 * @description The base every output builder extends. A parser walks the document and calls a fixed set of methods here; a subclass decides what the resulting
 * structure looks like. What this class provides is everything that is the same regardless of output shape — the two value-parser pipelines, the
 * shared per-document context, and the policy for comments, CDATA, declarations and stop nodes, all driven by the parser's own options rather than by
 * hardcoded rules. The methods a subclass normally overrides are `addElement`, `closeElement`, `addValue` and `getOutput`. The rest have working
 * defaults here.
 */
export default class BaseOutputBuilder {
  /**
   * @description The parser's options, read through narrow accessors. Kept as a record because the parser's option set is its own, not this package's — a builder
   * must not fail to compile when the parser grows an option.
   */
  readonly parserOptions: BuilderParserOptions & Record<string, unknown>;
  /**
   * @description The live path, or `null` when the parser supplied none. Read-only to subclasses in practice — mutating it would corrupt the parse.
   */
  readonly matcher: MatcherView | null;
  /**
   * @description This builder's own options — value parser chains and the output-shape flags.
   */
  readonly builderOptions: BuiltInValueParserOptions;
  /**
   * @description The factory's parser registry, shared with every builder it produces.
   */
  readonly registry: ValueParserRegistryLike;
  /**
   * @description The per-document store, handed to every value parser that implements `init`.
   */
  readonly sharedContext: SharedContext;
  /**
   * @description The chain for element text. Call `run(val, context)` from `closeElement`.
   */
  readonly tagsPipeline: ValueParserPipeline;
  /**
   * @description The chain for attribute values. Call `run(val, context)` from `addAttribute`.
   */
  readonly attrsPipeline: ValueParserPipeline;
  /**
   * @description The sentinel name the builder starts on, before any real tag. An attribute on the root declaration can be recognised by comparing against it.
   */
  readonly _rootName: string;
  /**
   * @description Whether a stop node is mid-collection, so its content bypasses the value-parser chain — it is already-decoded raw text.
   */
  _pendingStopNode: boolean;

  /**
   * @description Create a builder for one document. `parserOptions` is typed `object` because that is what a parser actually has: its own options interface, which
   * has no index signature. Promising a `Record<string, unknown>` here would be a lie in the safe direction — it would reject a perfectly good
   * options interface. The cast below is therefore the single place this package states what it reads, rather than every caller re-encoding it.
   *
   * @param parserOptions - The parser's options.
   * @param builderOptions - This builder's options. The value-parser chains are read from it, falling back to the defaults.
   * @param matcherView - The live path, or `null`.
   * @param registry - Where value-parser names resolve.
   * @param resetPipelines - Whether to reset the parsers on construction. Defaults to true; pass false only when the caller has already reset them.
   */
  constructor(
    parserOptions: object,
    builderOptions: BuiltInValueParserOptions,
    matcherView: MatcherView | null,
    registry: ValueParserRegistryLike,
    resetPipelines = true
  ) {
    this.matcher = matcherView;
    this._rootName = '^';
    // Every read below goes through the `?.` chains, so a parser that omitted a
    // group it never configured is handled rather than merely typed.
    this.parserOptions = parserOptions as BuilderParserOptions & Record<string, unknown>;
    this.builderOptions = builderOptions;
    this.registry = registry;

    const tagChain = builderOptions?.tags?.valueParsers ?? DEFAULT_TAG_PARSERS;
    const attrChain = builderOptions?.attributes?.valueParsers ?? DEFAULT_ATTR_PARSERS;

    // Shared mutable context distributed to all value parsers.
    // This class is the sole writer; parsers are readers (or
    // co-writers for cross-parser communication).
    this.sharedContext = new SharedContext();
    this.tagsPipeline = new ValueParserPipeline(tagChain, this.registry, this.sharedContext);
    this.attrsPipeline = new ValueParserPipeline(attrChain, this.registry, this.sharedContext);

    if (resetPipelines) {
      this.tagsPipeline.resetAll();
      this.attrsPipeline.resetAll();
    }

    this._pendingStopNode = false;
  }

  /**
   * @description Enter a tag. Every concrete builder implements this; the base takes no position on a document's shape, so there is nothing to do here.
   *
   * @param tag - The tag being entered.
   * @param matcher - The live path.
   */
  addElement(tag: TagDetailLike, matcher: MatcherView): void {
    // Subclasses build their own structure here.
    void tag;
    void matcher;
  }

  /**
   * @description Close a tag, appending whatever has accumulated for it to the parent.
   *
   * @param matcher - The live path.
   * @param closeMeta - When and where the tag closed, for a builder that records it.
   */
  closeElement(matcher: MatcherView, closeMeta?: CloseMetaLike): void {
    // Subclasses build their own structure here.
    void matcher;
    void closeMeta;
  }

  /**
   * @description Record an attribute on the current element. The base implementation writes into `this.attributes`, which only exists on the subclass shapes that
   * keep a flat attribute bag. A builder with a different structure should override this rather than call it.
   *
   * @param name - The attribute name, already prefixed and sanitised by the parser.
   * @param value - The raw value.
   * @param matcher - The live path.
   * @param meta - Where the attribute was seen, for a builder that records it.
   */
  addAttribute(name: string, value: unknown, matcher: MatcherView, meta?: unknown): void {
    // `meta` is accepted because the parser supplies it, not because the base
    // needs it — only a builder that records attribute positions reads it.
    void meta;
    // Capture XML version from the declaration tag and make it available to
    // value parsers (e.g. EntityParser) via SharedContext.
    const tagName = (this as { tagName?: string }).tagName;
    if (name === 'version' && tagName === this._rootName) {
      this.sharedContext?.set('xmlVersion', Number(value));
    }
    const { prefix = '', suffix = '' } = this.parserOptions.attributes ?? {};
    const context = new Context(name, matcher, true, true); // attributes are always leaf values
    const bag = (this as { attributes?: Record<string, unknown> }).attributes;
    if (bag) {
      bag[`${prefix}${name}${suffix}`] = this.attrsPipeline.run(value, context);
    }
  }

  /**
   * @description Append a text value. A subclass whose shape holds text implements this; the base has nowhere to put it.
   *
   * @param text - The text.
   * @param matcher - The live path.
   */
  addValue(text: string, matcher: MatcherView): void {
    // The base shape has no text slot; every concrete builder implements this.
    void text;
    void matcher;
  }

  /**
   * @description Hook for subclasses to append a named child. The base does nothing — the storage shape is the subclass's to choose.
   *
   * @param key - The child's key.
   * @param val - The child's value.
   */
  _addChild(key: string, val: unknown): void {
    // Nothing to add to in the base shape.
    void key;
    void val;
  }

  /**
   * @description Record a comment: dropped when `skip.comment`, stored under `nameFor.comment` when set, omitted when that name is empty.
   *
   * @param text - The comment body.
   */
  addComment(text: string): void {
    if (this.parserOptions.skip?.comment) return;
    const commentName = this.parserOptions.nameFor?.comment;
    if (commentName) {
      this._addChild(commentName, text);
    }
  }

  /**
   * @description Record CDATA: dropped when `skip.cdata`, stored under `nameFor.cdata` when set, otherwise merged into the element's text.
   *
   * @param text - The CDATA body.
   */
  addLiteral(text: string): void {
    if (this.parserOptions.skip?.cdata) return;
    const cdataName = this.parserOptions.nameFor?.cdata;
    if (cdataName) {
      this._addChild(cdataName, text);
    } else {
      this.addRawValue(text || '');
    }
  }

  /**
   * @description Append text to the element's value, bypassing the value-parser chain.
   *
   * @param text - The text.
   * @param matcher - The live path, forwarded to {@link BaseOutputBuilder.addValue}.
   */
  addRawValue(text: string, matcher?: MatcherView): void {
    this.addValue(text, matcher as MatcherView);
  }

  /**
   * @description Take the document's DOCTYPE entities, so the entity value parser can resolve them from its first call.
   *
   * @param entities - The entity map from the DOCTYPE block.
   */
  addInputEntities(entities: Record<string, unknown>): void {
    this.sharedContext?.set('inputEntities', entities);
  }

  /**
   * @description Record an XML declaration. The base treats it as a processing instruction.
   *
   * @param name - The declaration's rendered text.
   * @param xmlDeclaration - The declaration's attributes, for a builder that records them.
   */
  addDeclaration(name: string, xmlDeclaration?: unknown): void {
    this.addInstruction(name);
    void xmlDeclaration;
  }

  /**
   * @description Record a processing instruction. A no-op in the base; subclasses that keep instructions override it.
   *
   * @param name - The instruction's rendered text.
   */
  addInstruction(name: string): void {
    // Subclasses that keep processing instructions override this.
    void name;
  }

  /**
   * @description Called when a stop node has been fully collected, before its content is added as a value. Sets the pending flag so the collected text bypasses
   * the value-parser chain — a stop node's content is raw text the parser already decided not to decode, and running the chain over it would decode
   * it a second time. Forwards to the parser's own `onStopNode` option if the caller set one. The signature is the four arguments a parser actually
   * passes, not the two the base itself uses. A parser may only promise a `name` on the detail, and may only supply a live matcher and an end offset
   * for a stop node it fully collected — hence all three are optional — but a builder that needs them has to be able to declare them, and a subclass
   * cannot widen its base's parameter list.
   *
   * @param tagDetail - Where the stop node was.
   * @param rawContent - Its undecoded content.
   * @param matcher - The live path, when the parser has one.
   * @param end - Where the collected `</tag>` token ended.
   */
  onStopNode(tagDetail: TagNameLike, rawContent: string, matcher?: MatcherView, end?: { index: number }): void {
    this._pendingStopNode = true;
    // The parser's own hook gets this builder's matcher rather than the
    // argument's, because the argument is optional and the builder always has one.
    const onStopNode = this.parserOptions.onStopNode;
    if (typeof onStopNode === 'function') {
      onStopNode(tagDetail, rawContent, this.matcher);
    }
    void matcher;
    void end;
  }

  /**
   * @description Called when the parser's `exitIf` predicate fires. A no-op in the base.
   *
   * @param exitInfo - The state at the moment of exit.
   */
  onExit(exitInfo: ExitInfoLike): void {
    // Subclasses that record the exit position override this.
    void exitInfo;
  }

  /**
   * @description The finished result. A builder with no result of its own returns nothing.
   *
   * @returns The output structure.
   */
  getOutput(): unknown {
    return undefined;
  }
}
