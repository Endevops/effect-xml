import type { MatcherView } from '@endevops/common-xml';

import type { CloseMetaLike, TagDetailLike, ValueParserRegistryLike } from '../output-builder/index.ts';
import type { FactoryOptions, ResolvedFactoryOptions } from './options.ts';

import { BaseOutputBuilder as BaseOutputBuilderClass, BaseOutputBuilderFactory, Context } from '../output-builder/index.ts';
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
interface TagFrame {
  /**
   * @description The tag name in scope before this one was pushed.
   */
  tagName: string;
  /**
   * @description The text accumulated before this one was pushed.
   */
  textValue: string;
  /**
   * @description The value the enclosing tag had accumulated so far — which is the object this tag's own value gets written into on close. Not the same as
   * {@link CompactBuilder.parent}, and deliberately so: the frame captures the parent's _value_, which changes as siblings are added, whereas a
   * single `parent` reference set once in the constructor would be stale by the time a grandchild closed.
   */
  parentValue: CompactValue;
  /**
   * @description Whether the enclosing tag had attributes, so the flag can be restored rather than re-derived.
   */
  hasAttributes: boolean;
}

/**
 * @description A node's value while it is being built: an object once it has children or attributes, a bare string while it is still only text. The union is the
 * whole design of this builder. A tag with nothing but text collapses to that string; anything else becomes an object, and that is why `_addChild`
 * has to promote a string to `{ [nameFor.text]: string }` before it can hold a child.
 */
export type CompactValue = string | Record<string, unknown>;

/**
 * @description Produces a {@link CompactBuilder} per document. Resolve the options once, in the constructor, and hand each document a builder that shares the
 * factory's value-parser registry — so a parser registered after construction still applies to every document, while a builder's own per-document
 * state does not survive between them.
 *
 * @example
 *   ```typescript
 *   const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ alwaysArray: ['..item'] }) });
 *   parser.parse('<root><item>a</item><item>b</item></root>');
 *   // { root: { item: ['a', 'b'] } }
 *   ```;
 */
export class CompactBuilderFactory extends BaseOutputBuilderFactory {
  /**
   * @description This builder's resolved options. Narrower than the base's, which only knows the value-parser chains every builder shares.
   */
  declare builderOptions: ResolvedFactoryOptions;

  /**
   * @description Produce a builder for one document.
   *
   * @param parserOptions - The parser's options.
   * @param readonlyMatcher - The live path, or `null`.
   *
   * @returns A fresh builder.
   */
  override getInstance(parserOptions: object, readonlyMatcher: MatcherView | null): CompactBuilder {
    return new CompactBuilder(
      parserOptions as ConstructorParameters<typeof CompactBuilder>[0],
      this.builderOptions as ResolvedFactoryOptions,
      readonlyMatcher,
      this.registry as ValueParserRegistryLike
    );
  }

  /**
   * @description Create a factory.
   *
   * @param builderOptions - This builder's options, resolved on the way in.
   */
  constructor(builderOptions: FactoryOptions = {}) {
    super();
    this.builderOptions = buildOptions(builderOptions);
  }
}

/**
 * @description Builds a minimal JavaScript object from a document: a tag with only text becomes that string, anything with children or attributes becomes an
 * object, and repeated tags become an array. That last rule is what makes the shape awkward to consume — a key is a string on the document's first
 * occurrence and an array from the second — and {@link FactoryOptions.alwaysArray} and {@link FactoryOptions.forceArray} exist to make a key's shape
 * predictable when it matters.
 */
export class CompactBuilder extends BaseOutputBuilderClass {
  /**
   * @description One frame per open tag, holding the state to restore when that tag closes.
   */
  readonly tagsStack: TagFrame[];
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
   * @description Whether {@link CompactBuilder.attributes} holds anything. Tracked explicitly so the leaf test never has to re-derive it from key names, prefixes,
   * or a `groupBy` key.
   */
  hasAttributes: boolean;

  /**
   * @description Create a builder for one document.
   *
   * @param parserOptions - The parser's options, as `ResolvedOptions`.
   * @param builderOptions - This builder's resolved options.
   * @param readonlyMatcher - The live path, or `null`.
   * @param registry - Where value-parser names resolve.
   * @param resetPipelines - Whether to reset the value parsers. Defaults to true.
   */
  constructor(
    parserOptions: object,
    builderOptions: ResolvedFactoryOptions,
    readonlyMatcher: MatcherView | null,
    registry: ValueParserRegistryLike,
    resetPipelines = true
  ) {
    super(parserOptions, builderOptions, readonlyMatcher, registry, resetPipelines);
    this.parserOptions = parserOptions as CompactParserOptions;
    this.builderOptions = builderOptions;
    this.tagsStack = [];
    this.root = {};
    this.tagName = this._rootName;
    this.value = {};
    this.textValue = '';
    this.attributes = {};
    this.hasAttributes = false;
  }

  /**
   * @description The parser's options, narrowed to the ones this builder reads.
   */
  declare readonly parserOptions: CompactParserOptions;

  /**
   * @description This builder's resolved options.
   */
  declare readonly builderOptions: ResolvedFactoryOptions;

  /**
   * @description Fold the attributes seen so far into the value they belong to.
   *
   * @returns The attribute value, or `''` when there are none — an empty string rather than an empty object, so a bare tag's value starts as text.
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
  }

  /**
   * @description Enter a tag: push the current frame, then start a fresh one seeded with the attributes just seen.
   *
   * @param tag - The tag being entered, with its name already prefixed and sanitised by the parser.
   */
  override addElement(tag: TagDetailLike, matcher: MatcherView): void {
    // The matcher is accepted because the parser supplies one, not because this
    // builder needs it — it reads the live path from `this.matcher`, which the
    // factory was given at construction.
    void matcher;
    const value = this._buildAttributeValue();
    this.tagsStack.push({ tagName: this.tagName, textValue: this.textValue, parentValue: this.value, hasAttributes: this.hasAttributes });
    this.tagName = tag.name;
    this.value = value;
    this.textValue = '';
    this.attributes = {};
  }

  /**
   * @description Combine the `alwaysArray` and `forceArray` votes. The two are treated as equal voters, which is why `forceArray` can return three states rather
   * than a boolean:
   *
   * - `alwaysArray` votes `true` on a match and **abstains** otherwise — a non-match is not a veto
   * - `forceArray` votes `true`, `false`, or abstains An explicit `false` from either wins, because it is the only way to say "not even though it
   *   matched". Otherwise one `true` is enough. All abstaining means false, since that is the default shape.
   *
   * @param isLeafNode - Whether the tag turned out to have no child elements.
   *
   * @returns Whether to wrap this tag in an array.
   */
  _resolveForceArray(isLeafNode: boolean): boolean {
    // `this.matcher` is dereferenced unguarded, so a builder constructed without
    // one throws here rather than silently skipping both votes. That is upstream's
    // behaviour and it is the right one: `alwaysArray` and `forceArray` are both
    // path-based, so a builder with no path cannot honour either, and failing
    // loudly beats quietly not forcing an array the caller asked for.

    // --- alwaysArray vote ---
    // undefined = abstain. Note that a non-match abstains rather than vetoing:
    // "not in the alwaysArray list" says nothing about whether this tag should be
    // an array, so the decision is left to the other voter.
    const matched = this.builderOptions._alwaysArraySet.matchesAny(this.matcher as MatcherView);
    const alwaysVote = matched ? true : undefined;

    // --- forceArray vote ---
    // undefined = abstain
    let forceVote: boolean | undefined;
    const forceArray = this.builderOptions.forceArray;
    if (typeof forceArray === 'function') {
      const result = forceArray(this.matcher as MatcherView, isLeafNode);
      if (result === true) forceVote = true;
      else if (result === false) forceVote = false;
      // anything else (undefined, null, …) → abstain
    }

    // --- resolution ---
    // An explicit false is a veto and wins; otherwise one true is enough; all
    // abstaining falls back to the default shape, which is not an array.
    if (forceVote === false) return false;
    if (alwaysVote === true || forceVote === true) return true;
    return false;
  }

  /**
   * @description Close a tag: run its text through the value chain, wrap it, and write it into the parent. The interesting decision is what shape a tag takes. A
   * tag is a leaf when it has no child elements — attributes alone do not make it non-leaf, since a tag with only attributes is still a single value.
   * A leaf becomes its parsed text, unless it has attributes, in which case the attributes are the object and the text joins them under
   * `nameFor.text`. A non-leaf becomes an object of its children, plus a text key when it also had text of its own.
   */
  override closeElement(matcher: MatcherView, closeMeta?: CloseMetaLike): void {
    // Neither argument is needed: the builder tracks position through its own
    // stack, and closing metadata is the parser's business.
    void matcher;
    void closeMeta;
    const tagName = this.tagName;
    let value = this.value; // contains attributes if not skipped
    const textValue = this.textValue;
    const hasAttributes = this.hasAttributes;

    // A tag is a leaf node if it has no child elements.
    // It can have attributes and still be a leaf node.
    // hasAttributes is tracked explicitly by _buildAttributeValue() so we never
    // need to reverse-engineer this from key names, prefixes, or groupBy keys.
    const isLeafNode = typeof value !== 'object' || Array.isArray(value) || isEmpty(value) || hasAttributes;

    const context = new Context(tagName, this.matcher, isLeafNode, false);

    if (isLeafNode) {
      // A stop node's content is raw text the parser already declined to decode,
      // so running the value chain over it would decode it twice.
      const parsedText = this._pendingStopNode ? textValue : this.tagsPipeline.run(textValue, context);

      if (hasAttributes) {
        // Attributes are present — value is already an object.
        // Only write the text node when there is actual text content; an empty
        // parsedText alongside attributes would produce a spurious #text:"" key.
        // forceTextNode overrides this and writes the node even when empty.
        if (parsedText !== '' && parsedText !== null && parsedText !== undefined) {
          (value as Record<string, unknown>)[this.parserOptions.nameFor.text] = parsedText;
        } else if (this.builderOptions.forceTextNode) {
          (value as Record<string, unknown>)[this.parserOptions.nameFor.text] = parsedText;
        }
      } else if (this.builderOptions.forceTextNode) {
        // No attributes — wrap in an object so the shape is always consistent
        value = { [this.parserOptions.nameFor.text]: parsedText };
      } else {
        // No attributes, no forceTextNode — use the plain parsed value
        value = parsedText as CompactValue;
      }
    } else if (textValue.length > 0 || this.builderOptions.forceTextNode) {
      // Non-leaf node with actual text content sitting between child elements
      // mixed content: element has both child tags and text
      const parsedText = this._pendingStopNode ? textValue : this.tagsPipeline.run(textValue, context);
      (value as Record<string, unknown>)[this.parserOptions.nameFor.text] = parsedText;
    }

    // Unchecked on purpose: a close with no matching open is a parser bug, and
    // upstream threw here. The frame is written by addElement and read here, so
    // a missing one means the two are out of step — which a caller needs to know
    // about rather than have papered over with a default.
    const frame = this.tagsStack.pop() as TagFrame;
    let parentTag = frame.parentValue;

    // Check if this tag should be forced into an array
    const shouldForceArray = this._resolveForceArray(isLeafNode);

    parentTag = this._addChildTo(tagName, value, parentTag, shouldForceArray);

    this.tagName = frame.tagName;
    this.textValue = frame.textValue;
    this.value = parentTag;
    this.hasAttributes = frame.hasAttributes; // restore parent tag's flag
    this._pendingStopNode = false;
  }

  /**
   * @description Append a named child to the current value, promoting a bare string to an object first.
   *
   * @param key - The child's key.
   * @param val - The child's value.
   */
  override _addChild(key: string, val: unknown): void {
    if (typeof this.value === 'string') {
      this.value = { [this.parserOptions.nameFor.text]: this.value };
    }
    this._addChildTo(key, val, this.value, false);
    this.attributes = {};
  }

  /**
   * @description Write `key` into `node`, turning it into an array when the key is already taken or the caller insists.
   *
   * @param key - The child's key.
   * @param val - The child's value.
   * @param node - The object to write into. A string is promoted to an empty object, since a bare string cannot hold a child.
   * @param forceArray - Whether to wrap even on first occurrence.
   *
   * @returns `node`, promoted if it had to be.
   */
  _addChildTo(key: string, val: unknown, node: CompactValue, forceArray: boolean): CompactValue {
    const target: Record<string, unknown> = typeof node === 'string' ? {} : node;

    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = forceArray ? [val] : val;
    } else {
      const existing = target[key];
      if (!Array.isArray(existing)) target[key] = [existing];
      (target[key] as unknown[]).push(val);
    }
    return target;
  }

  /**
   * @description Append a text chunk, joining with `textJoint` once more than one has arrived.
   *
   * @param text - The chunk.
   */
  override addValue(text: string, matcher: MatcherView): void {
    void matcher;
    if (this.textValue.length > 0) this.textValue += `${this.builderOptions.textJoint}${text}`;
    else this.textValue = text;
  }

  /**
   * @description Record a processing instruction as a child, seeding it with any attributes seen on it.
   *
   * @param name - The instruction's rendered text.
   */
  override addInstruction(name: string): void {
    const value = this._buildAttributeValue();
    this._addChild(name, value);
    this.attributes = {};
  }

  /**
   * @description The finished result. The builder's own value, not the root object — at depth 0 the two are the same, and at depth > 0 the root is only where the
   * walk started.
   *
   * @returns The compact structure.
   */
  override getOutput(): unknown {
    return this.value;
  }
}

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

export default CompactBuilderFactory;
