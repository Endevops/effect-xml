import type EncodingRegistry from './EncodingRegistry.ts';
import type { ResolvedEncodingDescriptor } from './EncodingRegistry.ts';

import { ParseError, ErrorCode } from '../ParseError.ts';

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
export interface BomMatch {
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
 * @throws {ParseError} `ENCODING_MISMATCH` when the BOM and the declaration disagree.
 */
export function sniff(bytes: Buffer, registry: EncodingRegistry): EncodingDetection {
  const bomMatch = matchBom(bytes, registry);
  const declaredEncoding = sniffDeclaration(bytes, bomMatch ? bomMatch.bomLength : 0);

  if (bomMatch && declaredEncoding && !sameEncoding(bomMatch.descriptor.name, declaredEncoding, registry)) {
    throw new ParseError(
      `Byte-order mark indicates "${bomMatch.descriptor.name}" but the XML declaration says encoding="${declaredEncoding}"`,
      ErrorCode.ENCODING_MISMATCH
    );
  }

  if (bomMatch) {
    return { encoding: bomMatch.descriptor.name, bomLength: bomMatch.bomLength, declaredEncoding };
  }
  if (declaredEncoding) {
    return { encoding: declaredEncoding, bomLength: 0, declaredEncoding };
  }
  return { encoding: 'utf8', bomLength: 0, declaredEncoding: null };
}

function matchBom(bytes: Buffer, registry: EncodingRegistry): BomMatch | null {
  for (const descriptor of registry.bomCandidates()) {
    const sig = descriptor.bomBytes as Buffer;
    if (bytes.length >= sig.length && sig.equals(bytes.subarray(0, sig.length))) {
      return { descriptor, bomLength: sig.length };
    }
  }
  return null;
}

function sniffDeclaration(bytes: Buffer, offset: number): string | null {
  // ASCII-decode a bounded prefix; non-ASCII-safe encodings (UTF-16 etc.) are
  // already handled via BOM before we'd ever reach here without one.
  const prefix = bytes.subarray(offset, Math.min(bytes.length, offset + DECL_PEEK_BYTES)).toString('latin1');
  const declMatch = prefix.match(/^\s*<\?xml\s+[^?]*\?>/);
  if (!declMatch) return null;
  const encMatch = declMatch[0].match(/encoding\s*=\s*["']([^"']+)["']/i);
  return encMatch ? (encMatch[1] as string).toLowerCase() : null;
}

function sameEncoding(a: string, b: string, registry: EncodingRegistry): boolean {
  try {
    return registry.resolve(a).name === registry.resolve(b).name;
  } catch {
    return false;
  }
}
