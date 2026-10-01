import type { MatcherView } from '@endevops/common-xml';

import { Context, Effect, Layer, Predicate } from 'effect';

import type { BuilderError } from '#/errors.ts';
import type { OutputBuilder, TagDetailLike } from '#/output-builder/base-output-builder.ts';
import type { Context as ValueContext, ValueParser, ValueParserRegistryLike } from '#/output-builder/value-parser';
import type { ValueParserRegistry } from '#/output-builder/value-parser-registry.ts';

import { makeBaseOutputBuilder } from '#/output-builder/base-output-builder.ts';
import { makeContext } from '#/output-builder/value-parser';
import { makeValueParserRegistry } from '#/output-builder/value-parser-registry.ts';

import type { FactoryOptions, ResolvedFactoryOptions } from './options.ts';

import { buildOptions } from './options-builder.ts';

/**
 * @description The parser options this builder reads, narrowed from the base class's wider record. The base accepts any parser options object — a builder must not
 * fail to compile when the parser grows an option. This builder, though, reads exactly three groups unconditionally, so the narrowed view states what
 * it assumes of a parser that has resolved them.
 */
export type CompactParserOptions = Record<string, unknown> & {
  nameFor: { text: string; comment?: string; cdata?: string };
  attributes: { prefix?: string; suffix?: string; groupBy?: string };
  skip: { comment?: boolean; cdata?: boolean; attributes?: boolean };
};

/**
 * @description A tag frame on {@link CompactBuilder.tagsStack}: the four fields the builder must restore when the tag closes.
 */
export interface TagFrame {
  /**
   * @description The tag name in scope before this one was pushed.
   */
  tagName: string;
  /**
   * @description The text accumulated before this one was pushed.
   */
  textValue: string;
  /**
   * @description The value the enclosing tag had accumulated so far — which is the object this tag's own value gets written into on close.
   */
  parentValue: CompactValue;
  /**
   * @description Whether the enclosing tag had attributes, so the flag can be restored rather than re-derived.
   */
  hasAttributes: boolean;
}

/**
 * @description A node's value while it is being built: an object once it has children or attributes, a bare string while it is still only text. The union is the
 * whole design of this builder.
 */
export type CompactValue = string | Record<string, unknown>;

/**
 * @description The minimal-object builder a parser drives for one document, and the methods the shape rules are written in. Built by {@link makeCompactBuilder}.
 */
export interface CompactBuilder extends OutputBuilder {
  /**
   * @description The parser's options, narrowed to the ones this builder reads.
   */
  readonly parserOptions: CompactParserOptions;
  /**
   * @description This builder's resolved options.
   */
  readonly builderOptions: ResolvedFactoryOptions;
  /**
   * @description One frame per open tag, holding the state to restore when that tag closes.
   */
  readonly tagsStack: Array<TagFrame>;
  /**
   * @description The object every top-level tag is written into.
   */
  readonly root: Record<string, unknown>;
  /**
   * @description The tag in scope, or the root sentinel before the first tag.
   */
  tagName: string;
  /**
   * @description The value being accumulated for {@link CompactBuilder.tagName}.
   */
  value: CompactValue;
  /**
   * @description The text accumulated for {@link CompactBuilder.tagName}, joined with `textJoint` as it arrives.
   */
  textValue: string;
  /**
   * @description The attributes seen for {@link CompactBuilder.tagName}, still to be folded into {@link CompactBuilder.value}.
   */
  attributes: Record<string, unknown>;
  /**
   * @description Whether {@link CompactBuilder.attributes} holds anything.
   */
  hasAttributes: boolean;

  /**
   * @description Fold the attributes seen so far into the value they belong to.
   */
  _buildAttributeValue(): CompactValue;
  /**
   * @description Combine the `alwaysArray` and `forceArray` votes.
   */
  _resolveForceArray(isLeafNode: boolean): boolean;
  /**
   * @description The `alwaysArray` half of the vote.
   */
  _alwaysArrayVote(): boolean | undefined;
  /**
   * @description The `forceArray` half of the vote.
   */
  _forceArrayVote(isLeafNode: boolean): boolean | undefined;
  /**
   * @description A leaf's closing value.
   */
  _closedLeafValue(value: CompactValue, textValue: string, hasAttributes: boolean, context: ValueContext): Effect.Effect<CompactValue, BuilderError>;
  /**
   * @description A non-leaf's closing value.
   */
  _closedContainerValue(value: CompactValue, textValue: string, context: ValueContext): Effect.Effect<CompactValue, BuilderError>;
  /**
   * @description Run a closing tag's text through the element value chain.
   */
  _parseText(text: string, context: ValueContext): Effect.Effect<unknown, BuilderError>;
  /**
   * @description Write `key` into `node`, turning it into an array when the key is already taken or the caller insists.
   */
  _addChildTo(key: string, val: unknown, node: CompactValue, forceArray: boolean): CompactValue;
}

/**
 * @description Build a minimal-object builder for one document: a tag with only text becomes that string, anything with children or attributes becomes an object,
 * and repeated tags become an array. Built on {@link makeBaseOutputBuilder}, whose shared methods it inherits through the object spread and whose
 * `this`-calls resolve to the compact overrides below.
 *
 * @param parserOptions - The parser's options, as `ResolvedOptions`.
 * @param builderOptions - This builder's resolved options.
 * @param readonlyMatcher - The live path, or `null`.
 * @param registry - Where value-parser names resolve.
 * @param resetPipelines - Whether to reset the value parsers. Defaults to true.
 *
 * @returns The compact builder.
 */
export const makeCompactBuilder = (
  parserOptions: object,
  builderOptions: ResolvedFactoryOptions,
  readonlyMatcher: MatcherView | null,
  registry: ValueParserRegistryLike,
  resetPipelines = true
): CompactBuilder => {
  const base = makeBaseOutputBuilder(parserOptions, builderOptions, readonlyMatcher, registry, resetPipelines);

  const builder: CompactBuilder = {
    ...base,
    parserOptions: parserOptions as CompactParserOptions,
    builderOptions,
    tagsStack: [],
    root: {},
    tagName: base._rootName,
    value: {},
    textValue: '',
    attributes: {},
    hasAttributes: false,

    /**
     * @description Fold the attributes seen so far into the value they belong to.
     *
     * @returns The attribute value, or `''` when there are none.
     */
    _buildAttributeValue(): CompactValue {
      if (isEmpty(this.attributes)) {
        this.hasAttributes = false;
        return '';
      }
      this.hasAttributes = true;
      const groupBy = this.parserOptions.attributes.groupBy;
      if (groupBy) {
        return { [groupBy]: this.attributes };
      }
      return this.attributes;
    },

    /**
     * @description Enter a tag: push the current frame, then start a fresh one seeded with the attributes just seen.
     */
    addElement(tag: TagDetailLike, matcher: MatcherView): void {
      // The matcher is accepted because the parser supplies one, not because this
      // builder needs it — it reads the live path from `this.matcher`.
      void matcher;
      const value = this._buildAttributeValue();
      this.tagsStack.push({ tagName: this.tagName, textValue: this.textValue, parentValue: this.value, hasAttributes: this.hasAttributes });
      this.tagName = tag.name;
      this.value = value;
      this.textValue = '';
      this.attributes = {};
    },

    /**
     * @description Combine the `alwaysArray` and `forceArray` votes.
     *
     * @param isLeafNode - Whether the tag turned out to have no child elements.
     *
     * @returns Whether to wrap this tag in an array.
     */
    _resolveForceArray(isLeafNode: boolean): boolean {
      const alwaysVote = this._alwaysArrayVote();
      const forceVote = this._forceArrayVote(isLeafNode);

      // An explicit false is a veto and wins; otherwise one true is enough; all
      // abstaining falls back to the default shape, which is not an array.
      if (forceVote === false) return false;
      if (alwaysVote === true || forceVote === true) return true;
      return false;
    },

    /**
     * @description The `alwaysArray` half of the vote: `true` on a path match, abstaining otherwise.
     *
     * @returns The vote, or `undefined` to abstain.
     */
    _alwaysArrayVote(): boolean | undefined {
      return this.builderOptions._alwaysArraySet.matchesAny(this.matcher as MatcherView) ? true : undefined;
    },

    /**
     * @description The `forceArray` half of the vote.
     *
     * @param isLeafNode - Whether the tag turned out to have no child elements.
     *
     * @returns The vote, or `undefined` to abstain.
     */
    _forceArrayVote(isLeafNode: boolean): boolean | undefined {
      const forceArray = this.builderOptions.forceArray;
      if (!Predicate.isFunction(forceArray)) return undefined;
      const result = forceArray(this.matcher as MatcherView, isLeafNode);
      return typeof result === 'boolean' ? result : undefined;
    },

    /**
     * @description Close a tag: work out the shape its accumulated state takes, then write it into the parent.
     */
    closeElement(
      matcher: MatcherView,
      closeMeta?: { name: string; index?: number | undefined; closeEnd?: number | undefined }
    ): Effect.Effect<void, BuilderError> {
      // Neither argument is needed: the builder tracks position through its own
      // stack, and closing metadata is the parser's business.
      void matcher;
      void closeMeta;
      const tagName = this.tagName;
      const value = this.value; // contains attributes if not skipped
      const textValue = this.textValue;
      const hasAttributes = this.hasAttributes;
      const isLeafNode = isLeafValue(value, hasAttributes);

      const context = makeContext(tagName, this.matcher, isLeafNode, false);

      const closed = isLeafNode
        ? this._closedLeafValue(value, textValue, hasAttributes, context)
        : this._closedContainerValue(value, textValue, context);

      // Plain rather than a generator: the close has one fallible step (the text chain), and the rest
      // is bookkeeping that the callback runs once the value is in hand. When the chain resolves
      // synchronously this stays an exit, so the parser's close path inlines it.
      return Effect.mapEager(closed, (resolved): void => {
        // Unchecked on purpose: a close with no matching open is a parser bug.
        const frame = this.tagsStack.pop() as TagFrame;

        // Check if this tag should be forced into an array
        const shouldForceArray = this._resolveForceArray(isLeafNode);

        const parentTag = this._addChildTo(tagName, resolved, frame.parentValue, shouldForceArray);

        this.tagName = frame.tagName;
        this.textValue = frame.textValue;
        this.value = parentTag;
        this.hasAttributes = frame.hasAttributes; // restore parent tag's flag
        this._pendingStopNode = false;
      });
    },

    /**
     * @description A leaf's closing value.
     */
    _closedLeafValue(
      value: CompactValue,
      textValue: string,
      hasAttributes: boolean,
      context: ValueContext
    ): Effect.Effect<CompactValue, BuilderError> {
      return Effect.mapEager(this._parseText(textValue, context), (parsedText): CompactValue => {
        if (hasAttributes) {
          // Attributes are present — value is already an object. Only write the
          // text node when there is actual text content; an empty parsedText
          // alongside attributes would produce a spurious #text:"" key.
          if (hasTextContent(parsedText) || this.builderOptions.forceTextNode) {
            (value as Record<string, unknown>)[this.parserOptions.nameFor.text] = parsedText;
          }
          return value;
        }
        return this.builderOptions.forceTextNode ? { [this.parserOptions.nameFor.text]: parsedText } : (parsedText as CompactValue);
      });
    },

    /**
     * @description A non-leaf's closing value: its children, unchanged, plus a text key when it also had text of its own.
     */
    _closedContainerValue(value: CompactValue, textValue: string, context: ValueContext): Effect.Effect<CompactValue, BuilderError> {
      if (textValue.length === 0 && !this.builderOptions.forceTextNode) return Effect.succeed(value);
      return Effect.mapEager(this._parseText(textValue, context), (parsedText): CompactValue => {
        (value as Record<string, unknown>)[this.parserOptions.nameFor.text] = parsedText;
        return value;
      });
    },

    /**
     * @description Run a closing tag's text through the element value chain.
     */
    _parseText(text: string, context: ValueContext): Effect.Effect<unknown, BuilderError> {
      return this._pendingStopNode ? Effect.succeed(text) : this.tagsPipeline.run(text, context);
    },

    /**
     * @description Append a named child to the current value, promoting a bare string to an object first.
     */
    _addChild(key: string, val: unknown): void {
      if (typeof this.value === 'string') {
        this.value = { [this.parserOptions.nameFor.text]: this.value };
      }
      this._addChildTo(key, val, this.value, false);
      this.attributes = {};
    },

    /**
     * @description Write `key` into `node`, turning it into an array when the key is already taken or the caller insists.
     */
    _addChildTo(key: string, val: unknown, node: CompactValue, forceArray: boolean): CompactValue {
      const target: Record<string, unknown> = typeof node === 'string' ? {} : node;

      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        target[key] = forceArray ? [val] : val;
      } else {
        const existing = target[key];
        if (!Array.isArray(existing)) target[key] = [existing];
        (target[key] as Array<unknown>).push(val);
      }
      return target;
    },

    /**
     * @description Append a text chunk, joining with `textJoint` once more than one has arrived.
     */
    addValue(text: string, matcher: MatcherView): void {
      void matcher;
      if (this.textValue.length > 0) this.textValue += `${this.builderOptions.textJoint}${text}`;
      else this.textValue = text;
    },

    /**
     * @description Record a processing instruction as a child, seeding it with any attributes seen on it.
     */
    addInstruction(name: string): void {
      const value = this._buildAttributeValue();
      this._addChild(name, value);
      this.attributes = {};
    },

    /**
     * @description The finished result.
     */
    getOutput(): unknown {
      return this.value;
    },
  };

  return builder;
};

/**
 * @description Whether an object has no own enumerable keys.
 *
 * @param obj - The object to test.
 *
 * @returns Whether it is empty.
 */
function isEmpty(obj: object): boolean {
  return Object.keys(obj).length === 0;
}

/**
 * @description Whether a closing tag's accumulated value is a single value rather than a set of children.
 *
 * @param value - The value accumulated so far.
 * @param hasAttributes - Whether the tag had attributes.
 *
 * @returns Whether the tag is a leaf.
 */
function isLeafValue(value: CompactValue, hasAttributes: boolean): boolean {
  return typeof value !== 'object' || Array.isArray(value) || isEmpty(value) || hasAttributes;
}

/**
 * @description Whether a parsed text value is worth writing under the text key.
 *
 * @param value - The parsed text.
 *
 * @returns Whether there is text to write.
 */
function hasTextContent(value: unknown): boolean {
  return value !== '' && value !== null && value !== undefined;
}

/**
 * @description What a parser needs from an output builder factory: one fresh builder per parse run, plus the registry and resolved options a caller wiring a
 * custom builder needs. Deliberately narrow rather than the old base class.
 */
export interface OutputBuilderFactory {
  /**
   * @description This builder's resolved options.
   */
  readonly builderOptions: ResolvedFactoryOptions;
  /**
   * @description The value parsers available by name, shared with every builder this factory produces.
   */
  readonly registry: ValueParserRegistry;
  /**
   * @description Obtain a fresh builder instance. Called by the parser before each parse run.
   */
  getInstance(parserOptions: object, readonlyMatcher: MatcherView | null): Effect.Effect<OutputBuilder, BuilderError>;
  /**
   * @description Add or replace a named value parser, affecting every builder this factory produces afterwards.
   */
  registerValueParser(name: string, parserInstance: ValueParser): Effect.Effect<void, BuilderError>;
}

/**
 * @description Build the factory service implementation from resolved options.
 *
 * @param resolved - The resolved options.
 *
 * @returns The factory.
 */
const makeCompactBuilderFactory = (resolved: ResolvedFactoryOptions): OutputBuilderFactory => {
  const registry = makeValueParserRegistry();
  return {
    builderOptions: resolved,
    registry,
    getInstance: (parserOptions, readonlyMatcher) => Effect.succeed(makeCompactBuilder(parserOptions, resolved, readonlyMatcher, registry)),
    registerValueParser: (name, parserInstance) => registry.register(name, parserInstance),
  };
};

/**
 * @description Produces a compact builder per document. A `Context.Service` rather than a class to be constructed: resolve the options once, in the layer, and
 * hand each document a builder that shares the service's value-parser registry.
 *
 * @example
 *   ```typescript
 *   const factory = yield* CompactBuilderFactory.make({ alwaysArray: ['..item'] });
 *   ```;
 */
export class CompactBuilderFactory extends Context.Service<CompactBuilderFactory, OutputBuilderFactory>()('@endevops/builder/CompactBuilderFactory') {
  /**
   * @description Create the factory, resolving its options on the way in.
   *
   * @param builderOptions - This builder's options.
   *
   * @returns An effect producing the factory. Fails with the `InvalidOptionEntry` or `PatternCompilationFailed` reason.
   */
  static readonly make = (builderOptions: FactoryOptions = {}): Effect.Effect<OutputBuilderFactory, BuilderError> =>
    Effect.map(buildOptions(builderOptions), resolved => makeCompactBuilderFactory(resolved));

  /**
   * @description The factory as a `Layer`.
   *
   * @param builderOptions - This builder's options.
   *
   * @returns A layer providing {@link CompactBuilderFactory}.
   */
  static readonly layer = (builderOptions: FactoryOptions = {}): Layer.Layer<CompactBuilderFactory, BuilderError> =>
    Layer.effect(CompactBuilderFactory, CompactBuilderFactory.make(builderOptions));
}
