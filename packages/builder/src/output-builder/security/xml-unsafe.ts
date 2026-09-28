/**
 * @description One rule: what it looks for, and why it matters.
 */
export interface XmlUnsafeRule {
  /**
   * @description Stable identifier for the rule, safe to log or key a decision on.
   */
  readonly id: string;
  /**
   * @description What the rule catches, in words. Meant for a log line or an error, not for display to an end user.
   */
  readonly description: string;
  /**
   * @description What the rule matches on. No `g` flag, so `.test` carries no `lastIndex` state between calls.
   */
  readonly pattern: RegExp;
}

/**
 * @description Why a value was rejected, naming the rule that caught it.
 */
export interface XmlUnsafeMatch {
  /**
   * @description The rule that matched.
   */
  readonly rule: XmlUnsafeRule;
  /**
   * @description The text that matched, so a log can point at the offending span rather than the whole entity body.
   */
  readonly matchedText: string;
}

/**
 * @description Patterns that mark a string as unsafe to place inside an XML document. A port of the `XML` context from
 * [`is-unsafe`](https://www.npmjs.com/package/is-unsafe) v1.0.1, MIT licensed, copyright (c) 2026 Natural Intelligence. The full licence text is in
 * `LICENSE-is-unsafe` at the package root. All twelve rules are reproduced verbatim, ids and regexes unchanged, so a decision this module makes is
 * the same one the dependency made.
 *
 * ## Why only this context
 *
 * `is-unsafe` ships nine contexts. Only `XML` is reachable from this package: the entity value parser tests each DOCTYPE-declared entity before
 * expanding it, and an entity body is XML. The other eight — HTML, SVG, SQL, SQL-STRICT, SHELL, REDOS, NOSQL, LOG — are patterns for strings heading
 * somewhere else, and no caller in this repository can reach them. Carrying them would be nine untested code paths in a security control, which is
 * worse than not having them.
 *
 * ## The distinction this context draws
 *
 * These rules target parser-level attacks, not rendering: confusing or subverting an XML parser, triggering external entity resolution, or injecting
 * DTD content. HTML rendering concerns belong to a different context and are not covered here.
 */
const XML_PATTERNS: readonly XmlUnsafeRule[] = [
  { id: 'xml-cdata-injection', description: 'CDATA section injection: <![CDATA[ breaks out of text node context', pattern: /<!\[CDATA\[/i },
  { id: 'xml-cdata-close', description: 'CDATA close sequence: ]]> can terminate an enclosing CDATA section', pattern: /\]\]>/ },
  { id: 'xml-processing-instruction', description: 'XML processing instruction: <?xml-stylesheet or <?php etc.', pattern: /<\?(?:xml[- ]|php|asp)/i },
  {
    id: 'xml-doctype-injection',
    description: 'DOCTYPE declaration embedded in content — can define entities',
    // Match <!DOCTYPE followed by end-of-string, whitespace, or [ (internal subset)
    pattern: /<!DOCTYPE(?:[\s[]|$)/i,
  },
  { id: 'xml-entity-system', description: 'SYSTEM keyword — used in external entity declarations (XXE)', pattern: /\bSYSTEM\s+["']/i },
  { id: 'xml-entity-public', description: 'PUBLIC keyword — used in external entity declarations (XXE)', pattern: /\bPUBLIC\s+["']/i },
  {
    id: 'xml-entity-declaration',
    description: '<!ENTITY declaration — defines entities, potential XXE or entity expansion',
    pattern: /<!ENTITY[\s%]/i,
  },
  {
    id: 'xml-billion-laughs',
    description: 'Entity reference chaining / billion laughs: repeated &eX; style references',
    // Heuristic: 3+ consecutive entity refs suggests expansion attack
    pattern: /(?:&\w{1,20};){3,}/,
  },
  {
    id: 'xml-namespace-confusion',
    description: 'xmlns: attribute injection — can redefine namespaces to confuse parsers',
    pattern: /\bxmlns\s*(?::\w{1,40})?\s*=/i,
  },
  { id: 'xml-comment-injection', description: '<!-- comment injection — can hide content from some parsers', pattern: /<!--/ },
  { id: 'xml-comment-close', description: '--> closes an enclosing XML comment', pattern: /-->/ },
  { id: 'xml-pi-close', description: '?> closes an enclosing processing instruction', pattern: /\?>/ },
];

/**
 * @description The context this module tests against. A single named context rather than a registry, because there is only one.
 */
export const VALID_CONTEXTS = Object.freeze({ XML: 'XML' } as const);

/**
 * @description The name of the one context.
 */
export type ContextName = (typeof VALID_CONTEXTS)[keyof typeof VALID_CONTEXTS];

/**
 * @description The rules, in the order they are tested. First match wins, so the order is part of the contract: `allUnsafe` reports every hit, but
 * {@link isUnsafeXml} and {@link whyUnsafeXml} report the first.
 */
export const XML_UNSAFE_RULES: readonly XmlUnsafeRule[] = XML_PATTERNS;

/**
 * @description Reject a value that is not a string, rather than coercing it. A silent `String(value)` would be the wrong trade here. An entity value that reached
 * this check as `0`, `null` or an object would be coerced to something the rules were never written to judge, and `String(null)` is `'null'` — which
 * no rule flags, so the value would be allowed through unchecked. Throwing makes the mistake visible at the call site instead.
 *
 * @param value - The value to check.
 *
 * @throws {TypeError} If `value` is not a string.
 */
function assertString(value: string): void {
  if (typeof value !== 'string') {
    throw new TypeError(`isUnsafeXml: first argument must be a string, got ${typeof value}`);
  }
}

/**
 * @description Test one value against the XML rules.
 *
 * @param value - The value to test.
 *
 * @returns The first rule that matched and the text it matched on, or `null` when nothing matched.
 *
 * @throws {TypeError} If `value` is not a string.
 */
function matchContext(value: string): XmlUnsafeMatch | null {
  for (const rule of XML_PATTERNS) {
    const matched = rule.pattern.exec(value);
    if (matched) {
      return { rule, matchedText: matched[0] };
    }
  }
  return null;
}

/**
 * @description Whether a value is unsafe to place inside an XML document.
 *
 * @example
 *   ```typescript
 *   isUnsafeXml('<!DOCTYPE foo SYSTEM "file:///etc/passwd">'); // true
 *   isUnsafeXml('© 2026'); // false
 *   ```;
 *
 * @param value - The value to test.
 *
 * @returns `true` when any XML rule matches.
 *
 * @throws {TypeError} If `value` is not a string.
 */
export function isUnsafeXml(value: string): boolean {
  assertString(value);
  return matchContext(value) !== null;
}

/**
 * @description Like {@link isUnsafeXml}, but reports which rule matched rather than only that one did. Worth having on a security control: a boolean says an entity
 * was refused but not why, and a rule id is the difference between a five-minute diagnosis and an afternoon.
 *
 * @param value - The value to test.
 *
 * @returns The first match, or `null` when the value is safe.
 *
 * @throws {TypeError} If `value` is not a string.
 */
export function whyUnsafeXml(value: string): XmlUnsafeMatch | null {
  assertString(value);
  return matchContext(value);
}

/**
 * @description Every XML rule that matches, not just the first.
 *
 * @param value - The value to test.
 *
 * @returns All matches, in rule order. Empty when the value is safe.
 *
 * @throws {TypeError} If `value` is not a string.
 */
export function allUnsafeXml(value: string): XmlUnsafeMatch[] {
  assertString(value);
  const results: XmlUnsafeMatch[] = [];
  for (const rule of XML_PATTERNS) {
    const matched = rule.pattern.exec(value);
    if (matched) {
      results.push({ rule, matchedText: matched[0] });
    }
  }
  return results;
}
