import type { EncodingDecoder } from '../options.ts';

/**
 * @description Gives a `{ write(buf): string, end(): string }` shaped stateful decoder, the contract every `EncodingRegistry` descriptor already promises, but
 * built on the global `TextDecoder` instead of Node's `node:string_decoder`. Why this exists: `node:string_decoder` is Node-only, and bundling it for
 * a browser target fails outright (no browser polyfill is registered by default). `TextDecoder` is available natively in every modern browser _and_
 * in Node (global since Node 11), and it already supports incremental, chunk-safe decoding via `{ stream: true }` — a multi-byte character split
 * across two `write()` calls is buffered internally and stitched together on the next call, the same safety guarantee `StringDecoder` gave. Scope:
 * only replaces the five _built-in_ encodings (utf8, ascii, latin1, utf16le, utf16be). Fully custom Node-only decoders (e.g. iconv-lite based
 * Shift_JIS) registered via `decoding.customDecoders` are untouched — they keep supplying their own `createDecoder()` and are expected to only run
 * under Node.
 *
 * @param label - A valid `TextDecoder` label (`'utf-8'`, `'utf-16le'`, `'windows-1252'`, …).
 *
 * @returns A stateful decoder. `end()` flushes any incomplete trailing sequence, substituting U+FFFD for it.
 */
export function createTextDecoderAdapter(label: string): EncodingDecoder {
  const decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true });
  return {
    write(buf: Buffer) {
      // stream:true holds back a trailing partial multi-byte sequence
      // instead of emitting U+FFFD for it, and prepends it on the next call.
      return decoder.decode(buf, { stream: true });
    },
    end() {
      // Final call, no more bytes coming — flush anything held back.
      // A non-empty result here means genuinely truncated input; TextDecoder
      // substitutes U+FFFD for it, matching StringDecoder's prior behavior.
      return decoder.decode();
    },
  };
}

/**
 * @description Utf16be has no native `TextDecoder` label. Same approach as the previous Node-based implementation: byte-swap to little-endian, then decode as
 * utf-16le. Kept here (rather than in `EncodingRegistry`) since it's just another flavor of "adapter around a decoder".
 */
export function createUtf16BeAdapter(): EncodingDecoder {
  const inner = createTextDecoderAdapter('utf-16le');
  let pending: Buffer | null = null; // holds a single odd leftover byte across writes

  return {
    write(buf: Buffer) {
      let work: Buffer = pending ? concatBytes(pending, buf) : buf;
      pending = null;
      if (work.length % 2 === 1) {
        pending = work.subarray(work.length - 1);
        work = work.subarray(0, work.length - 1);
      }
      const swapped = swapBytePairs(work);
      return inner.write(swapped);
    },
    end() {
      return inner.end();
    },
  };
}

function concatBytes(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length + b.length);
  a.copy(out, 0);
  b.copy(out, a.length);
  return out;
}

function swapBytePairs(bytes: Buffer): Buffer {
  const swapped = Buffer.from(bytes);
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const tmp = swapped[i] as number;
    swapped[i] = swapped[i + 1] as number;
    swapped[i + 1] = tmp;
  }
  return swapped;
}
