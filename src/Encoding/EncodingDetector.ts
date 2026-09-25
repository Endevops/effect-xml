import { ParseError, ErrorCode } from '../ParseError.js';

const DECL_PEEK_BYTES = 200; // more than enough for a <?xml ... ?> declaration

/**
 * @description Sniff(bytes, registry) -> { encoding, bomLength, declaredEncoding } Pure function — no state, easy to unit test standalone. Only needs the leading
 * bytes of the document (caller decides how many it has available). Algorithm (XML 1.0 Appendix F, practical subset):
 *
 * 1. Check for a known BOM signature.
 * 2. ASCII-sniff far enough to find `encoding="..."` inside a leading `<?xml ... ?>` declaration (the declaration's own bytes are ASCII- stable across
 *    UTF-8/ASCII/Latin-1/most single-byte sets, which is exactly why this step doesn't need to already know the encoding).
 * 3. BOM present + declared encoding present + they disagree -> hard error.
 * 4. Neither found -> default to utf8 (spec default).
 */
export function sniff(bytes, registry) {
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

function matchBom(bytes, registry) {
  for (const descriptor of registry.bomCandidates()) {
    const sig = descriptor.bomBytes;
    if (bytes.length >= sig.length && sig.equals(bytes.subarray(0, sig.length))) {
      return { descriptor, bomLength: sig.length };
    }
  }
  return null;
}

function sniffDeclaration(bytes, offset) {
  // ASCII-decode a bounded prefix; non-ASCII-safe encodings (UTF-16 etc.) are
  // already handled via BOM before we'd ever reach here without one.
  const prefix = bytes.subarray(offset, Math.min(bytes.length, offset + DECL_PEEK_BYTES)).toString('latin1');
  const declMatch = prefix.match(/^\s*<\?xml\s+[^?]*\?>/);
  if (!declMatch) return null;
  const encMatch = declMatch[0].match(/encoding\s*=\s*["']([^"']+)["']/i);
  return encMatch ? encMatch[1].toLowerCase() : null;
}

function sameEncoding(a, b, registry) {
  try {
    return registry.resolve(a).name === registry.resolve(b).name;
  } catch {
    return false;
  }
}
