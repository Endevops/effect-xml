/**
 * @description The ordered form of the walk: an array of single-key objects, walked in document order with no key sorting and no lookahead. Kept beside the
 * plain-object walk in `xml-builder.ts` rather than folded into it, because the two emit genuinely different output — this one writes a node's
 * attributes in place, the other hoists a level's attributes ahead of the tag's `>` — and because the ordered form is a parser's own output shape,
 * which a caller reproducing it by hand has no reason to learn. The decisions the two share live in `walk.ts`.
 */
import type { Expression, Matcher } from '@endevops/common-xml';
import type { XmlVersion } from '@endevops/common-xml';

import { Matcher as PathMatcher } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { BuilderError } from '#/errors.ts';

import { nestingExceeded, runValueProcessor } from '#/errors.ts';

import type { ResolvedXmlBuilderOptions } from './options.ts';
import type { NameValidator } from './walk.ts';

import { safeCdata, safeComment, valToStr } from './util.ts';
import {
  attributePair,
  checkStopNode,
  collectAttributeValues,
  compileStopNodes,
  nameValidatorFor,
  renderRawTag,
  renderStopNodeAttributes,
  resolveTagName,
  stripAttributePrefix,
  substituteEntities,
} from './walk.ts';

const EOL = '\n';

/**
 * @description One node of the ordered form: an array of single-key objects, so that document order survives a round trip through a JavaScript object. The special
 * keys are the ordered form's own conventions, matching what the parser's `preserveOrder` output uses: `':@'` for attributes, and the configured
 * `textNodeName`, `cdataPropName` and `commentPropName` for the three content kinds.
 */
export type OrderedTag = Record<string, unknown>;

// The QName validator and the factory that builds it now live in `walk.ts`, which both walks import
// directly. Re-exported here so this module keeps exporting the names it did — `xml-builder.ts` reads
// them from here, and `walk.ts` holds the implementation rather than this module's surface.
export type { NameValidator };
export { nameValidatorFor };

/**
 * @description What one level of the walk carries down to each node. The options are threaded through unchanged, so what is worth naming is the live path, the
 * pre-compiled patterns, and the validator — three arguments that never vary within a build, bundled so a per-node renderer takes one argument for
 * all of them.
 */
interface OrderedWalkContext {
  /**
   * @description The resolved options.
   */
  options: ResolvedXmlBuilderOptions;
  /**
   * @description Line separator, or `''` when not formatting.
   */
  indentation: string;
  /**
   * @description The live path.
   */
  matcher: Matcher;
  /**
   * @description The pre-compiled stop-node patterns.
   */
  stopNodeExpressions: Array<Expression>;
  /**
   * @description The memoized QName validator.
   */
  qNameValidator: NameValidator;
}

/**
 * @description One node's contribution to a level of the ordered form: what it appends, and what the caller's "was the previous node an element" flag becomes.
 * Carried as a pair rather than written straight into the level's string because each form decides differently whether a line break belongs before it
 * — and because the flag, not the string, is what the next node reads.
 */
interface OrderedNodeOutput {
  /**
   * @description What this node appends to the level's output.
   */
  xmlStr: string;
  /**
   * @description The value the caller's flag takes after this node.
   */
  isPreviousElementTag: boolean;
}

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
 * @description Build an XML string from the ordered array form. Every node arrives already in document order, so this walk is a single pass with no key sorting
 * and no lookahead — the reason `preserveOrder` exists.
 *
 * @param jArray - The ordered input.
 * @param options - The resolved options.
 *
 * @returns An effect producing the XML. Fails with {@link BuilderError} and the `PatternCompilationFailed` reason if a `stopNodes` pattern does not
 *   compile, the `MaxNestingExceeded` reason past `maxNestedTags`, or the `NameResolutionFailed` reason when a configured `sanitizeName` throws.
 */
export default function toXml(jArray: unknown, options: ResolvedXmlBuilderOptions): Effect.Effect<string, BuilderError> {
  return Effect.gen(function* () {
    let indentation = '';
    if (options.format) {
      indentation = EOL;
    }

    // Pre-compile stopNode expressions for pattern matching
    const stopNodeExpressions = yield* compileStopNodes(options.stopNodes);

    // Detect XML version for use in name validation
    const xmlVersion = detectXmlVersionFromArray(jArray, options);
    const qNameValidator = yield* nameValidatorFor(xmlVersion);
    // Initialize matcher for path tracking
    const matcher = new PathMatcher();

    return yield* arrToStr(jArray, options, indentation, matcher, stopNodeExpressions, qNameValidator);
  });
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
 * @returns An effect producing the rendered XML for this level. Fails with {@link BuilderError} and the `MaxNestingExceeded` reason past
 *   `maxNestedTags`, or the `NameResolutionFailed` reason when a configured `sanitizeName` throws.
 */
function arrToStr(
  arr: unknown,
  options: ResolvedXmlBuilderOptions,
  indentation: string,
  matcher: Matcher,
  stopNodeExpressions: Array<Expression>,
  qNameValidator: NameValidator
): Effect.Effect<string, BuilderError> {
  return Effect.gen(function* () {
    if (options.maxNestedTags && matcher.getDepth() > options.maxNestedTags) {
      return yield* nestingExceeded(options.maxNestedTags, matcher.getDepth());
    }

    if (!Array.isArray(arr)) {
      // Non-array values (e.g. string tag values) should be treated as text content
      return renderOrderedTextValue(arr, options);
    }

    const ctx: OrderedWalkContext = { options, indentation, matcher, stopNodeExpressions, qNameValidator };

    let xmlStr = '';
    let isPreviousElementTag = false;

    for (let i = 0; i < arr.length; i++) {
      const tagObj = arr[i];
      if (!tagObj || typeof tagObj !== 'object') continue;
      const rawTagName = propName(tagObj as OrderedTag);
      if (rawTagName === undefined) continue;

      // Annotated because the walk is mutually recursive: this level calls `renderOrderedNode`, which
      // calls back into `arrToStr` for an element's body, and inference cannot close that loop.
      const emitted: OrderedNodeOutput | null = yield* renderOrderedNode(tagObj as OrderedTag, rawTagName, isPreviousElementTag, ctx);
      // A node the renderer skipped contributes nothing and leaves the flag as it found it.
      if (emitted === null) continue;

      xmlStr += emitted.xmlStr;
      isPreviousElementTag = emitted.isPreviousElementTag;
    }

    return xmlStr;
  });
}

/**
 * @description A non-array level of the ordered form. A bare string child arrives this way rather than as a list, and is text content in its own right: its
 * entities still need substituting, which is what distinguishes it from a stop node's copy-through.
 *
 * @param value - The non-array level.
 * @param options - The resolved options.
 *
 * @returns The text content, or `''` for `undefined` and `null`.
 */
function renderOrderedTextValue(value: unknown, options: ResolvedXmlBuilderOptions): string {
  if (value !== undefined && value !== null) {
    return valToStr(substituteEntities(valToStr(value), options));
  }
  return '';
}

/**
 * @description Render one node of the ordered form: resolve its name, put it on the path, and dispatch on what kind of node it is. Every branch leaves the path
 * balanced — pushed once above, popped once on the way out — so a sibling never inherits the previous sibling's position.
 *
 * @param tagObj - The node.
 * @param rawTagName - The node's tag name as written, before resolution.
 * @param isPreviousElementTag - Whether the node before this one was an element, which decides whether a line break precedes a text or CDATA node.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing what the node appends and what the flag becomes next, or `null` for a node with nothing to write.
 */
const renderOrderedNode = Effect.fnUntraced(function* (
  tagObj: OrderedTag,
  rawTagName: string,
  isPreviousElementTag: boolean,
  ctx: OrderedWalkContext
): Effect.fn.Return<OrderedNodeOutput | null, BuilderError> {
  const { options, matcher } = ctx;

  // Resolve tag name (may transform it; may throw for invalid names)
  const tagName = yield* resolveOrderedName(rawTagName, ctx);

  // Extract attributes from ":@" property
  const attrValues = extractAttributeValues(tagObj[':@'], options);

  // Push resolved tag to matcher WITH attributes
  matcher.push(tagName, attrValues);

  // Check if this is a stop node using Expression matching
  const isStopNode = checkStopNode(matcher, ctx.stopNodeExpressions);

  // Text, CDATA, comment and processing-instruction nodes stand outside the element form: they write into
  // the flow of the output and leave no element for a body to be wrapped in.
  const standalone = yield* renderOrderedStandalone(tagObj, rawTagName, tagName, isStopNode, isPreviousElementTag, ctx);
  if (standalone !== null) {
    matcher.pop();
    return standalone;
  }

  const xmlStr = yield* renderOrderedElement(tagObj, rawTagName, tagName, isStopNode, ctx);
  matcher.pop();
  return { xmlStr, isPreviousElementTag: true };
});

/**
 * @description A node's tag name, resolved through `sanitizeName` unless the name is one of the ordered form's own conventions. Special names are exempt: internal
 * conventions and PI tags are not user-supplied XML element names, and a resolver cannot repair a name it was never meant to see.
 *
 * @param rawTagName - The node's tag name as written.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing the name to write. Fails with the `NameResolutionFailed` reason when a configured `sanitizeName` throws.
 */
const resolveOrderedName = Effect.fnUntraced(function* (rawTagName: string, ctx: OrderedWalkContext): Effect.fn.Return<string, BuilderError> {
  const { options, matcher } = ctx;
  const isSpecialName =
    rawTagName === options.textNodeName || rawTagName === options.cdataPropName || rawTagName === options.commentPropName || rawTagName[0] === '?';

  return isSpecialName ? rawTagName : yield* resolveTagName(rawTagName, false, options, matcher, ctx.qNameValidator);
});

/**
 * @description Render the four node kinds that stand outside the element form. Text and CDATA are the two that sit inline, sharing the rule that a line break
 * precedes them only when the previous node was an element; a comment and a processing instruction each always start their own line. A comment and a
 * processing instruction each leave the flag set, because both are block-shaped to whatever follows.
 *
 * @param tagObj - The node.
 * @param rawTagName - The node's tag name as written, which is the key its content lives under.
 * @param tagName - The node's resolved tag name, which selects the form.
 * @param isStopNode - Whether the node is copied through verbatim.
 * @param isPreviousElementTag - Whether the node before this one was an element.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing what the node appends and what the flag becomes next, or `null` when the node is an element after all. Fails with the
 *   `ValueProcessingFailed` or `NameResolutionFailed` reason, propagated from whichever branch it takes.
 */
const renderOrderedStandalone = Effect.fnUntraced(function* (
  tagObj: OrderedTag,
  rawTagName: string,
  tagName: string,
  isStopNode: boolean,
  isPreviousElementTag: boolean,
  ctx: OrderedWalkContext
): Effect.fn.Return<OrderedNodeOutput | null, BuilderError> {
  const { options, indentation, matcher } = ctx;

  if (tagName === options.textNodeName) {
    const text = yield* renderOrderedText(tagObj[rawTagName], tagName, isStopNode, options);
    return { xmlStr: lineBreakBefore(isPreviousElementTag, indentation) + text, isPreviousElementTag: false };
  }

  if (tagName === options.cdataPropName) {
    const val = firstTextChild(tagObj, rawTagName, options);
    return { xmlStr: lineBreakBefore(isPreviousElementTag, indentation) + `<![CDATA[${safeCdata(val)}]]>`, isPreviousElementTag: false };
  }

  if (tagName === options.commentPropName) {
    const val = firstTextChild(tagObj, rawTagName, options);
    return { xmlStr: indentation + `<!--${safeComment(val)}-->`, isPreviousElementTag: true };
  }

  if (tagName[0] === '?') {
    const attStr = yield* attrToStr(tagObj[':@'], options, isStopNode, matcher, ctx.qNameValidator);
    const tempInd = tagName === '?xml' ? '' : indentation;
    // Text node content on PI/XML declaration tags is intentionally ignored.
    // Only attributes are valid on these tags per the XML spec.
    return { xmlStr: tempInd + `<${tagName}${attStr}?>`, isPreviousElementTag: true };
  }

  return null;
});

/**
 * @description The line break that precedes a node rendered in the flow of the output, or nothing when the previous node was not an element. Text and CDATA share
 * the rule; an element and a comment always have something before them.
 *
 * @param isPreviousElementTag - Whether the previous node was an element.
 * @param indentation - Line separator, or `''` when not formatting.
 *
 * @returns The indentation to prepend, or `''`.
 */
function lineBreakBefore(isPreviousElementTag: boolean, indentation: string): string {
  return isPreviousElementTag ? indentation : '';
}

/**
 * @description A text node of the ordered form, through the configured `tagValueProcessor` and entity substitution unless the node is a stop node copied through
 * verbatim. Nothing encloses it, so the value goes into the stream as it stands.
 *
 * @param value - The node's text.
 * @param tagName - The node's resolved tag name, which is what the processor is handed.
 * @param isStopNode - Whether the node is copied through verbatim.
 * @param options - The resolved options.
 *
 * @returns An effect producing the text. Fails with the `ValueProcessingFailed` reason if the configured `tagValueProcessor` does.
 */
const renderOrderedText = Effect.fnUntraced(function* (
  value: unknown,
  tagName: string,
  isStopNode: boolean,
  options: ResolvedXmlBuilderOptions
): Effect.fn.Return<string, BuilderError> {
  let tagText = value;
  if (!isStopNode) {
    const processed = yield* runValueProcessor('tagValueProcessor', tagName, () => options.tagValueProcessor!(tagName, tagText));
    tagText = substituteEntities(processed, options);
  }
  return valToStr(tagText);
});

/**
 * @description An element node of the ordered form: its opening half, its body, and its closing half.
 *
 * @param tagObj - The node.
 * @param rawTagName - The node's tag name as written, which is the key its children live under.
 * @param tagName - The resolved tag name.
 * @param isStopNode - Whether the whole node is copied through verbatim.
 * @param ctx - The level's walk context.
 *
 * @returns An effect producing the rendered element. Fails with the `MaxNestingExceeded` or `NameResolutionFailed` reason, propagated from the
 *   recursion into the body.
 */
const renderOrderedElement = Effect.fnUntraced(function* (
  tagObj: OrderedTag,
  rawTagName: string,
  tagName: string,
  isStopNode: boolean,
  ctx: OrderedWalkContext
): Effect.fn.Return<string, BuilderError> {
  const { options, indentation, matcher } = ctx;

  let newIdentation = indentation;
  if (newIdentation !== '') {
    newIdentation += options.indentBy;
  }

  // Pass isStopNode to attr_to_str so attributes are also not processed for stopNodes
  const attStr = yield* attrToStr(tagObj[':@'], options, isStopNode, matcher, ctx.qNameValidator);
  const tagStart = indentation + '<' + tagName + attStr;

  // If this is a stopNode, get raw content without processing
  let tagValue: string;
  if (isStopNode) {
    tagValue = getRawContent(tagObj[rawTagName], options);
  } else {
    tagValue = yield* arrToStr(tagObj[rawTagName], options, newIdentation, matcher, ctx.stopNodeExpressions, ctx.qNameValidator);
  }

  return closeOrderedElement(tagStart, tagName, tagValue, options, indentation);
});

/**
 * @description The closing half of an element: unpaired, empty, or wrapping a body. Three outcomes rather than one because the body decides two of them, and the
 * body is not known until the level under it has been walked.
 *
 * @param tagStart - Everything up to and including the tag name and its attributes.
 * @param tagName - The resolved tag name.
 * @param tagValue - The rendered body.
 * @param options - The resolved options.
 * @param indentation - Line separator, or `''` when not formatting.
 *
 * @returns The closing half, appended to `tagStart`.
 */
function closeOrderedElement(tagStart: string, tagName: string, tagValue: string, options: ResolvedXmlBuilderOptions, indentation: string): string {
  if (options.unpairedTags.indexOf(tagName) !== -1) {
    if (options.suppressUnpairedNode) return tagStart + '>';
    else return tagStart + '/>';
  }
  if ((!tagValue || tagValue.length === 0) && options.suppressEmptyNode) return tagStart + '/>';
  // A body that already ends in a closing bracket is a subtree, not text: it stays where it was written.
  if (tagValue && tagValue.endsWith('>')) return tagStart + `>${tagValue}${indentation}</${tagName}>`;
  return tagStart + '>' + indentOrderedBody(tagValue, options, indentation) + `</${tagName}>`;
}

/**
 * @description Where a nested body sits on its own element's line. A body that itself contains markup is indented onto its own line rather than inlined after the
 * tag, because inlining it would produce output no parser reads back the same way.
 *
 * @param tagValue - The rendered body.
 * @param options - The resolved options.
 * @param indentation - Line separator, or `''` when not formatting.
 *
 * @returns The body, indented if it contains markup and formatting is on.
 */
function indentOrderedBody(tagValue: string, options: ResolvedXmlBuilderOptions, indentation: string): string {
  if (tagValue && indentation !== '' && (tagValue.includes('/>') || tagValue.includes('</'))) {
    return indentation + options.indentBy + tagValue + indentation;
  }
  return tagValue;
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
 * @description Extract the `:@` attributes of an ordered node into the plain, escaped shape the path matcher wants. The `':@'` map is by definition all prefixed
 * keys, so its resolver can strip the prefix unconditionally.
 *
 * @param attrMap - The `:@` object, or absent.
 * @param options - The resolved options.
 *
 * @returns The attribute values, or `null` when there are none or attributes are ignored.
 */
function extractAttributeValues(attrMap: unknown, options: ResolvedXmlBuilderOptions): Record<string, string> | null {
  if (!attrMap || typeof attrMap !== 'object' || options.ignoreAttributes) return null;

  return collectAttributeValues(attrMap as Record<string, unknown>, key => stripAttributePrefix(key, options.attributeNamePrefix));
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
    return renderRawTextValue(arr);
  }

  let content = '';
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    const itemNode = item as OrderedTag;
    const tagName = propName(itemNode);
    if (tagName === undefined) continue;

    content += renderRawOrderedChild(itemNode, tagName, options);
  }

  return content;
}

/**
 * @description A non-array stop node's body: whatever is there, as it stands. Nothing is escaped, so this is the `undefined`/`null` guard the array walk opens
 * with, and nothing more.
 *
 * @param value - The non-array body.
 *
 * @returns The raw text, or `''` for `undefined` and `null`.
 */
function renderRawTextValue(value: unknown): string {
  // Non-array values return as-is
  if (value !== undefined && value !== null) {
    return valToStr(value);
  }
  return '';
}

/**
 * @description One child of a stop node, verbatim. The content kinds are read at the depth the parser wrote them, and a processing instruction is dropped rather
 * than re-emitted: the subtree is already XML, and a `?`-tag inside it would be a second declaration of something the outer stop node declared.
 *
 * @param itemNode - The child node.
 * @param tagName - The child's tag name.
 * @param options - The resolved options.
 *
 * @returns The raw content this child contributes, or `''` when it contributes none.
 */
function renderRawOrderedChild(itemNode: OrderedTag, tagName: string, options: ResolvedXmlBuilderOptions): string {
  if (tagName === options.textNodeName) {
    // Raw text content - NO processing, NO entity replacement
    return valToStr(itemNode[tagName]);
  }

  if (tagName === options.cdataPropName || tagName === options.commentPropName) {
    // CDATA and comment content, which the parser nests one level deeper than text
    return valToStr(firstTextChild(itemNode, tagName, options));
  }

  // Processing instruction - skip for stopNodes
  if (tagName[0] === '?') return '';

  // Nested tags within stopNode — no sanitizeName, content is raw
  return renderRawTag(tagName, attrToStrRaw(itemNode[':@'], options), getRawContent(itemNode[tagName], options));
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
  if (!attrMap || typeof attrMap !== 'object' || options.ignoreAttributes) return '';

  return renderStopNodeAttributes(attrMap as Record<string, unknown>, key => stripAttributePrefix(key, options.attributeNamePrefix), options);
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
const attrToStr = Effect.fnUntraced(function* (
  attrMap: unknown,
  options: ResolvedXmlBuilderOptions,
  isStopNode: boolean,
  matcher: Matcher,
  qNameValidator: NameValidator
): Effect.fn.Return<string, BuilderError> {
  if (!attrMap || typeof attrMap !== 'object' || options.ignoreAttributes) return '';

  const entries = attrMap as Record<string, unknown>;
  let attrStr = '';

  for (const attr in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, attr)) continue;

    // Strip prefix to get the clean XML attribute name, then optionally sanitize it
    const cleanAttrName = attr.substring(options.attributeNamePrefix.length);
    // stopNodes are raw — skip sanitizeName for attr names too
    const resolvedAttrName = isStopNode ? cleanAttrName : yield* resolveTagName(cleanAttrName, true, options, matcher, qNameValidator);

    const rawValue = entries[attr];
    // For stopNodes, use raw value without any processing; otherwise apply
    // attributeValueProcessor and entity replacement
    const attrVal = isStopNode
      ? rawValue
      : substituteEntities(
          yield* runValueProcessor('attributeValueProcessor', attr, () => options.attributeValueProcessor!(attr, rawValue)),
          options
        );

    attrStr += attributePair(resolvedAttrName, attrVal, options);
  }

  return attrStr;
});
