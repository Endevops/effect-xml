import type { ScanStrategy } from '../InputSource/input-source.ts';
import type { DecodingOptions, EncodingDecoder } from '../options.ts';
import type EncodingRegistry from './EncodingRegistry.js';
import type { ResolvedEncodingDescriptor } from './EncodingRegistry.js';

import { sniff } from './EncodingDetector.js';
import { defaultEncodingRegistry } from './EncodingRegistry.js';
import { createByteScanStrategy, decodeCharAtFixedWidth1, decodeCharAtUtf8 } from './ScanStrategy/ByteScanStrategy.js';
import { createCharScanStrategy } from './ScanStrategy/CharScanStrategy.js';

/**
 * @description Everything `BufferSource` needs to know about an encoding, decided once per parse and then never re-examined. This is the Dependency Inversion
 * boundary: `BufferSource` depends on the `ScanStrategy` interface, not on "which encoding is this". Resolving the decision here means no encoding
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
  /**
   * @description When true, the whole buffer is decoded up front before scanning begins. Required for any encoding where an ASCII delimiter byte could
   * legitimately appear as part of a different character.
   */
  decodeFirst: boolean;
  /**
   * @description Whether `_quotePairs` offsets can be reused as indices into a decoded string. `false` for `ByteScanStrategy` + utf8, where a byte offset can land
   * mid-character once decoded.
   */
  quotePairsUsable: boolean;
}

/**
 * @description BuildProfileForBuffer(bytes, decodingOptions, registry) -> `{ descriptor, bomLength, scanStrategy, decodeFirst, quotePairsUsable }`. The ONE place
 * encoding decisions are made for `BufferSource`. Called once per `parseBytesArr()` call, never per-token — every field on the returned object is a
 * concrete, already-resolved strategy, so `BufferSource` itself never branches on an encoding name again.
 *
 * @param bytes - The full document as bytes. Used only for BOM / `<?xml?>` sniffing when `decoding.encoding` is `'auto'` or unset.
 * @param decodingOptions - User decoding options.
 * @param registry - Registry to resolve names against. Defaults to the shared registry.
 *
 * @throws {ParseError} `UNSUPPORTED_ENCODING` for an unknown name, `ENCODING_MISMATCH` when a BOM contradicts the declaration.
 */
export function buildProfileForBuffer(
  bytes: Buffer,
  decodingOptions: DecodingOptions = {},
  registry: EncodingRegistry = defaultEncodingRegistry
): EncodingProfile {
  const requested = decodingOptions.encoding || 'auto';
  let name: string;
  let bomLength: number;
  if (requested === 'auto') {
    const detected = sniff(bytes, registry);
    name = detected.encoding;
    bomLength = detected.bomLength;
  } else {
    name = requested;
    bomLength = 0;
  }
  const descriptor = registry.resolve(name);
  const scanStrategy = descriptor.selfSynchronizing
    ? createByteScanStrategy(
        descriptor.name === 'utf8' ? decodeCharAtUtf8 : decodeCharAtFixedWidth1,
        // 'utf8'/'ascii'/'latin1' — all valid Buffer#toString() encodings. A custom
        // self-synchronizing descriptor whose name is not a Buffer encoding label
        // would throw on the first bulk read; that is the correct failure, but it
        // belongs here rather than at each toString() call inside the strategy.
        descriptor.name as BufferEncoding
      )
    : createCharScanStrategy();

  // scanTagExpEnd() records quote positions as offsets into the *raw
  // buffer* it's scanning. AttributeProcessor.parseAttributes() wants to
  // reuse those offsets directly as indices into the *decoded* attrStr
  // string it receives from readStr(). Those two only line up when one
  // buffer unit == one decoded character:
  //   - CharScanStrategy: always safe — it scans the already-decoded string,
  //     same string readStr() hands back.
  //   - ByteScanStrategy + fixed-width decode (ascii/latin1, and any custom
  //     self-synchronizing single-byte encoding): safe — 1 byte == 1 char.
  //   - ByteScanStrategy + utf8: NOT safe — non-ASCII characters are 2-4
  //     bytes each, so a byte offset recorded mid-scan can land in the
  //     middle of a character once decoded. AttributeProcessor falls back to
  //     its own quote scan in this case (see `quotePairsUsable`).
  const quotePairsUsable = !descriptor.selfSynchronizing || descriptor.name !== 'utf8';

  return { descriptor, bomLength, scanStrategy, decodeFirst: !descriptor.selfSynchronizing, quotePairsUsable };
}

/**
 * @description BuildDecoderForStream(decodingOptions, registry) -> the descriptor's stateful decoder, for `FeedableSource` / `StreamSource`. These two are already
 * decode-first architecturally (see `CharScanStrategy`'s doc comment) so they only ever need the decoder half of a profile, never a scan strategy.
 * Streaming auto-detection (peeking enough of the first `feed()` chunk before a decoder can even be constructed) is implemented separately in
 * `FeedableSource._resolveDetection()`; this helper covers the explicit-encoding case and falls back to utf8 otherwise.
 *
 * @param decodingOptions - User decoding options.
 * @param registry - Registry to resolve names against. Defaults to the shared registry.
 */
export function buildDecoderForStream(decodingOptions: DecodingOptions = {}, registry: EncodingRegistry = defaultEncodingRegistry): EncodingDecoder {
  const requested = decodingOptions.encoding && decodingOptions.encoding !== 'auto' ? decodingOptions.encoding : 'utf8';
  return registry.resolve(requested).createDecoder();
}
