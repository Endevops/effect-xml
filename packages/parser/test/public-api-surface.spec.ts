import { Effect } from 'effect';
import { describe, it, expect } from 'vite-plus/test';

import XMLParser, {
  ErrorCode,
  ParseError,
  quoteEnclosures,
  xmlEnclosures,
  type AttributeOptions,
  type AutoCloseInput,
  type AutoCloseOptions,
  type DecodingOptions,
  type DoctypeOptions,
  type EncodingDecoder,
  type EncodingDescriptor,
  type Enclosure,
  type ErrorCodeValue,
  type ExitIfPredicate,
  type FeedableOptions,
  type LimitsOptions,
  type NameForOptions,
  type ParseErrorEntry,
  type SkipOptions,
  type SkipTagEntry,
  type StopNodeEntry,
  type TagOptions,
  type X2jOptions,
} from '#/index.ts';
import { makeParser, runParser } from '#/test/helpers/test-runner.ts';

/**
 * @description Guards the public entry point. The type half of this spec is checked by the compiler rather than by Vitest, which does not type check, so a dropped
 * `export type` fails `vp check` and never gets as far as running. That is the whole point of writing it this way: the defect being guarded against
 * is a type that exists in a module but is unreachable from the package root, which no runtime assertion can detect. docs/10-typescript.md promises a
 * table of exports. This spec holds the package to it, plus the four types added alongside it, so the documentation and the built .d.mts cannot drift
 * apart without a red build.
 */

describe('Public API surface', function () {
  it('exposes the runtime exports the docs list', function () {
    expect(typeof XMLParser).toBe('function');
    expect(typeof ParseError).toBe('function');
    expect(typeof ErrorCode).toBe('object');
    expect(Array.isArray(xmlEnclosures)).toBe(true);
    expect(Array.isArray(quoteEnclosures)).toBe(true);
  });

  it('types every option group in the docs table', function () {
    // Each binding is a compile-time assertion. The values are deliberately inert; nothing here is parsed.
    const skip: SkipOptions = { attributes: false, nsPrefix: true };
    const nameFor: NameForOptions = { cdata: '#cdata' };
    const attributes: AttributeOptions = { prefix: '@_' };
    const tags: TagOptions = { unpaired: ['br'], stopNodes: [{ expression: 'script' }] };
    const doctypeOptions: DoctypeOptions = { enabled: false };
    const limits: LimitsOptions = { maxNestedTags: 10 };
    const feedable: FeedableOptions = { autoFlush: true };
    const autoClose: AutoCloseInput = 'html';
    const exitIf: ExitIfPredicate = () => Effect.succeed(false);

    const options: X2jOptions = { skip, nameFor, attributes, tags, doctypeOptions, limits, feedable, autoClose, exitIf };

    expect(options.skip?.attributes).toBe(false);
    expect(options.autoClose).toBe('html');
  });

  it('types the entry-object and decoder shapes a caller has to construct', function () {
    const enclosure: Enclosure = { open: '<!--', close: '-->' };
    const skipEntry: SkipTagEntry = { expression: 'a.b', nested: true, skipEnclosures: [enclosure] };
    const stopEntry: StopNodeEntry = { expression: 'a.b' };
    const decoder: EncodingDecoder = { write: () => '', end: () => '' };
    const descriptor: EncodingDescriptor = { name: 'x-test', createDecoder: () => decoder };
    const decoding: DecodingOptions = {};
    const autoCloseFull: AutoCloseOptions = { onEof: 'closeAll', onMismatch: 'discard', collectErrors: true };

    expect(skipEntry.skipEnclosures?.[0]?.open).toBe('<!--');
    expect(stopEntry.expression).toBe('a.b');
    expect(descriptor.createDecoder().end()).toBe('');
    expect(decoding).toEqual({});
    expect(autoCloseFull.onMismatch).toBe('discard');
  });

  it('types the return value of getParseErrors, which was previously unnameable', function () {
    const parser = makeParser({ autoClose: 'html' });
    runParser(parser.parse('<a><b></a>'));

    const errors: ParseErrorEntry[] = runParser(parser.getParseErrors());

    expect(Array.isArray(errors)).toBe(true);
  });

  it('exposes construction and parsing as effects, which is the package contract', function () {
    // The compile-time half: `XMLParser.make` and every entry point answer with an
    // `Effect` whose only failure is a `ParseError`. A dropped `E` would widen a
    // caller's error channel to `never` and make every recovery below unreachable,
    // so the assertion is on the type, not on a value.
    const made: Effect.Effect<XMLParser, ParseError> = XMLParser.make({ autoClose: 'html' });
    const parser: XMLParser = runParser(made);

    const parsed: Effect.Effect<unknown, ParseError> = parser.parse('<root><a>1</a></root>');
    const errors: Effect.Effect<ParseErrorEntry[], never> = parser.getParseErrors();
    const buffered: Effect.Effect<number | null, never> = parser.getFeedBufferLength();
    const threshold: Effect.Effect<number, never> = parser.getFeedBatchThreshold();

    expect(runParser(parsed)).toEqual({ root: { a: 1 } });
    expect(runParser(errors)).toEqual([]);
    expect(runParser(buffered)).toBeNull();
    expect(runParser(threshold)).toBeGreaterThan(0);
  });

  it('narrows ErrorCodeValue to real codes only', function () {
    const code: ErrorCodeValue = ErrorCode.MISMATCHED_CLOSE_TAG;
    const err = new ParseError('boom', code, { index: 4 });

    expect(err.code).toBe('MISMATCHED_CLOSE_TAG');
    expect(err.index).toBe(4);
  });
});
