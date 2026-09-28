import type { Readable } from 'node:stream';

import { Effect } from 'effect';
import { Buffer } from 'node:buffer';

import type { ParseErrorEntry } from './internal/parser-types.ts';
import type { ResolvedOptions, X2jOptions } from './options.ts';

import EncodingRegistry, { defaultEncodingRegistry } from './encoding/encoding-registry.js';
import FeedableSource from './input-source/feedable-source.js';
import StreamSource from './input-source/stream-source.js';
import { buildOptions } from './options-builder.js';
import { ErrorCode, ParseError, parseError, toParseError } from './parse-error.js';
import { absolutePosition } from './util.js';
import Xml2JsParser from './xml2-js-parser.js';

/**
 * @description XMLParser — the public entry point. Owns the resolved options, the shared name cache, and the three ways to get a document in: one-shot
 * ({@link parse}, {@link parseBytesArr}), streaming ({@link parseStream}), and incremental ({@link feed} / {@link end}). Every one of those paths
 * builds a fresh {@link Xml2JsParser} per document; the state that should survive between calls (resolved options, name cache, `wasExited`, the last
 * run's structural errors) lives here.
 *
 * ## Why construction is `XMLParser.make` and not `new XMLParser`
 *
 * A parser is configured, not merely allocated: its options are validated, a reserved property name is refused, and every stop-node and skip-tag path
 * expression is compiled and sealed into an indexed set. All of that can fail, and a constructor has nowhere to put an error channel — the choice is
 * between throwing and hiding the failure. So configuration is an effect, and {@link XMLParser.make} is the way in. The walk itself is a different
 * matter. {@link parse} and friends read the document character by character, and the readers inside it still raise `ParseError` by throwing —
 * routing every tag through a generator would cost an allocation per tag to deliver a failure the caller has not been told about yet. The boundary is
 * here: each entry point wraps the walk and converts anything that escaped into the `E` channel, so from the outside the whole package speaks one
 * language.
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
export default class XMLParser {
  /**
   * @description Fully-resolved options, built once by {@link XMLParser.make} and shared by reference with every `Xml2JsParser` this instance creates.
   */
  options: ResolvedOptions;
  /**
   * @description Whether the last parse call was terminated early by `exitIf`.
   */
  wasExited: boolean;

  // feed()/end() session state
  #feedParser: Xml2JsParser | null;
  #feedSource: FeedableSource | null;
  #isFeeding: boolean;

  // ── Batching state ──
  #pendingBytes: number;
  #batchThreshold: number;

  // Structural errors from the last run, populated only when autoClose.collectErrors is on.
  #lastParseErrors: ParseErrorEntry[];

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
    return Effect.map(buildOptions(options), resolved => new XMLParser(resolved));
  }

  /**
   * @description Assemble a parser around options that have already been validated, defaulted and compiled. Takes a `ResolvedOptions` rather than the caller's
   * `X2jOptions` because that is what {@link make} produces, and a caller cannot: resolving is where the security checks, the defaults and the
   * expression compilation live, and skipping it would hand the parser an object missing every field it reads. Prefer {@link make}.
   *
   * @param resolved - Fully-resolved options, from `buildOptions()`.
   */
  constructor(resolved: ResolvedOptions) {
    this.options = resolved;
    this.wasExited = false;

    // feed()/end() session state
    this.#feedParser = null;
    this.#feedSource = null;
    this.#isFeeding = false;

    // ── Batching state ──────────────────────────────────
    this.#pendingBytes = 0;
    this.#batchThreshold = this.options.feedable?.bufferSize;

    // Per-instance encoding registry only when custom decoders are supplied
    // — avoids mutating the shared default registry (which would leak a
    // customDecoder registered on one XMLParser instance into every other
    // instance in the process). The common case (no customDecoders) reuses
    // the shared default registry, seeded once at module load.
    if (this.options.decoding?.customDecoders) {
      const registry = new EncodingRegistry();
      for (const [name, descriptor] of Object.entries(this.options.decoding.customDecoders)) {
        // The map key is authoritative for `name`; spread first so a
        // descriptor that also carries `name` can't override the key.
        registry.register({ ...descriptor, name });
      }
      this.options.decoding._registry = registry;
    } else {
      this.options.decoding = this.options.decoding || {};
      this.options.decoding._registry = defaultEncodingRegistry;
    }

    this.#lastParseErrors = [];

    // Shared tag/attribute name cache — lives on `options`, not on any one
    // Xml2JsParser instance, because `.parse()` creates a fresh Xml2JsParser
    // every call while `this.options` is passed by reference to all of them.
    // This lets repeated names skip re-validation/re-sanitization across
    // separate parse() calls on the same XMLParser instance, not just within
    // one document. See xml2-js-parser.js for what's cached and why.
    this.options._nameCache = { tags: new Map(), attrs: new Map() };
  }

  /**
   * @description Parse an XML string or Buffer and produce a JS object.
   *
   * @param xmlData - The document, as a string or as bytes. Bytes are routed through the encoding-aware path so a configured `decoding.encoding`
   *   isn't silently ignored.
   *
   * @returns An effect producing the built output. Fails with a `ParseError` on any well-formedness or limit violation.
   */
  parse(xmlData: string | Buffer | ArrayBufferView | { toString(): string }): Effect.Effect<unknown, ParseError> {
    if (Buffer.isBuffer(xmlData) || ArrayBuffer.isView(xmlData)) {
      // Route through the encoding-aware path (auto-detect / configured
      // `decoding.encoding`) instead of an unconditional utf8 toString() —
      // otherwise a non-utf8 `decoding.encoding` option would silently be
      // ignored for Buffer input given directly to parse().
      return this.parseBytesArr(xmlData);
    } else if (typeof xmlData !== 'string') {
      if (xmlData && typeof xmlData.toString === 'function') {
        xmlData = xmlData.toString();
      } else {
        return parseError({ _tag: ErrorCode.INVALID_INPUT, option: 'xmlData', received: typeof xmlData }, 'XML data must be a string or Buffer.');
      }
    }

    return Effect.try({
      try: () => {
        const parser = this.#createParser();
        const result = parser.parse(xmlData as string);
        this.wasExited = parser.wasExited();
        this.#lastParseErrors = parser.autoCloseHandler?.getErrors() ?? [];
        return result;
      },
      catch: toParseError,
    });
  }

  /**
   * @description Parse a Uint8Array / byte array and produce a JS object.
   *
   * @param xmlData - The document, as bytes.
   *
   * @returns An effect producing the built output. Fails with `INVALID_INPUT` for a non-view argument, or with whatever the walk itself reports.
   */
  parseBytesArr(xmlData: Uint8Array | ArrayBufferView): Effect.Effect<unknown, ParseError> {
    if (!ArrayBuffer.isView(xmlData)) {
      return parseError(
        { _tag: ErrorCode.INVALID_INPUT, option: 'xmlData', received: typeof xmlData },
        'XML data must be a Uint8Array or ArrayBufferView.'
      );
    }
    const bytes = Buffer.from(xmlData.buffer, xmlData.byteOffset, xmlData.byteLength);

    return Effect.try({
      try: () => {
        const parser = this.#createParser();
        const result = parser.parseBytesArr(bytes);
        this.wasExited = parser.wasExited();
        this.#lastParseErrors = parser.autoCloseHandler?.getErrors() ?? [];
        return result;
      },
      catch: toParseError,
    });
  }

  /**
   * @description Parse an XML Node.js Readable stream and produce a JS object. Chunks are processed incrementally as they arrive — `parseXml()` runs after each
   * 'data' event and already-consumed input is freed before the next chunk arrives, so memory stays proportional to the largest incomplete token at
   * any chunk boundary rather than the total document size. This was a `Promise` and is an `Effect` now, for the same reason `parse` is: a stream is
   * asynchronous, an `Effect` is the package's one shape for "can fail", and a caller who already has both a runtime and a stream gets the same
   * language either way. `Effect.runPromise` is the direct substitute for the old `.then` / `.catch` pair.
   *
   * @param readable - The stream to read from.
   *
   * @returns An effect producing the built output. Fails with `INVALID_STREAM` if the argument is not a Node.js Readable stream, and with any parse
   *   error the stream path hits.
   */
  parseStream(readable: NodeJS.ReadableStream): Effect.Effect<unknown, ParseError> {
    if (!isReadableStream(readable)) {
      return parseError({ _tag: ErrorCode.INVALID_STREAM }, 'parseStream() requires a Node.js Readable stream.');
    }

    const source = new StreamSource({
      ...this.options.feedable,
      decoding: { encoding: this.options.decoding.encoding, registry: this.options.decoding._registry },
    });
    const streamParser = this.#createParser();
    streamParser.source = source;
    streamParser.initializeParser();

    return Effect.callback<unknown, ParseError>(resume => {
      let settled = false;
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          readable.destroy(); // stop further data/end events and free the handle
          resume(Effect.fail(toParseError(err)));
        }
      };

      source.attachStream(
        readable,
        // onChunk — run the parser incrementally after each chunk arrives.
        // Mirrors what feed() does: advance as far as possible, rewind on
        // UNEXPECTED_END (chunk boundary mid-token), re-throw real errors.
        err => {
          if (err) {
            fail(err);
            return;
          }
          try {
            streamParser.parseXml();
          } catch (parseErr) {
            if (parseErr instanceof ParseError && parseErr.code === ErrorCode.UNEXPECTED_END) {
              source.rewindToMark();
            } else {
              fail(parseErr);
            }
          }
        },
        // onEnd — stream finished cleanly; finalise the document.
        () => {
          if (settled) return;
          try {
            // source.end() (called by attachStream just before this) can
            // release content that was held back pending encoding detection
            // (see FeedableSource's 'auto' mode) — run parseXml() once more
            // to consume it before finalizing. No-op if there's nothing new.
            streamParser.parseXml();
            streamParser.finalizeXml();
            this.#lastParseErrors = streamParser.autoCloseHandler?.getErrors() ?? [];
            this.wasExited = streamParser.wasExited();
            settled = true;
            resume(Effect.succeed(streamParser.outputBuilder.getOutput()));
          } catch (err) {
            fail(err);
          }
        },
        // onError — stream-level error (e.g. file not found, network drop)
        fail
      );
    });
  }

  // ─── Incremental feed()/end() API ────────────────────────────────────────

  /**
   * @description Run the parser over whatever has accumulated so far, rewinding on a chunk boundary so the incomplete token is retried on the next `feed()`. Also
   * owns the batching heuristic: if the last pass made no progress — the parser is stuck mid-token — the byte threshold is doubled, up to
   * `feedable.maxBufferSize`, so `parseXml()` isn't re-attempted on every single byte until significantly more data arrives.
   */
  #runParse(): void {
    if (!this.#feedParser || !this.#feedSource) return;

    const beforePos = absolutePosition(this.#feedSource); // bytes consumed so far, flush-proof

    try {
      this.#feedParser.parseXml();
    } catch (err) {
      if (err instanceof ParseError && err.code === ErrorCode.UNEXPECTED_END) {
        this.#feedSource.rewindToMark();
      } else {
        throw err;
      }
    }

    const afterPos = absolutePosition(this.#feedSource);
    const didAdvance = afterPos > beforePos;

    if (didAdvance) {
      // Real progress made — reset threshold normally
      this.#pendingBytes = 0;
      this.#batchThreshold = this.options.feedable.bufferSize;
    } else {
      // Parser is stuck mid-token — grow the threshold to avoid
      // hammering parseXml() until significantly more data arrives
      this.#batchThreshold = Math.min(this.#batchThreshold * 2, this.options.feedable.maxBufferSize);
    }
  }

  /**
   * @description Feed an XML data chunk for incremental parsing. After appending the chunk, `parseXml()` is run immediately so the parser advances as far as
   * possible. If a chunk boundary falls mid-token, the reader reports UNEXPECTED_END; this is caught here and the source is rewound to the start of
   * the incomplete token so it will be re-parsed on the next `feed()` call once more data has arrived. Any other ParseError (unclosed quote,
   * mismatched tag, etc.) is a real parse failure and fails the returned effect.
   *
   * @param data - The next chunk, as a string or as bytes.
   *
   * @returns An effect producing `this`, for chaining. Fails with `DATA_MUST_BE_STRING` if data is not a string or Buffer, and with any parse error
   *   the pass over the accumulated input hit.
   */
  feed(data: string | Buffer): Effect.Effect<XMLParser, ParseError> {
    return Effect.try({
      try: () => {
        if (!this.#isFeeding) {
          this.#initFeedSession();
        }
        const source = this.#feedSource as FeedableSource;

        // Pass raw data straight through — do NOT pre-convert Buffers to string
        // here. FeedableSource.feed() decodes Buffers via a persistent stateful
        // decoder so a multi-byte UTF-8 character split across two feed()
        // calls decodes correctly; converting each chunk with .toString() first
        // (as this used to do) decodes each chunk in isolation and corrupts a
        // split character. feed() itself validates the type and reports
        // DATA_MUST_BE_STRING for anything unsupported.
        const appendedLength = source.feed(data);
        this.#pendingBytes += appendedLength;

        if (this.#pendingBytes >= this.#batchThreshold) {
          this.#runParse();
        }
        // Otherwise, delay parsing until next feed() or end()

        return this;
      },
      catch: toParseError,
    });
  }

  /**
   * @description Signal end of input, validate end-of-document state, and produce the parsed result. Fails if called before any `feed()` call. `parseXml()` is
   * called one final time after marking the source complete. This replays any bytes that were rewound during the last `feed()` call (e.g. a tag that
   * was split across the final chunk boundary). Now that the source is complete, any UNEXPECTED_END reported by a reader means the document is
   * genuinely truncated — not a chunk boundary — so it is treated as a real parse error rather than silently swallowed. AutoClose partial-tag
   * recovery works the same way it does in `_parseAndFinalize()`: if `autoCloseHandler` is configured and `parseXml()` reports UNEXPECTED_END, the
   * handler is given a chance to recover before `finalizeXml()` runs.
   *
   * @returns An effect producing the parsed output. Fails with `NOT_STREAMING` if called before any `feed()`, and with any well-formedness or limit
   *   violation in the accumulated input.
   */
  end(): Effect.Effect<unknown, ParseError> {
    if (!this.#isFeeding) {
      return parseError({ _tag: ErrorCode.NOT_STREAMING }, 'No data fed. Call feed() before end().');
    }
    const parser = this.#feedParser as Xml2JsParser;
    const source = this.#feedSource as FeedableSource;

    return Effect.try({
      try: () => {
        // Force a final parse (any pending bytes are now processed)
        this.#runParse();

        try {
          // Mark the source as complete so readers know there is no more data.
          source.end();

          // Replay any bytes rewound during the last feed() call (e.g. an
          // incomplete tag at the very end of the input stream). Any
          // UNEXPECTED_END thrown here is a genuine truncation error.
          let partialTagError: ParseError | null = null;
          const autoClose = parser.autoCloseHandler;
          if (autoClose) autoClose.reset();

          try {
            parser.parseXml();
          } catch (err) {
            if (err instanceof ParseError && err.code === ErrorCode.UNEXPECTED_END) {
              if (autoClose) {
                // autoClose recovery: treat the truncated tag the same way
                // _parseAndFinalize() does for the one-shot parse path.
                partialTagError = err;
              } else {
                // No recovery configured — truncated document is a hard error.
                throw err;
              }
            } else {
              throw err;
            }
          }

          if (partialTagError) {
            autoClose?.handlePartialTag(partialTagError, parser._parserState());
          } else {
            parser.finalizeXml();
          }

          this.#lastParseErrors = autoClose?.getErrors() ?? [];
          this.wasExited = parser.wasExited();
          return parser.outputBuilder.getOutput();
        } finally {
          this.#cleanupFeedSession();
        }
      },
      catch: toParseError,
    });
  }

  // ─── Error reporting ──────────────────────────────────────────────────────

  /**
   * @description Structural errors collected during the last parse call. Only populated when `autoClose.collectErrors` is true. Each entry: `{ type, tag,
   * expected, index }` A method returning an `Effect` rather than a plain array, like every other public entry point in this package: a caller who
   * reads it should not have to learn a second shape. The channel is empty — there is nothing here to fail on.
   *
   * @returns An effect producing the collected entries. Infallible.
   */
  getParseErrors(): Effect.Effect<ParseErrorEntry[], never> {
    return Effect.succeed(this.#lastParseErrors ?? []);
  }

  /**
   * @description Characters currently retained in the incremental-parse buffer, or `null` when no `feed()` session is open. The live buffer length is the honest
   * measure of how much memory a streaming parse is holding: the `autoFlush` / `flushThreshold` pair exists precisely to keep this proportional to
   * the largest incomplete token rather than the whole document, and this is the number that shows whether it is doing its job. Also useful as a
   * general diagnostic for callers streaming very large documents. Reading it is safe at any time; it does not disturb the parser.
   *
   * @returns An effect producing the retained character count, or `null`. Infallible.
   */
  getFeedBufferLength(): Effect.Effect<number | null, never> {
    return Effect.succeed(this.#feedSource === null ? null : this.#feedSource.buffer.length);
  }

  /**
   * @description The pending-byte count at which the next `feed()` triggers a parse pass. Starts at `feedable.bufferSize` and doubles on every pass that makes no
   * progress — the heuristic that stops a parser stuck mid-token from re-running `parseXml()` on every single byte until substantially more data
   * arrives. Exposed for diagnostics: a threshold that has grown a long way past the configured value means the parser is waiting on more input
   * before it will try again, which is the behaviour you want, but surprising if you did not know about it.
   *
   * @returns An effect producing the current threshold. Infallible.
   */
  getFeedBatchThreshold(): Effect.Effect<number, never> {
    return Effect.succeed(this.#batchThreshold);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  #createParser(): Xml2JsParser {
    return new Xml2JsParser(this.options);
  }

  #initFeedSession(): void {
    this.#feedSource = new FeedableSource({
      ...this.options.feedable,
      decoding: { encoding: this.options.decoding.encoding, registry: this.options.decoding._registry },
    });
    this.#feedParser = this.#createParser();
    this.#feedParser.source = this.#feedSource;
    this.#feedParser.initializeParser();
    this.#isFeeding = true;
  }

  #cleanupFeedSession(): void {
    this.#feedParser = null;
    this.#feedSource = null;
    this.#isFeeding = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @description Structural check for "is this a Node.js Readable stream", done by capability rather than `instanceof` so a duck-typed stream (or one from a
 * duplicated `node:stream` copy) is still accepted.
 */
function isReadableStream(value: unknown): value is Readable {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Readable).read === 'function' &&
    typeof (value as Readable).on === 'function' &&
    typeof (value as Readable).readableEnded === 'boolean'
  );
}
