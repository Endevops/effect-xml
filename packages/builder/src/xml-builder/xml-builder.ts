import type { Expression, Matcher } from '@endevops/common-xml';
import type { XmlVersion } from '@endevops/common-xml';

import { Matcher as PathMatcher } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { BuilderError } from '../errors.ts';
import type { IgnoreAttributesPredicate, ResolvedXmlBuilderOptions, XmlBuilderOptions } from './options.ts';
import type { NameValidator, OrderedTag } from './ordered.ts';

import { liftXml, nestingExceeded, runValueProcessor } from '../errors.ts';
import getIgnoreAttributesFn from './ignore-attributes.ts';
import buildFromOrderedJs, { nameValidatorFor } from './ordered.ts';
import { escapeAttribute, safeCdata, safeComment, valToStr } from './util.ts';
import {
  checkStopNode as matchesStopNode,
  collectAttributeValues,
  compileStopNodes,
  renderRawTag,
  renderStopNodeAttributes,
  resolveTagName,
  scalarVersion,
  stripAttributePrefix,
  toXmlVersion,
} from './walk.ts';

/**
 * @description What one step of the walk produced: the attribute string and the element bodies, kept apart so the attributes can be written ahead of the tag's
 * `>`. A whole level returns one of these, and so does each of its keys — which is what lets a key's renderer say which of the two it wrote to.
 */
interface J2xResult {
  /**
   * @description The leading ` name="value"` pairs to append at this level.
   */
  attrStr: string;
  /**
   * @description The element bodies to append at this level.
   */
  val: string;
}

/**
 * @description What one level of the walk carries down to each of its keys. The options are already on the builder, so what is worth naming is the live path, the
 * validator, and the two values derived from the path once per level — `jPath`, because stringifying the path is not free, and `isCurrentStopNode`,
 * because the question is asked once per level rather than once per key. Bundled so a per-key renderer takes one argument for all of it instead of
 * five that never vary.
 */
interface WalkContext {
  /**
   * @description Nesting depth of the level being walked.
   */
  level: number;
  /**
   * @description The live path, pushed and popped around recursion so stop-node patterns see the real position.
   */
  matcher: Matcher;
  /**
   * @description The memoized QName validator.
   */
  qNameValidator: NameValidator;
  /**
   * @description What the path callbacks receive: a jPath string, or the live `Matcher` when `jPath` is off.
   */
  jPath: string | Matcher;
  /**
   * @description Whether this level's node is a stop node, which decides whether its attributes are copied through verbatim.
   */
  isCurrentStopNode: boolean;
}

/**
 * @description The attribute values handed to {@link Matcher.push} for one node, already escaped. Keys are bare attribute names, without the prefix.
 */
export type AttributeValues = Record<string, string>;

const defaultOptions = {
  attributeNamePrefix: '@_',
  attributesGroupName: false,
  textNodeName: '#text',
  ignoreAttributes: true,
  cdataPropName: false,
  format: false,
  indentBy: '  ',
  suppressEmptyNode: false,
  suppressUnpairedNode: true,
  suppressBooleanAttributes: true,
  tagValueProcessor: function (_key: string, a: unknown) {
    return Effect.succeed(a as string);
  },
  attributeValueProcessor: function (_attrName: string, a: unknown) {
    return Effect.succeed(a as string);
  },
  preserveOrder: false,
  commentPropName: false,
  unpairedTags: [],
  entities: [
    { regex: new RegExp('&', 'g'), val: '&amp;' }, //it must be on top
    { regex: new RegExp('>', 'g'), val: '&gt;' },
    { regex: new RegExp('<', 'g'), val: '&lt;' },
    { regex: new RegExp("'", 'g'), val: '&apos;' },
    { regex: new RegExp('"', 'g'), val: '&quot;' },
  ],
  processEntities: true,
  // transformTagName: false,
  // transformAttributeName: false,
  oneListGroup: false,
  maxNestedTags: 100,
  jPath: true, // When true, callbacks receive string jPath; when false, receive Matcher instance
  sanitizeName: false, // false = allow all names as-is (default, backward-compatible).
  // Set to a function (name, { isAttribute, matcher }) => string to
  // validate/sanitize tag and attribute names. Throw inside the function
  // to reject an invalid name.
} as const satisfies Omit<ResolvedXmlBuilderOptions, 'stopNodes' | 'arrayNodeName'>;

/**
 * @description Detect the XML version from a `?xml` declaration at the root of a plain-object input, so name validation matches the document it came from. Both
 * attribute layouts are checked: grouped under `attributesGroupName`, and flat with the attribute prefix.
 *
 * @param jObj - The input object.
 * @param options - The resolved options.
 *
 * @returns The declared version, or `'1.0'` if there is no declaration.
 */
function detectXmlVersionFromObj(jObj: Record<string, unknown>, options: ResolvedXmlBuilderOptions): XmlVersion {
  return toXmlVersion(readDeclaredVersion(jObj['?xml'], options));
}

/**
 * @description Pull the `version` attribute out of a `?xml` declaration, in whichever attribute layout the document uses.
 *
 * @param decl - The value of the `?xml` key, or absent.
 * @param options - The resolved options.
 *
 * @returns The declared version string, or `undefined` if there is no usable declaration.
 */
function readDeclaredVersion(decl: unknown, options: ResolvedXmlBuilderOptions): string | undefined {
  if (!decl || typeof decl !== 'object') return undefined;
  const node = decl as Record<string, unknown>;

  // attributesGroupName path e.g. { '$$': { '@_version': '1.1' } }
  if (options.attributesGroupName) {
    const group = node[options.attributesGroupName];
    if (group && typeof group === 'object') {
      const v = (group as Record<string, unknown>)[options.attributeNamePrefix + 'version'];
      if (v) return scalarVersion(v);
    }
  }
  // flat attribute path e.g. { '@_version': '1.1' }
  const v = node[options.attributeNamePrefix + 'version'];
  if (v) return scalarVersion(v);
  return undefined;
}

/**
 * @description Builds an XML string from a JavaScript object. Construct it once and reuse it. The constructor pre-compiles the stop-node expressions, resolves the
 * `ignoreAttributes` form, and binds the indent strategy, so a builder built per document pays that setup on every call.
 *
 * @example
 *   ```typescript
 *   const builder = new XMLBuilder({ ignoreAttributes: false });
 *   builder.build({ a: { '@_id': '1', '#text': 'hello' } }); // '<a id="1">hello</a>'
 *   ```;
 */
export class XMLBuilder {
  /**
   * @description The options in use, with defaults applied.
   */
  readonly options: ResolvedXmlBuilderOptions;
  /**
   * @description The stop-node patterns, compiled once at construction.
   */
  declare readonly stopNodeExpressions: Expression[];

  /**
   * @description Whether a key names an attribute. When attributes are ignored entirely, this is a constant `false` and the per-key work disappears.
   */
  declare isAttribute: (name: string) => string | false;
  /**
   * @description The resolved `ignoreAttributes` predicate. Only consulted when {@link XMLBuilder.isAttribute} can return a name, so it is left unassigned when
   * attributes are ignored entirely and nothing can reach it.
   */
  ignoreAttributesFn!: IgnoreAttributesPredicate;
  /**
   * @description Length of the attribute prefix, precomputed so {@link XMLBuilder.isAttribute} is a substring rather than a search. Unassigned on the same
   * condition as {@link XMLBuilder.ignoreAttributesFn}.
   */
  attrPrefixLen!: number;
  /**
   * @description Whether this builder is walking the plain-object form rather than the ordered form.
   */
  declare processTextOrObjNode: boolean;
  /**
   * @description Indent for a given level. A no-op returning `''` unless `format` is on.
   */
  declare indentate: (level: number) => string;
  /**
   * @description What follows a tag's attributes: `'>\\n'` when formatting, `'>'` otherwise.
   */
  declare tagEndChar: string;
  /**
   * @description Line separator, or `''` when not formatting.
   */
  declare newLine: string;

  /**
   * @description Create a builder from options that are already resolved. Private because the patterns have to be compiled first, which is what
   * {@link XMLBuilder.make} does.
   *
   * @param resolved - The options, defaults applied.
   * @param stopNodeExpressions - The compiled stop-node patterns.
   */
  private constructor(resolved: ResolvedXmlBuilderOptions, stopNodeExpressions: Expression[]) {
    this.options = resolved;
    this.stopNodeExpressions = stopNodeExpressions;
    this.configure();
  }

  /**
   * @description Create a builder, compiling its stop-node patterns. A factory rather than a constructor, because compiling the patterns can fail — one that will
   * not parse — and a constructor has nowhere to put an error channel. The rest of what construction did is shared, in {@link XMLBuilder.configure}.
   *
   * @example
   *   ```typescript
   *   const builder = yield* XMLBuilder.make({ ignoreAttributes: false });
   *   yield* builder.build({ a: { '@_id': '1', '#text': 'hello' } }); // '<a id="1">hello</a>'
   *   ```;
   *
   * @param options - Configuration. See {@link XmlBuilderOptions}.
   *
   * @returns An effect producing the builder. Fails with the `PatternCompilationFailed` reason.
   */
  static make = (options?: XmlBuilderOptions): Effect.Effect<XMLBuilder, BuilderError> =>
    Effect.gen(function* () {
      const resolved: ResolvedXmlBuilderOptions = {
        ...defaultOptions,
        ...options,
        // The `*.tag` stop-node syntax predates `..tag`. Rewriting here rather than at each use means the rest of the builder only ever sees one form.
        stopNodes: (options?.stopNodes ?? []).map(node => (typeof node === 'string' && node.startsWith('*.') ? '..' + node.substring(2) : node)),
      };

      // Pre-compile stopNode expressions for pattern matching
      const stopNodeExpressions: Expression[] = yield* compileStopNodes(resolved.stopNodes);

      return new XMLBuilder(resolved, stopNodeExpressions);
    });

  /**
   * @description Everything construction does beyond compiling the patterns: the `ignoreAttributes` form, the indent strategy, and the special-key set.
   */
  private configure(): void {
    if (this.options.ignoreAttributes === true || this.options.attributesGroupName) {
      this.isAttribute = function () {
        return false;
      };
    } else {
      this.ignoreAttributesFn = getIgnoreAttributesFn(this.options.ignoreAttributes);
      this.attrPrefixLen = this.options.attributeNamePrefix.length;
      this.isAttribute = isAttribute;
    }

    this.processTextOrObjNode = true;

    if (this.options.format) {
      this.indentate = indentate;
      this.tagEndChar = '>\n';
      this.newLine = '\n';
    } else {
      this.indentate = function () {
        return '';
      };
      this.tagEndChar = '>';
      this.newLine = '';
    }
  }

  /**
   * @description Build an XML string from a JavaScript object.
   *
   * @example
   *   ```typescript
   *   const builder = yield* XMLBuilder.make({ ignoreAttributes: false });
   *   yield* builder.build({ a: { '@_id': '1', '#text': 'hello' } }); // '<a id="1">hello</a>'
   *   ```;
   *
   * @param jObj - The object, or the ordered array form when `preserveOrder` is on.
   *
   * @returns An effect producing the XML. Fails with {@link BuilderError} and the `MaxNestingExceeded` reason past `maxNestedTags`, or the
   *   `NameResolutionFailed` reason when a configured `sanitizeName` throws.
   */
  build = Effect.fnUntraced(function* (this: XMLBuilder, jObj: unknown): Effect.fn.Return<string, BuilderError> {
    const options = this.options;
    if (options.preserveOrder) {
      return yield* buildFromOrderedJs(jObj as OrderedTag[], options);
    } else {
      if (Array.isArray(jObj) && options.arrayNodeName !== undefined && options.arrayNodeName.length > 1) {
        jObj = { [options.arrayNodeName]: jObj };
      }
      // Initialize matcher for path tracking
      const matcher = new PathMatcher();
      const xmlVersion = detectXmlVersionFromObj(jObj as Record<string, unknown>, options);
      const qNameValidator: NameValidator = yield* nameValidatorFor(xmlVersion);
      return (yield* this.j2x(jObj as Record<string, unknown>, 0, matcher, qNameValidator)).val;
    }
  });

  /**
   * @description Walk one level of the object, appending to the accumulated attribute and element strings. The walk is the builder's hot path, so it is one flat
   * loop over the object's own keys with a type test per key rather than a dispatch table. Each key contributes to `val`; attributes accumulate
   * separately in `attrStr` because they have to precede the tag's `>`. What a key contributes is decided by {@link renderKeyValue}, which is where
   * the per-shape rules live.
   *
   * @param jObj - The object at this level.
   * @param level - Nesting depth, used for indentation.
   * @param matcher - The live path, pushed and popped around recursion so stop-node patterns see the real position.
   * @param qNameValidator - The memoized QName validator.
   *
   * @returns An effect producing the attributes and the element bodies for this level. Fails with the `MaxNestingExceeded` reason past
   *   `maxNestedTags`, or the `NameResolutionFailed` reason when a `sanitizeName` throws.
   */
  j2x = Effect.fnUntraced(function* (
    this: XMLBuilder,
    jObj: Record<string, unknown>,
    level: number,
    matcher: Matcher,
    qNameValidator: NameValidator
  ): Effect.fn.Return<J2xResult, BuilderError> {
    let attrStr = '';
    let val = '';
    if (this.options.maxNestedTags && (yield* liftXml(matcher.getDepth())) >= this.options.maxNestedTags) {
      return yield* nestingExceeded(this.options.maxNestedTags, yield* liftXml(matcher.getDepth()));
    }
    // Get jPath based on option: string for backward compatibility, or Matcher for new features
    const jPath = this.options.jPath ? yield* liftXml(matcher.toString()) : matcher;

    // Check if current node is a stopNode (will be used for attribute encoding)
    const isCurrentStopNode = yield* this.checkStopNode(matcher);

    const ctx: WalkContext = { level, matcher, qNameValidator, jPath, isCurrentStopNode };

    for (const key in jObj) {
      if (!Object.prototype.hasOwnProperty.call(jObj, key)) continue;

      // Resolve the key through sanitizeName before any use.
      const resolvedKey = isSpecialKey(this, key) ? key : yield* resolveTagName(key, false, this.options, matcher, qNameValidator);

      const rendered = yield* renderKeyValue(this, key, resolvedKey, jObj[key], ctx);
      attrStr += rendered.attrStr;
      val += rendered.val;
    }
    return { attrStr, val };
  });

  /**
   * @description Render one attribute pair, applying the value processor and entity substitution unless the node is a stop node.
   *
   * @param attrName - The resolved attribute name, without the prefix.
   * @param val - The raw value.
   * @param isStopNode - Whether the owning node is copied through verbatim.
   *
   * @returns An effect producing ` name="value"`, or ` name` for a suppressed boolean. Fails with the `ValueProcessingFailed` reason if the
   *   configured `attributeValueProcessor` does.
   */
  buildAttrPairStr = Effect.fnUntraced(function* (
    this: XMLBuilder,
    attrName: string,
    val: string,
    isStopNode: boolean
  ): Effect.fn.Return<string, BuilderError> {
    if (!isStopNode) {
      const processed = yield* runValueProcessor('attributeValueProcessor', attrName, () =>
        this.options.attributeValueProcessor(attrName, valToStr(val))
      );
      val = valToStr(this.replaceEntitiesValue(processed));
    }
    if (this.options.suppressBooleanAttributes && val === 'true') {
      return ' ' + attrName;
    } else return ' ' + attrName + '="' + escapeAttribute(val) + '"';
  });

  /**
   * @description Extract the attributes of one node, escaped and stripped of the prefix, for the path matcher.
   *
   * @param obj - The node.
   *
   * @returns The attribute values, or `null` when the node has none — which is what keeps the matcher's per-node memory at zero for a bare tag.
   */
  extractAttributes(obj: unknown): AttributeValues | null {
    if (!obj || typeof obj !== 'object') return null;

    const node = obj as Record<string, unknown>;
    const groupName = this.options.attributesGroupName;

    // Check for attributesGroupName (when attributes are grouped)
    if (groupName !== false && node[groupName]) {
      // The group accepts either spelling, so its resolver strips the prefix only when it is there
      return collectAttributeValues(node[groupName] as Record<string, unknown>, key => stripAttributePrefix(key, this.options.attributeNamePrefix));
    }

    // Look for individual attributes (prefixed with attributeNamePrefix)
    return collectAttributeValues(node, key => this.isAttribute(key));
  }

  /**
   * @description Build a stop node's body verbatim, without entity substitution. A stop node is a parser's already-encoded output being re-emitted, so escaping it
   * again would double-escape every entity. Attribute quotes are still escaped — that is structural, not encoding, and a quote must not be able to
   * close the attribute.
   *
   * @param obj - The node.
   *
   * @returns The raw XML body.
   */
  buildRawContent(obj: unknown): string {
    if (typeof obj === 'string') {
      return obj; // Already a string, return as-is
    }

    if (typeof obj !== 'object' || obj === null) {
      return valToStr(obj);
    }

    const node = obj as Record<string, unknown>;

    // Check if this is a stopNode data from parser: { "#text": "raw xml", "@_attr": "val" }
    if (node[this.options.textNodeName] !== undefined) {
      return valToStr(node[this.options.textNodeName]); // Return raw text without encoding
    }

    // Build raw XML from nested structure
    return renderRawChildren(this, node);
  }

  /**
   * @description Render a stop node's attributes, skipping the value processor and entity substitution for the same reason as {@link XMLBuilder.buildRawContent}.
   *
   * @param obj - The node.
   *
   * @returns The attribute string, or `''` when the node has no attributes.
   */
  buildAttributesForStopNode(obj: unknown): string {
    if (!obj || typeof obj !== 'object') return '';

    const node = obj as Record<string, unknown>;
    const groupName = this.options.attributesGroupName;

    // Check for attributesGroupName (when attributes are grouped)
    if (groupName !== false && node[groupName]) {
      return renderStopNodeAttributes(
        node[groupName] as Record<string, unknown>,
        key => stripAttributePrefix(key, this.options.attributeNamePrefix),
        this.options
      );
    }

    // Look for individual attributes
    return renderStopNodeAttributes(node, key => this.isAttribute(key), this.options);
  }

  /**
   * @description Wrap a body in a tag, choosing between self-closing, PI and full forms. A body that itself contains markup is not inlined onto the tag line,
   * because that would produce output no parser reads back the same way.
   *
   * @param val - The body.
   * @param key - The tag name.
   * @param attrStr - The attributes, already rendered.
   * @param level - Nesting depth.
   *
   * @returns The rendered element.
   */
  buildObjectNode(val: string, key: string, attrStr: string, level: number): string {
    // A PI/XML-declaration tag never has body content, so it takes the empty form whether or not there is a body.
    if (val === '' || key[0] === '?') {
      return buildEmptyObjectNode(this, key, attrStr, level);
    }
    return buildContentObjectNode(this, val, key, attrStr, level);
  }

  /**
   * @description The closing half of a tag, decided by `unpairedTags` and `suppressEmptyNode`.
   *
   * @param key - The tag name.
   *
   * @returns `'/'` for a self-closing tag, or the full closing bracket.
   */
  closeTag(key: string): string {
    let closeTag = '';
    if (this.options.unpairedTags.indexOf(key) !== -1) {
      //unpaired
      if (!this.options.suppressUnpairedNode) closeTag = '/';
    } else if (this.options.suppressEmptyNode) {
      //empty
      closeTag = '/';
    } else {
      closeTag = `></${key}`;
    }
    return closeTag;
  }

  /**
   * @description Whether the matcher's current position matches any stop-node pattern.
   *
   * @param matcher - The live path.
   *
   * @returns An effect producing whether this node should be copied through verbatim.
   */
  checkStopNode = Effect.fnUntraced(function* (this: XMLBuilder, matcher: Matcher): Effect.fn.Return<boolean, BuilderError> {
    return yield* matchesStopNode(matcher, this.stopNodeExpressions);
  });

  /**
   * @description Render a text-valued node, routing CDATA, comments and processing instructions to their own forms.
   *
   * @param val - The raw value.
   * @param key - The tag name, which selects the form.
   * @param attrStr - The attributes, already rendered.
   * @param level - Nesting depth.
   *
   * @returns The rendered element.
   */
  buildTextValNode = Effect.fnUntraced(function* (
    this: XMLBuilder,
    val: unknown,
    key: string,
    attrStr: string,
    level: number
  ): Effect.fn.Return<string, BuilderError> {
    if (this.options.cdataPropName !== false && key === this.options.cdataPropName) {
      const safeVal = safeCdata(val);
      return this.indentate(level) + `<![CDATA[${safeVal}]]>` + this.newLine;
    } else if (this.options.commentPropName !== false && key === this.options.commentPropName) {
      const safeVal = safeComment(val);
      return this.indentate(level) + `<!--${safeVal}-->` + this.newLine;
    } else if (key[0] === '?') {
      //PI tag
      return this.indentate(level) + '<' + key + attrStr + '?' + this.tagEndChar;
    } else {
      // Normal processing: apply tagValueProcessor and entity replacement
      const processed = yield* runValueProcessor('tagValueProcessor', key, () => this.options.tagValueProcessor(key, val));
      let textValue = this.replaceEntitiesValue(processed);
      // tagValueProcessor may return the raw value unchanged (default is identity), and
      // replaceEntitiesValue no-ops on non-strings, so a plain number can still reach here;
      // stringify it now, sign-preserving, before it's implicitly ToString'd below.
      textValue = valToStr(textValue);

      if (textValue === '') {
        return this.indentate(level) + '<' + key + attrStr + this.closeTag(key) + this.tagEndChar;
      } else {
        return this.indentate(level) + '<' + key + attrStr + '>' + textValue + '</' + key + this.tagEndChar;
      }
    }
  });

  /**
   * @description Apply the configured entity substitutions to a value.
   *
   * @param textValue - The value.
   *
   * @returns The substituted value, or the input unchanged when `processEntities` is off or the value is empty.
   */
  replaceEntitiesValue(textValue: unknown): string {
    let result = valToStr(textValue);
    if (result.length > 0 && this.options.processEntities) {
      for (let i = 0; i < this.options.entities.length; i++) {
        const entity = this.options.entities[i];
        if (entity) result = result.replace(entity.regex, entity.val);
      }
    }
    return result;
  }

  /**
   * @description Push a node, recurse into it, and wrap the result. Extracted from the array and nested-object branches of {@link XMLBuilder.j2x}, which differ
   * only in whether they wrap the result in one shared tag for a whole list.
   *
   * @param object - The node.
   * @param key - The resolved tag name.
   * @param level - Nesting depth.
   * @param matcher - The live path.
   * @param qNameValidator - The memoized QName validator.
   *
   * @returns An effect producing the rendered element. Fails with the `MaxNestingExceeded` or `NameResolutionFailed` reason, propagated from
   *   {@link XMLBuilder.j2x}.
   */
  processTextOrObjNodeFor = Effect.fnUntraced(function* (
    this: XMLBuilder,
    object: Record<string, unknown>,
    key: string,
    level: number,
    matcher: Matcher,
    qNameValidator: NameValidator
  ): Effect.fn.Return<string, BuilderError> {
    // Extract attributes to pass to matcher
    const attrValues = this.extractAttributes(object);

    // Push tag to matcher before recursion WITH attributes
    yield* liftXml(matcher.push(key, attrValues));

    // Check if this entire node is a stopNode
    const isStopNode = yield* this.checkStopNode(matcher);

    if (isStopNode) {
      // For stopNodes, build raw content without entity encoding
      const rawContent = this.buildRawContent(object);
      const attrStr = this.buildAttributesForStopNode(object);
      yield* liftXml(matcher.pop());
      return this.buildObjectNode(rawContent, key, attrStr, level);
    }

    const result = yield* this.j2x(object, level + 1, matcher, qNameValidator);
    // Pop tag from matcher after recursion
    yield* liftXml(matcher.pop());

    // PI/XML-declaration tags must never emit text content — route through
    // buildTextValNode which correctly ignores the text node for "?" tags.
    if (key[0] === '?') {
      return yield* this.buildTextValNode('', key, result.attrStr, level);
    } else if (object[this.options.textNodeName] !== undefined && Object.keys(object).length === 1) {
      return yield* this.buildTextValNode(object[this.options.textNodeName], key, result.attrStr, level);
    } else {
      return this.buildObjectNode(result.val, key, result.attrStr, level);
    }
  });
}

/**
 * @description Whether a key is one of the builder's own conventions rather than a user-supplied XML name. The special keys (textNodeName, cdataPropName,
 * commentPropName, attributesGroupName, attributeNamePrefix) are exempt from `sanitizeName` — they are builder-internal conventions, not XML names,
 * and a resolver cannot repair a name it was never meant to see. A `?` prefix marks a processing instruction, which is likewise not an element name.
 *
 * @param builder - The builder walking the level.
 * @param key - The key from the input object.
 *
 * @returns Whether the key is exempt from name resolution.
 */
function isSpecialKey(builder: XMLBuilder, key: string): boolean {
  const options = builder.options;
  // `isAttribute` answers with the bare attribute name rather than a boolean, and what this decides
  // is only whether there is one — the name is derived later, from the prefixed key.
  if (builder.isAttribute(key)) return true;
  // A `?` prefix marks a processing instruction, which is likewise not an element name.
  if (key[0] === '?') return true;
  return (
    key === options.textNodeName ||
    key === options.cdataPropName ||
    key === options.commentPropName ||
    (options.attributesGroupName !== false && key === options.attributesGroupName)
  );
}

/**
 * @description Wrap a body-less tag: a processing instruction where one is called for, a self-closing or explicitly-closed element otherwise.
 *
 * @param builder - The builder walking the level.
 * @param key - The tag name.
 * @param attrStr - The attributes, already rendered.
 * @param level - Nesting depth.
 *
 * @returns The rendered element.
 */
function buildEmptyObjectNode(builder: XMLBuilder, key: string, attrStr: string, level: number): string {
  if (key[0] === '?') return builder.indentate(level) + '<' + key + attrStr + '?' + builder.tagEndChar;
  return builder.indentate(level) + '<' + key + attrStr + builder.closeTag(key) + builder.tagEndChar;
}

/**
 * @description Wrap a tag that has a body. Three forms: inline when the body is plain text, a comment when the key is the comment property, and the general form —
 * body on its own lines — otherwise.
 *
 * @param builder - The builder walking the level.
 * @param val - The body.
 * @param key - The tag name.
 * @param attrStr - The attributes, already rendered.
 * @param level - Nesting depth.
 *
 * @returns The rendered element.
 */
function buildContentObjectNode(builder: XMLBuilder, val: string, key: string, attrStr: string, level: number): string {
  const tagEndExp = '</' + key + builder.tagEndChar;
  const piClosingChar = '';

  // attrStr is an empty string in case the attribute came as undefined or null
  if ((attrStr || attrStr === '') && val.indexOf('<') === -1) {
    return builder.indentate(level) + '<' + key + attrStr + piClosingChar + '>' + val + tagEndExp;
  } else if (builder.options.commentPropName !== false && key === builder.options.commentPropName && piClosingChar.length === 0) {
    return builder.indentate(level) + `<!--${safeComment(val)}-->` + builder.newLine;
  } else {
    return builder.indentate(level) + '<' + key + attrStr + piClosingChar + builder.tagEndChar + val + builder.indentate(level) + tagEndExp;
  }
}

/**
 * @description Render one key of a level. The dispatch is the walk's chain of `else if`s in its original order, and the order is load-bearing: a `Date` is an
 * object, so it has to be tested before the object shapes, and a primitive is neither. Which of the two strings a branch writes to is what it returns
 * — attributes for an attribute key, the body for everything else.
 *
 * @param builder - The builder walking the level.
 * @param key - The key, as written in the input object.
 * @param resolvedKey - The key after `sanitizeName`, which is the name written when the key is a tag rather than a special name.
 * @param value - The value under that key.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing what the key contributes. Fails with the `MaxNestingExceeded` or `NameResolutionFailed` reason, propagated from
 *   whichever branch the value routes to.
 */
const renderKeyValue = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  key: string,
  resolvedKey: string,
  value: unknown,
  ctx: WalkContext
): Effect.fn.Return<J2xResult, BuilderError> {
  if (typeof value === 'undefined') {
    // supress undefined node only if it is not an attribute
    return { attrStr: '', val: '' };
  }

  if (value === null) {
    // null attribute should be ignored by the attribute list, but should not cause the tag closing
    return renderNullValue(builder, key, resolvedKey, ctx.level);
  }

  if (value instanceof Date) {
    const val = yield* builder.buildTextValNode(value, resolvedKey, '', ctx.level);
    return { attrStr: '', val };
  }

  if (typeof value !== 'object') {
    //premitive type
    return yield* renderPrimitiveValue(builder, key, resolvedKey, value, ctx);
  }

  if (Array.isArray(value)) {
    //repeated nodes
    return { attrStr: '', val: yield* renderRepeatedNode(builder, resolvedKey, value, ctx) };
  }

  //nested node
  return yield* renderNestedObject(builder, key, resolvedKey, value, ctx);
});

/**
 * @description Render a `null`-valued key. A `null` body has nothing to write, so the only choice left is between the three empty forms: nothing at all for an
 * attribute or for the CDATA and comment properties, a processing instruction for a `?`-prefixed name, and a self-closing tag otherwise.
 *
 * @param builder - The builder walking the level.
 * @param key - The key, as written in the input object.
 * @param resolvedKey - The key after `sanitizeName`.
 * @param level - Nesting depth.
 *
 * @returns What the key contributes.
 */
function renderNullValue(builder: XMLBuilder, key: string, resolvedKey: string, level: number): J2xResult {
  if (builder.isAttribute(key)) {
    return { attrStr: '', val: '' };
  }
  if (resolvedKey === builder.options.cdataPropName || resolvedKey === builder.options.commentPropName) {
    return { attrStr: '', val: '' };
  }
  return { attrStr: '', val: renderEmptyNode(builder, resolvedKey, level) };
}

/**
 * @description An empty element, or the processing instruction form for a `?`-prefixed name.
 *
 * @param builder - The builder walking the level.
 * @param key - The resolved tag name.
 * @param level - Nesting depth.
 *
 * @returns The rendered element.
 */
function renderEmptyNode(builder: XMLBuilder, key: string, level: number): string {
  if (key[0] === '?') return builder.indentate(level) + '<' + key + '?' + builder.tagEndChar;
  return builder.indentate(level) + '<' + key + '/' + builder.tagEndChar;
}

/**
 * @description Render a primitive value. A key that names an attribute contributes to `attrStr` unless the `ignoreAttributes` predicate drops it; anything else is
 * a tag body, contributed to `val`. The two cannot both apply to one key, which is why the attribute branch returns early.
 *
 * @param builder - The builder walking the level.
 * @param key - The key, as written in the input object.
 * @param resolvedKey - The key after `sanitizeName`.
 * @param value - The primitive value.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing what the key contributes. Fails with the `ValueProcessingFailed` or `NameResolutionFailed` reason, propagated from the
 *   branch the value routes to.
 */
const renderPrimitiveValue = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  key: string,
  resolvedKey: string,
  value: unknown,
  ctx: WalkContext
): Effect.fn.Return<J2xResult, BuilderError> {
  const attr = builder.isAttribute(key);

  if (attr) {
    if (builder.ignoreAttributesFn(attr, ctx.jPath as string)) {
      return { attrStr: '', val: '' };
    }
    // Resolve the attribute name through sanitizeName
    const resolvedAttr = yield* resolveTagName(attr, true, builder.options, ctx.matcher, ctx.qNameValidator);
    return { attrStr: yield* builder.buildAttrPairStr(resolvedAttr, valToStr(value), ctx.isCurrentStopNode), val: '' };
  }

  //tag value
  return { attrStr: '', val: yield* renderPrimitiveTagValue(builder, key, resolvedKey, value, ctx) };
});

/**
 * @description Render a primitive as a tag body rather than as an attribute. The text-node key is handled without a tag at all — its value is the parent's content
 * — and everything else becomes a text-valued node, which a stop node takes verbatim.
 *
 * @param builder - The builder walking the level.
 * @param key - The key, as written in the input object.
 * @param resolvedKey - The key after `sanitizeName`.
 * @param value - The primitive value.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing the rendered body. Fails with the `ValueProcessingFailed` reason if the configured `tagValueProcessor` does.
 */
const renderPrimitiveTagValue = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  key: string,
  resolvedKey: string,
  value: unknown,
  ctx: WalkContext
): Effect.fn.Return<string, BuilderError> {
  if (key === builder.options.textNodeName) {
    const newval = yield* runValueProcessor('tagValueProcessor', key, () => builder.options.tagValueProcessor(key, valToStr(value)));
    return builder.replaceEntitiesValue(newval);
  }

  // Check if this is a stopNode before building
  if (yield* checkStopNodeAt(builder, resolvedKey, ctx.matcher)) {
    // Build as raw content without encoding
    return renderStopNodeText(builder, value, resolvedKey, ctx.level);
  }

  return yield* builder.buildTextValNode(value, resolvedKey, '', ctx.level);
});

/**
 * @description Render a value under an array key, one item at a time. Two options change the shape of the result rather than of any single item: `oneListGroup`
 * collects the whole array into one shared tag at the end, and `stopNodes` decides per item whether it is copied through verbatim. Extracted from the
 * array branch of {@link XMLBuilder.j2x}, which was the longest arm of its dispatch chain.
 *
 * @param builder - The builder walking the level.
 * @param resolvedKey - The resolved tag name, which every item in the list shares.
 * @param value - The array.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing the rendered list. Fails with the `MaxNestingExceeded` or `NameResolutionFailed` reason, propagated from the per-item
 *   renderers.
 */
const renderRepeatedNode = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  resolvedKey: string,
  value: unknown[],
  ctx: WalkContext
): Effect.fn.Return<string, BuilderError> {
  const arrLen = value.length;
  let listTagVal = '';
  let listTagAttr = '';
  // A `null` item is written to the level rather than into the list, so it lands ahead of the list's own
  // output instead of in item order. Kept as it was: two writers into one level, and where the empty
  // form lands is the difference between `<root/><root>str4</root>` and `<root>str4<root/></root>`.
  let emptyVal = '';

  for (let j = 0; j < arrLen; j++) {
    const item = value[j];

    // supress undefined node
    if (typeof item === 'undefined') continue;

    if (item === null) {
      emptyVal += renderEmptyNode(builder, resolvedKey, ctx.level);
      continue;
    }

    if (typeof item === 'object') {
      const grouped = yield* renderListObjectItem(builder, item as Record<string, unknown>, resolvedKey, ctx);
      listTagVal += grouped.val;
      listTagAttr += grouped.attrStr;
      continue;
    }

    listTagVal += yield* renderListPrimitiveItem(builder, item, resolvedKey, ctx);
  }

  if (builder.options.oneListGroup) {
    listTagVal = builder.buildObjectNode(listTagVal, resolvedKey, listTagAttr, ctx.level);
  }

  return emptyVal + listTagVal;
});

/**
 * @description Render one object item of a list. The two options diverge here: under `oneListGroup` the items share one tag, so each is walked in place and its
 * attributes accumulate for the shared tag to carry; otherwise each item becomes its own tag through {@link XMLBuilder.processTextOrObjNodeFor}.
 *
 * @param builder - The builder walking the level.
 * @param item - The item.
 * @param resolvedKey - The resolved tag name, which every item in the list shares.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing what the item contributes. Fails with the `MaxNestingExceeded` or `NameResolutionFailed` reason, propagated from the
 *   recursion into the item.
 */
const renderListObjectItem = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  item: Record<string, unknown>,
  resolvedKey: string,
  ctx: WalkContext
): Effect.fn.Return<J2xResult, BuilderError> {
  if (!builder.options.oneListGroup) {
    const val = yield* builder.processTextOrObjNodeFor(item, resolvedKey, ctx.level, ctx.matcher, ctx.qNameValidator);
    return { attrStr: '', val };
  }

  // Push tag to matcher before recursive call
  yield* liftXml(ctx.matcher.push(resolvedKey));
  const result = yield* builder.j2x(item, ctx.level + 1, ctx.matcher, ctx.qNameValidator);
  // Pop tag from matcher after recursive call
  yield* liftXml(ctx.matcher.pop());

  // Only a list written through attributesGroupName has attributes to give the shared tag; in the flat
  // layout an item's attributes belong to the item's own tag, which this branch does not write.
  if (builder.options.attributesGroupName && Object.prototype.hasOwnProperty.call(item, builder.options.attributesGroupName)) {
    return { attrStr: result.attrStr, val: result.val };
  }
  return { attrStr: '', val: result.val };
});

/**
 * @description Render one primitive item of a list. Under `oneListGroup` an item contributes bare text to the shared tag's body — processed and
 * entity-substituted, because the list is not a stop node's copy-through — and otherwise it becomes a text-valued tag, which a stop node takes
 * verbatim.
 *
 * @param builder - The builder walking the level.
 * @param item - The primitive item.
 * @param resolvedKey - The resolved tag name, which every item in the list shares.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing what the item contributes. Fails with the `ValueProcessingFailed` reason if the configured `tagValueProcessor` does.
 */
const renderListPrimitiveItem = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  item: unknown,
  resolvedKey: string,
  ctx: WalkContext
): Effect.fn.Return<string, BuilderError> {
  if (builder.options.oneListGroup) {
    let textValue = yield* runValueProcessor('tagValueProcessor', resolvedKey, () => builder.options.tagValueProcessor(resolvedKey, item));
    textValue = builder.replaceEntitiesValue(textValue);
    textValue = valToStr(textValue);
    return textValue;
  }

  // Check if this is a stopNode before building
  if (yield* checkStopNodeAt(builder, resolvedKey, ctx.matcher)) {
    // Build as raw content without encoding
    return renderStopNodeText(builder, item, resolvedKey, ctx.level);
  }

  return yield* builder.buildTextValNode(item, resolvedKey, '', ctx.level);
});

/**
 * @description Render an object value. One of two things depends on which key it sits under: the attributes group, whose keys are attribute names rather than
 * tags, and every other key, whose value is a nested node.
 *
 * @param builder - The builder walking the level.
 * @param key - The key, as written in the input object.
 * @param resolvedKey - The key after `sanitizeName`.
 * @param value - The object.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing what the key contributes. Fails with the `MaxNestingExceeded` or `NameResolutionFailed` reason, propagated from the
 *   recursion into the value.
 */
const renderNestedObject = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  key: string,
  resolvedKey: string,
  value: unknown,
  ctx: WalkContext
): Effect.fn.Return<J2xResult, BuilderError> {
  const groupName = builder.options.attributesGroupName;

  if (groupName !== false && key === groupName) {
    return { attrStr: yield* renderGroupedAttributes(builder, value as Record<string, unknown>, ctx), val: '' };
  }

  const val = yield* builder.processTextOrObjNodeFor(value as Record<string, unknown>, resolvedKey, ctx.level, ctx.matcher, ctx.qNameValidator);
  return { attrStr: '', val };
});

/**
 * @description Render the attributes grouped under `attributesGroupName`. Unlike the flat layout, where the walk finds attribute keys as it goes, every key of a
 * group is an attribute — which is why the group is walked here rather than through the level's own loop.
 *
 * @param builder - The builder walking the level.
 * @param group - The group's value.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing the group's attribute string. Fails with the `ValueProcessingFailed` or `NameResolutionFailed` reason, propagated from
 *   the per-attribute rendering.
 */
const renderGroupedAttributes = Effect.fnUntraced(function* (
  builder: XMLBuilder,
  group: Record<string, unknown>,
  ctx: WalkContext
): Effect.fn.Return<string, BuilderError> {
  let attrStr = '';
  const Ks = Object.keys(group);
  const L = Ks.length;

  for (let j = 0; j < L; j++) {
    const rawKey = Ks[j];
    if (rawKey === undefined) continue;
    // Resolve attribute names inside attributesGroupName
    const resolvedAttr = yield* resolveTagName(rawKey, true, builder.options, ctx.matcher, ctx.qNameValidator);
    attrStr += yield* builder.buildAttrPairStr(resolvedAttr, valToStr(group[rawKey]), ctx.isCurrentStopNode);
  }

  return attrStr;
});

/**
 * @description Whether the child about to be written is a stop node. The key goes on the path for the question and comes off again, so a pattern anchored at that
 * child sees its own position rather than its parent's — which is what lets a stop-node pattern name the node it matches.
 *
 * @param builder - The builder walking the level.
 * @param key - The child's resolved tag name.
 * @param matcher - The live path.
 *
 * @returns An effect producing whether the child is a stop node.
 */
function checkStopNodeAt(builder: XMLBuilder, key: string, matcher: Matcher): Effect.Effect<boolean, BuilderError> {
  return Effect.gen(function* () {
    yield* liftXml(matcher.push(key));
    const isStopNode = yield* builder.checkStopNode(matcher);
    yield* liftXml(matcher.pop());
    return isStopNode;
  });
}

/**
 * @description Render a text value that belongs to a stop node, without entity substitution: the value is a parser's already-encoded output being re-emitted, and
 * escaping it again would double-escape every entity. The empty case still asks {@link XMLBuilder.closeTag}, because an empty stop-node body is
 * written the way any other empty body is.
 *
 * @param builder - The builder walking the level.
 * @param value - The raw value.
 * @param key - The resolved tag name.
 * @param level - Nesting depth.
 *
 * @returns The rendered element.
 */
function renderStopNodeText(builder: XMLBuilder, value: unknown, key: string, level: number): string {
  const textValue = valToStr(value);
  if (textValue === '') {
    return builder.indentate(level) + '<' + key + builder.closeTag(key) + builder.tagEndChar;
  } else {
    return builder.indentate(level) + '<' + key + '>' + textValue + '</' + key + builder.tagEndChar;
  }
}

/**
 * @description Walk a stop node's own keys into its raw body. Attributes are skipped: they belong to the tag this body is written inside, and the parser's
 * already-encoded ones are rendered by {@link XMLBuilder.buildAttributesForStopNode}.
 *
 * @param builder - The builder walking the level.
 * @param node - The stop node.
 *
 * @returns The raw XML body.
 */
function renderRawChildren(builder: XMLBuilder, node: Record<string, unknown>): string {
  let content = '';

  for (const key in node) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;

    // Skip attributes
    if (builder.isAttribute(key)) continue;
    if (builder.options.attributesGroupName !== false && key === builder.options.attributesGroupName) continue;

    content += renderRawChild(builder, key, node[key]);
  }

  return content;
}

/**
 * @description Render one key of a stop node's raw body. An array repeats the tag once per item; a nested object and a primitive both write one element, and
 * differ only in whether their content has been walked yet.
 *
 * @param builder - The builder walking the level.
 * @param key - The key, as written in the input object.
 * @param value - The value under that key.
 *
 * @returns The raw XML this key contributes.
 */
function renderRawChild(builder: XMLBuilder, key: string, value: unknown): string {
  if (key === builder.options.textNodeName) {
    return valToStr(value); // Raw text
  }

  if (Array.isArray(value)) {
    // Array of same tag
    return renderRawList(builder, key, value);
  }

  if (typeof value === 'object' && value !== null) {
    // Nested object
    const valueNode = value as Record<string, unknown>;
    return renderRawTag(key, builder.buildAttributesForStopNode(valueNode), builder.buildRawContent(valueNode));
  }

  // Primitive value
  return `<${key}>${valToStr(value)}</${key}>`;
}

/**
 * @description Render an array inside a stop node, repeating the tag once per item. An item that is neither a scalar nor an object contributes nothing, which is
 * what the parser's own output never produces but hand-written input can.
 *
 * @param builder - The builder walking the level.
 * @param key - The tag name every item repeats.
 * @param items - The array.
 *
 * @returns The raw XML this array contributes.
 */
function renderRawList(builder: XMLBuilder, key: string, items: unknown[]): string {
  let content = '';

  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number') {
      content += `<${key}>${valToStr(item)}</${key}>`;
    } else if (typeof item === 'object' && item !== null) {
      const itemNode = item as Record<string, unknown>;
      content += renderRawTag(key, builder.buildAttributesForStopNode(itemNode), builder.buildRawContent(itemNode));
    }
  }

  return content;
}

/**
 * @description Indent for a given nesting level.
 *
 * @param level - Nesting depth.
 *
 * @returns The indent string.
 */
function indentate(this: XMLBuilder, level: number): string {
  return this.options.indentBy.repeat(level);
}

/**
 * @description Whether a key names an attribute, and if so what its bare name is.
 *
 * @param name - The key from the input object.
 *
 * @returns The attribute name without its prefix, or `false` if the key is not an attribute.
 */
function isAttribute(this: XMLBuilder, name: string): string | false {
  if (name.startsWith(this.options.attributeNamePrefix) && name !== this.options.textNodeName) {
    return name.substring(this.attrPrefixLen);
  } else {
    return false;
  }
}

export default XMLBuilder;
