import type { EncodingDecoder } from '../options.ts';

/**
 * @description Gives a `{ write(buf): string, end(): string }` shaped stateful decoder, the contract every `EncodingRegistry` descriptor already promises, but
 * built on the global `TextDecoder`. Why this exists: `node:string_decoder` is Node-only, and bundling it for a browser target fails outright (no
 * browser polyfill is registered by default). `TextDecoder` is available natively in every modern browser _and_ in Node (global since Node 11), and
 * it already supports incremental, chunk-safe decoding via `{ stream: true }` — a multi-byte character split across two `write()` calls is buffered
 * internally and stitched together on the next call, the same safety guarantee `StringDecoder` gave. This is the only decoder mechanism the package
 * uses: the built-in encodings (utf8, ascii, latin1, utf16le, utf16be) all resolve here, and a custom encoding registered via
 * `decoding.customDecoders` supplies its own `createDecoder()`, which may of course be Node-only — that is the caller's choice, not this package's
 * dependency.
 *
 * @param label - A valid `TextDecoder` label (`'utf-8'`, `'utf-16le'`, `'windows-1252'`, …).
 *
 * @returns A stateful decoder. `end()` flushes any incomplete trailing sequence, substituting U+FFFD for it.
 */
export function createTextDecoderAdapter(label: string): EncodingDecoder {
  const decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true });
  return {
    write(buf: Uint8Array) {
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
 * @description Utf16be has no native `TextDecoder` label. Byte-swap to little-endian, then decode as utf16le. Kept here (rather than in `EncodingRegistry`) since
 * it's just another flavor of "adapter around a decoder".
 */
export function createUtf16BeAdapter(): EncodingDecoder {
  const inner = createTextDecoderAdapter('utf-16le');
  let pending: Uint8Array | null = null; // holds a single odd leftover byte across writes

  return {
    write(buf: Uint8Array) {
      let work: Uint8Array = pending ? concatBytes(pending, buf) : buf;
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function swapBytePairs(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes);
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const tmp = swapped[i] as number;
    swapped[i] = swapped[i + 1] as number;
    swapped[i + 1] = tmp;
  }
  return swapped;
}
