import { describe, expect, it } from 'vite-plus/test';

import type { X2jOptions } from '#/options.ts';

import XMLParser from '#/xml-parser.ts';

/**
 * @description The three ways a document can be handed to the parser, each of which must produce identical output. The suite runs most behavioural tests across
 * all three, so a bug that only shows up on the chunked `feedable` path (mid-token rewinds, split multi-byte characters) can't hide behind the easy
 * string path.
 */
export type InputSourceType = 'string' | 'buffer' | 'feedable';

/**
 * @description The parsed output tree, shaped so tests can navigate it the way a parsed document actually behaves. A parsed element can be a scalar
 * (`<a>text</a>`), a list of scalars, an object of children, or an array of those for repeated elements — which one a given node is depends entirely
 * on the document, so this type models that honestly instead of inventing a schema. Every property read yields another `ParsedNode`, so traversal
 * goes as deep as the test needs (`result.root.item[0]['@_id']`), and the value a test finally asserts on is compared through the matcher, which
 * accepts anything. Deliberately a record of itself rather than a union with primitives: a union would let you read `result.root` as a `string`, and
 * then `.tag` on it would not type-check — the very first hop of every assertion. The trade-off is that a leaf is typed `ParsedNode` rather than
 * `string | number | …`; in practice leaves are only ever handed to `expect(...).toBe(...)`, which takes `unknown`.
 */
export interface ParsedNode {
  [key: string]: ParsedNode;
}

export interface InputSourceWrapper {
  /**
   * @description Which mechanism this wrapper drives.
   */
  type: InputSourceType;
  /**
   * @description Drive `parser` with the wrapped document and return its output.
   */
  parse(parser: XMLParser): ParsedNode;
}

/**
 * @description Creates an input source wrapper for the given delivery mechanism.
 *
 * @param xmlString - The XML document to parse.
 * @param type - Which mechanism to use: `'string'`, `'buffer'`, or `'feedable'`.
 *
 * @returns A wrapper exposing `type` and a `parse(parser)` that runs the document through a parser instance.
 *
 * @throws {Error} For an unrecognised `type`.
 */
export function createInputSource(xmlString: string, type: InputSourceType): InputSourceWrapper {
  switch (type) {
    case 'string':
      return { type: 'string', parse: parser => parser.parse(xmlString) as ParsedNode };

    case 'buffer':
      return { type: 'buffer', parse: parser => parser.parse(Buffer.from(xmlString)) as ParsedNode };

    case 'feedable':
      return {
        type: 'feedable',
        parse: parser => {
          // Feed one character at a time. This is the harshest chunking the
          // parser can face: every single character is a chunk boundary, so
          // nearly every token gets split across a feed() call and the
          // mark/rewind machinery is exercised on every single test.
          const chunkSize = 1;
          for (let i = 0; i < xmlString.length; i += chunkSize) {
            parser.feed(xmlString.substring(i, i + chunkSize));
          }
          return parser.end() as ParsedNode;
        },
      };

    default:
      // Unreachable through the type — the union is exhausted by the three
      // cases above. Kept because this helper is also called from plain-JS
      // scratch files, and a bad value there should fail with a name rather
      // than silently parse nothing. `String()` is what keeps the linter from
      // reporting the (correct) `never` narrowing as a defect.
      throw new Error(`Unknown input source type: ${String(type)}`);
  }
}

/**
 * @description Callback invoked with each run's parsed output.
 */
export type ResultCallback = (result: ParsedNode) => void;

/**
 * @description Callback that also receives the parser, for tests that inspect `wasExited` or re-parse. Generic in the parser type so a test that supplies an
 * instrumented parser (see `recording-builder.ts`) receives that concrete type in the callback rather than the base `XMLParser`, keeping fields like
 * `_events` typed all the way through.
 */
export type ResultWithParserCallback<TParser extends XMLParser = XMLParser> = (result: ParsedNode, parser: TParser) => void;

/**
 * @description Callback that also receives which input mechanism produced the result.
 */
export type ResultWithTypeCallback = (result: ParsedNode, inputType: InputSourceType) => void;

/**
 * @description Every mechanism a behavioural test is repeated across. Exported so a spec that has to drive the loop itself — a case needing both a custom parser
 * and a throw expectation, which no single runner covers — uses the same list the runners do, instead of re-typing the literal and drifting when a
 * mechanism is added.
 */
export const INPUT_TYPES: readonly InputSourceType[] = ['string', 'buffer', 'feedable'];

/**
 * @description Run a test across every input source, ensuring the parser behaves identically regardless of how the document is delivered.
 *
 * @param testName - Name of the test. The input type is appended in brackets.
 * @param xmlString - XML content to parse.
 * @param testFn - Receives the parsed result and the input type.
 * @param parserOptions - Parser options for each run.
 */
export function runAcrossAllInputSources(testName: string, xmlString: string, testFn: ResultWithTypeCallback, parserOptions: X2jOptions = {}): void {
  INPUT_TYPES.forEach(inputType => {
    it(`${testName} [${inputType}]`, function () {
      const inputSource = createInputSource(xmlString, inputType);
      const parser = new XMLParser(parserOptions);
      const result = inputSource.parse(parser);
      testFn(result, inputSource.type);
    });
  });
}

/**
 * @description Focused variant of {@link runAcrossAllInputSources}, for narrowing the run to one test during debugging. Uses `it.only`, so it excludes every other
 * test in the file while present. Convert to `runAcrossAllInputSources` once the investigation is done — a leftover focus turns the whole file into a
 * single-test run and hides real regressions.
 *
 * @param testName - Name of the test. The input type is appended in brackets.
 * @param xmlString - XML content to parse.
 * @param testFn - Receives the parsed result and the parser.
 * @param parserOptions - Parser options for each run.
 */
export function frunAcrossAllInputSources(
  testName: string,
  xmlString: string,
  testFn: ResultWithParserCallback,
  parserOptions: X2jOptions = {}
): void {
  INPUT_TYPES.forEach(inputType => {
    it.only(`${testName} [${inputType}]`, function () {
      const inputSource = createInputSource(xmlString, inputType);
      const parser = new XMLParser(parserOptions);
      const result = inputSource.parse(parser);
      testFn(result, parser);
    });
  });
}

/**
 * @description Skipped counterpart of {@link runAcrossAllInputSources}, for a case that's documented but not currently asserted.
 *
 * @param testName - Name of the skipped test.
 */
export function xrunAcrossAllInputSources(testName: string): void {
  it.skip(`${testName}`, function () {});
}

/**
 * @description The expected error message for one input mechanism. Supplying an object lets a case expect a different message per mechanism — necessary because
 * the chunked path reports a different position than the one-shot path for the same malformed document.
 */
export type ExpectedError = string | RegExp | { string?: string | RegExp; feedable?: string | RegExp };

/**
 * @description Assert that parsing throws, across every input source.
 *
 * @param testName - Name of the test. The input type is appended in brackets.
 * @param xmlString - XML content that should be rejected.
 * @param errMsg - Expected error, or per-mechanism expectations.
 * @param parserOptions - Parser options for each run.
 */
export function runAcrossAllInputSourcesWithException(
  testName: string,
  xmlString: string,
  errMsg: ExpectedError,
  parserOptions: X2jOptions = {}
): void {
  const { string: stringErrMsg, feedable: feedableErrMsg } = normalizeExpectedError(errMsg);

  INPUT_TYPES.forEach(inputType => {
    it(`${testName} [${inputType}]`, function () {
      const inputSource = createInputSource(xmlString, inputType);
      expect(() => {
        const parser = new XMLParser(parserOptions);
        inputSource.parse(parser);
      }).toThrowError(inputType === 'feedable' ? feedableErrMsg : stringErrMsg);
    });
  });
}

/**
 * @description Flatten the per-mechanism form of an expected error into a `{ string, feedable }` pair. A bare string or RegExp applies to every mechanism. The
 * per-mechanism object form only needs the keys that actually differ; an omitted one falls back to the whole-message form so a partially-specified
 * object is still usable.
 */
function normalizeExpectedError(errMsg: ExpectedError): { string: string | RegExp; feedable: string | RegExp } {
  if (errMsg !== null && typeof errMsg === 'object' && !(errMsg instanceof RegExp) && ('string' in errMsg || 'feedable' in errMsg)) {
    return { string: errMsg.string ?? errMsg.feedable ?? '', feedable: errMsg.feedable ?? errMsg.string ?? '' };
  }
  return { string: errMsg as string | RegExp, feedable: errMsg as string | RegExp };
}

/**
 * @description Builds a parser instance for a test. Used when the parser has to be configured differently per run — a custom builder, a subclass, an instrumented
 * instance. Generic in the parser type for the same reason as {@link ResultWithParserCallback}.
 */
export type ParserFactory<TParser extends XMLParser = XMLParser> = () => TParser;

/**
 * @description Run a test across every input source with a caller-supplied parser, for cases needing a custom builder or an instrumented instance.
 *
 * @param testName - Name of the test. The input type is appended in brackets.
 * @param xmlString - XML content to parse.
 * @param testFn - Receives the parsed result and the parser.
 * @param parserFactory - Produces the parser for each run.
 */
export function runAcrossAllInputSourcesWithFactory<TParser extends XMLParser = XMLParser>(
  testName: string,
  xmlString: string,
  testFn: ResultWithParserCallback<TParser>,
  parserFactory: ParserFactory<TParser>
): void {
  INPUT_TYPES.forEach(inputType => {
    it(`${testName} [${inputType}]`, function () {
      const parser = parserFactory();
      const inputSource = createInputSource(xmlString, inputType);
      const result = inputSource.parse(parser);
      testFn(result, parser);
    });
  });
}

/**
 * @description Focused variant of {@link runAcrossAllInputSourcesWithFactory}, for narrowing the run to one test during debugging. Uses `it.only` — see
 * {@link frunAcrossAllInputSources} for the caveat about leaving one behind.
 *
 * @param testName - Name of the test. The input type is appended in brackets.
 * @param xmlString - XML content to parse.
 * @param testFn - Receives the parsed result and the parser.
 * @param parserFactory - Produces the parser for each run.
 */
export function frunAcrossAllInputSourcesWithFactory(
  testName: string,
  xmlString: string,
  testFn: ResultWithParserCallback,
  parserFactory: ParserFactory
): void {
  INPUT_TYPES.forEach(inputType => {
    it.only(`${testName} [${inputType}]`, function () {
      const parser = parserFactory();
      const inputSource = createInputSource(xmlString, inputType);
      const result = inputSource.parse(parser);
      testFn(result, parser);
    });
  });
}

/**
 * @description Parses `xmlString` through one specific input mechanism.
 */
export type ParseWithSource = (xmlString: string, parserOptions?: X2jOptions) => ParsedNode;

/**
 * @description Re-runs a whole block of tests once per input mechanism, the `describe` counterpart of {@link runAcrossAllInputSources}.
 *
 * @param description - Description of the suite. The input type is appended in brackets.
 * @param fn - Receives a `parseWithSource` helper bound to the current mechanism, plus that mechanism's name.
 */
export function describeAcrossAllInputSources(description: string, fn: (parseWithSource: ParseWithSource, inputType: InputSourceType) => void): void {
  INPUT_TYPES.forEach(inputType => {
    describe(`${description} [${inputType}]`, function () {
      // Bound to this iteration's mechanism, so each describe block parses
      // only through the input type named in its own title.
      const parseWithSource: ParseWithSource = (xmlString, parserOptions = {}) => {
        const parser = new XMLParser(parserOptions);
        const inputSource = createInputSource(xmlString, inputType);
        return inputSource.parse(parser);
      };

      fn(parseWithSource, inputType);
    });
  });
}

/**
 * @description Parse a document and return the tree the tests traverse. `XMLParser.parse()` returns `unknown` on purpose: the output shape is entirely
 * document-driven, so the library has nothing honest to promise. Every test that wants to drill into the result would otherwise repeat `as
 * ParsedNode`, which both clutters the assertions and hides _which_ line is under test. This wraps that one cast in a named function instead.
 *
 * @param parser - The parser to use, so per-test options stay explicit at the call site.
 * @param xml - The document to parse.
 *
 * @returns The parsed tree.
 */
export function parseDoc(parser: XMLParser, xml: string | Buffer): ParsedNode {
  return parser.parse(xml) as ParsedNode;
}

/**
 * @description Finish a {@link XMLParser.feed} session and return the tree the tests traverse. The `feed()` / `end()` counterpart of {@link parseDoc}, for the same
 * reason and with the same `unknown` return from the library.
 *
 * @param parser - A parser that has already been fed a complete document.
 *
 * @returns The parsed tree.
 */
export function endDoc(parser: XMLParser): ParsedNode {
  return parser.end() as ParsedNode;
}

/**
 * @description Parse raw bytes and return the tree the tests traverse. The {@link parseDoc} counterpart for `parseBytesArr()`, which returns `unknown` for the same
 * reason.
 *
 * @param parser - The parser to use.
 * @param bytes - The document, as bytes.
 *
 * @returns The parsed tree.
 */
export function bytesDoc(parser: XMLParser, bytes: Uint8Array | ArrayBufferView): ParsedNode {
  return parser.parseBytesArr(bytes) as ParsedNode;
}

/**
 * @description Await a {@link XMLParser.parseStream} call and return the tree the tests traverse.
 *
 * @param parser - The parser to stream into.
 * @param readable - The stream to read.
 *
 * @returns The parsed tree.
 */
export async function streamDoc(parser: XMLParser, readable: NodeJS.ReadableStream): Promise<ParsedNode> {
  return (await parser.parseStream(readable)) as ParsedNode;
}
