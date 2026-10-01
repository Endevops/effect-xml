import type { Expression, MatcherView } from '@endevops/common-xml';

/**
 * @description A caller-supplied transform for a tag or attribute value. Returns an effect because the ordinary use of this hook is to run a value through an
 * `EntityEncoder`, and encoding can fail. A pure transform is `Effect.succeed(...)`; a caller's own effect is yielded directly, and either way the
 * failure is mapped into this package's `BuilderError` rather than left to escape as a defect. Returning `undefined` or `null` keeps the original
 * value, which is what the identity default does.
 *
 * @param name - The tag or attribute name.
 * @param value - The value to transform.
 *
 * @returns An effect producing the replacement value.
 */
import { Effect } from 'effect';

export type ValueProcessor = (name: string, value: unknown) => Effect.Effect<string | undefined, unknown>;

/**
 * @description Context handed to {@link XmlBuilderOptions.sanitizeName}.
 */
export interface SanitizeNameContext {
  /**
   * @description `true` when the name being resolved is an attribute name, `false` when it is an element name.
   */
  isAttribute: boolean;
  /**
   * @description The live path at the point the name is resolved. Read-only from the callback's perspective — `.toString()` gives the current jPath string,
   * `.getDepth()` the nesting depth. It reflects the builder's current position without allocating per call.
   */
  matcher: MatcherView;
}

/**
 * @description Resolves a tag or attribute name that failed QName validation, returning the name to write. Throw to reject it outright.
 */
export type NameResolver = (name: string, context: SanitizeNameContext) => string;

/**
 * @description One entry in the `entities` option: a pattern to replace, and the text to replace it with.
 */
export interface EntityReplacement {
  /**
   * @description The pattern to replace. Must be global, or only the first occurrence is substituted.
   */
  regex: RegExp;
  /**
   * @description The replacement text.
   */
  val: string;
}

/**
 * @description Decides whether an attribute is dropped. Receives the attribute name with its prefix already stripped.
 */
export type IgnoreAttributesPredicate = (attrName: string, jPath: string) => boolean;

/**
 * @description Everything the builder can be configured with. Every field has a default, so `{}` is valid and produces the same output as `new Builder()`.
 */
export interface XmlBuilderOptions {
  /**
   * @description Prefix that marks a key as an attribute in the input object. Defaults to `'@_'`.
   */
  attributeNamePrefix?: string;
  /**
   * @description Key to group all of a tag's attributes under, or `false` to read them from the top level. Defaults to `false`.
   */
  attributesGroupName?: false | string;
  /**
   * @description Key holding a tag's text content. Defaults to `'#text'`.
   */
  textNodeName?: string;
  /**
   * @description Which attributes to emit. `true` drops them all, `false` keeps them all, an array of names and patterns drops the ones that match, and a function
   * drops the ones it returns `true` for. Defaults to `true`.
   */
  ignoreAttributes?: boolean | (string | RegExp)[] | IgnoreAttributesPredicate;
  /**
   * @description Key holding CDATA content, or `false` to inline it as text. Defaults to `false`.
   */
  cdataPropName?: false | string;
  /**
   * @description Key holding comment content, or `false` to drop comments. Defaults to `false`.
   */
  commentPropName?: false | string;
  /**
   * @description Whether to indent the output instead of emitting one line. Defaults to `false`.
   */
  format?: boolean;
  /**
   * @description The indent string, used when `format` is on. Defaults to two spaces.
   */
  indentBy?: string;
  /**
   * @description Tag to wrap a top-level array in. Defaults to none — the array is walked directly.
   */
  arrayNodeName?: string;
  /**
   * @description Whether a tag with no content becomes self-closing. Defaults to `false`.
   */
  suppressEmptyNode?: boolean;
  /**
   * @description Whether an unpaired tag is written without a closing tag. Defaults to `true`.
   */
  suppressUnpairedNode?: boolean;
  /**
   * @description Whether an attribute whose value is `true` is written bare, as `attr` rather than `attr="true"`. Defaults to `true`.
   */
  suppressBooleanAttributes?: boolean;
  /**
   * @description Whether the input is the ordered form — an array of single-key objects that preserves document order. Defaults to `false`.
   */
  preserveOrder?: boolean;
  /**
   * @description Tags that never have a closing tag, such as HTML void elements. Defaults to `[]`.
   */
  unpairedTags?: string[];
  /**
   * @description Subtrees to copy through verbatim, without entity encoding — a parser's `stopNodes` output re-emitted as XML. Accepts pattern strings or
   * pre-compiled `Expression`s; a leading `*.` is rewritten to `..` for compatibility with the older syntax. Defaults to `[]`.
   */
  stopNodes?: (string | Expression)[];
  /**
   * @description Called for each non-empty tag value before entities are substituted. Return `undefined` or `null` to keep the original. Defaults to the identity
   * function. See {@link ValueProcessor} for the shape.
   *
   * @example
   *   ```typescript
   *   import { Effect } from 'effect';
   *   import { EntityEncoder } from '@endevops/common-xml';
   *   const encoder = new EntityEncoder();
   *   new XMLBuilder({ tagValueProcessor: (_tag, value) => Effect.succeed(encoder.encode(String(value))) });
   *   ```;
   */
  tagValueProcessor?: ValueProcessor;
  /**
   * @description Called for each attribute value before entities are substituted. Return `undefined` or `null` to keep the original. Defaults to the identity
   * function. See {@link ValueProcessor} for the shape.
   */
  attributeValueProcessor?: ValueProcessor;
  /**
   * @description The entity substitutions applied to text and attribute values. Defaults to the five predefined XML entities; the `&` entry must stay first, or it
   * would re-escape the ampersands the later entries introduce. Overriding this replaces the whole table rather than extending it, so an entry that
   * stops the `&` pass from running first will double-escape the ampersands the later entries introduce.
   */
  entities?: EntityReplacement[];
  /**
   * @description Whether to apply {@link XmlBuilderOptions.entities}. Defaults to `true`. Quotes inside attribute values are escaped either way, since that is what
   * stops a value breaking out of its attribute.
   */
  processEntities?: boolean;
  /**
   * @description Whether an array of mixed values is wrapped in one shared tag rather than repeating the tag per item. Defaults to `false`.
   */
  oneListGroup?: boolean;
  /**
   * @description Maximum nesting depth, or a falsy value for no limit. Guards against stack exhaustion on hostile input. Defaults to `100`.
   */
  maxNestedTags?: number;
  /**
   * @description What path argument callbacks receive: `true` (the default) passes a jPath string to `ignoreAttributes` functions, `false` passes the live
   * `Matcher` instead so the callback can query the path.
   */
  jPath?: boolean;
  /**
   * @description Validate and repair tag and attribute names, or `false` to write every name as given. The callback runs only for names that fail QName
   * validation, so a document of valid names pays nothing for having it configured. Defaults to `false`.
   *
   * @remarks
   *   The resolver stays synchronous, and a throw from one is captured: `build` fails with the `NameResolutionFailed` reason carrying the resolver's
   *   own message, rather than the throw escaping as a defect. That keeps a rejecting resolver in the same error channel as every other build
   *   failure, so one `catchReason` covers them all.
   *
   * @example
   *   // Repair invalid names
   *   import { sanitize } from '@endevops/common-xml';
   *   new Builder({ sanitizeName: name => sanitize(name, 'qName') });
   *
   * @example
   *   // Reject invalid names outright
   *   import { qName } from '@endevops/common-xml';
   *   new Builder({
   *     sanitizeName: name => {
   *       if (!qName(name)) throw new Error(`Invalid XML name: ${name}`);
   *       return name;
   *     },
   *   });
   */
  sanitizeName?: false | NameResolver;
}

/**
 * @description The options as the builder stores them after defaults are applied. Split from {@link XmlBuilderOptions} because the resolved form is not uniform:
 * the `false | string` options keep their union, the entity and processor options are fully populated, and `stopNodes` is normalised from a mixed
 * array into compiled expressions on the builder rather than kept here.
 */
export interface ResolvedXmlBuilderOptions {
  attributeNamePrefix: string;
  attributesGroupName: false | string;
  textNodeName: string;
  ignoreAttributes: XmlBuilderOptions['ignoreAttributes'];
  cdataPropName: false | string;
  commentPropName: false | string;
  format: boolean;
  indentBy: string;
  suppressEmptyNode: boolean;
  suppressUnpairedNode: boolean;
  suppressBooleanAttributes: boolean;
  preserveOrder: boolean;
  unpairedTags: string[];
  tagValueProcessor: ValueProcessor;
  attributeValueProcessor: ValueProcessor;
  entities: EntityReplacement[];
  processEntities: boolean;
  oneListGroup: boolean;
  maxNestedTags: number;
  jPath: boolean;
  sanitizeName: false | NameResolver;
  /**
   * @description `arrayNodeName` is absent by default rather than empty, because "no wrapper tag" and "wrap in the empty string" are different and the builder
   * tests its length.
   */
  arrayNodeName?: string;
  stopNodes: (string | Expression)[];
}
