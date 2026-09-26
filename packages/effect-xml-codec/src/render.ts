// Rendering: an `XmlValue` to XML text.
//
// This is the hot path for an application that serializes often, so it builds
// into one array of chunks and joins once, resolves each distinct name at most
// once per render, and hands escaping to `@endevops/entities` — which returns
// its input by identity when there is nothing to escape, so clean text costs
// one regex test and no allocation.

import type { XmlVersion } from '@endevops/xml-naming';

import { EntityEncoder } from '@endevops/entities';

import type { NameMode } from './conventions.ts';
import type { XmlRecord, XmlValue } from './xml-value.ts';

import { attributeName, DEFAULT_ITEM_NAME, DEFAULT_ROOT_NAME, isAttributeKey, isTextKey, resolveName, TEXT_KEY } from './conventions.ts';
import { isXmlArray } from './xml-value.ts';

/**
 * @description One escaping pass for the whole module. `encodeAllNamed: false` matters for XML: the encoder's named tables are HTML's, and an HTML name such as
 * `&eacute;` is _not_ a predefined XML entity — writing one produces a document that is well-formed but not valid against any DTD, and that no XML
 * parser will resolve. With it off, the only names the encoder can emit are the five XML predefines, which is exactly the set an XML parser is
 * required to know. A single shared instance is safe because `maxReplacements` defaults to 0, which the encoder treats as unlimited, so the instance
 * carries no state between calls.
 */
const encoder = new EntityEncoder({ encodeAllNamed: false });

/**
 * @description The character references that survive XML's attribute-value whitespace normalization. An XML parser replaces a literal newline, carriage return or
 * tab inside an attribute value with a space, so a value that has to survive a round trip has to spell them as numeric references. The `&` is written
 * after {@link escapeText}, never before, or the escaping pass would rewrite the `&` of the reference it just introduced.
 */
const ATTRIBUTE_WHITESPACE = /[\n\r\t]/g;

/**
 * @description Options for {@link renderXml}.
 */
export interface XmlRenderOptions {
  /**
   * @description Name of the root element. Defaults to `'root'`. A codec passes the name it took from the schema's `identifier` annotation when the caller did not
   * set one.
   */
  readonly rootName?: string | undefined;

  /**
   * @description Element name used for the members of a document whose root value is an array. Defaults to `'item'`.
   */
  readonly itemName?: string | undefined;

  /**
   * @description Indent nested elements on their own lines. Defaults to `false`, matching `@endevops/xml-builder`.
   */
  readonly format?: boolean | undefined;

  /**
   * @description The string one indent level is made of. Defaults to two spaces.
   */
  readonly indent?: string | undefined;

  /**
   * @description Write an element with no attributes, text or children as `<a/>` rather than `<a></a>`. Defaults to `true`.
   */
  readonly suppressEmptyNode?: boolean | undefined;

  /**
   * @description Sort an element's keys so the same value always renders to the same bytes. Defaults to `false`, which keeps declaration order. Worth turning on
   * for snapshot tests, where key order is otherwise the only thing that can make two equal values differ.
   */
  readonly sortKeys?: boolean | undefined;

  /**
   * @description What to do with a field name that is not a legal XML name. Defaults to `'repair'`.
   */
  readonly name?: NameMode | undefined;

  /**
   * @description XML version to validate names against. Defaults to `'1.0'`.
   */
  readonly xmlVersion?: XmlVersion | undefined;

  /**
   * @description How deep to nest before giving up. Guards against a value that nests without end taking the stack with it. Defaults to 256.
   */
  readonly maxDepth?: number | undefined;
}

/**
 * @description Options every render call needs, with the defaults already applied.
 */
interface ResolvedOptions {
  readonly rootName: string;
  readonly itemName: string;
  readonly format: boolean;
  readonly indent: string;
  readonly suppressEmptyNode: boolean;
  readonly sortKeys: boolean;
  readonly name: NameMode;
  readonly xmlVersion: XmlVersion;
  readonly maxDepth: number;

  /**
   * @description Resolves a field name to a legal XML name, in the mode this render was configured with. See {@link makeNamer} for why it is a function rather than
   * a call to `resolveName`.
   */
  readonly namer: (name: string) => string;
}

/**
 * @description Builds the name resolver for one render. Every element and every attribute name goes through here, and a document repeats names: a thousand
 * `<item>` elements, or the same `id` on every row. A validator that runs a regex per occurrence pays that cost a thousand times for one answer, so
 * the first result is remembered and the rest are lookups. It also keeps the mode and version in one place, which is what stops a caller from
 * resolving a name with different settings than the render it is part of.
 *
 * @param options - Resolved render options.
 *
 * @returns A function from field name to legal XML name.
 */
const makeNamer = (options: Omit<ResolvedOptions, 'namer'>): ((name: string) => string) => {
  const cache = new Map<string, string>();
  return name => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const resolved = resolveName(name, { mode: options.name, xmlVersion: options.xmlVersion });
    cache.set(name, resolved);
    return resolved;
  };
};

const resolveOptions = (options: XmlRenderOptions): ResolvedOptions => {
  const resolved = {
    rootName: options.rootName ?? DEFAULT_ROOT_NAME,
    itemName: options.itemName ?? DEFAULT_ITEM_NAME,
    format: options.format ?? false,
    indent: options.indent ?? '  ',
    suppressEmptyNode: options.suppressEmptyNode ?? true,
    sortKeys: options.sortKeys ?? false,
    name: options.name ?? ('repair' as NameMode),
    xmlVersion: options.xmlVersion ?? ('1.0' as XmlVersion),
    maxDepth: options.maxDepth ?? 256,
  };
  return { ...resolved, namer: makeNamer(resolved) };
};

/**
 * @description Escapes a value for use as character data.
 *
 * @param value - The text to escape.
 *
 * @returns The text with the XML-unsafe characters replaced by predefined entities.
 */
export const escapeText = (value: string): string => encoder.encode(value);

/**
 * @description Escapes a value for use inside a double-quoted attribute.
 *
 * @param value - The text to escape.
 *
 * @returns The escaped text, with the whitespace that XML would otherwise normalize spelled as character references.
 */
export const escapeAttribute = (value: string): string =>
  encoder.encode(value).replace(ATTRIBUTE_WHITESPACE, character => `&#${character.charCodeAt(0)};`);

/**
 * @description Renders an {@link XmlValue} as an XML document. A record becomes an element: `@`-prefixed keys become attributes, the reserved `#text` key becomes
 * character data, and every other key becomes a child element. An array repeats its name — a document whose root value is an array wraps it in the
 * root element and names each member `itemName`. A string is character data.
 *
 * @param value - The value to render.
 * @param options - Root name, formatting, empty-element and name-resolution settings.
 *
 * @returns The XML document as a string.
 *
 * @throws {TypeError} When `options.name` is `'error'` and a field name is not a legal XML name.
 * @throws {RangeError} When the value nests deeper than `options.maxDepth`.
 */
export const renderXml = (value: XmlValue, options: XmlRenderOptions = {}): string => {
  const resolved = resolveOptions(options);
  const out: Array<string> = [];

  // A document has exactly one root element, so a root value that is an array
  // is wrapped rather than emitted as several roots. Inside a named element an
  // array repeats that element's own name, so this wrapping is the only place
  // `itemName` is ever used.
  if (isXmlArray(value)) {
    const tag = resolved.namer(resolved.rootName);
    out.push('<', tag, '>');
    for (const member of value) renderElement(out, resolved.itemName, member, 1, resolved);
    if (resolved.format) out.push('\n');
    out.push('</', tag, '>');
  } else {
    renderElement(out, resolved.rootName, value, 0, resolved);
  }

  if (resolved.format) out.push('\n');
  return out.join('');
};

/**
 * @description Renders one named element and its subtree.
 *
 * @param out - The chunk buffer to append to.
 * @param name - The element name, not yet resolved.
 * @param value - The element's value.
 * @param depth - Current nesting depth, for indentation and the depth cap.
 * @param options - Resolved render options.
 */
const renderElement = (out: Array<string>, name: string, value: XmlValue, depth: number, options: ResolvedOptions): void => {
  if (depth > options.maxDepth) {
    throw new RangeError(`XML nesting exceeded maxDepth (${options.maxDepth}). Raise the limit if the document is legitimately this deep.`);
  }

  // A repeated run of children under one name: `tags: ['a', 'b']` renders
  // `<tags>a</tags><tags>b</tags>`, not one element wrapping both. The name is
  // already the element's own, so the caller only supplies a name when the
  // array sits where no name is available.
  //
  // Checked before the line break and the name are taken, because the array
  // itself is not an element: opening a line for it as well as for each of its
  // members would leave a blank line where the array was.
  if (isXmlArray(value)) {
    // An empty array still gets an element. Writing nothing would make a field
    // that was present and empty indistinguishable from one that was never
    // there, and a document that came from a schema is easier to trust when the
    // element it describes is actually in the output.
    if (value.length === 0) {
      if (options.format && depth > 0) openLine(out, depth, options);
      writeEmpty(out, options.namer(name), options);
      return;
    }
    for (const member of value) renderElement(out, name, member, depth, options);
    return;
  }

  // An element opens its own line rather than having its caller do it, which is
  // what keeps a repeated run of children on separate lines. The root is the
  // one element that has nothing in front of it.
  if (options.format && depth > 0) openLine(out, depth, options);

  const tag = options.namer(name);

  if (typeof value === 'string') {
    // An empty string is character data that happens to be empty, and an element
    // holding none of it is the same element as one holding nothing at all.
    if (value === '') {
      writeEmpty(out, tag, options);
      return;
    }
    out.push('<', tag, '>', escapeText(value), '</', tag, '>');
    return;
  }

  // An `undefined` element is an absent one. The renderer is handed values that
  // never went through the schema — a caller building a document by hand — so
  // this is reachable, and an empty element is the honest rendering of it.
  if (value === undefined) {
    writeEmpty(out, tag, options);
    return;
  }

  const record: XmlRecord = value;
  const attributes = renderAttributes(record, options);
  const text = textOf(record);
  const children = childKeys(record, options);

  // Self-closing is decided by whether the element has any *content*, not by
  // whether it has attributes: `<a id="1"/>` is the same element as `<a id="1">`
  // with nothing in it, and the short form is what every XML writer produces.
  if (children.length === 0 && text === '') {
    writeEmpty(out, tag, options, attributes);
    return;
  }

  const childrenAreElements = children.length > 0;
  out.push('<', tag, attributes, '>');

  // Character data sits inline when it is all an element has, and on its own
  // line when the element also has children, so an indented document does not
  // end up with its first line of text glued to its opening tag.
  if (text !== '') {
    if (childrenAreElements && options.format) openLine(out, depth + 1, options);
    out.push(escapeText(text));
  }

  if (childrenAreElements) {
    for (const key of children) {
      const child = record[key];
      if (child === undefined) continue;
      renderElement(out, key, child, depth + 1, options);
    }
    if (options.format) openLine(out, depth, options);
  }

  out.push('</', tag, '>');
};

/**
 * @description Starts a new line at the given depth, when pretty-printing.
 *
 * @param out - The chunk buffer to append to.
 * @param depth - The depth the line sits at.
 * @param options - Resolved render options.
 */
const openLine = (out: Array<string>, depth: number, options: ResolvedOptions): void => {
  out.push('\n');
  out.push(options.indent.repeat(depth));
};

/**
 * @description Writes an element with no content, in whichever of the two forms the options ask for. Every path that produces an element with nothing in it goes
 * through here, so the self-closing decision is made in exactly one place. That matters because "nothing in it" arrives four different ways — an
 * empty string, an absent value, an empty array, and a record whose fields are all absent — and four separate decisions are four chances for one of
 * them to write the long form by accident.
 *
 * @param out - The chunk buffer to append to.
 * @param tag - The element's name, already resolved.
 * @param options - Resolved render options.
 * @param attributes - The element's rendered attributes, if it has any. Defaults to none.
 */
const writeEmpty = (out: Array<string>, tag: string, options: ResolvedOptions, attributes = ''): void => {
  if (options.suppressEmptyNode) out.push('<', tag, attributes, '/>');
  else out.push('<', tag, attributes, '></', tag, '>');
};

/**
 * @description An element's character data, with the reserved text key read off its value.
 *
 * @param record - The element's value.
 *
 * @returns The text to write between the tags, or `''` when the element has none.
 */
const textOf = (record: XmlRecord): string => {
  const text = record[TEXT_KEY];
  if (text === undefined) return '';
  return typeof text === 'string' ? text : renderScalar(text);
};

/**
 * @description Renders an element's attributes, or an empty string when it has none.
 *
 * @param record - The element's value.
 * @param options - Resolved render options.
 *
 * @returns The attribute text, each name preceded by a space, or `''`.
 */
const renderAttributes = (record: XmlRecord, options: ResolvedOptions): string => {
  let out = '';
  for (const key of Object.keys(record)) {
    if (!isAttributeKey(key)) continue;
    const value = record[key];
    if (value === undefined) continue; // an absent attribute is not written at all
    const name = options.namer(attributeName(key));
    // An attribute's value is always character data, so a bare string is the
    // only sensible shape. A non-string is stringified rather than rejected:
    // the schema is what enforces the field's type, and rejecting here would
    // duplicate that check with a different error.
    const text = typeof value === 'string' ? value : renderScalar(value);
    out += ' ' + name + '="' + escapeAttribute(text) + '"';
  }
  return out;
};

/**
 * @description Collects the keys of an element's child elements, in the order they should be written.
 *
 * @param record - The element's value.
 * @param options - Resolved render options.
 *
 * @returns The child element names, attributes and the reserved text key excluded.
 */
const childKeys = (record: XmlRecord, options: ResolvedOptions): Array<string> => {
  const keys: Array<string> = [];
  for (const key of Object.keys(record)) {
    if (isAttributeKey(key) || isTextKey(key)) continue;
    if (record[key] === undefined) continue; // an absent field is not written
    keys.push(key);
  }
  if (options.sortKeys) keys.sort();
  return keys;
};

/**
 * @description Renders a leaf that is not a string as the character data an XML document can hold. A schema-derived value never reaches here —
 * `Schema.toCodecStringTree` has already turned every scalar into a string — so this is for values a caller built by hand. A value with no sensible
 * text form is rendered as nothing rather than as `[object Object]`, which would silently write a document that parses back to something else.
 *
 * @param value - The leaf to render.
 *
 * @returns The leaf's textual form.
 */
const renderScalar = (value: Exclude<XmlValue, string | undefined>): string => {
  if (value === null) return 'null';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return ''; // circular or otherwise not representable
  }
};
