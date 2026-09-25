import type { Readable } from 'node:stream';

import { Buffer } from 'node:buffer';

import type { ParseErrorEntry } from './internal/parser-types.ts';
import type { ResolvedOptions, X2jOptions } from './options.ts';

import EncodingRegistry, { defaultEncodingRegistry } from './Encoding/EncodingRegistry.js';
import FeedableSource from './InputSource/FeedableSource.js';
import StreamSource from './InputSource/StreamSource.js';
import { buildOptions } from './OptionsBuilder.js';
import { ParseError, ErrorCode } from './ParseError.js';
import { absolutePosition } from './util.js';
import Xml2JsParser from './Xml2JsParser.js';

/**
 * @description XMLParser — the public entry point. Owns the resolved options, the shared name cache, and the three ways to get a document in: one-shot ({@link
 * parse}, {@link parseBytesArr}), streaming ({@link parseStream}), and incremental ({@link feed} / {@link end}). Every one of those paths builds a
 * fresh {@link Xml2JsParser} per document; the state that should survive between calls (resolved options, name cache, `wasExited`, the last run's
 * structural errors) lives here.
 */
export default class XMLParser {
  /**
   * @description Fully-resolved options, built once in the constructor and shared by reference with every `Xml2JsParser` this instance creates.
   */
  options: ResolvedOptions;
  /**
   * @description Whether the last parse call was terminated early by `exitIf`.
   */
  wasExited: boolean;

  // feed()/end() session state
  private _feedParser: Xml2JsParser | null;
  private _feedSource: FeedableSource | null;
  private _isFeeding: boolean;

  // ── Batching state ──
  private _pendingBytes: number;
  private _batchThreshold: number;

  // Structural errors from the last run, populated only when autoClose.collectErrors is on.
  private _lastParseErrors: ParseErrorEntry[];

  /**
   * @description Create a new XMLParser.
   *
   * @param options - User options. Omit for defaults.
   *
   * @throws {ParseError} With code `INVALID_INPUT` or `SECURITY_RESERVED_OPTION`
   * if any option value is invalid or contains a reserved property name.
   */
  constructor(options?: X2jOptions) {
    this.options = buildOptions(options);
    this.wasExited = false;

    // feed()/end() session state
    this._feedParser = null;
    this._feedSource = null;
    this._isFeeding = false;

    // ── Batching state ──────────────────────────────────
    this._pendingBytes = 0;
    this._batchThreshold = this.options.feedable?.bufferSize;

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

    this._lastParseErrors = [];

    // Shared tag/attribute name cache — lives on `options`, not on any one
    // Xml2JsParser instance, because `.parse()` creates a fresh Xml2JsParser
    // every call while `this.options` is passed by reference to all of them.
    // This lets repeated names skip re-validation/re-sanitization across
    // separate parse() calls on the same XMLParser instance, not just within
    // one document. See Xml2JsParser.js for what's cached and why.
    this.options._nameCache = { tags: new Map(), attrs: new Map() };
  }

  /**
   * @description Parse an XML string or Buffer and return a JS object.
   *
   * @param xmlData - The document, as a string or as bytes. Bytes are routed through the encoding-aware path so a configured `decoding.encoding`
   *   isn't silently ignored.
   *
   * @throws {ParseError} On any well-formedness or limit violation.
   */
  parse(xmlData: string | Buffer | ArrayBufferView | { toString(): string }): unknown {
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
        throw new ParseError('XML data must be a string or Buffer.', ErrorCode.INVALID_INPUT);
      }
    }

    const parser = this._createParser();
    const result = parser.parse(xmlData as string);
    this.wasExited = parser.wasExited();
    this._lastParseErrors = parser.autoCloseHandler?.getErrors() ?? [];
    return result;
  }

  /**
   * @description Parse a Uint8Array / byte array and return a JS object.
   *
   * @param xmlData - The document, as bytes.
   *
   * @throws {ParseError} `INVALID_INPUT` for a non-view argument, or any well-formedness or limit violation.
   */
  parseBytesArr(xmlData: Uint8Array | ArrayBufferView): unknown {
    let bytes: Buffer;
    if (ArrayBuffer.isView(xmlData)) {
      bytes = Buffer.from(xmlData.buffer, xmlData.byteOffset, xmlData.byteLength);
    } else {
      throw new ParseError('XML data must be a Uint8Array or ArrayBufferView.', ErrorCode.INVALID_INPUT);
    }

    const parser = this._createParser();
    const result = parser.parseBytesArr(bytes);
    this.wasExited = parser.wasExited();
    this._lastParseErrors = parser.autoCloseHandler?.getErrors() ?? [];
    return result;
  }

  /**
   * @description Parse an XML Node.js Readable stream and return a Promise that resolves with the parsed JS object. Chunks are processed incrementally as they
   * arrive — `parseXml()` runs after each 'data' event and already-consumed input is freed before the next chunk arrives, so memory stays
   * proportional to the largest incomplete token at any chunk boundary rather than the total document size.
   *
   * @param readable - The stream to read from.
   *
   * @returns The parsed output.
   *
   * @throws {ParseError} With code `INVALID_STREAM` if the argument is not a Node.js Readable stream. Also rejects with any parse error the stream
   *   path hits.
   */
  parseStream(readable: NodeJS.ReadableStream): Promise<unknown> {
    if (!isReadableStream(readable)) {
      throw new ParseError('parseStream() requires a Node.js Readable stream.', ErrorCode.INVALID_STREAM);
    }

    const source = new StreamSource({
      ...this.options.feedable,
      decoding: { encoding: this.options.decoding.encoding, registry: this.options.decoding._registry },
    });
    const streamParser = this._createParser();
    streamParser.source = source;
    streamParser.initializeParser();

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          readable.destroy(); // stop further data/end events and free the handle
          reject(err);
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
            this._lastParseErrors = streamParser.autoCloseHandler?.getErrors() ?? [];
            this.wasExited = streamParser.wasExited();
            settled = true;
            resolve(streamParser.outputBuilder.getOutput());
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
  private _runParse(): void {
    if (!this._feedParser || !this._feedSource) return;

    const beforePos = absolutePosition(this._feedSource); // bytes consumed so far, flush-proof

    try {
      this._feedParser.parseXml();
    } catch (err) {
      if (err instanceof ParseError && err.code === ErrorCode.UNEXPECTED_END) {
        this._feedSource.rewindToMark();
      } else {
        throw err;
      }
    }

    const afterPos = absolutePosition(this._feedSource);
    const didAdvance = afterPos > beforePos;

    if (didAdvance) {
      // Real progress made — reset threshold normally
      this._pendingBytes = 0;
      this._batchThreshold = this.options.feedable.bufferSize;
    } else {
      // Parser is stuck mid-token — grow the threshold to avoid
      // hammering parseXml() until significantly more data arrives
      this._batchThreshold = Math.min(this._batchThreshold * 2, this.options.feedable.maxBufferSize);
    }
  }

  /**
   * @description Feed an XML data chunk for incremental parsing. After appending the chunk, `parseXml()` is run immediately so the parser advances as far as
   * possible. If a chunk boundary falls mid-token, the reader throws UNEXPECTED_END; this is caught here and the source is rewound to the start of
   * the incomplete token so it will be re-parsed on the next `feed()` call once more data has arrived. Any other ParseError (unclosed quote,
   * mismatched tag, etc.) is a real parse failure and is re-thrown after cleaning up the session.
   *
   * @param data - The next chunk, as a string or as bytes.
   *
   * @returns `this`, for chaining.
   *
   * @throws {ParseError} With code `DATA_MUST_BE_STRING` if data is not a string or Buffer.
   */
  feed(data: string | Buffer): XMLParser {
    if (!this._isFeeding) {
      this._initFeedSession();
    }
    const source = this._feedSource as FeedableSource;

    // Pass raw data straight through — do NOT pre-convert Buffers to string
    // here. FeedableSource.feed() decodes Buffers via a persistent stateful
    // decoder so a multi-byte UTF-8 character split across two feed()
    // calls decodes correctly; converting each chunk with .toString() first
    // (as this used to do) decodes each chunk in isolation and corrupts a
    // split character. feed() itself validates the type and throws
    // DATA_MUST_BE_STRING for anything unsupported.
    const appendedLength = source.feed(data);
    this._pendingBytes += appendedLength;

    if (this._pendingBytes >= this._batchThreshold) {
      this._runParse();
    }
    // Otherwise, delay parsing until next feed() or end()

    return this;
  }

  /**
   * @description Signal end of input, validate end-of-document state, and return the parsed result. Throws if called before any `feed()` call. `parseXml()` is
   * called one final time after marking the source complete. This replays any bytes that were rewound during the last `feed()` call (e.g. a tag that
   * was split across the final chunk boundary). Now that the source is complete, any UNEXPECTED_END thrown by a reader means the document is
   * genuinely truncated — not a chunk boundary — so it is treated as a real parse error rather than silently swallowed. AutoClose partial-tag
   * recovery works the same way it does in `_parseAndFinalize()`: if `autoCloseHandler` is configured and `parseXml()` throws UNEXPECTED_END, the
   * handler is given a chance to recover before `finalizeXml()` runs.
   *
   * @returns The parsed output.
   *
   * @throws {ParseError} With code `NOT_STREAMING` if called before any `feed()`.
   * @throws {ParseError} On any well-formedness or limit violation in the accumulated input.
   */
  end(): unknown {
    if (!this._isFeeding) {
      throw new ParseError('No data fed. Call feed() before end().', ErrorCode.NOT_STREAMING);
    }
    const parser = this._feedParser as Xml2JsParser;
    const source = this._feedSource as FeedableSource;

    // Force a final parse (any pending bytes are now processed)
    this._runParse();

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

      this._lastParseErrors = autoClose?.getErrors() ?? [];
      this.wasExited = parser.wasExited();
      return parser.outputBuilder.getOutput();
    } finally {
      this._cleanupFeedSession();
    }
  }

  // ─── Error reporting ──────────────────────────────────────────────────────

  /**
   * @description Return structural errors collected during the last parse call. Only populated when `autoClose.collectErrors` is true. Each entry: `{ type, tag,
   * expected, index }`
   */
  getParseErrors(): ParseErrorEntry[] {
    return this._lastParseErrors ?? [];
  }

  /**
   * @description Characters currently retained in the incremental-parse buffer, or `null` when no `feed()` session is open.
   *
   * The live buffer length is the honest measure of how much memory a streaming parse is holding: the `autoFlush` / `flushThreshold` pair exists precisely
   * to keep this proportional to the largest incomplete token rather than the whole document, and this is the number that shows whether it is doing its
   * job. Also useful as a general diagnostic for callers streaming very large documents.
   *
   * Reading it is safe at any time; it does not disturb the parser.
   */
  getFeedBufferLength(): number | null {
    return this._feedSource === null ? null : this._feedSource.buffer.length;
  }

  /**
   * @description The pending-byte count at which the next `feed()` triggers a parse pass.
   *
   * Starts at `feedable.bufferSize` and doubles on every pass that makes no progress — the heuristic that stops a parser stuck mid-token from re-running
   * `parseXml()` on every single byte until substantially more data arrives. Exposed for diagnostics: a threshold that has grown a long way past the
   * configured value means the parser is waiting on more input before it will try again, which is the behaviour you want, but surprising if you did not
   * know about it.
   */
  getFeedBatchThreshold(): number {
    return this._batchThreshold;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * @private
   */
  private _createParser(): Xml2JsParser {
    return new Xml2JsParser(this.options);
  }

  /**
   * @private
   */
  private _initFeedSession(): void {
    this._feedSource = new FeedableSource({
      ...this.options.feedable,
      decoding: { encoding: this.options.decoding.encoding, registry: this.options.decoding._registry },
    });
    this._feedParser = this._createParser();
    this._feedParser.source = this._feedSource;
    this._feedParser.initializeParser();
    this._isFeeding = true;
  }

  /**
   * @private
   */
  private _cleanupFeedSession(): void {
    this._feedParser = null;
    this._feedSource = null;
    this._isFeeding = false;
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
