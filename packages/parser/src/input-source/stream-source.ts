import FeedableSource from './feedable-source.js';

/**
 * @description The subset of a Node.js `Readable` that `attachStream()` actually uses. Declared structurally rather than imported from `node:stream` so this
 * module carries no Node type dependency and the package's `.d.mts` stays loadable in a browser toolchain. A real `Readable` satisfies it
 * structurally, and so does any duck-typed stream — which is what `XMLParser.isReadableStream()` has always tested for at runtime, so the type and
 * the runtime check now agree.
 */
export interface ReadableLike {
  /**
   * @description Present on every `Readable`; unused by this package, which is driven by `'data'` events rather than by explicit pulls. Part of the shape because
   * it is the cheapest way to tell a stream from an arbitrary object.
   */
  read(size?: number): unknown;
  /**
   * @description Event registration. Used for `'data'`, `'end'` and `'error'`. The listener args are `any` on purpose: Node's `Readable['on']` is a set of
   * per-event overloads keyed on a `ReadableEventMap`, and narrowing the listener here to a concrete tuple makes a real `Readable` fail to satisfy
   * this interface for reasons that have nothing to do with this package. `attachStream()` re-types the `'data'` listener itself.
   */
  // oxlint-disable-next-line no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  /**
   * @description Tear the stream down after a parse failure, so a half-read socket or file handle is released rather than left open. Optional so a minimal
   * duck-typed stream is still accepted; the failure path guards on its presence.
   */
  destroy?(error?: Error): unknown;
}

/**
 * @description Structural check for "is this a Node.js Readable stream", done by capability rather than `instanceof` so a duck-typed stream (or one from a
 * duplicated `node:stream` copy) is still accepted. This is the runtime counterpart of {@link ReadableLike}: the type is what the compiler requires of
 * a caller, this is what `parseStream()` actually tests.
 *
 * @param value - Anything a caller passed to `parseStream()`.
 *
 * @returns True when the value is stream-shaped.
 */
export function isReadableStream(value: unknown): value is ReadableLike {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { on?: unknown; read?: unknown };
  return typeof candidate.on === 'function' && typeof candidate.read === 'function';
}

/**
 * @description StreamSource — input source that reads from a Node.js Readable stream. Extends `FeedableSource` so it shares the same buffer management and read
 * interface. `attachStream()` wires Node.js stream events. On each 'data' event the chunk is appended to the buffer and `onChunk` is called so the
 * caller can run `parseXml()` incrementally. Parsing is therefore driven chunk-by-chunk rather than once over the full accumulated document.
 * Streaming is the one entry point that is inherently Node-flavoured — it is driven by a Node `Readable`'s events. It is isolated here so the rest of
 * the package, including `parse()`, `parseBytesArr()` and `feed()`/`end()`, carries no Node dependency at all. Chunks arrive as `Buffer` or `string`;
 * `FeedableSource.feed()` accepts either and decodes bytes through a persistent stateful decoder, so a multi-byte character split across a chunk
 * boundary is still decoded correctly.
 */
export default class StreamSource extends FeedableSource {
  /**
   * @description Wire a Readable stream to this source.
   *
   * @param readable - The stream to read chunks from.
   * @param onChunk - Called after each successful `feed()` with `null`, or immediately with the feed error if the buffer limit was exceeded. The
   *   caller runs `parseXml()` inside this callback and handles UNEXPECTED_END (chunk boundary mid-token) by calling `rewindToMark()`.
   * @param onEnd - Called when the stream ends cleanly. The caller should finalise the parse (`finalizeXml()`) here.
   * @param onError - Called with any stream-level error (e.g. the readable's 'error' event).
   */
  attachStream(readable: ReadableLike, onChunk: (error: Error | null) => void, onEnd: () => void, onError: (error: Error) => void) {
    readable.on('data', (chunk: string | Uint8Array) => {
      try {
        // Pass the raw chunk (bytes or string) straight through — feed()
        // decodes bytes via a persistent stateful decoder so a multi-byte
        // UTF-8 character split across two chunks decodes correctly instead
        // of each half being independently mangled by a per-chunk decode.
        this.feed(chunk);
        onChunk(null); // chunk appended successfully — caller runs parseXml()
      } catch (err) {
        onChunk(err as Error | null); // buffer overflow or coercion failure
      }
    });

    readable.on('error', onError);

    readable.on('end', () => {
      try {
        this.end();
        onEnd();
      } catch (err) {
        onError(err as Error);
      }
    });
  }
}
