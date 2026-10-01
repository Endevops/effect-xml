/**
 * @description The input-source matrix: most parser behaviour must be identical no matter how the document reaches the parser, so a case is registered once and
 * run three times — as a `string`, as a `Buffer`, and as a one-character-at-a-time `feed()`/`end()` session. The runners below are plain functions
 * that register `it.effect` tests; they exist for the matrix, not to hide Effect. A spec that wants to drive a parser itself uses `yield*` on the
 * parser's own effects, exactly as the `@effect/vitest` tests do.
 */

import { assert, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { X2jOptions } from '#/options.ts';
import type { ParseError } from '#/parse-error.ts';

import { XMLParser } from '#/xml-parser.ts';

/**
 * @description The three ways a document can be handed to the parser, each of which must produce identical output.
 */
export type InputSourceType = 'string' | 'buffer' | 'feedable';

/**
 * @description Every mechanism a behavioural test is repeated across.
 */
export const INPUT_TYPES: ReadonlyArray<InputSourceType> = ['string', 'buffer', 'feedable'];

/**
 * @description The parsed output tree. A parsed element can be a scalar, a list of scalars, an object of children, or an array of those for repeated elements, so
 * this models it as a record of itself and leaves the leaf comparisons to `expect`, which accepts `unknown`.
 */
export interface ParsedNode {
  [key: string]: ParsedNode;
}

/**
 * @description Parser options, either as a plain object or as an `Effect` when building them needs effects of its own — a compiled builder, an `Expression`.
 * Resolved inside the test so the effect runs on the test's fiber rather than at module load.
 */
export type ParserOptionsInput = X2jOptions | Effect.Effect<X2jOptions, ParseError>;

const resolveOptions = (options: ParserOptionsInput): Effect.Effect<X2jOptions, ParseError> =>
  Effect.isEffect(options) ? options : Effect.succeed(options);

/**
 * @description Drive one parser with a document through one input mechanism.
 *
 * @param parser - The parser to drive.
 * @param xmlString - The document.
 * @param inputType - Which mechanism to use.
 *
 * @returns The parsed output, or the `ParseError` the parser raised.
 */
export function parseInput(parser: XMLParser, xmlString: string, inputType: InputSourceType): Effect.Effect<unknown, ParseError> {
  switch (inputType) {
    case 'string':
      return parser.parse(xmlString);

    case 'buffer':
      return parser.parse(Buffer.from(xmlString));

    case 'feedable':
      return Effect.gen(function* () {
        // One character at a time is the harshest chunking the parser can
        // face: nearly every token is split across a feed() call, so the
        // mark/rewind machinery is exercised on every case.
        for (let i = 0; i < xmlString.length; i++) {
          yield* parser.feed(xmlString[i]!);
        }
        return yield* parser.end();
      });
  }
}

/**
 * @description The callback a matrix case runs: assertions on the parsed result, with the parser available for any read-back.
 */
export type MatrixTestFn = (result: ParsedNode, parser: XMLParser, inputType: InputSourceType) => void;

/**
 * @description Run a case across every input source. The parser is built inside the test, so options that need effects can be passed as an `Effect`.
 *
 * @param testName - Name of the case. The input type is appended in brackets.
 * @param xmlString - XML content to parse.
 * @param testFn - Receives the parsed result, the parser, and the input type.
 * @param parserOptions - Parser options, or an effect producing them.
 */
export function runAcrossAllInputSources(testName: string, xmlString: string, testFn: MatrixTestFn, parserOptions: ParserOptionsInput = {}): void {
  INPUT_TYPES.forEach(inputType => {
    it.effect(`${testName} [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* XMLParser.make(yield* resolveOptions(parserOptions));
        const result = yield* parseInput(parser, xmlString, inputType);
        testFn(result as ParsedNode, parser, inputType);
      })
    );
  });
}

/**
 * @description The expected error message for one input mechanism. Supplying an object lets a case expect a different message per mechanism, because the chunked
 * path reports a different position than the one-shot path for the same malformed document.
 */
export type ExpectedError = string | RegExp | { string?: string | RegExp; feedable?: string | RegExp };

/**
 * @description Assert that parsing fails, across every input source.
 *
 * @param testName - Name of the case. The input type is appended in brackets.
 * @param xmlString - XML content that should be rejected.
 * @param errMsg - Expected error, or per-mechanism expectations.
 * @param parserOptions - Parser options, or an effect producing them.
 */
export function runAcrossAllInputSourcesWithException(
  testName: string,
  xmlString: string,
  errMsg: ExpectedError,
  parserOptions: ParserOptionsInput = {}
): void {
  const { string: stringErrMsg, feedable: feedableErrMsg } = normalizeExpectedError(errMsg);

  INPUT_TYPES.forEach(inputType => {
    it.effect(`${testName} [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* XMLParser.make(yield* resolveOptions(parserOptions));
        const result = yield* parseInput(parser, xmlString, inputType).pipe(Effect.result);
        assert(Result.isFailure(result));
        expect(result.failure.message).toMatch(inputType === 'feedable' ? feedableErrMsg : stringErrMsg);
      })
    );
  });
}

/**
 * @description A callback that also receives the parser, for cases that inspect a custom or instrumented instance.
 */
export type FactoryTestFn<TParser extends XMLParser = XMLParser> = (result: ParsedNode, parser: TParser, inputType: InputSourceType) => void;

/**
 * @description Produces the parser for one run. An effect, because building a parser (or the instrumented builder inside it) can fail.
 */
export type ParserFactory<TParser extends XMLParser = XMLParser> = () => Effect.Effect<TParser, ParseError>;

/**
 * @description Run a case across every input source with a caller-supplied parser.
 *
 * @param testName - Name of the case. The input type is appended in brackets.
 * @param xmlString - XML content to parse.
 * @param testFn - Receives the parsed result and the parser.
 * @param parserFactory - Produces the parser for each run.
 */
export function runAcrossAllInputSourcesWithFactory<TParser extends XMLParser = XMLParser>(
  testName: string,
  xmlString: string,
  testFn: FactoryTestFn<TParser>,
  parserFactory: ParserFactory<TParser>
): void {
  INPUT_TYPES.forEach(inputType => {
    it.effect(`${testName} [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* parserFactory();
        const result = yield* parseInput(parser, xmlString, inputType);
        testFn(result as ParsedNode, parser, inputType);
      })
    );
  });
}

/**
 * @description Whether the expected error was given in the per-mechanism `{ string, feedable }` form, as opposed to a bare string or RegExp. A `RegExp` is an
 * object and would otherwise match the first half of the test, so it is excluded explicitly.
 *
 * @param errMsg - The caller's expectation.
 *
 * @returns `true` when `errMsg` is the per-mechanism object form.
 */
function isPerMechanismError(errMsg: ExpectedError): errMsg is { string?: string | RegExp; feedable?: string | RegExp } {
  if (errMsg === null || typeof errMsg !== 'object' || errMsg instanceof RegExp) return false;
  return 'string' in errMsg || 'feedable' in errMsg;
}

/**
 * @description Flatten the per-mechanism form of an expected error into a `{ string, feedable }` pair. A bare string or RegExp applies to every mechanism; an
 * omitted key in the object form falls back to the other, so a partially-specified object is still usable.
 *
 * @param errMsg - The caller's expectation.
 *
 * @returns The expectation to apply to each mechanism.
 */
function normalizeExpectedError(errMsg: ExpectedError): { string: string | RegExp; feedable: string | RegExp } {
  if (!isPerMechanismError(errMsg)) return { string: errMsg as string | RegExp, feedable: errMsg as string | RegExp };

  const { string, feedable } = errMsg;
  return { string: string ?? feedable ?? '', feedable: feedable ?? string ?? '' };
}
