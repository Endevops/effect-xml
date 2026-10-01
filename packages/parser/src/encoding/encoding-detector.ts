import { Effect } from 'effect';

import { EncodingMismatch } from '#/parse-error.ts';

import type { EncodingRegistry, ResolvedEncodingDescriptor } from './encoding-registry.ts';

const DECL_PEEK_BYTES = 200; // more than enough for a <?xml ... ?> declaration

/**
 * @description Outcome of {@link sniff}.
 */
export interface EncodingDetection {
  /**
   * @description Resolved encoding name — the BOM's encoding, the declaration's encoding, or `'utf8'` when neither was found.
   */
  encoding: string;
  /**
   * @description Byte length of the detected BOM, so the caller can exclude it from content and from indices. `0` when there is none.
   */
  bomLength: number;
  /**
   * @description Encoding named by the `<?xml … encoding="…"?>` declaration, lowercased, or `null` when absent.
   */
  declaredEncoding: string | null;
}

/**
 * @description A descriptor whose BOM signature matched the head of the document.
 */
interface BomMatch {
  descriptor: ResolvedEncodingDescriptor;
  bomLength: number;
}

/**
 * @description Sniff(bytes, registry) -> `{ encoding, bomLength, declaredEncoding }`. Pure function — no state, easy to unit test standalone. Only needs the
 * leading bytes of the document (the caller decides how many it has available). Algorithm (XML 1.0 Appendix F, practical subset):
 *
 * 1. Check for a known BOM signature.
 * 2. ASCII-sniff far enough to find `encoding="..."` inside a leading `<?xml ... ?>` declaration (the declaration's own bytes are ASCII-stable across
 *    UTF-8/ASCII/Latin-1/most single-byte sets, which is exactly why this step doesn't need to already know the encoding).
 * 3. BOM present + declared encoding present + they disagree → hard error.
 * 4. Neither found → default to utf8 (spec default).
 *
 * @param bytes - Leading bytes of the document. Only the first `DECL_PEEK_BYTES` past any BOM are inspected.
 * @param registry - Registry to resolve BOM signatures and encoding names against.
 *
 * @returns An effect producing the detection. Fails with `ENCODING_MISMATCH` when the BOM and the declaration disagree.
 */
export const sniff = Effect.fnUntracedEager(function* (
  bytes: Uint8Array,
  registry: EncodingRegistry
): Effect.fn.Return<EncodingDetection, EncodingMismatch> {
  const bomMatch = matchBom(bytes, registry);
  const declaredEncoding = sniffDeclaration(bytes, bomMatch ? bomMatch.bomLength : 0);

  if (bomMatch && declaredEncoding && !(yield* sameEncoding(bomMatch.descriptor.name, declaredEncoding, registry))) {
    return yield* new EncodingMismatch({
      declared: declaredEncoding,
      actual: bomMatch.descriptor.name,
      message: `Byte-order mark indicates "${bomMatch.descriptor.name}" but the XML declaration says encoding="${declaredEncoding}"`,
    });
  }

  if (bomMatch) {
    return { encoding: bomMatch.descriptor.name, bomLength: bomMatch.bomLength, declaredEncoding };
  }
  if (declaredEncoding) {
    return { encoding: declaredEncoding, bomLength: 0, declaredEncoding };
  }
  return { encoding: 'utf8', bomLength: 0, declaredEncoding: null };
});

function matchBom(bytes: Uint8Array, registry: EncodingRegistry): BomMatch | null {
  for (const descriptor of registry.bomCandidates()) {
    const sig = descriptor.bomBytes as Uint8Array;
    if (bytes.length < sig.length) continue;
    // Byte-by-byte compare. A BOM is at most 4 bytes, so this runs at most a
    // handful of times per parse and the loop is not worth optimising further.
    let i = 0;
    while (i < sig.length && sig[i] === bytes[i]) i++;
    if (i === sig.length) return { descriptor, bomLength: sig.length };
  }
  return null;
}

function sniffDeclaration(bytes: Uint8Array, offset: number): string | null {
  // ASCII-decode a bounded prefix; non-ASCII-safe encodings (UTF-16 etc.) are
  // already handled via BOM before we'd ever reach here without one. The
  // declaration's own bytes are ASCII in every encoding that reaches this
  // function, so latin1 (a byte-preserving decode) is exactly right.
  const end = Math.min(bytes.length, offset + DECL_PEEK_BYTES);
  const decoder = new TextDecoder('iso-8859-1');
  const prefix = decoder.decode(bytes.subarray(offset, end));
  const declMatch = prefix.match(/^\s*<\?xml\s+[^?]*\?>/);
  if (!declMatch) return null;
  const encMatch = declMatch[0].match(/encoding\s*=\s*["']([^"']+)["']/i);
  return encMatch ? (encMatch[1] as string).toLowerCase() : null;
}

const sameEncoding = (a: string, b: string, registry: EncodingRegistry): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    // An unknown name is "not the same encoding", not a failure: the caller is
    // only asking whether the two names agree, and an unregistered one cannot.
    const first = yield* Effect.orElseSucceed(registry.resolve(a), (): ResolvedEncodingDescriptor | null => null);
    const second = yield* Effect.orElseSucceed(registry.resolve(b), (): ResolvedEncodingDescriptor | null => null);
    return first !== null && second !== null && first.name === second.name;
  });
