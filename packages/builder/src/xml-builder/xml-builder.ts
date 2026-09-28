import type { Expression, Matcher } from '@endevops/common-xml';
import type { XmlVersion } from '@endevops/common-xml';

import { Expression as CompiledExpression, Matcher as PathMatcher } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { BuilderError } from '../errors.ts';
import type { IgnoreAttributesPredicate, ResolvedXmlBuilderOptions, XmlBuilderOptions } from './options.ts';
import type { OrderedTag } from './ordered.ts';

import { compilePattern, liftXml, nestingExceeded, runValueProcessor, tryResolveName } from '../errors.ts';
import getIgnoreAttributesFn from './ignore-attributes.ts';
import buildFromOrderedJs from './ordered.ts';
import { nameValidatorFor } from './ordered.ts';
import { escapeAttribute, safeCdata, safeComment, valToStr } from './util.ts';

/**
 * @description What {@link XMLBuilder.j2x} returns: the attribute string and the element body, kept apart so a caller can nest them.
 */
export interface J2xResult {
  /**
   * @description The leading ` name="value"` pairs for this level.
   */
  attrStr: string;
  /**
   * @description The element bodies for this level.
   */
  val: string;
}

/**
 * @description The attribute values handed to {@link Matcher.push} for one node, already escaped. Keys are bare attribute names, without the prefix.
 */
export type AttributeValues = Record<string, string>;

/**
 * @description A QName validator. Always the memoized form from `@endevops/common-xml`; named separately so the signature reads at each use site without repeating
 * the `MemoizedValidator` import. It returns an effect, as every validator in `common-xml` does. The walk tests it before deciding a name needs
 * repairing, so a name the validator rejects is the one that reaches `sanitizeName` — the same rule as before, with one more `yield*` at each use.
 */
type NameValidator = (name: string) => Effect.Effect<boolean, BuilderError>;

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
      if (v) return versionToString(v);
    }
  }
  // flat attribute path e.g. { '@_version': '1.1' }
  const v = node[options.attributeNamePrefix + 'version'];
  if (v) return versionToString(v);
  return undefined;
}

/**
 * @description Read a declared version, accepting only the two scalar forms a declaration can legitimately take. The original interpolated whatever it found, so
 * an object-valued `version` became `"[object Object]"` — which then failed the `1.1` comparison and silently fell back to 1.0. Rejecting the
 * non-scalars outright reaches the same outcome without manufacturing a junk string.
 *
 * @param value - The raw `version` value from the document.
 *
 * @returns The version as a string, or `undefined` if it is not a scalar.
 */
function versionToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * @description Narrow a declared version to the two this package validates against. A document declaring anything else — `2.0` from a future spec, or a typo — is
 * validated as 1.0, which is the safe direction: 1.0's character classes are the stricter subset, so a name that passes here is at least plausible in
 * either.
 *
 * @param declared - The version string read from the document, if any.
 *
 * @returns `'1.1'` or `'1.0'`.
 */
function toXmlVersion(declared: string | undefined): XmlVersion {
  return declared === '1.1' ? '1.1' : '1.0';
}

/**
 * @description Resolve a tag or attribute name through `sanitizeName` if one is configured. QName validation runs first, so the callback is only invoked for names
 * that actually need work — a document of valid names pays nothing for having the option configured. With no resolver configured the name is returned
 * untouched and no validation happens at all.
 *
 * @param name - The raw name from the input object.
 * @param isAttribute - Whether an attribute name is being resolved.
 * @param options - The resolved options.
 * @param matcher - The current path, for the resolver's context.
 * @param qNameValidator - The memoized QName validator.
 *
 * @returns The name to write.
 */
function resolveTagName(
  name: string,
  isAttribute: boolean,
  options: ResolvedXmlBuilderOptions,
  matcher: Matcher,
  qNameValidator: NameValidator
): Effect.Effect<string, BuilderError> {
  return Effect.gen(function* () {
    const resolve = options.sanitizeName;
    if (!resolve) return name;
    if (yield* qNameValidator(name)) return name;
    // `readOnly` is an effect, so the view is built before the callback runs rather than inside it
    // — the callback is a plain function, and a plain function cannot run an effect.
    const view = yield* liftXml(matcher.readOnly());
    return yield* tryResolveName(name, () => resolve(name, { isAttribute, matcher: view }));
  });
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
      const stopNodeExpressions: Expression[] = [];
      if (Array.isArray(resolved.stopNodes)) {
        for (const node of resolved.stopNodes) {
          if (typeof node === 'string') {
            stopNodeExpressions.push(yield* compilePattern(node));
          } else if (node instanceof CompiledExpression) {
            stopNodeExpressions.push(node);
          }
        }
      }

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
   * loop over the object's own keys with a type test per key rather than a dispatch table. Each branch appends to `val`; attributes accumulate
   * separately in `attrStr` because they have to precede the tag's `>`.
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

    for (const key in jObj) {
      if (!Object.prototype.hasOwnProperty.call(jObj, key)) continue;

      // Resolve the key through sanitizeName before any use.
      // Special keys (textNodeName, cdataPropName, commentPropName, attributeNamePrefix,
      // attributesGroupName, "?" PI tags) are exempt — they are builder-internal conventions,
      // not user-supplied XML names.
      const isSpecialKey =
        key === this.options.textNodeName ||
        key === this.options.cdataPropName ||
        key === this.options.commentPropName ||
        (this.options.attributesGroupName !== false && key === this.options.attributesGroupName) ||
        this.isAttribute(key) ||
        key[0] === '?';

      const resolvedKey = isSpecialKey ? key : yield* resolveTagName(key, false, this.options, matcher, qNameValidator);
      const value = jObj[key];

      if (typeof value === 'undefined') {
        // supress undefined node only if it is not an attribute
        if (this.isAttribute(key)) {
          val += '';
        }
      } else if (value === null) {
        // null attribute should be ignored by the attribute list, but should not cause the tag closing
        if (this.isAttribute(key)) {
          val += '';
        } else if (resolvedKey === this.options.cdataPropName || resolvedKey === this.options.commentPropName) {
          val += '';
        } else if (resolvedKey[0] === '?') {
          val += this.indentate(level) + '<' + resolvedKey + '?' + this.tagEndChar;
        } else {
          val += this.indentate(level) + '<' + resolvedKey + '/' + this.tagEndChar;
        }
      } else if (value instanceof Date) {
        val += yield* this.buildTextValNode(value, resolvedKey, '', level);
      } else if (typeof value !== 'object') {
        //premitive type
        const attr = this.isAttribute(key);
        if (attr && !this.ignoreAttributesFn(attr, jPath as string)) {
          // Resolve the attribute name through sanitizeName
          const resolvedAttr = yield* resolveTagName(attr, true, this.options, matcher, qNameValidator);
          attrStr += yield* this.buildAttrPairStr(resolvedAttr, valToStr(value), isCurrentStopNode);
        } else if (!attr) {
          //tag value
          if (key === this.options.textNodeName) {
            const newval = yield* runValueProcessor('tagValueProcessor', key, () => this.options.tagValueProcessor(key, valToStr(value)));
            val += this.replaceEntitiesValue(newval);
          } else {
            // Check if this is a stopNode before building
            yield* liftXml(matcher.push(resolvedKey));
            const isStopNode = yield* this.checkStopNode(matcher);
            yield* liftXml(matcher.pop());

            if (isStopNode) {
              // Build as raw content without encoding
              const textValue = valToStr(value);
              if (textValue === '') {
                val += this.indentate(level) + '<' + resolvedKey + this.closeTag(resolvedKey) + this.tagEndChar;
              } else {
                val += this.indentate(level) + '<' + resolvedKey + '>' + textValue + '</' + resolvedKey + this.tagEndChar;
              }
            } else {
              val += yield* this.buildTextValNode(value, resolvedKey, '', level);
            }
          }
        }
      } else if (Array.isArray(value)) {
        //repeated nodes
        const arrLen = value.length;
        let listTagVal = '';
        let listTagAttr = '';
        for (let j = 0; j < arrLen; j++) {
          const item = value[j];
          if (typeof item === 'undefined') {
            // supress undefined node
          } else if (item === null) {
            if (resolvedKey[0] === '?') val += this.indentate(level) + '<' + resolvedKey + '?' + this.tagEndChar;
            else val += this.indentate(level) + '<' + resolvedKey + '/' + this.tagEndChar;
          } else if (typeof item === 'object') {
            if (this.options.oneListGroup) {
              // Push tag to matcher before recursive call
              yield* liftXml(matcher.push(resolvedKey));
              const result = yield* this.j2x(item as Record<string, unknown>, level + 1, matcher, qNameValidator);
              // Pop tag from matcher after recursive call
              yield* liftXml(matcher.pop());

              listTagVal += result.val;
              if (this.options.attributesGroupName && Object.prototype.hasOwnProperty.call(item, this.options.attributesGroupName)) {
                listTagAttr += result.attrStr;
              }
            } else {
              listTagVal += yield* this.processTextOrObjNodeFor(item as Record<string, unknown>, resolvedKey, level, matcher, qNameValidator);
            }
          } else {
            if (this.options.oneListGroup) {
              let textValue = yield* runValueProcessor('tagValueProcessor', resolvedKey, () => this.options.tagValueProcessor(resolvedKey, item));
              textValue = this.replaceEntitiesValue(textValue);
              textValue = valToStr(textValue);
              listTagVal += textValue;
            } else {
              // Check if this is a stopNode before building
              yield* liftXml(matcher.push(resolvedKey));
              const isStopNode = yield* this.checkStopNode(matcher);
              yield* liftXml(matcher.pop());

              if (isStopNode) {
                // Build as raw content without encoding
                const textValue = valToStr(item);
                if (textValue === '') {
                  listTagVal += this.indentate(level) + '<' + resolvedKey + this.closeTag(resolvedKey) + this.tagEndChar;
                } else {
                  listTagVal += this.indentate(level) + '<' + resolvedKey + '>' + textValue + '</' + resolvedKey + this.tagEndChar;
                }
              } else {
                listTagVal += yield* this.buildTextValNode(item, resolvedKey, '', level);
              }
            }
          }
        }
        if (this.options.oneListGroup) {
          listTagVal = this.buildObjectNode(listTagVal, resolvedKey, listTagAttr, level);
        }
        val += listTagVal;
      } else {
        //nested node
        if (this.options.attributesGroupName !== false && key === this.options.attributesGroupName) {
          const group = value as Record<string, unknown>;
          const Ks = Object.keys(group);
          const L = Ks.length;
          for (let j = 0; j < L; j++) {
            const rawKey = Ks[j];
            if (rawKey === undefined) continue;
            // Resolve attribute names inside attributesGroupName
            const resolvedAttr = yield* resolveTagName(rawKey, true, this.options, matcher, qNameValidator);
            attrStr += yield* this.buildAttrPairStr(resolvedAttr, valToStr(group[rawKey]), isCurrentStopNode);
          }
        } else {
          val += yield* this.processTextOrObjNodeFor(value as Record<string, unknown>, resolvedKey, level, matcher, qNameValidator);
        }
      }
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
    const attrValues: AttributeValues = {};
    let hasAttrs = false;

    // Check for attributesGroupName (when attributes are grouped)
    if (this.options.attributesGroupName !== false && node[this.options.attributesGroupName]) {
      const attrGroup = node[this.options.attributesGroupName] as Record<string, unknown>;
      for (const attrKey in attrGroup) {
        if (!Object.prototype.hasOwnProperty.call(attrGroup, attrKey)) continue;
        // Remove attribute prefix if present
        const cleanKey = attrKey.startsWith(this.options.attributeNamePrefix) ? attrKey.substring(this.options.attributeNamePrefix.length) : attrKey;
        attrValues[cleanKey] = escapeAttribute(attrGroup[attrKey]);
        hasAttrs = true;
      }
    } else {
      // Look for individual attributes (prefixed with attributeNamePrefix)
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const attr = this.isAttribute(key);
        if (attr) {
          attrValues[attr] = escapeAttribute(node[key]);
          hasAttrs = true;
        }
      }
    }

    return hasAttrs ? attrValues : null;
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
    let content = '';

    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;

      // Skip attributes
      if (this.isAttribute(key)) continue;
      if (this.options.attributesGroupName !== false && key === this.options.attributesGroupName) continue;

      const value = node[key];

      if (key === this.options.textNodeName) {
        content += valToStr(value); // Raw text
      } else if (Array.isArray(value)) {
        // Array of same tag
        for (const item of value) {
          if (typeof item === 'string' || typeof item === 'number') {
            content += `<${key}>${valToStr(item)}</${key}>`;
          } else if (typeof item === 'object' && item !== null) {
            const itemNode = item as Record<string, unknown>;
            const nestedContent = this.buildRawContent(itemNode);
            const nestedAttrs = this.buildAttributesForStopNode(itemNode);
            if (nestedContent === '') {
              content += `<${key}${nestedAttrs}/>`;
            } else {
              content += `<${key}${nestedAttrs}>${nestedContent}</${key}>`;
            }
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        // Nested object
        const valueNode = value as Record<string, unknown>;
        const nestedContent = this.buildRawContent(valueNode);
        const nestedAttrs = this.buildAttributesForStopNode(valueNode);
        if (nestedContent === '') {
          content += `<${key}${nestedAttrs}/>`;
        } else {
          content += `<${key}${nestedAttrs}>${nestedContent}</${key}>`;
        }
      } else {
        // Primitive value
        content += `<${key}>${valToStr(value)}</${key}>`;
      }
    }

    return content;
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
    let attrStr = '';

    // Check for attributesGroupName (when attributes are grouped)
    if (this.options.attributesGroupName !== false && node[this.options.attributesGroupName]) {
      const attrGroup = node[this.options.attributesGroupName] as Record<string, unknown>;
      for (const attrKey in attrGroup) {
        if (!Object.prototype.hasOwnProperty.call(attrGroup, attrKey)) continue;
        const cleanKey = attrKey.startsWith(this.options.attributeNamePrefix) ? attrKey.substring(this.options.attributeNamePrefix.length) : attrKey;
        const val = attrGroup[attrKey];
        if (val === true && this.options.suppressBooleanAttributes) {
          attrStr += ' ' + cleanKey;
        } else {
          // stopNode content is raw, but the quote delimiter is always escaped
          // so a quote in the value cannot break out of the attribute (see orderedJs2Xml attr_to_str)
          attrStr += ' ' + cleanKey + '="' + escapeAttribute(val) + '"';
        }
      }
    } else {
      // Look for individual attributes
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const attr = this.isAttribute(key);
        if (attr) {
          const val = node[key];
          if (val === true && this.options.suppressBooleanAttributes) {
            attrStr += ' ' + attr;
          } else {
            // stopNode content is raw, but the quote delimiter is always escaped
            // so a quote in the value cannot break out of the attribute (see orderedJs2Xml attr_to_str)
            attrStr += ' ' + attr + '="' + escapeAttribute(val) + '"';
          }
        }
      }
    }

    return attrStr;
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
    if (val === '') {
      if (key[0] === '?') return this.indentate(level) + '<' + key + attrStr + '?' + this.tagEndChar;
      else {
        return this.indentate(level) + '<' + key + attrStr + this.closeTag(key) + this.tagEndChar;
      }
    } else if (key[0] === '?') {
      // PI/XML-declaration tags never have body content — treat them like empty.
      return this.indentate(level) + '<' + key + attrStr + '?' + this.tagEndChar;
    } else {
      const tagEndExp = '</' + key + this.tagEndChar;
      const piClosingChar = '';

      // attrStr is an empty string in case the attribute came as undefined or null
      if ((attrStr || attrStr === '') && val.indexOf('<') === -1) {
        return this.indentate(level) + '<' + key + attrStr + piClosingChar + '>' + val + tagEndExp;
      } else if (this.options.commentPropName !== false && key === this.options.commentPropName && piClosingChar.length === 0) {
        return this.indentate(level) + `<!--${safeComment(val)}-->` + this.newLine;
      } else {
        return this.indentate(level) + '<' + key + attrStr + piClosingChar + this.tagEndChar + val + this.indentate(level) + tagEndExp;
      }
    }
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
    if (!this.stopNodeExpressions || this.stopNodeExpressions.length === 0) return false;

    for (let i = 0; i < this.stopNodeExpressions.length; i++) {
      const expression = this.stopNodeExpressions[i];
      if (expression !== undefined && (yield* liftXml(matcher.matches(expression)))) {
        return true;
      }
    }
    return false;
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
