/**
 * @description The single place a raw JavaScript value becomes XML text. `String(-0)` is `'0'`, so a naive conversion silently corrupts a round-tripped negative
 * zero — and XML has no separate integer or float syntax to recover the distinction from. Every value that reaches the output goes through here,
 * which is what makes one guard enough.
 *
 * @param val - The value to stringify.
 *
 * @returns The string form, with `-0` preserved as `'-0'`.
 */
export const valToStr = (val: unknown): string => (typeof val === 'number' && Object.is(val, -0) ? '-0' : String(val));

/**
 * @description Make a value safe to place inside an XML comment. `--` is illegal anywhere in comment content, and a trailing `-` would form one with the closing
 * `-->`, so both are neutralised.
 *
 * @param val - The raw comment content.
 *
 * @returns The content, safe to embed.
 */
export const safeComment = (val: unknown): string =>
  valToStr(val)
    .replace(/--/g, '- -') // -- is illegal anywhere in comment content
    .replace(/--/g, '- -') // handle the scenario when 2 consiucative dashes appears
    .replace(/-$/, '- '); // trailing - would form -- with the closing -->

/**
 * @description Make a value safe to place inside a CDATA section.
 *
 * @param val - The raw CDATA content.
 *
 * @returns The content, with any `]]>` split across two sections.
 */
export const safeCdata = (val: unknown): string => valToStr(val).replace(/\]\]>/g, ']]]]><![CDATA[>');

/**
 * @description Escape the quote characters in an attribute value. Only the delimiter is escaped, never the ampersand: entity substitution for the value itself has
 * already happened by the time this runs, and escaping `&` here would double-escape it. A quote in the value must not be able to terminate the
 * attribute and inject a new one.
 *
 * @param val - The raw attribute value.
 *
 * @returns The value, safe to place between double quotes.
 */
export const escapeAttribute = (val: unknown): string => valToStr(val).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
