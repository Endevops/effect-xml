import { Context, Effect, Layer } from 'effect';

import type { ReadableLike } from './input-source/stream-source.ts';
import type { ParseErrorEntry } from './internal/parser-types.ts';
import type { ResolvedOptions, X2jOptions } from './options.ts';
import type { ParseError } from './parse-error.ts';

import { defaultEncodingRegistry, makeEncodingRegistry } from './encoding/encoding-registry.ts';
import FeedableSource from './input-source/feedable-source.ts';
import StreamSource, { isReadableStream } from './input-source/stream-source.ts';
import { buildOptions } from './options-builder.ts';
import { ErrorCode, InvalidInput, InvalidStream, NotStreaming, isParseError, toParseError } from './parse-error.ts';
import { absolutePosition } from './util.ts';
import Xml2JsParser from './xml2-js-parser.ts';

/**
 * @description XMLParser — the public entry point. Owns the resolved options, the shared name cache, and the three ways to get a document in: one-shot
 * ({@link XMLParser.parse}, {@link XMLParser.parseBytesArr}), streaming ({@link XMLParser.parseStream}), and incremental ({@link XMLParser.feed} /
 * {@link XMLParser.end}). Every one of those paths builds a fresh {@link Xml2JsParser} per document; the state that should survive between calls
 * (resolved options, name cache, `wasExited`, the last run's structural errors) lives here.
 *
 * ## Why construction is `XMLParser.make` and not `new XMLParser`
 *
 * A parser is configured, not merely allocated: its options are validated, a reserved property name is refused, and every stop-node and skip-tag path
 * expression is compiled and sealed into an indexed set. All of that can fail, and a constructor has nowhere to put an error channel — the choice is
 * between throwing and hiding the failure. So configuration is an effect, and {@link XMLParser.make} is the way in. The walk itself is a different
 * matter. {@link XMLParser.parse} and friends read the document character by character, and the readers inside it still raise `ParseError` by
 * throwing — routing every tag through a generator would cost an allocation per tag to deliver a failure the caller has not been told about yet. The
 * boundary is here: each entry point wraps the walk and converts anything that escaped into the `E` channel, so from the outside the whole package
 * speaks one language.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import XMLParser from '@endevops/parser';
 *
 *   const result = Effect.runSync(
 *     Effect.flatMap(XMLParser.make({ tags: { stopNodes: ['..script'] } }), parser =>
 *       Effect.gen(function* () {
 *         yield* parser.feed('<root><script>alert(1)</script>');
 *         return yield* parser.end();
 *       }),
 *     ),
 *   );
 *   ```;
 */
export interface XMLParser {
  /**
   * @description Fully-resolved options, built once by {@link XMLParser.make} and shared by reference with every `Xml2JsParser` this instance creates.
   */
  readonly options: ResolvedOptions;
  /**
   * @description Whether the last parse call was terminated early by `exitIf`.
   */
  wasExited: boolean;
  /**
   * @description Parse an XML string or byte array and produce a JS object.
   *
   * @param xmlData - The document, as a string or as bytes. Bytes are routed through the encoding-aware path so a configured `decoding.encoding`
   *   isn't silently ignored.
   *
   * @returns An effect producing the built output. Fails with a `ParseError` on any well-formedness or limit violation.
   */
  parse<T>(xmlData: string | ArrayBufferView | { toString(): string }): Effect.Effect<T, ParseError>;
  /**
   * @description Parse a Uint8Array / byte array and produce a JS object.
   *
   * @param xmlData - The document, as bytes.
   *
   * @returns An effect producing the built output. Fails with `INVALID_INPUT` for a non-view argument, or with whatever the walk itself reports.
   */
  parseBytesArr(xmlData: Uint8Array | ArrayBufferView): Effect.Effect<unknown, ParseError>;
  /**
   * @description Parse an XML Node.js Readable stream and produce a JS object.
   *
   * @param readable - The stream to read from.
   *
   * @returns An effect producing the built output.
   */
  parseStream(readable: ReadableLike): Effect.Effect<unknown, ParseError>;
  /**
   * @description Feed an XML data chunk for incremental parsing.
   *
   * @param data - The next chunk, as a string or as bytes.
   *
   * @returns An effect producing `this`, for chaining. Fails with `DATA_MUST_BE_STRING` if data is not a string or a byte array, and with any parse
   *   error the pass over the accumulated input hit.
   */
  feed(data: string | Uint8Array): Effect.Effect<XMLParser, ParseError>;
  /**
   * @description Signal end of input, validate end-of-document state, and produce the parsed result.
   *
   * @returns An effect producing the parsed output.
   */
  end(): Effect.Effect<unknown, ParseError>;
  /**
   * @description Structural errors collected during the last parse call.
   *
   * @returns An effect producing the collected entries. Infallible.
   */
  getParseErrors(): Effect.Effect<Array<ParseErrorEntry>>;
  /**
   * @description Characters currently retained in the incremental-parse buffer, or `null` when no `feed()` session is open.
   *
   * @returns An effect producing the retained character count, or `null`. Infallible.
   */
  getFeedBufferLength(): Effect.Effect<number | null>;
  /**
   * @description The pending-byte count at which the next `feed()` triggers a parse pass.
   *
   * @returns An effect producing the current threshold. Infallible.
   */
  getFeedBatchThreshold(): Effect.Effect<number>;
}

/**
 * @description The mutable state one parser instance owns between calls. Built once by {@link createParserService}, it survives repeated `parse()` calls and a
 * `feed()`/`end()` session so the resolved options and the shared name cache are paid for once rather than per document.
 */
interface ParserState {
  options: ResolvedOptions;
  wasExited: boolean;
  // feed()/end() session state
  feedParser: Xml2JsParser | null;
  feedSource: FeedableSource | null;
  isFeeding: boolean;
  // ── Batching state ──
  pendingBytes: number;
  batchThreshold: number;
  // Structural errors from the last run, populated only when autoClose.collectErrors is on.
  lastParseErrors: Array<ParseErrorEntry>;
}

/**
 * @description Assemble a parser around options that have already been validated, defaulted and compiled. Takes a `ResolvedOptions` rather than the caller's
 * `X2jOptions` because that is what {@link buildOptions} produces, and a caller cannot: resolving is where the security checks, the defaults and the
 * expression compilation live, and skipping it would hand the parser an object missing every field it reads. Prefer {@link XMLParser.make}.
 *
 * @param resolved - Fully-resolved options, from `buildOptions()`.
 *
 * @returns The parser service.
 */
const createParserService = (resolved: ResolvedOptions): XMLParser => {
  const state: ParserState = {
    options: resolved,
    wasExited: false,
    feedParser: null,
    feedSource: null,
    isFeeding: false,
    pendingBytes: 0,
    batchThreshold: resolved.feedable?.bufferSize,
    lastParseErrors: [],
  };

  // Per-instance encoding registry only when custom decoders are supplied
  // — avoids mutating the shared default registry (which would leak a
  // customDecoder registered on one XMLParser instance into every other
  // instance in the process). The common case (no customDecoders) reuses
  // the shared default registry, seeded once at module load.
  if (state.options.decoding?.customDecoders) {
    const registry = makeEncodingRegistry();
    for (const [name, descriptor] of Object.entries(state.options.decoding.customDecoders)) {
      // The map key is authoritative for `name`; spread first so a
      // descriptor that also carries `name` can't override the key.
      registry.register({ ...descriptor, name });
    }
    state.options.decoding._registry = registry;
  } else {
    state.options.decoding = state.options.decoding || {};
    state.options.decoding._registry = defaultEncodingRegistry;
  }

  // Shared tag/attribute name cache — lives on `options`, not on any one
  // Xml2JsParser instance, because `.parse()` creates a fresh Xml2JsParser
  // every call while `state.options` is passed by reference to all of them.
  // This lets repeated names skip re-validation/re-sanitization across
  // separate parse() calls on the same parser instance, not just within
  // one document.
  state.options._nameCache = { tags: new Map(), attrs: new Map() };

  /**
   * @description Build a fresh walker for one document.
   */
  const createParser = (): Xml2JsParser => new Xml2JsParser(state.options);

  /**
   * @description Run the parser over whatever has accumulated so far, rewinding on a chunk boundary so the incomplete token is retried on the next `feed()`. Also
   * owns the batching heuristic: if the last pass made no progress — the parser is stuck mid-token — the byte threshold is doubled, up to
   * `feedable.maxBufferSize`.
   */
  const runParse = (): void => {
    if (!state.feedParser || !state.feedSource) return;

    const beforePos = absolutePosition(state.feedSource); // bytes consumed so far, flush-proof

    try {
      state.feedParser.parseXml();
    } catch (err) {
      if (isParseError(err) && err._tag === ErrorCode.UNEXPECTED_END) {
        state.feedSource.rewindToMark();
      } else {
        throw err;
      }
    }

    const afterPos = absolutePosition(state.feedSource);
    const didAdvance = afterPos > beforePos;

    if (didAdvance) {
      // Real progress made — reset threshold normally
      state.pendingBytes = 0;
      state.batchThreshold = state.options.feedable.bufferSize;
    } else {
      // Parser is stuck mid-token — grow the threshold to avoid
      // hammering parseXml() until significantly more data arrives
      state.batchThreshold = Math.min(state.batchThreshold * 2, state.options.feedable.maxBufferSize);
    }
  };

  /**
   * @description Open a `feed()`/`end()` session: a fresh feedable source and a fresh walker wired to it.
   */
  const initFeedSession = (): void => {
    state.feedSource = new FeedableSource({
      ...state.options.feedable,
      decoding: { encoding: state.options.decoding.encoding, registry: state.options.decoding._registry },
    });
    state.feedParser = createParser();
    state.feedParser.source = state.feedSource;
    state.feedParser.initializeParser();
    state.isFeeding = true;
  };

  /**
   * @description Close a `feed()`/`end()` session.
   */
  const cleanupFeedSession = (): void => {
    state.feedParser = null;
    state.feedSource = null;
    state.isFeeding = false;
  };

  const parser: XMLParser = {
    get options() {
      return state.options;
    },
    get wasExited() {
      return state.wasExited;
    },
    set wasExited(value: boolean) {
      state.wasExited = value;
    },

    /**
     * @description Parse an XML string or byte array and produce a JS object.
     */
    parse<T>(xmlData: string | ArrayBufferView | { toString(): string }): Effect.Effect<T, ParseError> {
      if (ArrayBuffer.isView(xmlData)) {
        // Route through the encoding-aware path (auto-detect / configured
        // `decoding.encoding`) instead of an unconditional utf8 decode —
        // otherwise a non-utf8 `decoding.encoding` option would silently be
        // ignored for byte input given directly to parse().
        return parser.parseBytesArr(xmlData) as Effect.Effect<T, ParseError>;
      } else if (typeof xmlData !== 'string') {
        if (xmlData && typeof xmlData.toString === 'function') {
          xmlData = xmlData.toString();
        } else {
          return new InvalidInput({ option: 'xmlData', received: typeof xmlData, message: 'XML data must be a string or a byte array.' });
        }
      }

      return Effect.try({
        try: () => {
          const created = createParser();
          const result = created.parse(xmlData as string);
          state.wasExited = created.wasExited();
          state.lastParseErrors = created.autoCloseHandler?.getErrors() ?? [];
          return result;
        },
        catch: toParseError,
      }) as Effect.Effect<T, ParseError>;
    },

    /**
     * @description Parse a Uint8Array / byte array and produce a JS object.
     */
    parseBytesArr(xmlData: Uint8Array | ArrayBufferView): Effect.Effect<unknown, ParseError> {
      if (!ArrayBuffer.isView(xmlData)) {
        return new InvalidInput({ option: 'xmlData', received: typeof xmlData, message: 'XML data must be a Uint8Array or ArrayBufferView.' });
      }
      // A view, not a copy: `Buffer.from(buffer, offset, length)` used to do the same
      // thing, and `new Uint8Array(...)` over the same three arguments is the identical
      // zero-copy window onto the caller's memory. `BufferSource` decodes it
      // immediately and never retains it, so there is no aliasing hazard.
      const bytes = new Uint8Array(xmlData.buffer, xmlData.byteOffset, xmlData.byteLength);

      return Effect.try({
        try: () => {
          const created = createParser();
          const result = created.parseBytesArr(bytes);
          state.wasExited = created.wasExited();
          state.lastParseErrors = created.autoCloseHandler?.getErrors() ?? [];
          return result;
        },
        catch: toParseError,
      });
    },

    /**
     * @description Parse an XML Node.js Readable stream and produce a JS object.
     */
    parseStream(readable: ReadableLike): Effect.Effect<unknown, ParseError> {
      if (!isReadableStream(readable)) {
        return new InvalidStream({ message: 'parseStream() requires a Node.js Readable stream.' });
      }

      const source = new StreamSource({
        ...state.options.feedable,
        decoding: { encoding: state.options.decoding.encoding, registry: state.options.decoding._registry },
      });
      const streamParser = createParser();
      streamParser.source = source;
      streamParser.initializeParser();

      return Effect.callback<unknown, ParseError>(resume => {
        let settled = false;
        const fail = (err: unknown) => {
          if (!settled) {
            settled = true;
            readable.destroy?.(); // stop further data/end events and free the handle
            resume(Effect.fail(toParseError(err)));
          }
        };

        source.attachStream(
          readable,
          err => {
            if (err) {
              fail(err);
              return;
            }
            try {
              streamParser.parseXml();
            } catch (parseErr) {
              if (isParseError(parseErr) && parseErr._tag === ErrorCode.UNEXPECTED_END) {
                source.rewindToMark();
              } else {
                fail(parseErr);
              }
            }
          },
          () => {
            if (settled) return;
            try {
              streamParser.parseXml();
              streamParser.finalizeXml();
              state.lastParseErrors = streamParser.autoCloseHandler?.getErrors() ?? [];
              state.wasExited = streamParser.wasExited();
              settled = true;
              resume(Effect.succeed(streamParser.outputBuilder.getOutput()));
            } catch (err) {
              fail(err);
            }
          },
          fail
        );
      });
    },

    /**
     * @description Feed an XML data chunk for incremental parsing.
     */
    feed(data: string | Uint8Array): Effect.Effect<XMLParser, ParseError> {
      return Effect.try({
        try: () => {
          if (!state.isFeeding) {
            initFeedSession();
          }
          const source = state.feedSource as FeedableSource;

          // Pass raw data straight through — do NOT pre-convert byte chunks to
          // string here. FeedableSource.feed() decodes them via a persistent
          // stateful decoder so a multi-byte UTF-8 character split across two
          // feed() calls decodes correctly.
          const appendedLength = source.feed(data);
          state.pendingBytes += appendedLength;

          if (state.pendingBytes >= state.batchThreshold) {
            runParse();
          }
          // Otherwise, delay parsing until next feed() or end()

          return parser;
        },
        catch: toParseError,
      });
    },

    /**
     * @description Signal end of input, validate end-of-document state, and produce the parsed result.
     */
    end(): Effect.Effect<unknown, ParseError> {
      if (!state.isFeeding) {
        return new NotStreaming({ message: 'No data fed. Call feed() before end().' });
      }
      const feedParser = state.feedParser as Xml2JsParser;
      const source = state.feedSource as FeedableSource;

      return Effect.try({
        try: () => {
          // Force a final parse (any pending bytes are now processed)
          runParse();

          try {
            // Mark the source as complete so readers know there is no more data.
            source.end();

            let partialTagError: ParseError | null = null;
            const autoClose = feedParser.autoCloseHandler;
            if (autoClose) autoClose.reset();

            try {
              feedParser.parseXml();
            } catch (err) {
              if (isParseError(err) && err._tag === ErrorCode.UNEXPECTED_END) {
                if (autoClose) {
                  partialTagError = err;
                } else {
                  throw err;
                }
              } else {
                throw err;
              }
            }

            if (partialTagError) {
              autoClose?.handlePartialTag(partialTagError, feedParser._parserState());
            } else {
              feedParser.finalizeXml();
            }

            state.lastParseErrors = autoClose?.getErrors() ?? [];
            state.wasExited = feedParser.wasExited();
            return feedParser.outputBuilder.getOutput();
          } finally {
            cleanupFeedSession();
          }
        },
        catch: toParseError,
      });
    },

    /**
     * @description Structural errors collected during the last parse call.
     */
    getParseErrors(): Effect.Effect<Array<ParseErrorEntry>> {
      return Effect.succeed(state.lastParseErrors ?? []);
    },

    /**
     * @description Characters currently retained in the incremental-parse buffer, or `null` when no `feed()` session is open.
     */
    getFeedBufferLength(): Effect.Effect<number | null> {
      return Effect.succeed(state.feedSource === null ? null : state.feedSource.buffer.length);
    },

    /**
     * @description The pending-byte count at which the next `feed()` triggers a parse pass.
     */
    getFeedBatchThreshold(): Effect.Effect<number> {
      return Effect.succeed(state.batchThreshold);
    },
  };

  return parser;
};

/**
 * @description The `XMLParser` service key. The interface above is what a parser _is_; this is the tag a program yields and the static entry points a caller uses.
 */
class XMLParserTag extends Context.Service<XMLParserTag, XMLParser>()('@endevops/parser/XMLParser') {
  /**
   * @description Build a new XMLParser from the caller's options.
   *
   * @param options - User options. Omit for defaults.
   *
   * @returns An effect producing the parser. Fails with a `ParseError`: `INVALID_INPUT` for a malformed `limits`, `exitIf`, or stop-node entry,
   *   `SECURITY_RESERVED_OPTION` for an option value that would become a reserved JavaScript property key, and `DEPENDENCY_ERROR` for a path
   *   expression `@endevops/common-xml` refuses to compile.
   */
  static make(options?: X2jOptions): Effect.Effect<XMLParser, ParseError> {
    return Effect.map(buildOptions(options), resolved => createParserService(resolved));
  }

  /**
   * @description The parser as a `Layer`, for callers wiring it through the Effect environment.
   *
   * @param options - User options. Omit for defaults.
   *
   * @returns A layer providing {@link XMLParser}.
   */
  static layer(options?: X2jOptions): Layer.Layer<XMLParserTag, ParseError> {
    return Layer.effect(XMLParserTag, XMLParserTag.make(options));
  }

  /**
   * @description Build a parser around options that have already been validated, defaulted and compiled. Takes a `ResolvedOptions` rather than the caller's
   * `X2jOptions` because that is what {@link XMLParser.make} produces, and a caller cannot: resolving is where the security checks, the defaults and
   * the expression compilation live. Prefer {@link XMLParser.make}.
   *
   * @param resolved - Fully-resolved options, from `buildOptions()`.
   *
   * @returns The parser service.
   */
  static fromResolved(resolved: ResolvedOptions): XMLParser {
    return createParserService(resolved);
  }
}

export const XMLParser = XMLParserTag;
export default XMLParser;
