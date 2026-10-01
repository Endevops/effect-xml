import type { MatcherView } from '@endevops/common-xml';

import { Effect } from 'effect';

import type { BuilderError } from '#/errors.ts';

import type { BuiltInValueParserOptions, BuilderParserOptions } from './options.ts';
import type { Context, SharedContext, ValueParserPipeline, ValueParserRegistryLike } from './value-parser.ts';

import { makeContext, makeSharedContext, makeValueParserPipeline } from './value-parser.ts';

/**
 * @description The chain a builder uses for element text when it configures nothing.
 */
const DEFAULT_TAG_PARSERS: Array<string> = ['ws', 'entity', 'boolean', 'number'];

/**
 * @description The chain a builder uses for attribute values when it configures nothing. Note the difference from the tag chain: no `'ws'`. Attribute whitespace
 * is significant, so normalizing it would corrupt the value.
 */
const DEFAULT_ATTR_PARSERS: Array<string> = ['entity', 'boolean', 'number'];

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
 * a promise no parser could keep. A parser that does have positions passes them anyway, and a {@link TagDetailLike} is assignable to this.
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
   * @description The tag that triggered the exit. Only a name is guaranteed.
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
 * @description The per-document contract a parser drives. A plain value built by {@link makeBaseOutputBuilder} or {@link makeCompactBuilder}, not a class: the
 * parser holds one for the duration of one document and calls a fixed set of methods on it. Everything the base supplies is the same regardless of
 * output shape — the two value-parser pipelines, the shared per-document context, and the policy for comments, CDATA, declarations and stop nodes,
 * all driven by the parser's own options rather than by hardcoded rules.
 */
export interface OutputBuilder {
  /**
   * @description The parser's options, read through narrow accessors. Kept as a record because the parser's option set is its own, not this package's — a builder
   * must not fail to compile when the parser grows an option.
   */
  readonly parserOptions: BuilderParserOptions & Record<string, unknown>;
  /**
   * @description The live path, or `null` when the parser supplied none.
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
   * @description The chain for element text.
   */
  readonly tagsPipeline: ValueParserPipeline;
  /**
   * @description The chain for attribute values.
   */
  readonly attrsPipeline: ValueParserPipeline;
  /**
   * @description The sentinel name the builder starts on, before any real tag.
   */
  readonly _rootName: string;
  /**
   * @description Whether a stop node is mid-collection, so its content bypasses the value-parser chain.
   */
  _pendingStopNode: boolean;

  /**
   * @description Enter a tag. A concrete builder implements this; the base takes no position on a document's shape.
   */
  addElement(tag: TagDetailLike, matcher: MatcherView): void;
  /**
   * @description Close a tag, appending whatever has accumulated for it to the parent.
   */
  closeElement(matcher: MatcherView, closeMeta?: CloseMetaLike): Effect.Effect<void, BuilderError>;
  /**
   * @description Record an attribute on the current element.
   */
  addAttribute(name: string, value: unknown, matcher: MatcherView, meta?: unknown): Effect.Effect<void, BuilderError>;
  /**
   * @description Append a text value.
   */
  addValue(text: string, matcher: MatcherView): void;
  /**
   * @description Hook for subclasses to append a named child. The base does nothing.
   */
  _addChild(key: string, val: unknown): void;
  /**
   * @description Record a comment: dropped when `skip.comment`, stored under `nameFor.comment` when set, omitted when that name is empty.
   */
  addComment(text: string): void;
  /**
   * @description Record CDATA: dropped when `skip.cdata`, stored under `nameFor.cdata` when set, otherwise merged into the element's text.
   */
  addLiteral(text: string): void;
  /**
   * @description Append text to the element's value, bypassing the value-parser chain.
   */
  addRawValue(text: string, matcher?: MatcherView): void;
  /**
   * @description Take the document's DOCTYPE entities, so the entity value parser can resolve them.
   */
  addInputEntities(entities: Record<string, unknown>): void;
  /**
   * @description Record an XML declaration.
   */
  addDeclaration(name: string, xmlDeclaration?: unknown): void;
  /**
   * @description Record a processing instruction.
   */
  addInstruction(name: string): void;
  /**
   * @description Called when a stop node has been fully collected, before its content is added as a value.
   */
  onStopNode(tagDetail: TagNameLike, rawContent: string, matcher?: MatcherView, end?: { index: number }): void;
  /**
   * @description Called when the parser's `exitIf` predicate fires.
   */
  onExit(exitInfo: ExitInfoLike): void;
  /**
   * @description The finished result.
   */
  getOutput(): unknown;
}

/**
 * @description Create the base per-document builder. It supplies everything that is the same regardless of output shape — the two value-parser pipelines, the
 * shared per-document context, and the policy for comments, CDATA, declarations and stop nodes — and leaves the shape itself to the caller, which
 * builds on the returned value.
 *
 * @param parserOptions - The parser's options.
 * @param builderOptions - This builder's options. The value-parser chains are read from it, falling back to the defaults.
 * @param matcherView - The live path, or `null`.
 * @param registry - Where value-parser names resolve.
 * @param resetPipelines - Whether to reset the parsers on construction. Defaults to true; pass false only when the caller has already reset them.
 *
 * @returns The base builder.
 */
export const makeBaseOutputBuilder = (
  parserOptions: object,
  builderOptions: BuiltInValueParserOptions,
  matcherView: MatcherView | null,
  registry: ValueParserRegistryLike,
  resetPipelines = true
): OutputBuilder => {
  const tagChain = builderOptions?.tags?.valueParsers ?? DEFAULT_TAG_PARSERS;
  const attrChain = builderOptions?.attributes?.valueParsers ?? DEFAULT_ATTR_PARSERS;

  // Shared mutable context distributed to all value parsers.
  const sharedContext = makeSharedContext();
  const tagsPipeline = makeValueParserPipeline(tagChain, registry, sharedContext);
  const attrsPipeline = makeValueParserPipeline(attrChain, registry, sharedContext);

  if (resetPipelines) {
    tagsPipeline.resetAll();
    attrsPipeline.resetAll();
  }

  const builder: OutputBuilder = {
    matcher: matcherView,
    _rootName: '^',
    // Every read below goes through the `?.` chains, so a parser that omitted a
    // group it never configured is handled rather than merely typed.
    parserOptions: parserOptions as BuilderParserOptions & Record<string, unknown>,
    builderOptions,
    registry,
    sharedContext,
    tagsPipeline,
    attrsPipeline,
    _pendingStopNode: false,

    /**
     * @description Enter a tag. The base takes no position on a document's shape, so there is nothing to do here.
     */
    addElement(tag: TagDetailLike, matcher: MatcherView): void {
      void tag;
      void matcher;
    },

    /**
     * @description Close a tag. The base shape has no output of its own, so this is a no-op.
     */
    closeElement(matcher: MatcherView, closeMeta?: CloseMetaLike): Effect.Effect<void, BuilderError> {
      void matcher;
      void closeMeta;
      return Effect.void;
    },

    /**
     * @description Record an attribute on the current element. The base implementation writes into `this.attributes`, which only exists on subclass shapes that
     * keep a flat attribute bag.
     */
    addAttribute(name: string, value: unknown, matcher: MatcherView, meta?: unknown): Effect.Effect<void, BuilderError> {
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
      const context: Context = makeContext(name, matcher, true, true); // attributes are always leaf values
      const bag = (this as { attributes?: Record<string, unknown> }).attributes;
      if (!bag) return Effect.void;
      // Plain rather than a generator: the value chain is the only fallible step, so this returns it
      // mapped and the walk inlines the result. A no-bag builder answers with the shared `Effect.void`.
      return Effect.mapEager(this.attrsPipeline.run(value, context), (parsed: unknown) => {
        bag[`${prefix}${name}${suffix}`] = parsed;
      });
    },

    /**
     * @description Append a text value. The base shape has nowhere to put it.
     */
    addValue(text: string, matcher: MatcherView): void {
      void text;
      void matcher;
    },

    /**
     * @description Hook for subclasses. The base does nothing.
     */
    _addChild(key: string, val: unknown): void {
      void key;
      void val;
    },

    /**
     * @description Record a comment: dropped when `skip.comment`, stored under `nameFor.comment` when set, omitted when that name is empty.
     */
    addComment(text: string): void {
      if (this.parserOptions.skip?.comment) return;
      const commentName = this.parserOptions.nameFor?.comment;
      if (commentName) {
        this._addChild(commentName, text);
      }
    },

    /**
     * @description Record CDATA: dropped when `skip.cdata`, stored under `nameFor.cdata` when set, otherwise merged into the element's text.
     */
    addLiteral(text: string): void {
      if (this.parserOptions.skip?.cdata) return;
      const cdataName = this.parserOptions.nameFor?.cdata;
      if (cdataName) {
        this._addChild(cdataName, text);
      } else {
        this.addRawValue(text || '');
      }
    },

    /**
     * @description Append text to the element's value, bypassing the value-parser chain.
     */
    addRawValue(text: string, matcher?: MatcherView): void {
      this.addValue(text, matcher as MatcherView);
    },

    /**
     * @description Take the document's DOCTYPE entities, so the entity value parser can resolve them.
     */
    addInputEntities(entities: Record<string, unknown>): void {
      this.sharedContext?.set('inputEntities', entities);
    },

    /**
     * @description Record an XML declaration. The base treats it as a processing instruction.
     */
    addDeclaration(name: string, xmlDeclaration?: unknown): void {
      this.addInstruction(name);
      void xmlDeclaration;
    },

    /**
     * @description Record a processing instruction. A no-op in the base.
     */
    addInstruction(name: string): void {
      void name;
    },

    /**
     * @description Called when a stop node has been fully collected, before its content is added as a value. Sets the pending flag so the collected text bypasses
     * the value-parser chain — a stop node's content is raw text the parser already decided not to decode.
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
    },

    /**
     * @description Called when the parser's `exitIf` predicate fires. A no-op in the base.
     */
    onExit(exitInfo: ExitInfoLike): void {
      void exitInfo;
    },

    /**
     * @description The finished result. The base returns nothing.
     */
    getOutput(): unknown {
      return undefined;
    },
  };

  return builder;
};
