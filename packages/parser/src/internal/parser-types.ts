import type { Matcher, MatcherView } from '@endevops/common-xml';

import type { InputSourceLike } from '../input-source/input-source.ts';
import type { ResolvedOptions } from '../options.ts';
import type { TagExpressionConfig } from './tag-expression.ts';

/**
 * @description Structural view of an open tag: where it is, what it is called, and where its expression ended. The synthetic root node and the real `TagDetail`
 * class both satisfy this, which is what lets the stack be typed uniformly even though the root is a plain object with no `openEnd` / `rawName`.
 */
export interface TagDetailLike {
  /**
   * @description Processed tag name — namespace prefix already stripped, already sanitized.
   */
  name: string;
  /**
   * @description Character offset of this tag's `<` from document start.
   */
  index: number;
  /**
   * @description Offset immediately after the opening tag's `>` (after `/>` for self-closing tags). `undefined` until the opening tag has been fully read.
   */
  openEnd: number | undefined;
  /**
   * @description Tag name exactly as written, before prefix stripping — what a matching closing tag literally contains. `undefined` for the synthetic root.
   */
  rawName: string | undefined;
  /**
   * @description `true` only for the synthetic root, which has no matching closing tag and is never reported as an error.
   */
  root?: boolean | undefined;
}

/**
 * @description Position info for a closing tag, handed to `outputBuilder.closeElement()`. `index` and `closeEnd` are optional because not every close has a real
 * closing token: `AutoCloseHandler` synthesizing a close at EOF, and `exitIf` closing already-open ancestors, both pass only a `name`. Builders must
 * therefore treat anything but `name` as possibly absent.
 */
export interface CloseMeta {
  /**
   * @description Processed name of the tag being closed.
   */
  name: string;
  /**
   * @description Offset of the closing tag's `<` from document start. Absent for synthesized closes.
   */
  index?: number | undefined;
  /**
   * @description Offset immediately after the closing tag's `>`. For a stop node this is the end of the whole `</tag>` token.
   */
  closeEnd?: number | undefined;
}

/**
 * @description Absolute document position passed to `addAttribute()` as its last argument.
 */
export interface AttributeMeta {
  /**
   * @description Character offset of the attribute's first character from document start.
   */
  index: number;
}

/**
 * @description One `<?xml … ?>` declaration, as read by `XmlSpecialTagsReader.readPiTag()` and forwarded to `outputBuilder.addDeclaration()`.
 */
export interface XmlDeclaration {
  /**
   * @description Declared XML version — the number `1` / `1.1` the parser normalizes to internally. Selects the `xml-naming` production set used to validate every
   * tag and attribute name in the document.
   */
  version: number;
  /**
   * @description `xml:lang`, or `null` when absent.
   */
  lang: string | null;
  /**
   * @description Declared encoding, or `null` when absent. Informational here — byte decoding is already resolved before parsing starts.
   */
  encoding: string | null;
  /**
   * @description Declared standalone flag, or `null` when absent.
   */
  standalone: string | null;
}

/**
 * @description One `{ name, value, startIndex }` tuple produced by `AttributeProcessor.parseAttributes()`, before any name processing.
 */
export interface RawAttributeMatch {
  /**
   * @description Attribute name exactly as written in the document.
   */
  name: string;
  /**
   * @description Raw attribute text, or `undefined` for a valueless (boolean) attribute.
   */
  value: string | undefined;
  /**
   * @description Offset of the attribute's first character within the attribute expression.
   */
  startIndex: number;
}

/**
 * @description Attribute value plus its offset, pre-computed by `AttributeProcessor` pass 1 and consumed verbatim by pass 2.
 */
export interface ParsedAttribute {
  /**
   * @description Processed attribute name — prefix-stripped, sanitized, reserved-name-checked.
   */
  name: string;
  /**
   * @description Raw attribute text, or `true` for a valueless (boolean) attribute.
   */
  value: string | true;
  /**
   * @description Offset of this attribute's first character within the tag expression.
   */
  index: number;
}

/**
 * @description The output-builder surface the parser drives. Structural rather than a nominal import so any compatible builder — including hand-written ones in
 * tests — satisfies it without extending the published base class.
 */
export interface OutputBuilderLike {
  /**
   * @description Announce an opening tag. Must be paired with exactly one {@link closeElement} unless the builder overrides the tag stack itself.
   */
  addElement(tag: TagDetailLike, matcher: MatcherView): void;
  /**
   * @description Announce a closing tag. `closeMeta` is a plain `{ name }` when there was no real closing token to report a position for.
   */
  closeElement(matcher: MatcherView, closeMeta: CloseMeta): void;
  /**
   * @description Append a text run to the current node, to be run through the builder's value-parser chain.
   */
  addValue(text: string, matcher: MatcherView): void;
  /**
   * @description Append CDATA content, merged into the tag's text value when `nameFor.cdata` is empty.
   */
  addLiteral(text: string): void;
  /**
   * @description Append comment content.
   */
  addComment(text: string): void;
  /**
   * @description Announce the XML declaration, carrying the parsed declaration fields.
   */
  addDeclaration(name: string, xmlDec?: XmlDeclaration): void;
  /**
   * @description Announce a processing instruction.
   */
  addInstruction(name: string): void;
  /**
   * @description Forward entities collected from the DOCTYPE internal subset.
   */
  addInputEntities(entities: Record<string, unknown>): void;
  /**
   * @description Append one attribute to the current tag. `meta` is absent when the tag expression's start offset was unavailable.
   */
  addAttribute(name: string, value: unknown, matcher: MatcherView, meta?: AttributeMeta): void;
  /**
   * @description Called once a stop node's raw content has been collected, before it is added to the tree. Optional. The tag detail is declared permissively (`{
   * name: string } & object`) rather than as `TagDetailLike`: `@nodable/compact-builder` types its own `onStopNode` with a detail carrying
   * `line`/`col` that this index-only parser never produces, and an interface augmentation can only add an overload, never remove one. Requiring just
   * a `name` — all these callbacks actually read — is what lets the bundled `CompactBuilderFactory` be passed as an `OutputBuilder` without a cast,
   * while a builder that wants the position fields still receives them at runtime.
   */
  onStopNode?(tagDetail: { name: string } & object, rawContent: string, matcher?: MatcherView, end?: { index: number }): void;
  /**
   * @description Called instead of normal completion when `exitIf` truncated the parse. Optional.
   */
  onExit?(exitInfo: { tagDetail: { name: string } & object; matcher: MatcherView; depth: number }): void;
  /**
   * @description Finalize and return the parsed tree.
   */
  getOutput(): unknown;
}

/**
 * @description What the parser needs from an output-builder factory: one fresh builder per parse run. Deliberately narrower than `BaseOutputBuilderFactory`. The
 * published base class declares `addElement(tag)` with one parameter while every real implementation — including the base's own subclass chain —
 * takes `(tag, matcher)`, so a `CompactBuilderFactory` is not assignable to the base factory type. Depending on the structural factory keeps both the
 * bundled builders and hand-written ones usable without a cast.
 */
export interface OutputBuilderFactoryLike {
  /**
   * @description Obtain a fresh builder instance. Called by the parser before each parse run.
   */
  getInstance(parserOptions: object, readonlyMatcher: MatcherView | null): OutputBuilderLike;
}

/**
 * @description Live mutable parser state handed to {@link import('../auto-close-handler.ts').AutoCloseHandler}. A live view, not a copy: the handler drives the
 * parser through the same methods the parser itself uses (`addTextNode()`, `popTag()`, `currentTagDetail = …`) so the parser stack and the output
 * builder stay in sync. Every member forwards to the parser instead of duplicating its state, which is why this is an interface with accessors rather
 * than a plain data bag.
 */
export interface ParserState {
  /**
   * @description Live stack of open ancestors, innermost last. Index `0` is the synthetic root.
   */
  readonly tagsStack: TagDetailLike[];
  /**
   * @description The currently open tag, or `null` when nothing is open. Writable — `handleMismatch()` reassigns it after popping toward a match.
   */
  currentTagDetail: TagDetailLike | null;
  /**
   * @description Live output builder instance.
   */
  readonly outputBuilder: OutputBuilderLike;
  /**
   * @description Read-only view of the matcher, for position queries.
   */
  readonly readonlyMatcher: MatcherView;
  /**
   * @description Writable matcher, alongside its read-only view.
   */
  readonly matcher: Matcher;
  /**
   * @description Current input source, for error positions.
   */
  readonly source: InputSourceLike;
  /**
   * @description Text accumulated since the last flushed node. Writable — the partial-tag path discards it.
   */
  tagTextData: string;
  /**
   * @description Bound `Xml2JsParser.addTextNode()`.
   */
  addTextNode(): void;
  /**
   * @description Bound `Xml2JsParser.popTag()`.
   */
  popTag(closeMeta?: CloseMeta): void;
}

/**
 * @description Result of one {@link import('../stop-node-processor.ts').StopNodeProcessor} collection pass.
 */
export interface StopNodeResult {
  /**
   * @description Raw text between the opening and closing tags, never XML-parsed.
   */
  content: string;
  /**
   * @description Position immediately after the matched closing tag's `>`.
   */
  end: { index: number };
}

/**
 * @description Which branch of `Xml2JsParser.readOpeningTag()` created the currently active `StopNodeProcessor`.
 */
export interface StopNodeMeta {
  /**
   * @description The stop/skip node's opening tag.
   */
  tagDetail: TagDetailLike;
  /**
   * @description `true` for a `skip.tags` match (content is collected to advance the source, then discarded), `false` for a `tags.stopNodes` match (content is
   * forwarded to the output builder).
   */
  isSkip: boolean;
}

/**
 * @description A single entry from `AutoCloseHandler.getErrors()` / `XMLParser.getParseErrors()`.
 */
export interface ParseErrorEntry {
  /**
   * @description Which recovery path produced the entry.
   */
  type: 'unclosed-eof' | 'mismatched-close' | 'phantom-close' | 'partial-tag';
  /**
   * @description The tag the entry is about.
   */
  tag: string | null;
  /**
   * @description The tag that was expected instead, or `null`/`undefined` when not applicable.
   */
  expected?: string | null | undefined;
  /**
   * @description Character offset the error was recorded at, or `null` when unavailable.
   */
  index?: number | null | undefined;
}

/**
 * @description Per-tag and per-attribute name caches, shared across every `Xml2JsParser` one `XMLParser` instance creates. Lives on the options object rather than
 * on a parser so a repeated name in a later `parse()` call still hits the cache — `XMLParser.parse()` builds a fresh `Xml2JsParser` every time but
 * passes the same options by reference.
 */
export interface NameCache {
  /**
   * @description Raw tag name as written → processed name.
   */
  tags: Map<string, string>;
  /**
   * @description Raw attribute name as written → processed name.
   */
  attrs: Map<string, string>;
}

/**
 * @description A name validator produced by `xml-naming`'s `createValidator()`.
 */
export type NameValidator = (str: string) => boolean;

/**
 * @description The parser surface the readers need — attribute processing, tag expressions, and the special tags (`readCdata`, `readPiTag`, `readComment`).
 * Declared structurally rather than as a nominal import of `Xml2JsParser`, so no reader module ever has to import the parser back. `Xml2JsParser`
 * satisfies it; every reader takes it as a parameter.
 */
export interface TagExpressionParser {
  /**
   * @description The live input source.
   */
  source: InputSourceLike;
  /**
   * @description Fully-resolved parser options.
   */
  options: ResolvedOptions;
  /**
   * @description Output builder receiving CDATA literals, comment text, and declaration/instruction nodes.
   */
  outputBuilder: OutputBuilderLike;
  /**
   * @description The document's `<?xml ?>` declaration. Written by `readPiTag()`; the version it carries selects the name validators used for the rest of the
   * document.
   */
  xmlDec: XmlDeclaration;
  /**
   * @description Memoized name validators, keyed by production. Assignable because `readPiTag()` must discard them the moment it learns the real XML version — the
   * `'xml'` PI's own name was already validated (and cached) against the '1.0' default.
   */
  _nameValidators: Record<string, NameValidator>;
  /**
   * @description The tag currently being opened, used only to name the tag in a limit-violation message.
   */
  currentTagDetail: TagDetailLike | null;
  /**
   * @description Read-only view of the path matcher at this tag.
   */
  readonlyMatcher: MatcherView;
  /**
   * @description Validate, prefix-resolve and sanitize a raw attribute name. Returns `false` for a dropped `xmlns:` declaration.
   */
  processAttrName(rawAttrName: string): string | false;
  /**
   * @description Validate a tag name against the document's XML version, memoized.
   */
  isValidQName(name: string): boolean;
  /**
   * @description A memoized `xml-naming` validator for one production — `'qName'` for tag and attribute names, `'name'` for DOCTYPE entity and element names.
   * Built lazily on first use and cached for the rest of the document, because the production set depends on the declared XML version, which is not
   * final until the optional `<?xml?>` declaration has been read.
   */
  getNameValidator(production: 'name' | 'qName'): NameValidator;
}

/**
 * @description The `nested` + `skipEnclosures` config a stop-node or skip-tag expression matched, or `null` when nothing matched.
 */
export type TagMatchConfig = TagExpressionConfig | null;
