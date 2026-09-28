import type { Expression, Matcher } from '@endevops/common-xml';
import type { XmlVersion } from '@endevops/common-xml';

import { Expression as CompiledExpression } from '@endevops/common-xml';
import { Matcher as PathMatcher } from '@endevops/common-xml';
import { createValidator } from '@endevops/common-xml';

import type { ResolvedXmlBuilderOptions } from './options.ts';

import { escapeAttribute, safeCdata, safeComment, valToStr } from './util.ts';

const EOL = '\n';

/**
 * @description One node of the ordered form: an array of single-key objects, so that document order survives a round trip through a JavaScript object. The special
 * keys are the ordered form's own conventions, matching what the parser's `preserveOrder` output uses: `':@'` for attributes, and the configured
 * `textNodeName`, `cdataPropName` and `commentPropName` for the three content kinds.
 */
export type OrderedTag = Record<string, unknown>;

/**
 * @description A memoized QName validator, or the equivalent plain function.
 */
type NameValidator = (name: string) => boolean;

/**
 * @description Detect the XML version from the first element of the ordered array input. Only the first element can carry a declaration, and only if it is a
 * `?xml` processing instruction with a version attribute.
 *
 * @param jArray - The ordered input.
 * @param options - The resolved options.
 *
 * @returns The declared version, or `'1.0'` if there is no declaration.
 */
function detectXmlVersionFromArray(jArray: unknown, options: ResolvedXmlBuilderOptions): XmlVersion {
  if (!Array.isArray(jArray) || jArray.length === 0) return '1.0';
  const first = jArray[0];
  if (!first || typeof first !== 'object') return '1.0';
  const firstKey = propName(first as OrderedTag);
  if (firstKey !== '?xml') return '1.0';

  const attrs = (first as OrderedTag)[':@'];
  if (!attrs || typeof attrs !== 'object') return '1.0';
  const version = (attrs as Record<string, unknown>)[options.attributeNamePrefix + 'version'];
  // Anything other than 1.1 validates against 1.0's stricter character classes.
  return version === '1.1' ? '1.1' : '1.0';
}

/**
 * @description Resolve a tag or attribute name through `sanitizeName` if one is configured. QName validation runs first, so the resolver is only invoked for names
 * that actually need work. With no resolver configured the name is returned untouched and no validation happens at all.
 *
 * @param name - The raw name from the input.
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
): string {
  const resolve = options.sanitizeName;
  if (!resolve) return name;
  if (qNameValidator(name)) return name;
  return resolve(name, { isAttribute, matcher: matcher.readOnly() });
}

/**
 * @description Build an XML string from the ordered array form. Every node arrives already in document order, so this walk is a single pass with no key sorting
 * and no lookahead — the reason `preserveOrder` exists.
 *
 * @param jArray - The ordered input.
 * @param options - The resolved options.
 *
 * @returns The XML.
 *
 * @throws {Error} `Maximum nested tags exceeded` past `maxNestedTags`, and whatever a `sanitizeName` resolver throws.
 */
export default function toXml(jArray: unknown, options: ResolvedXmlBuilderOptions): string {
  let indentation = '';
  if (options.format) {
    indentation = EOL;
  }

  // Pre-compile stopNode expressions for pattern matching
  const stopNodeExpressions: Expression[] = [];
  if (options.stopNodes && Array.isArray(options.stopNodes)) {
    for (let i = 0; i < options.stopNodes.length; i++) {
      const node = options.stopNodes[i];
      if (typeof node === 'string') {
        stopNodeExpressions.push(new CompiledExpression(node));
      } else if (node instanceof CompiledExpression) {
        stopNodeExpressions.push(node);
      }
    }
  }

  // Detect XML version for use in name validation
  const xmlVersion = detectXmlVersionFromArray(jArray, options);
  const qNameValidator: NameValidator = createValidator('qName', { xmlVersion });
  // Initialize matcher for path tracking
  const matcher = new PathMatcher();

  return arrToStr(jArray, options, indentation, matcher, stopNodeExpressions, qNameValidator);
}

/**
 * @description Render one level of the ordered form.
 *
 * @param arr - The level, as an array of single-key objects. A non-array is treated as a text value, which is how a bare string child arrives.
 * @param options - The resolved options.
 * @param indentation - Line separator, or `''` when not formatting.
 * @param matcher - The live path.
 * @param stopNodeExpressions - The pre-compiled stop-node patterns.
 * @param qNameValidator - The memoized QName validator.
 *
 * @returns The rendered XML for this level.
 *
 * @throws {Error} `Maximum nested tags exceeded` past `maxNestedTags`.
 */
function arrToStr(
  arr: unknown,
  options: ResolvedXmlBuilderOptions,
  indentation: string,
  matcher: Matcher,
  stopNodeExpressions: Expression[],
  qNameValidator: NameValidator
): string {
  let xmlStr = '';
  let isPreviousElementTag = false;

  if (options.maxNestedTags && matcher.getDepth() > options.maxNestedTags) {
    throw new Error('Maximum nested tags exceeded');
  }

  if (!Array.isArray(arr)) {
    // Non-array values (e.g. string tag values) should be treated as text content
    if (arr !== undefined && arr !== null) {
      return valToStr(replaceEntitiesValue(valToStr(arr), options));
    }
    return '';
  }

  for (let i = 0; i < arr.length; i++) {
    const tagObj = arr[i];
    if (!tagObj || typeof tagObj !== 'object') continue;
    const rawTagName = propName(tagObj as OrderedTag);
    if (rawTagName === undefined) continue;

    // Special names are exempt from sanitizeName: internal conventions and PI tags
    // are not user-supplied XML element names.
    const isSpecialName =
      rawTagName === options.textNodeName || rawTagName === options.cdataPropName || rawTagName === options.commentPropName || rawTagName[0] === '?';

    // Resolve tag name (may transform it; may throw for invalid names)
    const tagName = isSpecialName ? rawTagName : resolveTagName(rawTagName, false, options, matcher, qNameValidator);

    // Extract attributes from ":@" property
    const attrValues = extractAttributeValues((tagObj as OrderedTag)[':@'], options);

    // Push resolved tag to matcher WITH attributes
    matcher.push(tagName, attrValues);

    // Check if this is a stop node using Expression matching
    const isStopNode = checkStopNode(matcher, stopNodeExpressions);

    if (tagName === options.textNodeName) {
      let tagText = (tagObj as OrderedTag)[rawTagName];
      if (!isStopNode) {
        tagText = options.tagValueProcessor(tagName, tagText);
        tagText = replaceEntitiesValue(tagText, options);
      }
      tagText = valToStr(tagText);
      if (isPreviousElementTag) {
        xmlStr += indentation;
      }
      xmlStr += tagText;
      isPreviousElementTag = false;
      matcher.pop();
      continue;
    } else if (tagName === options.cdataPropName) {
      if (isPreviousElementTag) {
        xmlStr += indentation;
      }
      const val = firstTextChild(tagObj as OrderedTag, rawTagName, options);
      const safeVal = safeCdata(val);
      xmlStr += `<![CDATA[${safeVal}]]>`;
      isPreviousElementTag = false;
      matcher.pop();
      continue;
    } else if (tagName === options.commentPropName) {
      const val = firstTextChild(tagObj as OrderedTag, rawTagName, options);
      const safeVal = safeComment(val);
      xmlStr += indentation + `<!--${safeVal}-->`;
      isPreviousElementTag = true;
      matcher.pop();
      continue;
    } else if (tagName[0] === '?') {
      const attStr = attrToStr((tagObj as OrderedTag)[':@'], options, isStopNode, matcher, qNameValidator);
      const tempInd = tagName === '?xml' ? '' : indentation;
      // Text node content on PI/XML declaration tags is intentionally ignored.
      // Only attributes are valid on these tags per the XML spec.
      xmlStr += tempInd + `<${tagName}${attStr}?>`;
      isPreviousElementTag = true;
      matcher.pop();
      continue;
    }

    let newIdentation = indentation;
    if (newIdentation !== '') {
      newIdentation += options.indentBy;
    }

    // Pass isStopNode to attr_to_str so attributes are also not processed for stopNodes
    const attStr = attrToStr((tagObj as OrderedTag)[':@'], options, isStopNode, matcher, qNameValidator);
    const tagStart = indentation + '<' + tagName + attStr;

    // If this is a stopNode, get raw content without processing
    let tagValue: string;
    if (isStopNode) {
      tagValue = getRawContent((tagObj as OrderedTag)[rawTagName], options);
    } else {
      tagValue = arrToStr((tagObj as OrderedTag)[rawTagName], options, newIdentation, matcher, stopNodeExpressions, qNameValidator);
    }

    if (options.unpairedTags.indexOf(tagName) !== -1) {
      if (options.suppressUnpairedNode) xmlStr += tagStart + '>';
      else xmlStr += tagStart + '/>';
    } else if ((!tagValue || tagValue.length === 0) && options.suppressEmptyNode) {
      xmlStr += tagStart + '/>';
    } else if (tagValue && tagValue.endsWith('>')) {
      xmlStr += tagStart + `>${tagValue}${indentation}</${tagName}>`;
    } else {
      xmlStr += tagStart + '>';
      if (tagValue && indentation !== '' && (tagValue.includes('/>') || tagValue.includes('</'))) {
        xmlStr += indentation + options.indentBy + tagValue + indentation;
      } else {
        xmlStr += tagValue;
      }
      xmlStr += `</${tagName}>`;
    }
    isPreviousElementTag = true;

    // Pop tag from matcher
    matcher.pop();
  }

  return xmlStr;
}

/**
 * @description The text inside a CDATA or comment node of the ordered form. Unlike a text node — whose value the parser emits as a bare string — a CDATA or
 * comment node carries its content one level deeper, as `[{ '#text': '…' }]`, because the content is itself a child in document order. That is the
 * shape this indexes.
 *
 * @param tagObj - The node.
 * @param tagName - The node's tag name.
 * @param options - The resolved options.
 *
 * @returns The text content, or `undefined` for a node that is not in the expected shape.
 */
function firstTextChild(tagObj: OrderedTag, tagName: string, options: ResolvedXmlBuilderOptions): unknown {
  const child = tagObj[tagName];
  if (!Array.isArray(child)) return undefined;
  const first = child[0];
  if (first === null || typeof first !== 'object') return undefined;
  return (first as OrderedTag)[options.textNodeName];
}

/**
 * @description Extract the `:@` attributes of an ordered node into the plain, escaped shape the path matcher wants.
 *
 * @param attrMap - The `:@` object, or absent.
 * @param options - The resolved options.
 *
 * @returns The attribute values, or `null` when there are none or attributes are ignored.
 */
function extractAttributeValues(attrMap: unknown, options: ResolvedXmlBuilderOptions): Record<string, string> | null {
  if (!attrMap || typeof attrMap !== 'object' || options.ignoreAttributes) return null;

  const attrValues: Record<string, string> = {};
  let hasAttrs = false;

  for (const attr in attrMap as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(attrMap, attr)) continue;
    // Remove the attribute prefix to get clean attribute name
    const cleanAttrName = attr.startsWith(options.attributeNamePrefix) ? attr.substring(options.attributeNamePrefix.length) : attr;
    attrValues[cleanAttrName] = escapeAttribute((attrMap as Record<string, unknown>)[attr]);
    hasAttrs = true;
  }

  return hasAttrs ? attrValues : null;
}

/**
 * @description Extract a stop node's body verbatim, preserving it exactly as-is including special characters.
 *
 * @param arr - The node's children.
 * @param options - The resolved options.
 *
 * @returns The raw XML body.
 */
function getRawContent(arr: unknown, options: ResolvedXmlBuilderOptions): string {
  if (!Array.isArray(arr)) {
    // Non-array values return as-is
    if (arr !== undefined && arr !== null) {
      return valToStr(arr);
    }
    return '';
  }

  let content = '';
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    const itemNode = item as OrderedTag;
    const tagName = propName(itemNode);

    if (tagName === options.textNodeName) {
      // Raw text content - NO processing, NO entity replacement
      content += valToStr(itemNode[tagName]);
    } else if (tagName === options.cdataPropName) {
      // CDATA content
      content += valToStr(firstTextChild(itemNode, tagName, options));
    } else if (tagName === options.commentPropName) {
      // Comment content
      content += valToStr(firstTextChild(itemNode, tagName, options));
    } else if (tagName && tagName[0] === '?') {
      // Processing instruction - skip for stopNodes
      continue;
    } else if (tagName) {
      // Nested tags within stopNode — no sanitizeName, content is raw
      const attStr = attrToStrRaw((itemNode as OrderedTag)[':@'], options);
      const nestedContent = getRawContent(itemNode[tagName], options);

      if (!nestedContent || nestedContent.length === 0) {
        content += `<${tagName}${attStr}/>`;
      } else {
        content += `<${tagName}${attStr}>${nestedContent}</${tagName}>`;
      }
    }
  }
  return content;
}

/**
 * @description Render a stop node's attributes in the ordered form, with no entity substitution.
 *
 * @param attrMap - The `:@` object, or absent.
 * @param options - The resolved options.
 *
 * @returns The attribute string.
 */
function attrToStrRaw(attrMap: unknown, options: ResolvedXmlBuilderOptions): string {
  let attrStr = '';
  if (attrMap && typeof attrMap === 'object' && !options.ignoreAttributes) {
    for (const attr in attrMap as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(attrMap, attr)) continue;
      // For stopNodes, use raw value without processing
      const attrVal = (attrMap as Record<string, unknown>)[attr];
      if (attrVal === true && options.suppressBooleanAttributes) {
        attrStr += ` ${attr.substring(options.attributeNamePrefix.length)}`;
      } else {
        attrStr += ` ${attr.substring(options.attributeNamePrefix.length)}="${escapeAttribute(attrVal)}"`;
      }
    }
  }
  return attrStr;
}

/**
 * @description A node's tag name: its first key other than `':@'`.
 *
 * @param obj - The node.
 *
 * @returns The tag name, or `undefined` for a node carrying only attributes.
 */
function propName(obj: OrderedTag): string | undefined {
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (key !== ':@') return key;
  }
  return undefined;
}

/**
 * @description Render a node's attributes in the ordered form, resolving names through `sanitizeName` when configured.
 *
 * @param attrMap - The `:@` object, or absent.
 * @param options - The resolved options.
 * @param isStopNode - Whether the owning node is copied through verbatim, in which case names and values are left alone.
 * @param matcher - The live path, for the resolver's context.
 * @param qNameValidator - The memoized QName validator.
 *
 * @returns The attribute string.
 */
function attrToStr(
  attrMap: unknown,
  options: ResolvedXmlBuilderOptions,
  isStopNode: boolean,
  matcher: Matcher,
  qNameValidator: NameValidator
): string {
  let attrStr = '';
  if (attrMap && typeof attrMap === 'object' && !options.ignoreAttributes) {
    for (const attr in attrMap as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(attrMap, attr)) continue;

      // Strip prefix to get the clean XML attribute name, then optionally sanitize it
      const cleanAttrName = attr.substring(options.attributeNamePrefix.length);
      const resolvedAttrName = isStopNode
        ? cleanAttrName // stopNodes are raw — skip sanitizeName for attr names too
        : resolveTagName(cleanAttrName, true, options, matcher, qNameValidator);

      let attrVal: unknown;
      if (isStopNode) {
        // For stopNodes, use raw value without any processing
        attrVal = (attrMap as Record<string, unknown>)[attr];
      } else {
        // Normal processing: apply attributeValueProcessor and entity replacement
        attrVal = options.attributeValueProcessor(attr, (attrMap as Record<string, unknown>)[attr]);
        attrVal = replaceEntitiesValue(attrVal, options);
      }

      if (attrVal === true && options.suppressBooleanAttributes) {
        attrStr += ` ${resolvedAttrName}`;
      } else {
        attrStr += ` ${resolvedAttrName}="${escapeAttribute(attrVal)}"`;
      }
    }
  }
  return attrStr;
}

/**
 * @description Whether the matcher's current position matches any stop-node pattern.
 *
 * @param matcher - The live path.
 * @param stopNodeExpressions - The pre-compiled patterns.
 *
 * @returns Whether this node should be copied through verbatim.
 */
function checkStopNode(matcher: Matcher, stopNodeExpressions: Expression[]): boolean {
  if (!stopNodeExpressions || stopNodeExpressions.length === 0) return false;

  for (let i = 0; i < stopNodeExpressions.length; i++) {
    const expression = stopNodeExpressions[i];
    if (expression !== undefined && matcher.matches(expression)) {
      return true;
    }
  }
  return false;
}

/**
 * @description Apply the configured entity substitutions to a value, leaving a non-string untouched. Only strings are substituted, and the return type mirrors the
 * input: a boolean stays a boolean. That is load-bearing rather than incidental — the boolean-attribute check downstream is `value === true`, so
 * stringifying here first would make `suppressBooleanAttributes` dead on this path. Callers that want text stringify with {@link valToStr} themselves.
 *
 * @param textValue - The value.
 * @param options - The resolved options.
 *
 * @returns The substituted string, or `textValue` unchanged.
 */
function replaceEntitiesValue(textValue: unknown, options: ResolvedXmlBuilderOptions): unknown {
  if (typeof textValue === 'string' && textValue.length > 0 && options.processEntities) {
    let result = textValue;
    for (let i = 0; i < options.entities.length; i++) {
      const entity = options.entities[i];
      if (entity) result = result.replace(entity.regex, entity.val);
    }
    return result;
  }
  return textValue;
}
