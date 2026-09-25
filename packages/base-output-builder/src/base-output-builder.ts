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
export interface TagDetailLike {
  /**
   * @description The tag name.
   */
  name: string;
  /**
   * @description Zero-based offset from the start of the document.
   */
  index: number;
}

/**
 * @description The state the parser reports when an `exitIf` predicate fires.
 */
export interface ExitInfoLike {
  /**
   * @description The tag that triggered the exit.
   */
  tagDetail: TagDetailLike;
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
   * @description Create a builder for one document.
   *
   * @param parserOptions - The parser's options.
   * @param builderOptions - This builder's options. The value-parser chains are read from it, falling back to the defaults.
   * @param matcherView - The live path, or `null`.
   * @param registry - Where value-parser names resolve.
   * @param resetPipelines - Whether to reset the parsers on construction. Defaults to true; pass false only when the caller has already reset them.
   */
  constructor(
    parserOptions: BuilderParserOptions & Record<string, unknown>,
    builderOptions: BuiltInValueParserOptions,
    matcherView: MatcherView | null,
    registry: ValueParserRegistryLike,
    resetPipelines = true
  ) {
    this.matcher = matcherView;
    this._rootName = '^';
    this.parserOptions = parserOptions;
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
   * @description Record an attribute on the current element. The base implementation writes into `this.attributes`, which only exists on the subclass shapes that
   * keep a flat attribute bag. A builder with a different structure should override this rather than call it.
   *
   * @param name - The attribute name, already prefixed and sanitised by the parser.
   * @param value - The raw value.
   * @param matcher - The live path.
   */
  addAttribute(name: string, value: unknown, matcher: MatcherView): void {
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
   * @description Append a text value. A subclass whose shape holds text overrides this; the base has nowhere to put it.
   *
   * @param text - The text.
   */
  addValue(text: string): void {
    // The base shape has no text slot; every concrete builder overrides this.
    void text;
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
   */
  addRawValue(text: string): void {
    this.addValue(text);
  }

  /**
   * @description Take the document's DOCTYPE entities, so the entity value parser can resolve them from its first call.
   *
   * @param entities - The entity map from the DOCTYPE block.
   */
  addInputEntities(entities: Record<string, string>): void {
    this.sharedContext?.set('inputEntities', entities);
  }

  /**
   * @description Record an XML declaration. The base treats it as a processing instruction.
   *
   * @param name - The declaration's rendered text.
   */
  addDeclaration(name: string): void {
    this.addInstruction(name);
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
   * it a second time. Forwards to the parser's own `onStopNode` option if the caller set one.
   *
   * @param tagDetail - Where the stop node was.
   * @param rawContent - Its undecoded content.
   */
  onStopNode(tagDetail: TagDetailLike, rawContent: string): void {
    this._pendingStopNode = true;
    const onStopNode = this.parserOptions.onStopNode;
    if (typeof onStopNode === 'function') {
      onStopNode(tagDetail, rawContent, this.matcher);
    }
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
