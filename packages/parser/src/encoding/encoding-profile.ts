import { Effect } from 'effect';

import type { ScanStrategy } from '#/input-source/input-source.ts';
import type { DecodingOptions } from '#/options.ts';
import type { ParseError } from '#/parse-error.ts';

import type { EncodingRegistry } from './encoding-registry.ts';
import type { ResolvedEncodingDescriptor } from './encoding-registry.ts';

import { sniff } from './encoding-detector.ts';
import { defaultEncodingRegistry } from './encoding-registry.ts';
import { createCharScanStrategy } from './scan-strategy/char-scan-strategy.ts';

/**
 * @description Everything `BufferSource` needs to know about an encoding, decided once per parse and then never re-examined. This is the Dependency Inversion
 * boundary: `BufferSource` depends on the `ScanStrategy` interface, not on "which encoding this is". Resolving the decision here means no encoding
 * name ever appears in the scanning code.
 */
export interface EncodingProfile {
  /**
   * @description The resolved encoding descriptor, used for the decoder and reported as `BufferSource.encodingName`.
   */
  descriptor: ResolvedEncodingDescriptor;
  /**
   * @description Byte length of the detected BOM to exclude from content and from indices, or `0` when there is none.
   */
  bomLength: number;
  /**
   * @description Character-level read interface for this encoding's buffer representation.
   */
  scanStrategy: ScanStrategy;
}

/**
 * @description BuildProfileForBuffer(bytes, decodingOptions, registry) -> `{ descriptor, bomLength, scanStrategy }`. The ONE place encoding decisions are made for
 * `BufferSource`. Called once per `parseBytesArr()` call, never per-token — every field on the returned object is a concrete, already-resolved
 * strategy, so `BufferSource` itself never branches on an encoding name again.
 *
 * ### Why every encoding is decoded before scanning
 *
 * There was once a byte-scan fast path here, selected for self-synchronizing encodings (utf8/ascii/latin1) to avoid materializing the decoded string.
 * It measured **slower** than decoding the whole buffer up front and running the identical scanner over the resulting string: on a 4.5 MiB, 20k-item
 * catalog, byte-scan took 588 ms against 508 ms for decode-first, because it paid 2,537,787 individual `Buffer#toString(enc, i, j)` calls — averaging
 * 2.6 bytes each — to avoid one decode. A reused `TextDecoder` is not a per-call bargain either (measured ~1.4x the cost of `Buffer#toString` on a
 * 20-byte read), so "keep the bytes and decode per token" has no fast version. That settles the design on measurement rather than principle: decode
 * once, scan the string, and the whole package depends on `TextDecoder` and `Uint8Array` alone. It is also what makes the package run in a browser,
 * since neither of those is Node-specific. The streaming memory argument that justified byte-scan does not apply to this path — `BufferSource`
 * already holds the entire document in memory before scanning starts, so there was never a bound on peak memory to win back.
 *
 * @param bytes - The full document as bytes. Used only for BOM / `<?xml?>` sniffing when `decoding.encoding` is `'auto'` or unset.
 * @param decodingOptions - User decoding options.
 * @param registry - Registry to resolve names against. Defaults to the shared registry.
 *
 * @returns An effect producing the profile. Fails with `UNSUPPORTED_ENCODING` for an unknown name, `ENCODING_MISMATCH` when a BOM contradicts the
 *   declaration.
 */
export const buildProfileForBuffer = Effect.fnUntracedEager(function* (
  bytes: Uint8Array,
  decodingOptions: DecodingOptions = {},
  registry: EncodingRegistry = defaultEncodingRegistry
): Effect.fn.Return<EncodingProfile, ParseError> {
  const requested = decodingOptions.encoding || 'auto';
  let name: string;
  let bomLength: number;
  if (requested === 'auto') {
    const detected = yield* sniff(bytes, registry);
    name = detected.encoding;
    bomLength = detected.bomLength;
  } else {
    name = requested;
    bomLength = 0;
  }
  const descriptor = yield* registry.resolve(name);
  return { descriptor, bomLength, scanStrategy: createCharScanStrategy() };
});
