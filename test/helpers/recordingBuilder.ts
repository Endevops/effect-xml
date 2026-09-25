import type { ValueParserRegistry } from '@nodable/base-output-builder';
import type { FactoryOptions } from '@nodable/compact-builder';
import type { MatcherView } from 'path-expression-matcher';

import { CompactBuilder, CompactBuilderFactory } from '@nodable/compact-builder';

import type { AttributeMeta, CloseMeta, OutputBuilderLike, TagDetailLike, XmlDeclaration } from '#/internal/parser-types.ts';
import type { X2jOptions } from '#/options.ts';

import XMLParser from '#/XMLParser.ts';

/**
 * @description What a recording builder saw when an element was opened.
 */
export interface TagEvent {
  /**
   * @description Processed tag name.
   */
  name: string;
  /**
   * @description Offset of the opening `<` from document start.
   */
  index: number;
  /**
   * @description Offset immediately after the opening tag's `>`.
   */
  openEnd: number | undefined;
}

/**
 * @description What a recording builder saw when an element was closed.
 */
export interface CloseEvent {
  /**
   * @description Processed name of the tag being closed.
   */
  name: string;
  /**
   * @description Offset of the closing tag's `<`. Absent when the close was synthesized (autoClose at EOF, or `exitIf` unwinding ancestors).
   */
  index?: number | undefined;
  /**
   * @description Offset immediately after the closing tag's `>`. Absent for a synthesized close.
   */
  closeEnd?: number | undefined;
}

/**
 * @description What a recording builder saw when an attribute was flushed.
 */
export interface AttrEvent {
  /**
   * @description Processed attribute name.
   */
  name: string;
  /**
   * @description Raw attribute text, or `true` for a valueless attribute.
   */
  value: unknown;
  /**
   * @description Offset of the attribute's first character from document start. Absent when the tag expression's start offset was unavailable.
   */
  index: number | undefined;
}

/**
 * @description What a recording builder saw when a stop node's raw content was collected.
 */
export interface StopNodeEvent {
  /**
   * @description Processed tag name of the stop node.
   */
  name: string;
  /**
   * @description Raw unparsed text between the stop node's tags.
   */
  content: string;
  /**
   * @description Offset immediately after the stop node's closing `>`.
   */
  end: { index: number };
}

/**
 * @description Everything a {@link RecordingBuilder} intercepted, bucketed by callback. One array per callback, in call order. Buckets rather than a single flat
 * list because the assertions almost always ask "every `item` open tag", which is a filter over one stream — mixing closes and attributes into the
 * same array would make those reads wrong.
 */
export interface RecordingEvents {
  /**
   * @description One record per `addElement()` call.
   */
  tags: TagEvent[];
  /**
   * @description One record per `closeElement()` call.
   */
  closes: CloseEvent[];
  /**
   * @description One record per `addAttribute()` call.
   */
  attrs: AttrEvent[];
  /**
   * @description One record per `onStopNode()` call.
   */
  stopNodes: StopNodeEvent[];
}

/**
 * @description An output builder that records every position-bearing callback, then forwards to a real {@link CompactBuilder}. A decorator rather than a
 * `CompactBuilder` subclass, because the published `CompactBuilder`/`BaseOutputBuilder` types declare `onStopNode` / `onExit` with a tag detail
 * carrying `line` and `col` — a shape this parser's index-only position model never produces — and it declares `closeElement()` with no arguments
 * where the parser always passes a `closeMeta`. Extending those classes and overriding the broken members is unsatisfiable. The parser's real
 * contract is the structural `OutputBuilderLike`, and this satisfies it directly while keeping the real builder's output behaviour byte-for-byte:
 * every call is recorded, then handed straight through.
 */
export class RecordingBuilder implements OutputBuilderLike {
  /**
   * @description The intercepted callbacks.
   */
  readonly events: RecordingEvents;

  private readonly inner: CompactBuilder;

  /**
   * @param events - Buckets to record into.
   * @param parserOptions - Forwarded to the real builder.
   * @param builderOptions - Forwarded to the real builder.
   * @param readonlyMatcher - Forwarded to the real builder.
   * @param registry - Forwarded to the real builder.
   */
  constructor(
    events: RecordingEvents,
    parserOptions: object,
    builderOptions: FactoryOptions,
    readonlyMatcher: MatcherView | null,
    registry: ValueParserRegistry
  ) {
    this.events = events;
    this.inner = new CompactBuilder(parserOptions, builderOptions, readonlyMatcher, registry);
  }

  addElement(tag: TagDetailLike, matcher: MatcherView): void {
    this.events.tags.push({ name: tag.name, index: tag.index, openEnd: tag.openEnd });
    this.inner.addElement(tag, matcher);
  }

  closeElement(matcher: MatcherView, closeMeta?: CloseMeta): void {
    this.events.closes.push({ name: closeMeta?.name as string, index: closeMeta?.index, closeEnd: closeMeta?.closeEnd });
    this.inner.closeElement(matcher, closeMeta);
  }

  addAttribute(name: string, value: unknown, matcher: MatcherView, meta?: AttributeMeta): void {
    this.events.attrs.push({ name, value, index: meta?.index });
    this.inner.addAttribute(name, value, matcher, meta);
  }

  addValue(text: string, matcher: MatcherView): void {
    this.inner.addValue(text, matcher);
  }

  addLiteral(text: string): void {
    this.inner.addLiteral(text);
  }

  addComment(text: string): void {
    this.inner.addComment(text);
  }

  addDeclaration(name: string, xmlDec?: XmlDeclaration): void {
    this.inner.addDeclaration(name, xmlDec);
  }

  addInstruction(name: string): void {
    this.inner.addInstruction(name);
  }

  addInputEntities(entities: Record<string, unknown>): void {
    this.inner.addInputEntities(entities);
  }

  onStopNode(tagDetail: TagDetailLike, rawContent: string, _matcher: MatcherView, end: { index: number }): void {
    this.events.stopNodes.push({ name: tagDetail.name, content: rawContent, end });
    // `onStopNode` and `onExit` are the two members the published builder types
    // get structurally wrong (they demand `line`/`col` the index-only parser
    // never produces), and an interface augmentation can only add an overload,
    // not replace one. The runtime reads just `tagDetail.name` and forwards its
    // own `this.matcher`, so these two calls are safe and the cast is confined
    // to them rather than to every builder the tests build.
    const inner = this.inner as unknown as {
      onStopNode(tagDetail: TagDetailLike, rawContent: string): void;
      onExit(exitInfo: { tagDetail: TagDetailLike; matcher: MatcherView; depth: number }): void;
    };
    inner.onStopNode(tagDetail, rawContent);
  }

  onExit(exitInfo: { tagDetail: TagDetailLike; matcher: MatcherView; depth: number }): void {
    const inner = this.inner as unknown as { onExit(exitInfo: { tagDetail: TagDetailLike; matcher: MatcherView; depth: number }): void };
    inner.onExit(exitInfo);
  }

  getOutput(): unknown {
    return this.inner.getOutput();
  }
}

/**
 * @description An `XMLParser` wired to a {@link RecordingBuilder}, exposing the recorder as a real field. Tests need to read back what the builder intercepted
 * during a parse. Making `_events` a declared field on a one-line subclass gives it a type at every use site, instead of each test casting the parser
 * to reach an ad-hoc property.
 */
export class RecordingXMLParser extends XMLParser {
  /**
   * @description Every position-bearing callback the recording builder saw, bucketed by callback.
   */
  readonly _events: RecordingEvents;

  /**
   * @param options - Parser options, merged ahead of the recording factory.
   * @param events - Buckets to record into.
   */
  constructor(options: X2jOptions, events: RecordingEvents) {
    super({
      ...options,
      OutputBuilder: {
        getInstance(parserOptions, readonlyMatcher) {
          const base = new CompactBuilderFactory();
          return new RecordingBuilder(events, parserOptions, base.builderOptions, readonlyMatcher, base.registry);
        },
      },
    });
    this._events = events;
  }
}

/**
 * @description Build a parser that records everything the output builder sees. `events` is created fresh per call, so a test that runs across all three input
 * mechanisms never sees one run's records mixed into another's — the factory is invoked once per mechanism, and the test reads the parser it was
 * handed.
 *
 * @param parserOptions - Options for this parser, merged ahead of the recording factory.
 *
 * @returns A parser whose `_events` holds this run's records.
 */
export function makeRecordingParser(parserOptions: X2jOptions = {}): RecordingXMLParser {
  return new RecordingXMLParser(parserOptions, { tags: [], closes: [], attrs: [], stopNodes: [] });
}

/**
 * @description Adapt a `CompactBuilder`-shaped object to the parser's structural {@link OutputBuilderLike} contract. The published `@nodable/base-output-builder` /
 * `@nodable/compact-builder` types declare `onStopNode` / `onExit` as taking a tag detail carrying `line` and `col` — a shape this parser's
 * index-only position model never produces — and they declare `addElement(tag)` / `closeElement()` with fewer parameters than the parser actually
 * passes. An interface augmentation can add an overload but cannot replace those members, so any real `CompactBuilder` subclass stays nominally
 * unassignable to the structural contract. The runtime reads only `tagDetail.name` and forwards its own matcher, so the calls are safe. Tests that
 * deliberately exercise old-style builder subclasses (a `closeElement(matcher)`, an `addAttribute(name, value, matcher)`) use this to hand the parser
 * an object it can drive. Behaviour is untouched: the returned object forwards every call to `builder`.
 *
 * @param builder - The builder to adapt.
 */
export function asOutputBuilder(builder: CompactBuilder): OutputBuilderLike {
  const adapted = builder as unknown as {
    onStopNode(tagDetail: TagDetailLike, rawContent: string): void;
    onExit(exitInfo: { tagDetail: TagDetailLike; matcher: MatcherView; depth: number }): void;
  };
  return {
    addElement: (tag, matcher) => builder.addElement(tag, matcher),
    closeElement: (matcher, closeMeta) => builder.closeElement(matcher, closeMeta),
    addValue: (text, matcher) => builder.addValue(text, matcher),
    addLiteral: text => builder.addLiteral(text),
    addComment: text => builder.addComment(text),
    addDeclaration: (name, xmlDec) => builder.addDeclaration(name, xmlDec),
    addInstruction: name => builder.addInstruction(name),
    addInputEntities: entities => builder.addInputEntities(entities),
    addAttribute: (name, value, matcher, meta) => builder.addAttribute(name, value, matcher, meta),
    onStopNode: (tagDetail, rawContent, matcher, end) => adapted.onStopNode(tagDetail, rawContent),
    onExit: exitInfo => adapted.onExit(exitInfo),
    getOutput: () => builder.getOutput(),
  };
}
