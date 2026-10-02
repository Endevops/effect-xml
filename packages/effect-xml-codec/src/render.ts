// Rendering: an `XmlValue` to XML text.
//
// This is the hot path for an application that serializes often, so it is built
// around three things: one pass over each record's keys rather than one per
// role a key can play, one pass over each character rather than one per
// character class, and one array of chunks joined once rather than a growing
// string.
//
// The walk itself is plain synchronous functions rather than a chain of
// `yield*`es. Publicly `renderXml` is still an `Effect` — it suspends the walk so
// it runs lazily, and folds the one failure the walk can report into the typed
// error channel — but inside a document there is no effect boundary per element
// or per attribute. A 500-row report is thousands of elements, and a fiber step
// for each of them was most of what the `render 500 rows` row measured. The
// typed failure survives: the walk throws an {@link XmlRenderError} and
// `renderXml` catches it into `Effect.fail`.
//
// Escaping is the part that scales with the size of the document rather than
// with its structure, and it is written out here rather than delegated, for a
// measured reason. The entity encoder that used to live beside this package
// escaped by applying five sequential global replacements, one per character,
// so a document with a single `&` in twenty thousand characters was scanned
// five times over to change one byte -- which is what the `render 20k` rows in
// `bench/codec.bench.ts` measure. The table below covers the same five
// characters that encoder escaped, and the explicit expectations in
// `test/render.spec.ts` pin the fast path.

import { Effect, Predicate, Result } from 'effect';

import type { NameMode } from './conventions.ts';
import type { XmlVersion } from './naming.ts';
import type { XmlRecord, XmlValue } from './xml-value.ts';

import { attributeName, DEFAULT_ITEM_NAME, DEFAULT_ROOT_NAME, isAttributeKey, isTextKey, resolveNameSync, TEXT_KEY } from './conventions.ts';
import { XmlRenderError } from './errors.ts';

/**
 * @description The five characters XML predefines an entity for, and the names to write for them. Written out rather than referenced from the entity decoder
 * because the table is indexed by character code below.
 */
const XML_PREDEFINED = { 34: '&quot;', 38: '&amp;', 39: '&apos;', 60: '&lt;', 62: '&gt;' } as const;

/**
 * @description The character references for the whitespace XML normalizes inside an attribute value. A parser replaces a literal newline, carriage return or tab
 * in an attribute with a space, so a value that has to survive a round trip has to spell them as references. They are in the attribute table and not
 * the text one: in character data they are content, and only an attribute value is normalized.
 */
const ATTRIBUTE_WHITESPACE = { 9: '&#9;', 10: '&#10;', 13: '&#13;' } as const;

/**
 * @description The replacement for each ASCII character that needs one, and `undefined` for the ones that do not. Indexed by character code and 128 long, so the
 * check is one comparison and one array read with no string search in it.
 *
 * @param extra - Characters to escape in addition to the five predefines.
 *
 * @returns The lookup table.
 */
const buildTable = (extra: Record<number, string>): ReadonlyArray<string | undefined> => {
  const table = Array.from<string | undefined>({ length: 128 }).fill(undefined);
  for (const [code, entity] of Object.entries({ ...XML_PREDEFINED, ...extra })) table[Number(code)] = entity;
  return table;
};

const TEXT_TABLE = buildTable({});
const ATTRIBUTE_TABLE = buildTable(ATTRIBUTE_WHITESPACE);

/**
 * @description The characters each table escapes, as a pattern rather than as a set of replacement passes. Finding the first one with a pattern is what makes
 * clean text cheap: V8 compiles a single character class into a scan that is several times faster than a JavaScript loop reading the same string a
 * code unit at a time, and clean text is most text. `render 20k of clean text` in `bench/codec.bench.ts` is the row that says so — a hand-written
 * loop over the same twenty thousand characters is roughly two and a half times slower. Neither pattern is global, so `exec` ignores `lastIndex` and
 * always starts at the beginning. One module-level instance of each is therefore safe to reuse, and nothing has to be reset between calls.
 */
const TEXT_UNSAFE = /[<>&"']/;
const ATTRIBUTE_UNSAFE = /[<>&"'\n\r\t]/;

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
   * @description Indent nested elements on their own lines. Defaults to `false`.
   *
   * @default `false`
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
   * @description Resolves a field name to a legal XML name, in the mode this render was configured with. Synchronous and memoized; see {@link makeNamer}.
   */
  readonly namer: (name: string) => string;

  /**
   * @description The indent for a given depth, when pretty-printing. Built on first use at each depth and kept, so an indented document builds one string per
   * level rather than one per line.
   */
  readonly lineAt: (depth: number) => string;
}

/**
 * @description Builds the name resolver for one render. Every element and every attribute name goes through here, and a document repeats names: a thousand
 * `<item>` elements, or the same `id` on every row. A validator that runs a regex per occurrence pays that cost a thousand times for one answer, so
 * the first result is remembered and the rest are lookups. It also keeps the mode and version in one place, which is what stops a caller from
 * resolving a name with different settings than the render it is part of. A cache miss calls {@link resolveNameSync}, which throws an
 * {@link XmlParseError} in `'error'` mode; {@link renderXml} catches it and reports it as an {@link XmlRenderError}.
 *
 * @param options - Resolved render options.
 *
 * @returns A function from field name to the legal XML name.
 */
const makeNamer = (options: Omit<ResolvedOptions, 'namer' | 'lineAt'>): ((name: string) => string) => {
  const cache = new Map<string, string>();
  return (name: string): string => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const resolved = resolveNameSync(name, { mode: options.name, xmlVersion: options.xmlVersion });
    cache.set(name, resolved);
    return resolved;
  };
};

/**
 * @description A boolean option's value, with an absent one read as the default. The three boolean options are spelled through here rather than through a `??` of
 * their own, so the table below reads as a list of what each option _is_ instead of a list of nine separate decisions about what an omitted option
 * means — and so a reader looking for "which options are on by default" finds three words rather than three mixes of `?? true` and `?? false` to
 * read.
 *
 * @param value - The option as the caller wrote it, or `undefined` when the caller left it out.
 * @param fallback - The value to use when the caller left it out.
 *
 * @returns The option's value.
 */
const flag = (value: boolean | undefined, fallback: boolean): boolean => value ?? fallback;

/**
 * @description The indent for a given depth, built the first time a render reaches that depth and kept. A document of a few thousand elements on several lines
 * each would otherwise call `repeat` once per line and allocate the same handful of strings thousands of times over.
 *
 * @param indent - The string one level of indentation is made of.
 *
 * @returns A function from depth to the indent for that depth.
 */
const makeLineAt = (indent: string): ((depth: number) => string) => {
  const lines: Array<string> = [''];
  return depth => {
    const line = lines[depth];
    if (line !== undefined) return line;
    const built = indent.repeat(depth);
    lines[depth] = built;
    return built;
  };
};

/**
 * @description Applies the defaults to one call's options, and builds the two things a render needs that are not options: the memoized name resolver and the
 * memoized indent lines.
 *
 * @param options - The options as the caller wrote them.
 *
 * @returns Every option a render reads, defaulted, with the resolver and the indent lines attached.
 */
const resolveOptions = (options: XmlRenderOptions): ResolvedOptions => {
  const resolved = {
    rootName: options.rootName ?? DEFAULT_ROOT_NAME,
    itemName: options.itemName ?? DEFAULT_ITEM_NAME,
    format: flag(options.format, false),
    indent: options.indent ?? '  ',
    suppressEmptyNode: flag(options.suppressEmptyNode, true),
    sortKeys: flag(options.sortKeys, false),
    name: options.name ?? ('repair' as NameMode),
    xmlVersion: options.xmlVersion ?? ('1.0' as XmlVersion),
    maxDepth: options.maxDepth ?? 256,
  };
  return { ...resolved, namer: makeNamer(resolved), lineAt: makeLineAt(resolved.indent) };
};

/**
 * @description Escapes a value for use as character data.
 *
 * @param value - The text to escape.
 *
 * @returns The text with the XML-unsafe characters replaced by predefined entities, or the very same string when there is nothing to escape.
 */
export const escapeText = (value: string): string => escape(value, TEXT_UNSAFE, TEXT_TABLE);

/**
 * @description Escapes a value for use inside a double-quoted attribute.
 *
 * @param value - The text to escape.
 *
 * @returns The escaped text, with the whitespace that XML would otherwise normalize spelled as character references.
 */
export const escapeAttribute = (value: string): string => escape(value, ATTRIBUTE_UNSAFE, ATTRIBUTE_TABLE);

/**
 * @description Replaces every character the table has an entry for, in one pass over the string. The pattern finds the first character that needs replacing, and a
 * string with none is handed straight back — which is the common case, and the one the pattern is there to make fast. From there the rest of the
 * string is copied in runs between the replacements rather than a character at a time, so the cost is one pattern scan, one copy, and one
 * concatenation per replacement, rather than a whole pass per character class. Only ASCII is looked up. XML carries every other character natively,
 * and a code unit above 127 has no entity an XML parser is required to know.
 *
 * @param value - The text to escape.
 * @param pattern - Matches the first character that needs replacing.
 * @param table - The replacement for each ASCII character that needs one.
 *
 * @returns The escaped text, or `value` itself when there is nothing to escape.
 */
const escape = (value: string, pattern: RegExp, table: ReadonlyArray<string | undefined>): string => {
  const found = pattern.exec(value);
  if (found === null) return value; // nothing to escape: hand back the same string

  const length = value.length;
  const start = found.index;
  let out = value.slice(0, start);
  let copied = start;

  for (let index = start; index < length; index++) {
    const code = value.charCodeAt(index);
    const entity = code < 128 ? table[code] : undefined;
    if (entity !== undefined) {
      out += value.slice(copied, index) + entity;
      copied = index + 1;
    }
  }

  return copied === length ? out : out + value.slice(copied);
};

/**
 * @description Renders an {@link XmlValue} as an XML document.\
 * A record becomes an element:
 *
 * - `@`-prefixed keys become attributes, the reserved `#text` key becomes character data, and every other key becomes a child element.
 * - An array repeats its name — a document whose root value is an array wraps it in the root element and names each member `itemName`.
 * - A string is character data. The walk is synchronous, and what can go wrong is reported by throwing an {@link XmlRenderError}; {@link renderXml}
 *   folds that into the effect's typed error channel. A caller not already in an `Effect` runs it with `Effect.runSync`, which throws the failure it
 *   produced.
 *
 * @param value - The value to render.
 * @param options - Root name, formatting, empty-element and name-resolution settings.
 *
 * @returns An effect producing the XML document as a string.
 */
export const renderXml = (value: XmlValue, options: XmlRenderOptions = {}): Effect.Effect<string, XmlRenderError> =>
  Effect.suspend(() => Effect.fromResult(renderResult(value, options)));

/**
 * @description Runs the synchronous walk and folds the one failure it reports into a {@link Result}, which {@link renderXml} turns back into an `Effect`. Kept
 * separate so the walk itself can throw without the public API ever throwing.
 *
 * @param value - The value to render.
 * @param options - The options as the caller wrote them.
 *
 * @returns The document, or the failure to report.
 */
const renderResult = (value: XmlValue, options: XmlRenderOptions): Result.Result<string, XmlRenderError> => {
  try {
    return Result.succeed(render(value, options));
  } catch (cause) {
    return Result.fail(toRenderError(cause));
  }
};

/**
 * @description Reports a failure the synchronous walk threw in the render's own error type. The walk only throws an {@link XmlRenderError} of its own or an
 * {@link XmlParseError} from the name resolver; the latter carries the message the spec asserts on, so it is carried across rather than replaced.
 *
 * @param cause - Whatever was thrown.
 *
 * @returns The failure to report.
 */
const toRenderError = (cause: unknown): XmlRenderError => {
  if (cause instanceof XmlRenderError) return cause;
  if (Predicate.isError(cause)) return new XmlRenderError({ message: cause.message });
  return new XmlRenderError({ message: String(cause) });
};

/**
 * @description The synchronous walk behind {@link renderXml}.
 *
 * @param value - The value to render.
 * @param options - The options as the caller wrote them.
 *
 * @returns The XML document as a string.
 *
 * @throws {XmlRenderError} When the value nests past `maxDepth`, or the name resolver refuses a field name.
 */
const render = (value: XmlValue, options: XmlRenderOptions): string => {
  const resolved = resolveOptions(options);
  const out: Array<string> = [];

  // A document has exactly one root element, so a root value that is an array
  // is wrapped rather than emitted as several roots. Inside a named element an
  // array repeats that element's own name, so this wrapping is the only place
  // `itemName` is ever used.
  if (Array.isArray(value)) {
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
 * @description Renders one named element and its subtree. The value an {@link XmlValue} holds decides which of the four shapes below it takes — a repeated run of
 * children, character data, an absent field, or a record — and each of those is written by a function of its own, so this one is the dispatch rather
 * than the document.
 *
 * @param out - The chunk buffer to append to.
 * @param name - The element name, not yet resolved.
 * @param value - The element's value.
 * @param depth - Current nesting depth, for indentation and the depth cap.
 * @param options - Resolved render options.
 */
const renderElement = (out: Array<string>, name: string, value: XmlValue, depth: number, options: ResolvedOptions): void => {
  assertWithinDepth(depth, options);

  if (Array.isArray(value)) {
    renderRepeated(out, name, value, depth, options);
    return;
  }

  // An element opens its own line rather than having its caller do it, which is
  // what keeps a repeated run of children on separate lines. The root is the
  // one element that has nothing in front of it.
  if (options.format && depth > 0) openLine(out, depth, options);

  const tag = options.namer(name);

  if (Predicate.isString(value) || Predicate.isUndefined(value)) {
    renderLeaf(out, tag, value, options);
    return;
  }

  // The array case returned above; `Predicate.isObject` narrows what is left to
  // a record, since `Array.isArray` alone leaves a `ReadonlyArray` in the union.
  if (!Predicate.isObject(value)) return;
  renderRecord(out, tag, value as XmlRecord, depth, options);
};

/**
 * @description Refuses to walk deeper than the render allows. A value can nest without end, and every one of those levels costs a stack frame here, so the cap is
 * checked on the way down rather than trusted to the caller.
 *
 * @param depth - The depth about to be written.
 * @param options - Resolved render options.
 *
 * @throws {XmlRenderError} When the depth is past the cap.
 */
const assertWithinDepth = (depth: number, options: ResolvedOptions): void => {
  if (depth > options.maxDepth) {
    throw new XmlRenderError({
      message: `XML nesting exceeded maxDepth (${options.maxDepth}). Raise the limit if the document is legitimately this deep.`,
    });
  }
};

/**
 * @description Renders a repeated run of children under one name: `tags: ['a', 'b']` renders `<tags>a</tags><tags>b</tags>`, not one element wrapping both. The
 * name is already the element's own, so a name only has to be supplied where no name is available. Checked before the line break and the name are
 * taken, because the array itself is not an element: opening a line for it as well as for each of its members would leave a blank line where the
 * array was.
 *
 * @param out - The chunk buffer to append to.
 * @param name - The element name, not yet resolved.
 * @param members - The children to write, one after another.
 * @param depth - The depth the run sits at.
 * @param options - Resolved render options.
 */
const renderRepeated = (out: Array<string>, name: string, members: ReadonlyArray<XmlValue>, depth: number, options: ResolvedOptions): void => {
  // An empty array still gets an element. Writing nothing would make a field
  // that was present and empty indistinguishable from one that was never
  // there, and a document that came from a schema is easier to trust when the
  // element it describes is actually in the output.
  if (members.length === 0) {
    if (options.format && depth > 0) openLine(out, depth, options);
    writeEmpty(out, options.namer(name), options);
    return;
  }
  for (const member of members) renderElement(out, name, member, depth, options);
};

/**
 * @description Renders an element whose value is character data, or nothing. An empty string is character data that happens to be empty, and an element holding
 * none of it is the same element as one holding nothing at all — as is an `undefined` element, which is an absent one. The renderer is handed values
 * that never went through the schema — a caller building a document by hand — so the absent case is reachable, and an empty element is the honest
 * rendering of both.
 *
 * @param out - The chunk buffer to append to.
 * @param tag - The element's name, already resolved.
 * @param value - The element's character data, or `undefined` for an absent element.
 * @param options - Resolved render options.
 */
const renderLeaf = (out: Array<string>, tag: string, value: string | undefined, options: ResolvedOptions): void => {
  if (Predicate.isUndefined(value) || value === '') {
    writeEmpty(out, tag, options);
    return;
  }
  out.push('<', tag, '>', escapeText(value), '</', tag, '>');
};

/**
 * @description Renders an element holding a record: the attributes gathered from its `@` keys, the character data from its `#text` key, and its remaining keys as
 * child elements.
 *
 * @param out - The chunk buffer to append to.
 * @param tag - The element's name, already resolved.
 * @param record - The element's value.
 * @param depth - The depth the element sits at.
 * @param options - Resolved render options.
 */
const renderRecord = (out: Array<string>, tag: string, record: XmlRecord, depth: number, options: ResolvedOptions): void => {
  const fields = collectFields(record, options);
  const text = textOf(record);
  const children = fields.children;

  // Self-closing is decided by whether the element has any *content*, not by
  // whether it has attributes: `<a id="1"/>` is the same element as
  // `<a id="1">` with nothing in it, and the short form is what every XML
  // writer produces.
  if (children === undefined && text === '') {
    writeEmpty(out, tag, options, fields.attributes);
    return;
  }

  out.push('<', tag, fields.attributes, '>');

  // Character data sits inline when it is all an element has, and on its own
  // line when the element also has children, so an indented document does not
  // end up with its first line of text glued to its opening tag.
  if (text !== '') {
    if (children !== undefined && options.format) openLine(out, depth + 1, options);
    out.push(escapeText(text));
  }

  if (children !== undefined) {
    writeChildren(out, record, children, depth, options);
    if (options.format) openLine(out, depth, options);
  }

  out.push('</', tag, '>');
};

/**
 * @description An element's keys resolved into the roles they play.
 */
interface Fields {
  /**
   * @description The element's rendered attributes, each with its leading space, or `''` when it has none.
   */
  readonly attributes: string;

  /**
   * @description The names of the child elements, in the order they will be written, or `undefined` when the element has none. `undefined` rather than an empty
   * array because "has children" is one of the two things the self-closing decision turns on, and the other is the text.
   */
  readonly children: Array<string> | undefined;
}

/**
 * @description One pass over a record's keys, collecting all three roles at once: the attributes are rendered as they are found, the child names are set aside for
 * the pass that writes them, and the text key is left to {@link textOf}. A pass for the attributes, a pass for the children and an index for the text
 * instead walks the keys three times and allocates the key array twice, which on a document of a few thousand elements is thousands of allocations
 * for nothing. Sorting is off by default, and the default path is the one that matters, so the attributes are built as they are found and there is
 * nothing to sort. When it is on, the attribute keys are collected instead and rendered afterwards in sorted order, which costs an array per element
 * and buys output that does not depend on the order the fields happened to be declared in.
 *
 * @param record - The element's value.
 * @param options - Resolved render options.
 *
 * @returns The element's rendered attributes and its child names.
 */
const collectFields = (record: XmlRecord, options: ResolvedOptions): Fields => {
  const keys = Object.keys(record);
  let attributes = '';
  let children: Array<string> | undefined;
  const sortAttributes = options.sortKeys ? ([] as Array<string>) : undefined;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    const child = record[key];

    // An absent field is not written at all, which is what keeps an unset
    // optional attribute out of the document rather than in it as `a=""`, and
    // an absent child out of it rather than in it as `<a/>`. The text key is
    // read by `textOf` either way, so skipping it here costs nothing.
    if (child === undefined) continue;

    if (isAttributeKey(key)) {
      // Only keys with a value are collected, so every name in `sortAttributes`
      // has one to read back out of.
      if (sortAttributes === undefined) attributes += renderAttribute(key, child, options);
      else sortAttributes.push(key);
      continue;
    }

    if (!isTextKey(key)) (children ??= []).push(key);
  }

  if (sortAttributes !== undefined) {
    sortAttributes.sort();
    attributes += sortedAttributes(sortAttributes, record, options);
    children?.sort();
  }

  return { attributes, children };
};

/**
 * @description The attributes named by `keys`, rendered in the order given. Only reached when the render was asked to sort keys, where the names are collected
 * during the key pass and written here so their order does not follow the order the fields were declared in.
 *
 * @param keys - The attribute keys to write, in the order to write them.
 * @param record - The element's value, to read the attribute values out of.
 * @param options - Resolved render options.
 *
 * @returns The rendered attributes, each with its leading space.
 */
const sortedAttributes = (keys: ReadonlyArray<string>, record: XmlRecord, options: ResolvedOptions): string => {
  let attributes = '';
  for (const key of keys) attributes += renderAttribute(key, record[key], options);
  return attributes;
};

/**
 * @description One attribute, written whole. The leading space is part of it so the caller can concatenate attributes and the opening tag without a separator of
 * its own.
 *
 * @param key - The attribute's key, with or without its `@` prefix.
 * @param value - The attribute's value.
 * @param options - Resolved render options.
 *
 * @returns The attribute, ready to write inside the opening tag.
 */
const renderAttribute = (key: string, value: XmlValue, options: ResolvedOptions): string => {
  const name = options.namer(attributeName(key));
  return ' ' + name + '="' + escapeAttribute(attributeText(value)) + '"';
};

/**
 * @description Writes an element's children, by name and in the order their keys were found. The names are what the key pass kept; the values are read back out of
 * the record here, because keeping both would mean a second array per element.
 *
 * @param out - The chunk buffer to append to.
 * @param record - The element's value.
 * @param children - The child names, in the order to write them.
 * @param depth - The depth the parent sits at; its children are one deeper.
 * @param options - Resolved render options.
 */
const writeChildren = (out: Array<string>, record: XmlRecord, children: ReadonlyArray<string>, depth: number, options: ResolvedOptions): void => {
  for (let i = 0; i < children.length; i++) {
    const key = children[i] as string;
    const child = record[key];
    if (child === undefined) continue;
    renderElement(out, key, child, depth + 1, options);
  }
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
  out.push(options.lineAt(depth));
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
  if (Predicate.isUndefined(text)) return '';
  return Predicate.isString(text) ? text : renderScalar(text);
};

/**
 * @description An attribute value as the character data it is written as. A bare string is the only sensible shape, since an attribute holds nothing else. A
 * non-string is stringified rather than rejected: the schema is what enforces the field's type, and rejecting here would duplicate that check with a
 * different error and a message that names neither the field nor the document.
 *
 * @param value - The attribute's value.
 *
 * @returns The text to escape and write between the quotes.
 */
const attributeText = (value: XmlValue): string => {
  if (Predicate.isString(value)) return value;
  if (Predicate.isUndefined(value)) return '';
  return renderScalar(value);
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
  if (Predicate.isNull(value)) return 'null';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return ''; // circular or otherwise not representable
  }
};
