// Parsing: XML text to an `XmlValue`.
//
// The parser is a hand-written scanner rather than a regular expression or a
// pre-split token array, because a document is mostly text: this walks the
// source string once, copying spans straight out of it, and allocates only for
// the values it keeps.
//
// It is deliberately lenient in the places where being strict would reject
// documents that are worth reading, and strict everywhere else:
//
//   - A bare `&` that is not a character reference is kept as text rather than
//     rejected, and is escaped on the way out. Refusing to read a document
//     because of one unescaped ampersand is not a useful default.
//   - Comments and processing instructions are skipped: they are markup, not
//     data, and `@endevops/builder` drops them by default too.
//   - CDATA becomes character data, since that is what it is.
//   - A mismatched or unclosed tag, a malformed attribute, or content after the
//     root element *is* an error, because silently accepting those produces a
//     document that means something different from the one that was written.

import type { XmlVersion } from '@endevops/common-xml';

import { EntityDecoder } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { NameMode } from './conventions.ts';
import type { XmlValue } from './xml-value.ts';

import { ATTRIBUTE_PREFIX, resolveName, TEXT_KEY } from './conventions.ts';
import { XmlParseError } from './errors.ts';

/**
 * @description Resolves character references. The default expansion limits are zero, which the decoder treats as unlimited, so one instance can be shared for the
 * process; the counters it keeps are only ever compared against a non-zero limit.
 */
const decoder = new EntityDecoder();

/**
 * @description A parsed document: the root element's name, and its content as an {@link XmlValue}.
 */
export interface XmlDocument {
  /**
   * @description The root element's name as it appeared in the source, after name resolution.
   */
  readonly name: string;

  /**
   * @description The root element's content. The root's own name is not part of it, the same way a schema's encoded form does not carry a name for the value it
   * describes.
   */
  readonly value: XmlValue;
}

/**
 * @description Options for {@link parseXml} and {@link parseXmlSync}.
 */
export interface XmlParseOptions {
  /**
   * @description Keep the whitespace at the edges of every text run. Defaults to `false`, which trims it — and trimming is what makes a pretty-printed document
   * read as the same value as an unindented one, because the indentation around a child element and around a closing tag lands at the edges of its
   * parent's text. Whitespace _inside_ a run is content and is never touched either way, so `'one two'` and a paragraph with a newline in the middle
   * of it survive. Set it to `true` to keep leading and trailing spaces in text exactly as written, at the cost of a document that was laid out on
   * several lines no longer reading the same as one that was not.
   */
  readonly preserveWhitespace?: boolean | undefined;

  /**
   * @description How deep to nest before giving up. Guards against a document crafted to exhaust the stack. Defaults to 256.
   */
  readonly maxDepth?: number | undefined;

  /**
   * @description What to do with an element or attribute name that is not a legal XML name. Defaults to `'repair'`, the same default {@link renderXml} uses, so a
   * name that renders and a name that parses come out the same.
   */
  readonly name?: NameMode | undefined;

  /**
   * @description XML version to validate names against. Defaults to `'1.0'`.
   */
  readonly xmlVersion?: XmlVersion | undefined;
}

/**
 * @description Parses an XML document into its root element's content.
 *
 * @param text - The document to read.
 * @param options - Whitespace, depth and name-handling settings.
 *
 * @returns The root element's content as an {@link XmlValue}.
 */
export const parseXml = (text: string, options: XmlParseOptions = {}): Effect.Effect<XmlValue, XmlParseError> =>
  Effect.sync(() => parseDocument(text, options).value);

/**
 * @description Parses an XML document, throwing instead of returning a failed `Effect`.
 *
 * @param text - The document to read.
 * @param options - Whitespace, depth and name-handling settings.
 *
 * @returns The root element's content as an {@link XmlValue}.
 *
 * @throws {XmlParseError} When the document is not well-formed.
 */
export const parseXmlSync = (text: string, options: XmlParseOptions = {}): XmlValue => parseDocument(text, options).value;

/**
 * @description Parses an XML document, keeping the root element's name.
 *
 * @param text - The document to read.
 * @param options - Whitespace, depth and name-handling settings.
 *
 * @returns The root element's name and content.
 *
 * @throws {XmlParseError} When the document is not well-formed.
 */
export const parseXmlDocument = (text: string, options: XmlParseOptions = {}): XmlDocument => parseDocument(text, options);

/**
 * @description Options every parse call needs, with the defaults already applied.
 */
interface ResolvedOptions {
  readonly preserveWhitespace: boolean;
  readonly maxDepth: number;
  readonly name: NameMode;
  readonly xmlVersion: XmlVersion;
}

const resolveOptions = (options: XmlParseOptions): ResolvedOptions => ({
  preserveWhitespace: options.preserveWhitespace ?? false,
  maxDepth: options.maxDepth ?? 256,
  name: options.name ?? 'repair',
  xmlVersion: options.xmlVersion ?? '1.0',
});

/**
 * @description Whether a character is XML whitespace. XML defines exactly four, and they are the only ones a parser may treat as insignificant.
 *
 * @param code - A UTF-16 code unit.
 *
 * @returns Whether the character is XML whitespace.
 */
const isWhitespace = (code: number): boolean => code === 32 || code === 10 || code === 9 || code === 13;

/**
 * @description `<`
 */
const LT = 60;
/**
 * @description `>`
 */
const GT = 62;
/**
 * @description `/`
 */
const SLASH = 47;
/**
 * @description `=`
 */
const EQUALS = 61;

/**
 * @description One element as the parser saw it: the name it was written under, and the value it holds. Carrying the name alongside the value is what lets the
 * parent file it correctly — the value alone cannot say, because a text-only element reduces to a bare string.
 */
interface Element {
  readonly name: string;
  readonly value: XmlValue;
}

/**
 * @description What a start tag yielded: the record its attributes went into, which becomes the element's value, and whether the tag closed itself.
 */
interface StartTag {
  readonly record: Record<string, XmlValue>;
  readonly selfClosing: boolean;

  /**
   * @description Whether the tag carried any attribute. Counted as they are read rather than asked of the record afterwards, which would mean a key array per
   * element.
   */
  readonly hasAttributes: boolean;
}

/**
 * @description Parses a whole document: a prolog, exactly one root element, and nothing but whitespace after it.
 *
 * @param text - The document to read.
 * @param options - Whitespace, depth and name-handling settings.
 *
 * @returns The root element's name and content.
 *
 * @throws {XmlParseError} When the document is not well-formed.
 */
const parseDocument = (text: string, options: XmlParseOptions): XmlDocument => {
  const resolved = resolveOptions(options);
  let at = 0;

  const fail = (message: string, position: number): never => {
    throw new XmlParseError({ message, position, input: text });
  };

  /**
   * @description The options every name is resolved with, built once. They cannot change during a parse, and building them per name would allocate one object per
   * element and per attribute in the document.
   */
  const nameOptions = { mode: resolved.name, xmlVersion: resolved.xmlVersion };

  /**
   * @description Names already resolved by this parse. A document repeats names — every one of five hundred rows has a `sku` — and a validator that ran per
   * occurrence would pay for the same answer five hundred times.
   */
  const nameCache = new Map<string, string>();

  const resolve = (raw: string, what: string, position: number): string => {
    const cached = nameCache.get(raw);
    if (cached !== undefined) return cached;

    let name: string;
    try {
      name = resolveName(raw, nameOptions);
    } catch (cause) {
      // `resolveName` throws a `TypeError` because it is also called from the
      // renderer, which has no error channel. Here the failure is a property of
      // the document, so it becomes a parse error like any other.
      const reason = cause instanceof Error ? cause.message : String(cause);
      return fail(`${what} ${JSON.stringify(raw)} is not a legal XML name: ${reason}`, position);
    }

    nameCache.set(raw, name);
    return name;
  };

  /**
   * @description Reads to the end of a `<!-- -->`, `<? ?>` or `<!DOCTYPE >` construct, and reports the one past its last character.
   */
  const skipUntil = (marker: string, start: number, what: string): number => {
    const end = text.indexOf(marker, start);
    if (end === -1) fail(`Unterminated ${what}`, start);
    return end + marker.length;
  };

  const skipDoctype = (start: number): number => {
    let depth = 0;
    for (let i = start + 9; i < text.length; i++) {
      const char = text[i];
      if (char === '[') depth++;
      else if (char === ']') depth--;
      else if (char === '>' && depth <= 0) return i + 1;
    }
    return fail('Unterminated DOCTYPE declaration', start);
  };

  /**
   * @description Consumes whitespace, comments, processing instructions and a DOCTYPE, leaving the cursor on the first character that is none of them — or at the
   * end of the document.
   */
  const skipMisc = (): void => {
    for (;;) {
      while (at < text.length && isWhitespace(text.charCodeAt(at))) at++;
      if (at >= text.length) return; // whitespace ran to the end of the document: consumed, and that is the end
      if (text.charCodeAt(at) !== LT) return; // real content: leave the cursor on it for the caller
      if (text.startsWith('<!--', at)) at = skipUntil('-->', at + 4, 'comment');
      else if (text.startsWith('<?', at)) at = skipUntil('?>', at + 2, 'processing instruction');
      else if (text.startsWith('<!DOCTYPE', at)) at = skipDoctype(at);
      else return; // the start of the root element, or of a closing tag
    }
  };

  /**
   * @description Reads a name up to the character that ends it, advancing the cursor past it.
   */
  const readName = (what: string): string => {
    const start = at;
    while (at < text.length) {
      const char = text.charCodeAt(at);
      // Whitespace, `/`, `=` and `>` all end a name. Stopping on `/` and `>` is what lets `<a/>` and `<a>` share one loop.
      if (isWhitespace(char) || char === SLASH || char === EQUALS || char === GT) break;
      at++;
    }
    if (at === start) fail(`Expected a ${what}`, start);
    return text.slice(start, at);
  };

  const skipSpaces = (): void => {
    while (at < text.length && isWhitespace(text.charCodeAt(at))) at++;
  };

  const readAttributeValue = (name: string, nameStart: number): string => {
    const quote = text[at];
    // `indexOf` below is only reached once `quote` is known to be a real quote,
    // which the guard establishes; the `?? ''` is unreachable and exists only to
    // keep the type of the index lookup a `string`.
    if (quote !== '"' && quote !== "'") fail(`Attribute ${JSON.stringify(name)} has no quoted value`, nameStart);
    at++;
    const end = text.indexOf(quote ?? '', at);
    // A raw quote cannot appear inside a quoted value — it would have to be written `&quot;` — so the next quote of the same kind always closes it.
    if (end === -1) fail(`Unterminated value for attribute ${JSON.stringify(name)}`, at);
    const raw = text.slice(at, end);
    at = end + 1;
    return decodeEntities(raw);
  };

  const readStartTag = (): StartTag => {
    // Built as the record the element will end up holding rather than as a
    // separate set of attributes, so that folding the text and the children into
    // it later costs no copy. One object per element instead of two.
    const record: Record<string, XmlValue> = {};
    let hasAttributes = false;
    for (;;) {
      skipSpaces();
      if (at >= text.length) fail('Unterminated start tag', at);
      if (text.charCodeAt(at) === GT) {
        at++;
        return { record, selfClosing: false, hasAttributes };
      }
      if (text.charCodeAt(at) === SLASH && text[at + 1] === '>') {
        at += 2;
        return { record, selfClosing: true, hasAttributes };
      }
      const nameStart = at;
      const name = resolve(readName('attribute name'), 'Attribute', nameStart);
      skipSpaces();
      if (text.charCodeAt(at) !== EQUALS) fail(`Attribute ${JSON.stringify(name)} has no "="`, at);
      at++;
      skipSpaces();
      record[ATTRIBUTE_PREFIX + name] = readAttributeValue(name, nameStart);
      hasAttributes = true;
    }
  };

  const readElement = (depth: number): Element => {
    if (depth > resolved.maxDepth) fail(`Element nesting exceeded maxDepth (${resolved.maxDepth})`, at);
    if (text.charCodeAt(at) !== LT) fail('Expected an element', at);
    at++;

    const name = resolve(readName('element name'), 'Element', at);
    const { record, selfClosing, hasAttributes } = readStartTag();

    if (selfClosing) return { name, value: finishElement(record, hasAttributes, '', false) };

    // The parser folds character data and child elements into the record the
    // start tag produced, as it goes rather than in passes, because the order
    // they appear in is the only order available: attributes always come first on
    // the tag, but text and children interleave freely.
    let childText = '';
    let hasChildren = false;

    for (;;) {
      if (at >= text.length) fail(`Unclosed element <${name}>`, at);

      if (text.charCodeAt(at) !== LT) {
        const next = text.indexOf('<', at);
        const end = next === -1 ? text.length : next;
        childText += decodeEntities(text.slice(at, end));
        at = end;
        continue;
      }

      if (text.startsWith('</', at)) {
        const closeStart = at;
        at += 2;
        const closing = readName('element name');
        if (closing !== name) fail(`Closing tag </${closing}> does not match <${name}>`, closeStart);
        skipSpaces();
        if (text.charCodeAt(at) !== GT) fail(`Malformed closing tag </${closing}>`, at);
        at++;
        return { name, value: finishElement(record, hasAttributes, childText, hasChildren) };
      }

      if (text.startsWith('<!--', at)) {
        at = skipUntil('-->', at + 4, 'comment');
        continue;
      }

      if (text.startsWith('<![CDATA[', at)) {
        const end = text.indexOf(']]>', at + 9);
        if (end === -1) fail('Unterminated CDATA section', at);
        childText += text.slice(at + 9, end); // CDATA is character data, already resolved
        at = end + 3;
        continue;
      }

      if (text.startsWith('<?', at)) {
        at = skipUntil('?>', at + 2, 'processing instruction');
        continue;
      }

      if (text.startsWith('<!', at)) fail('A declaration is not allowed inside an element', at);

      const child = readElement(depth + 1);
      hasChildren = true;
      const existing = record[child.name];
      if (existing === undefined) record[child.name] = child.value;
      else if (Array.isArray(existing)) (existing as Array<XmlValue>).push(child.value);
      else record[child.name] = [existing, child.value];
    }
  };

  /**
   * @description Decides what an element with the given attributes, text and children reduces to.
   */
  const finishElement = (record: Record<string, XmlValue>, hasAttributes: boolean, text: string, hasChildren: boolean): XmlValue => {
    // Whitespace at the edges of a text run is dropped unless the caller asked to
    // keep it. This is what makes a pretty-printed document round trip: the
    // indentation a renderer puts around a child element and around a closing tag
    // lands at the edges of its parent's text, and trimming removes exactly that
    // and nothing else. Whitespace *inside* the run — between two words, or a
    // newline in the middle of a paragraph — is content and stays.
    const content = resolved.preserveWhitespace ? text : text.trim();

    if (!hasAttributes && !hasChildren) {
      // A leaf is character data on its own. Returning the string rather than a `{ '#text': … }` record is what lets
      // `Schema.Struct({ name: Schema.String })` round-trip, and it is the shape `@endevops/builder` produces for a text-only element too.
      return content;
    }

    // Folded in place: the record is the one the start tag built and that the children were added to, so there is
    // nothing left to copy.
    if (content !== '') record[TEXT_KEY] = content;
    return record;
  };

  skipMisc();
  if (at >= text.length || text.charCodeAt(at) !== LT) fail('Document has no root element', at);

  const root = readElement(0);

  skipMisc();
  if (at < text.length) fail('Unexpected content after the root element', at);

  return { name: root.name, value: root.value };
};

/**
 * @description Decodes character references, falling back to the raw text when the reference is not one the decoder recognises. The fallback is what makes a bare
 * `&` survivable: the decoder treats it as a malformed reference and throws, and a document containing one is far more likely to be worth reading
 * than to be rejected. The `&` is escaped on the way out, so the value still round-trips.
 *
 * @param raw - Text read straight from the source, with references unexpanded.
 *
 * @returns The decoded text.
 */
const decodeEntities = (raw: string): string => {
  if (raw.indexOf('&') === -1) return raw; // nothing to expand: the common case, and no work
  try {
    return decoder.decode(raw);
  } catch {
    return raw;
  }
};
