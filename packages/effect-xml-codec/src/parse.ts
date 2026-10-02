import type { XmlVersion } from '@endevops/common-xml';

import { EntityDecoder } from '@endevops/common-xml';
import { Effect, Result } from 'effect';

import type { NameMode } from './conventions.ts';
import type { XmlValue } from './xml-value.ts';

import { ATTRIBUTE_PREFIX, resolveNameSync, TEXT_KEY } from './conventions.ts';
import { XmlParseError } from './errors.ts';

const decoder = EntityDecoder.make().pipe(Effect.runSync);

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
 * @description Options for {@link parseXml} and {@link parseXmlDocument}.
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
 * @description Parses an XML document into its root element's content. The walk itself is synchronous, but it reports a malformed document by failing with an
 * {@link XmlParseError} rather than by throwing, so the failure lands in the effect's error channel where `catchTag`, `retry` and a fallback can all
 * see it. A failed parse is an expected outcome of reading untrusted text — it is what those combinators key off — and only a defect would hide it.
 * The span is the boundary a performance trace hangs off: it carries the document's length, which is the size that drives the parser's cost, so a
 * slow parse in a profile can be attributed to the input that produced it. A caller that wants the value outside an `Effect` uses
 * {@link parseXmlDocument}, which runs the same walk synchronously and throws instead. The walk is plain recursive descent rather than a chain of
 * `yield*`es. Publicly `parseXml` is still an `Effect` — it suspends the walk so it runs lazily under the span, and folds the failure the walk throws
 * into the typed error channel — but inside a document there is no effect boundary per tag, attribute or text run. A 500-row report is thousands of
 * those, and a fiber step for each of them was most of what the `parse 500 rows` row measured. The typed failure survives: the walk throws an
 * {@link XmlParseError} and `parseXml` catches it into `Effect.fail`.
 *
 * @param text - The document to read.
 * @param options - Whitespace, depth and name-handling settings.
 *
 * @returns An effect producing the root element's content as an {@link XmlValue}.
 */
export const parseXml = (text: string, options: XmlParseOptions = {}): Effect.Effect<XmlValue, XmlParseError> =>
  Effect.suspend(() => Effect.fromResult(parseDocumentResult(text, options))).pipe(
    Effect.map(document => document.value),
    Effect.withSpan('XmlCodec.parseXml', { attributes: { 'xml.length': text.length } })
  );

/**
 * @description Parses an XML document, keeping the root element's name. This is the synchronous form of {@link parseXml}: it runs the same walk and throws the
 * {@link XmlParseError} the effect would have failed with, for a caller that is not already in an `Effect`.
 *
 * @deprecated
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
 * @description An element's body as the parser read it: the character data it accumulated, and whether any child element went into the record.
 */
interface Content {
  /**
   * @description Every text run in the body, concatenated in the order they appeared.
   */
  readonly text: string;

  /**
   * @description Whether the body held at least one child element. Counted rather than asked of the record afterwards, because a child whose fields are all absent
   * leaves no trace of itself in the record and must still keep its element from being written self-closing.
   */
  readonly hasChildren: boolean;
}

/**
 * @description What sits at the cursor inside an element's body. Naming what is there before deciding what to do with it is what lets the content loop stay a
 * dispatch: each construct is recognised in one place, against the ones that cannot be confused with it, rather than by a chain of `startsWith`
 * guesses where each had to remember what the last had already ruled out.
 */
type Construct = 'text' | 'close' | 'comment' | 'cdata' | 'instruction' | 'child';

/**
 * @description Parses a whole document: a prolog, exactly one root element, and nothing but whitespace after it. The walk is synchronous and reports a malformed
 * document by throwing an {@link XmlParseError}; {@link parseXml} folds that into the effect's typed error channel.
 *
 * @param text - The document to read.
 * @param options - Whitespace, depth and name-handling settings.
 *
 * @returns The root element's name and content.
 *
 * @throws {XmlParseError} When the document is not well-formed.
 */
const parseDocument = (text: string, options: XmlParseOptions): XmlDocument => {
  const resolved: ResolvedOptions = {
    preserveWhitespace: options.preserveWhitespace ?? false,
    maxDepth: options.maxDepth ?? 256,
    name: options.name ?? 'repair',
    xmlVersion: options.xmlVersion ?? '1.0',
  };

  let at = 0;

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

    // `resolveNameSync` reports an illegal name by throwing an `XmlParseError`; the failure is reworded
    // here so it names the position in the document and whether the name belonged to an element or
    // an attribute, which a generic name resolver cannot know.
    let name: string;
    try {
      name = resolveNameSync(raw, nameOptions);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      throw new XmlParseError({ message: `${what} ${JSON.stringify(raw)} is not a legal XML name: ${reason}`, position, input: text });
    }

    nameCache.set(raw, name);
    return name;
  };

  /**
   * @description Reads to the end of a `<!-- -->`, `<? ?>` or `<!DOCTYPE >` construct, and reports the one past its last character.
   */
  const skipUntil = (marker: string, start: number, what: string): number => {
    const end = text.indexOf(marker, start);
    if (end === -1) throw new XmlParseError({ message: `Unterminated ${what}`, position: start, input: text });
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
    throw new XmlParseError({ message: 'Unterminated DOCTYPE declaration', position: start, input: text });
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
    if (at === start) throw new XmlParseError({ message: `Expected a ${what}`, position: start, input: text });
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
    if (quote !== '"' && quote !== "'")
      throw new XmlParseError({ message: `Attribute "${name}" has no quoted value`, position: nameStart, input: text });
    at++;
    const end = text.indexOf(quote ?? '', at);
    // A raw quote cannot appear inside a quoted value — it would have to be written `&quot;` — so the next quote of the same kind always closes it.
    if (end === -1) throw new XmlParseError({ message: `Unterminated value for attribute "${name}"`, position: at, input: text });
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
      if (at >= text.length) throw new XmlParseError({ message: 'Unterminated start tag', position: at, input: text });
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
      if (text.charCodeAt(at) !== EQUALS) throw new XmlParseError({ message: `Attribute "${name}" has no "="`, position: at, input: text });
      at++;
      skipSpaces();
      record[ATTRIBUTE_PREFIX + name] = readAttributeValue(name, nameStart);
      hasAttributes = true;
    }
  };

  const readElement = (depth: number): Element => {
    if (depth > resolved.maxDepth)
      throw new XmlParseError({ message: `Element nesting exceeded maxDepth (${resolved.maxDepth})`, position: at, input: text });
    if (text.charCodeAt(at) !== LT) throw new XmlParseError({ message: 'Expected an element', position: at, input: text });
    at++;

    const name = resolve(readName('element name'), 'Element', at);
    const { record, selfClosing, hasAttributes } = readStartTag();

    if (selfClosing) return { name, value: finishElement(record, hasAttributes, '', false) };

    // The parser folds character data and child elements into the record the
    // start tag produced, as it goes rather than in passes, because the order
    // they appear in is the only order available: attributes always come first on
    // the tag, but text and children interleave freely.
    const content = readContent(name, record, depth);

    return { name, value: finishElement(record, hasAttributes, content.text, content.hasChildren) };
  };

  /**
   * @description Reads an element's body up to and including its closing tag, folding what it finds into the record the start tag produced. Returns when the
   * closing tag has been consumed; failing on it is {@link readClosingTag}'s job, so that a mismatched or unclosed tag is reported the same way
   * wherever it was found.
   *
   * @param name - The name the start tag gave the element, which its closing tag has to match.
   * @param record - The record to fold the children into.
   * @param depth - The depth the element sits at; its children are one deeper.
   *
   * @returns The body as character data, and whether it held any child element.
   */
  const readContent = (name: string, record: Record<string, XmlValue>, depth: number): Content => {
    let childText = '';
    let hasChildren = false;

    for (;;) {
      switch (classifyContent(name)) {
        case 'text':
          childText += readTextRun();
          break;
        case 'close':
          readClosingTag(name);
          return { text: childText, hasChildren };
        case 'comment':
          at = skipUntil('-->', at + 4, 'comment');
          break;
        case 'cdata':
          childText += readCdata();
          break;
        case 'instruction':
          at = skipUntil('?>', at + 2, 'processing instruction');
          break;
        case 'child': {
          hasChildren = true;
          addChild(record, readElement(depth + 1));
          break;
        }
      }
    }
  };

  /**
   * @description What the cursor is sitting on inside an element's body. The two things the loop cannot read are refused here rather than in it: running out of
   * document and a declaration, which is markup the parser does not accept inside an element. Recognising the constructs that _are_ read is the rest,
   * and the order is the one that rules out the shorter prefixes first — `</` before `<?` before any other `<!`, and `<![CDATA[` before the `<!` that
   * would otherwise match it.
   *
   * @param name - The name the enclosing element's start tag gave it, for the unterminated-body message.
   *
   * @returns What the cursor is on.
   */
  const classifyContent = (name: string): Construct => {
    if (at >= text.length) throw new XmlParseError({ message: `Unclosed element <${name}>`, position: at, input: text });
    if (text.charCodeAt(at) !== LT) return 'text';
    if (text.startsWith('</', at)) return 'close';
    if (text.startsWith('<!--', at)) return 'comment';
    if (text.startsWith('<![CDATA[', at)) return 'cdata';
    if (text.startsWith('<?', at)) return 'instruction';
    if (text.startsWith('<!', at)) throw new XmlParseError({ message: 'A declaration is not allowed inside an element', position: at, input: text });
    return 'child';
  };

  /**
   * @description Consumes a `</name>`, checking on the way that it is the tag that closes this element and that it is well-formed.
   *
   * @param name - The name the start tag gave the element, which the closing tag has to match.
   */
  const readClosingTag = (name: string): void => {
    const closeStart = at;
    at += 2;
    const closing = readName('element name');
    if (closing !== name)
      throw new XmlParseError({ message: `Closing tag </${closing}> does not match <${name}>`, position: closeStart, input: text });
    skipSpaces();
    if (text.charCodeAt(at) !== GT) throw new XmlParseError({ message: `Malformed closing tag </${closing}>`, position: at, input: text });
    at++;
  };

  /**
   * @description Reads the run of character data up to the next `<`, or to the end of the document.
   *
   * @returns The run, with its character references expanded.
   */
  const readTextRun = (): string => {
    const next = text.indexOf('<', at);
    const end = next === -1 ? text.length : next;
    const run = decodeEntities(text.slice(at, end));
    at = end;
    return run;
  };

  /**
   * @description Reads a `<![CDATA[…]]>` section. CDATA is character data, and character data is what it holds, so it joins the element's text as it stands — the
   * entities in it are literal text and must not be expanded.
   *
   * @returns The section's contents.
   */
  const readCdata = (): string => {
    const end = text.indexOf(']]>', at + 9);
    if (end === -1) throw new XmlParseError({ message: 'Unterminated CDATA section', position: at, input: text });
    const data = text.slice(at + 9, end);
    at = end + 3;
    return data;
  };

  /**
   * @description Adds a child to its parent's record. Two children under one name make an array, and the first one does not: a schema can tell a repeated field
   * from a single one by the shape, and an array of one is not what a single value encodes to.
   *
   * @param record - The parent's record, added to in place.
   * @param child - The child element as it was read.
   */
  const addChild = (record: Record<string, XmlValue>, child: Element): void => {
    const existing = record[child.name];
    if (existing === undefined) record[child.name] = child.value;
    else if (Array.isArray(existing)) (existing as Array<XmlValue>).push(child.value);
    else record[child.name] = [existing, child.value];
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
  if (at >= text.length || text.charCodeAt(at) !== LT)
    throw new XmlParseError({ message: 'Document has no root element', position: at, input: text });

  const root = readElement(0);

  skipMisc();
  if (at < text.length) throw new XmlParseError({ message: 'Unexpected content after the root element', position: at, input: text });

  return { name: root.name, value: root.value };
};

/**
 * @description Runs the synchronous walk and folds the one failure it reports into a {@link Result}, which {@link parseXml} turns back into an `Effect`. Kept
 * separate so the walk itself can throw without the public API ever throwing.
 *
 * @param text - The document to read.
 * @param options - The options as the caller wrote them.
 *
 * @returns The document, or the failure to report.
 */
const parseDocumentResult = (text: string, options: XmlParseOptions): Result.Result<XmlDocument, XmlParseError> => {
  try {
    return Result.succeed(parseDocument(text, options));
  } catch (cause) {
    if (cause instanceof XmlParseError) return Result.fail(cause);
    return Result.fail(new XmlParseError({ message: cause instanceof Error ? cause.message : String(cause), position: -1, input: text }));
  }
};

/**
 * @description Decodes character references, falling back to the raw text when the reference is not one the decoder recognises. The fallback is what makes a bare
 * `&` survivable: the decoder treats it as a malformed reference and fails, and a document containing one is far more likely to be worth reading than
 * to be rejected. The `&` is escaped on the way out, so the value still round-trips. The decoder answers with an `Effect`, and this is the one place
 * a parse still runs one. It is only reached when the raw text holds an `&` — the common case returns before it — and the effect is synchronous, so
 * the run is cheap next to the decoder's own work.
 *
 * @param raw - Text read straight from the source, with references unexpanded.
 *
 * @returns The decoded text, which cannot fail.
 */
const decodeEntities = (raw: string): string => {
  if (raw.indexOf('&') === -1) return raw; // nothing to expand: the common case, and no work
  // `orElseSucceed` rather than `try`/`catch`: the decoder reports a malformed
  // reference by failing in its error channel, and a document containing a bare
  // `&` is far more likely to be worth reading than to be rejected. The `&` is
  // escaped on the way out, so the value still round-trips.
  return Effect.runSync(Effect.orElseSucceed(decoder.decode(raw), () => raw));
};
