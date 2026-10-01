/**
 * @description The decisions both of this package's walks make the same way. `xml-builder.ts` walks the plain-object form and `ordered.ts` walks the ordered array
 * form; the two emit different output — the plain form hoists a level's attributes ahead of the tag's `>`, the ordered form writes them in place —
 * but name validation, stop-node matching, attribute extraction and the raw re-emission of a stop node's subtree are the same decisions in both, and
 * were the same code written twice. They live here so the two walks cannot drift apart. Nothing in this module knows which form it is serving: every
 * function takes the values it needs as arguments, and none of them reads the shape of the input beyond deciding what its own arguments mean.
 */
import type { Expression, Matcher } from '@endevops/common-xml';
import type { XmlVersion } from '@endevops/common-xml';

import { Expression as CompiledExpression } from '@endevops/common-xml';
import { createValidator } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { BuilderError } from '#/errors.ts';

import { compilePattern, fromPatternError, tryResolveName } from '#/errors.ts';

import type { ResolvedXmlBuilderOptions } from './options.ts';

import { escapeAttribute } from './util.ts';

/**
 * @description A memoized QName validator. The walks test it before deciding a name needs repairing — so a name the validator rejects is the one that reaches
 * `sanitizeName`. Named separately so the signature reads at each use site without repeating the `MemoizedValidator` import.
 */
export type NameValidator = (name: string) => boolean;

/**
 * @description Build the memoized QName validator for an XML version. The validator itself is a plain predicate — validating a name is a regex test that cannot
 * fail — but `createValidator` answers with an `Effect`, because an unknown production is a failure it reports in its error channel. The production
 * here is the literal `'qName'`, so that failure is unreachable; it is mapped into this package's own error type rather than left to widen the
 * channel.
 *
 * @param xmlVersion - The version detected from the document.
 *
 * @returns An effect producing the validator. Fails with the `PatternCompilationFailed` reason only for an unknown production, which cannot happen
 *   here.
 */
export const nameValidatorFor = (xmlVersion: XmlVersion): Effect.Effect<NameValidator, BuilderError> =>
  Effect.mapError(createValidator('qName', { xmlVersion }), cause => fromPatternError('qName', cause));

/**
 * @description Resolve a tag or attribute name through `sanitizeName` if one is configured. QName validation runs first, so the resolver is only invoked for names
 * that actually need work — a document of valid names pays nothing for having the option configured. With no resolver configured the name is returned
 * untouched and no validation happens at all.
 *
 * @param name - The raw name from the input.
 * @param isAttribute - Whether an attribute name is being resolved.
 * @param options - The resolved options.
 * @param matcher - The current path, for the resolver's context.
 * @param qNameValidator - The memoized QName validator.
 *
 * @returns The name to write.
 */
export function resolveTagName(
  name: string,
  isAttribute: boolean,
  options: ResolvedXmlBuilderOptions,
  matcher: Matcher,
  qNameValidator: NameValidator
): Effect.Effect<string, BuilderError> {
  return Effect.gen(function* () {
    const resolve = options.sanitizeName;
    if (!resolve) return name;
    if (qNameValidator(name)) return name;
    // `readOnly` is a plain read, so the view is built before the callback runs.
    const view = matcher.readOnly();
    return yield* tryResolveName(name, () => resolve(name, { isAttribute, matcher: view }));
  });
}

/**
 * @description Compile a document's `stopNodes` into matchable patterns. Done once per build rather than per node, because compiling a pattern parses it and every
 * node at or below a stop node asks the question again.
 *
 * @param stopNodes - The configured patterns, as pattern strings and/or already-compiled expressions.
 *
 * @returns An effect producing the compiled patterns. Fails with the `PatternCompilationFailed` reason for a string that does not compile.
 */
export function compileStopNodes(stopNodes: Array<string | Expression>): Effect.Effect<Array<Expression>, BuilderError> {
  return Effect.gen(function* () {
    const compiled: Array<Expression> = [];
    if (Array.isArray(stopNodes)) {
      for (let i = 0; i < stopNodes.length; i++) {
        const node = stopNodes[i];
        if (typeof node === 'string') {
          compiled.push(yield* compilePattern(node));
        } else if (node instanceof CompiledExpression) {
          compiled.push(node);
        }
      }
    }
    return compiled;
  });
}

/**
 * @description Whether the matcher's current position matches any stop-node pattern.
 *
 * @param matcher - The live path.
 * @param stopNodeExpressions - The pre-compiled patterns.
 *
 * @returns Whether this node should be copied through verbatim.
 */
export function checkStopNode(matcher: Matcher, stopNodeExpressions: Array<Expression>): boolean {
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
 * stringifying here first would make `suppressBooleanAttributes` dead on this path. Callers that want text stringify with `valToStr` themselves.
 *
 * @param textValue - The value.
 * @param options - The resolved options.
 *
 * @returns The substituted string, or `textValue` unchanged.
 */
export function substituteEntities(textValue: unknown, options: ResolvedXmlBuilderOptions): unknown {
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

/**
 * @description Read a declared version, accepting only the two scalar forms a declaration can legitimately take. The original interpolated whatever it found, so
 * an object-valued `version` became `"[object Object]"` — which then failed the `1.1` comparison and silently fell back to 1.0. Rejecting the
 * non-scalars outright reaches the same outcome without manufacturing a junk string.
 *
 * @param value - The raw `version` value from the document.
 *
 * @returns The version as a string, or `undefined` if it is not a scalar.
 */
export function scalarVersion(value: unknown): string | undefined {
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
export function toXmlVersion(declared: string | undefined): XmlVersion {
  return declared === '1.1' ? '1.1' : '1.0';
}

/**
 * @description Strip the attribute prefix from a key that carries one, leaving a bare key alone. Both grouped layouts accept either spelling — a parser that emits
 * prefixed attribute names and one that emits bare ones can land in the same group — so the grouped forms cannot assume the prefix is there, whereas
 * the ordered form's `':@'` map can and does.
 *
 * @param key - The attribute key, as written in the input.
 * @param prefix - The configured `attributeNamePrefix`.
 *
 * @returns The bare attribute name.
 */
export function stripAttributePrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.substring(prefix.length) : key;
}

/**
 * @description Walk one attribute map into the plain, escaped shape the path matcher wants. Every layout of every form reduces to this loop once the key naming
 * the attribute is resolved: the plain form grouped under `attributesGroupName` or flat with the prefix, and the ordered form's `':@'`. So the loop
 * lives here once, and each layout supplies its own resolver.
 *
 * @param entries - The attribute map.
 * @param nameOf - Resolves a key to the attribute name to write it under, or `false` for a key that is not an attribute.
 *
 * @returns The attribute values, or `null` when the map contributes none — which is what keeps the matcher's per-node memory at zero for a bare tag.
 */
export function collectAttributeValues(entries: Record<string, unknown>, nameOf: (key: string) => string | false): Record<string, string> | null {
  const attrValues: Record<string, string> = {};
  let hasAttrs = false;

  for (const key in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
    const name = nameOf(key);
    if (name === false) continue;
    attrValues[name] = escapeAttribute(entries[key]);
    hasAttrs = true;
  }

  return hasAttrs ? attrValues : null;
}

/**
 * @description Render one ` name="value"` pair. The caller has already decided whether the value goes through the value processor and entity substitution — a stop
 * node's value is copied through, since escaping it again would double-escape every entity a parser already encoded — but the quote delimiter is
 * escaped either way, because that is structural rather than encoding: a quote in the value must not be able to close the attribute. (The ordered
 * form makes the same call from its `attr_to_str`.)
 *
 * @param name - The attribute name, without any prefix.
 * @param value - The value, already through whatever processing the caller applies.
 * @param options - The resolved options.
 *
 * @returns ` name="value"`, or ` name` for a suppressed boolean.
 */
export function attributePair(name: string, value: unknown, options: ResolvedXmlBuilderOptions): string {
  if (value === true && options.suppressBooleanAttributes) {
    return ' ' + name;
  } else {
    return ' ' + name + '="' + escapeAttribute(value) + '"';
  }
}

/**
 * @description Render a stop node's attributes, skipping the value processor and entity substitution — see {@link attributePair} for why the value is left alone
 * and the quote is not. Shared with the ordered form, which reads the same attributes out of its `':@'` map.
 *
 * @param entries - The attribute map.
 * @param nameOf - Resolves a key to the attribute name to write it under, or `false` for a key that is not an attribute.
 * @param options - The resolved options.
 *
 * @returns The attribute string, or `''` when the map contributes none.
 */
export function renderStopNodeAttributes(
  entries: Record<string, unknown>,
  nameOf: (key: string) => string | false,
  options: ResolvedXmlBuilderOptions
): string {
  let attrStr = '';

  for (const key in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
    const name = nameOf(key);
    if (name === false) continue;
    attrStr += attributePair(name, entries[key], options);
  }

  return attrStr;
}

/**
 * @description Wrap a raw body in a tag, choosing the self-closing form when there is nothing to wrap. Shared by both stop-node walkers so a raw subtree is
 * assembled the same way whichever one emitted the body.
 *
 * @param tagName - The tag name, already resolved: a stop node's content is copied through, so its names are not re-sanitized.
 * @param attrStr - The attributes, already rendered.
 * @param body - The body.
 *
 * @returns The rendered element.
 */
export function renderRawTag(tagName: string, attrStr: string, body: string): string {
  if (body === '') return `<${tagName}${attrStr}/>`;
  return `<${tagName}${attrStr}>${body}</${tagName}>`;
}
