import type { BuilderError, ValueParserRegistryLike } from '@endevops/builder';
import type { MatcherView } from '@endevops/common-xml';

import { CompactBuilder, CompactBuilderFactory } from '@endevops/builder';
import { Effect } from 'effect';

import type { AttributeMeta, CloseMeta, OutputBuilderLike, TagDetailLike, XmlDeclaration } from '#/internal/parser-types.ts';
import type { ResolvedOptions, X2jOptions } from '#/options.ts';

import { buildOptions } from '#/options-builder.ts';
import { runParser } from '#/test/helpers/test-runner.ts';
import XMLParser from '#/xml-parser.ts';

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
class RecordingBuilder implements OutputBuilderLike {
  /**
   * @description The intercepted callbacks.
   */
  readonly events: RecordingEvents;

  readonly #inner: CompactBuilder;

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
    builderOptions: ConstructorParameters<typeof CompactBuilder>[1],
    readonlyMatcher: MatcherView | null,
    registry: ValueParserRegistryLike
  ) {
    this.events = events;
    this.#inner = new CompactBuilder(parserOptions, builderOptions, readonlyMatcher, registry);
  }

  addElement(tag: TagDetailLike, matcher: MatcherView): void {
    this.events.tags.push({ name: tag.name, index: tag.index, openEnd: tag.openEnd });
    this.#inner.addElement(tag, matcher);
  }

  closeElement(matcher: MatcherView, closeMeta?: CloseMeta): Effect.Effect<void, BuilderError> {
    this.events.closes.push({ name: closeMeta?.name as string, index: closeMeta?.index, closeEnd: closeMeta?.closeEnd });
    return this.#inner.closeElement(matcher, closeMeta);
  }

  addAttribute(name: string, value: unknown, matcher: MatcherView, meta?: AttributeMeta): Effect.Effect<void, BuilderError> {
    this.events.attrs.push({ name, value, index: meta?.index });
    return this.#inner.addAttribute(name, value, matcher, meta);
  }

  addValue(text: string, matcher: MatcherView): void {
    this.#inner.addValue(text, matcher);
  }

  addLiteral(text: string): void {
    this.#inner.addLiteral(text);
  }

  addComment(text: string): void {
    this.#inner.addComment(text);
  }

  addDeclaration(name: string, xmlDec?: XmlDeclaration): void {
    this.#inner.addDeclaration(name, xmlDec);
  }

  addInstruction(name: string): void {
    this.#inner.addInstruction(name);
  }

  addInputEntities(entities: Record<string, unknown>): void {
    this.#inner.addInputEntities(entities);
  }

  onStopNode(tagDetail: TagDetailLike, rawContent: string, _matcher: MatcherView, end: { index: number }): void {
    this.events.stopNodes.push({ name: tagDetail.name, content: rawContent, end });
    // `onStopNode` and `onExit` are the two members the published builder types
    // get structurally wrong (they demand `line`/`col` the index-only parser
    // never produces), and an interface augmentation can only add an overload,
    // not replace one. The runtime reads just `tagDetail.name` and forwards its
    // own `this.matcher`, so these two calls are safe and the cast is confined
    // to them rather than to every builder the tests build.
    const inner = this.#inner as unknown as {
      onStopNode(tagDetail: TagDetailLike, rawContent: string): void;
      onExit(exitInfo: { tagDetail: TagDetailLike; matcher: MatcherView; depth: number }): void;
    };
    inner.onStopNode(tagDetail, rawContent);
  }

  onExit(exitInfo: { tagDetail: TagDetailLike; matcher: MatcherView; depth: number }): void {
    const inner = this.#inner as unknown as { onExit(exitInfo: { tagDetail: TagDetailLike; matcher: MatcherView; depth: number }): void };
    inner.onExit(exitInfo);
  }

  getOutput(): unknown {
    return this.#inner.getOutput();
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
   * @param resolved - Fully-resolved parser options, from `buildOptions()`.
   * @param events - Buckets to record into.
   */
  constructor(resolved: ResolvedOptions, events: RecordingEvents) {
    super(resolved);
    this._events = events;
  }
}

/**
 * @description Build a parser that records everything the output builder sees. `events` is created fresh per call, so a test that runs across all three input
 * mechanisms never sees one run's records mixed into another's — the factory is invoked once per mechanism, and the test reads the parser it was
 * handed. Three effects meet here, which is the honest shape of the thing rather than an accident: the parser's options are resolved by
 * `buildOptions`, the wrapped builder's by `CompactBuilderFactory.make`, and the recording factory is installed into the already-resolved options.
 * Each is run for its value, so a failure surfaces as the thrown `ParseError` / `BuilderError` a test can assert on.
 *
 * @param parserOptions - Options for this parser, merged ahead of the recording factory.
 *
 * @returns A parser whose `_events` holds this run's records.
 */
export function makeRecordingParser(parserOptions: X2jOptions = {}): RecordingXMLParser {
  const events: RecordingEvents = { tags: [], closes: [], attrs: [], stopNodes: [] };
  const base = runParser(CompactBuilderFactory.make());
  const resolved = runParser(
    buildOptions({
      ...parserOptions,
      OutputBuilder: {
        getInstance: (builderParserOptions, readonlyMatcher) =>
          Effect.succeed(new RecordingBuilder(events, builderParserOptions, base.builderOptions, readonlyMatcher, base.registry)),
      },
    })
  );
  return new RecordingXMLParser(resolved, events);
}

/**
 * @description Adapt a `CompactBuilder`-shaped object to the parser's structural {@link OutputBuilderLike} contract. A real `CompactBuilder` now satisfies
 * `OutputBuilderLike` directly, so this is not a shim for a type mismatch. It exists for the tests that deliberately drive deliberately old-style
 * builder subclasses — a `closeElement(matcher)` with no close metadata, an `addAttribute(name, value, matcher)` with no attribute meta — and want
 * the parser's own adapter rather than a hand-written one. It is also the clearest place to see the full builder contract in one list. History, since
 * the reason it used to be load-bearing is not obvious: the `@nodable` packages published a hand-written `index.d.ts` that declared `onStopNode` and
 * `onExit` as taking a tag detail carrying `line` and `col` — a shape this parser's index-only position model never produces — and declared
 * `addElement(tag)` and `closeElement()` with fewer parameters than the parser actually passes. An interface augmentation could add an overload but
 * not replace those members, so a real `CompactBuilder` subclass was nominally unassignable to the structural contract. `src/nodable-builders.d.ts`
 * carried that augmentation. The workspace packages now declare the arity the parser genuinely calls with, the augmentation is deleted, and the cast
 * this function needed is gone.
 *
 * @param builder - The builder to adapt.
 */
export function asOutputBuilder(builder: CompactBuilder): OutputBuilderLike {
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
    onStopNode: (tagDetail, rawContent) => builder.onStopNode(tagDetail, rawContent),
    onExit: exitInfo => builder.onExit(exitInfo),
    getOutput: () => builder.getOutput(),
  };
}
