import { Effect } from 'effect';

import type { InputSourceLike } from './input-source/input-source.ts';
import type { TagExpressionParser } from './internal/parser-types.ts';
import type { ParsedAttribute } from './internal/parser-types.ts';
import type { ParseError } from './parse-error.ts';

import { collectRawAttributes } from './attribute-processor.ts';
import { InvalidTagName, UnclosedQuote, UnexpectedEnd } from './parse-error.ts';
import { isSpace, absolutePosition } from './util.ts';

// Re-export flushAttributes so Xml2JsParser and XmlSpecialTagsReader can
// continue to import it from here without changing their import lines.
export { flushAttributes } from './attribute-processor.ts';

/**
 * @description A parsed tag expression: everything between `<` and `>` for an opening tag, or between `<?` and `?>` for a processing instruction. Carries two
 * representations of the same attribute list, each serving a different consumer: `rawAttributes` for the matcher (keyed by the names _as written_,
 * because path-expression attribute conditions match against written names), and `_parsedAttrs` for the output builder (keyed by processed names).
 * Both are produced by a single `collectRawAttributes()` pass.
 */
export class TagExp {
  /**
   * @description Processed tag name.
   */
  tagName: string;
  /**
   * @description Whether the tag ended with `/>` rather than `>`.
   */
  selfClosing: boolean;
  /**
   * @description Raw attribute values keyed by the name as written, for `matcher.push()`.
   */
  rawAttributes: Record<string, string | true>;
  /**
   * @description Number of attributes that survived name processing.
   */
  rawAttributesLen: number;
  /**
   * @description The attribute expression, kept for the second-pass flush. Reading it is not needed after `collectRawAttributes()`, but retaining it keeps the
   * offset bookkeeping single-sourced.
   */
  _attrsExp: string;
  /**
   * @description Absolute document offset of `_attrsExp`'s first character, or `undefined` when the start offset was unavailable. Used to compute each attribute's
   * absolute position for `addAttribute()`'s meta argument.
   */
  _attrsExpStart: number | undefined;
  /**
   * @description Total attributes parsed, including any dropped by name processing. Kept for `maxAttributesPerTag` parity.
   */
  _rawAttrMatchCount: number;
  /**
   * @description Processed-name/value pairs consumed directly by `flushAttributes()`.
   */
  _parsedAttrs: Array<ParsedAttribute>;

  constructor() {
    this.tagName = '';
    this.selfClosing = false;
    // rawAttributes= Object.create(null),
    this.rawAttributes = {};
    this.rawAttributesLen = 0;
    this._attrsExp = ''; // stored for two-pass attribute flushing in readOpeningTag
    this._attrsExpStart = undefined; // absolute document offset of _attrsExp's first char
    this._rawAttrMatchCount = 0;
    this._parsedAttrs = [];
  }
}

/**
 * @description Try to match an upcoming closing tag against the name we already expect (the tag sitting on top of the stack) without reading it into a string
 * first. Peeks character-by-character (no consumption) — a mismatch, or running out of buffered data, costs nothing to undo since nothing was
 * consumed. Caller falls back to the normal read+validate+compare path in either case, so this never needs its own error handling or chunk-boundary
 * logic. On success, only whitespace is allowed between the name and `>` — matches XML's own grammar for ETag (`</tag ... >`, no attributes
 * permitted).
 *
 * @param source - Input source.
 * @param expectedRawName - The raw (pre namespace-stripped) name the currently-open tag was written with.
 *
 * @returns Characters to consume (name + whitespace + `>`), or `-1` if this isn't a match (or not enough data yet to tell).
 */
export function tryMatchClosingTagName(source: InputSourceLike, expectedRawName: string): number {
  // false (mismatch) and null (not enough buffered data yet) both fall back
  // to the same slow path below, so both collapse to -1 here.
  if (source.matchAhead(expectedRawName) !== true) return -1;
  let i = expectedRawName.length;
  let c = source.readChAt(i);
  if (c === '>') return i + 1;
  while (isSpace(c)) {
    i++;
    c = source.readChAt(i);
    if (c === '>') return i + 1;
  }
  if (c !== '>') return -1;
  return i + 1;
}

/**
 * @description Read closing tag name. Uses the level-1 (inner) mark so `flush()` knows the safe trim boundary while this reader is in progress. Does NOT overwrite
 * the level-0 outer mark set by `parseXml()`'s loop, which `rewindToMark()` always restores to.
 *
 * @param source - Input source.
 *
 * @returns An effect producing the tag name. Fails with `UNEXPECTED_END` when the buffer ran out before `>`, with the partial name embedded in the
 *   message so autoClose's truncation recovery can still report something useful.
 */
export const readClosingTagName = Effect.fnUntracedEager(function* (source: InputSourceLike): Effect.fn.Return<string, UnexpectedEnd> {
  source.markTokenStart(1);
  // Closing tags never carry attributes, so unlike an opening tag's
  // expression there is no quoting to worry about — the very first '>' is
  // always the real end. That means the whole name can be found with one
  // direct scan of whatever is already buffered (readUptoChar), instead of
  // asking "is there more data yet?" before every single character.
  const start = source.startIndex;
  const str = yield* source.readUptoChar('>').pipe(
    Effect.catchTag('UNEXPECTED_END', () => {
      // Buffer ran out before '>' showed up — the retryable chunk-boundary
      // case (readUptoChar didn't consume anything on failure). Fail with
      // whatever was buffered so far in the message so autoClose's truncation
      // recovery (which reads it back out of the message) can still report a
      // useful partial tag name.
      const partial = source.readStr(Number.MAX_SAFE_INTEGER, start);
      return Effect.fail(
        new UnexpectedEnd({ reading: `closing tag '</${partial}'`, message: `Unexpected end of source reading closing tag '</${partial}'` })
      );
    })
  );
  return str.trimEnd();
});

/**
 * @description Read an XML opening tag expression and return a tag descriptor. Handles normal tags — not comments, CDATA, or DOCTYPE. Example input (from source,
 * after `<`): `tag attr='some"' attr2=">" bool` Uses the level-1 (inner) mark — see `readClosingTagName()` for rationale.
 *
 * @param parser - Parser context.
 *
 * @returns An effect producing the parsed tag expression. Fails with `UNEXPECTED_END` on a chunk boundary mid-tag, `INVALID_TAG_NAME` when the name
 *   fails XML's `QName` production.
 */
export const readTagExp = Effect.fnUntracedEager(function* (parser: TagExpressionParser): Effect.fn.Return<TagExp, ParseError> {
  parser.source.markTokenStart(1);
  // Absolute document offset where `exp` (tag name onward, right after '<')
  // begins — captured before any reads so buildTagExpObj can compute each
  // attribute's absolute document position from its offset within attrsExp.
  const expStart = absolutePosition(parser.source);

  // Pick the scan variant once — scanTagExpEnd records quote positions for
  // AttributeProcessor to reuse; scanTagExpEndFast skips that bookkeeping
  // entirely when attributes are being skipped (nobody reads _quotePairs).
  // No flag is passed into the loop; the decision is made here, once.
  const collectQuotes = !parser.options.skip.attributes;
  const relEnd = collectQuotes ? parser.source.scanTagExpEnd() : parser.source.scanTagExpEndFast();

  if (relEnd === -1) {
    // Buffer exhausted before an unquoted '>' was found — chunk boundary
    // mid-tag. Fail with UNEXPECTED_END so feed()/parseStream() rewinds to the
    // level-0 outer mark and retries. (Note: scanTagExpEnd() only returns a
    // non-negative index once both quote flags are already balanced-closed —
    // by construction, not by a separate post-scan check — so there is no
    // longer a distinct "unclosed quote but '>' was found" case to detect;
    // the old UNCLOSED_QUOTE branch here was checking the same two flags
    // immediately after the only code path that requires them both false,
    // making it permanently unreachable.)
    return yield* new UnexpectedEnd({ reading: `'>'`, message: "Unexpected closing of source waiting for '>'" });
  }

  const exp = parser.source.readStr(relEnd);
  parser.source.updateBufferBoundary(relEnd + 1);

  // Quote positions the scan above already found while looking for '>' —
  // handed to AttributeProcessor so it doesn't re-scan for quotes itself.
  // Usable because every source decodes before scanning, so the offsets are
  // already character indices into the same string `exp` was sliced from; the
  // `_quotePairsUsable !== false` test is retained so a source recording byte
  // offsets would still opt out. Consumed synchronously by
  // buildTagExpObj below, before any other tag scan can touch the array
  // again, so no staleness risk. `_quotePairs` is a fixed-capacity reusable
  // typed array — `_quotePairsLen` says how many of its slots are valid for
  // this tag (not `_quotePairs.length`, which is always the full capacity).
  const usableQuotes = collectQuotes && parser.source._quotePairsUsable !== false;
  const quotePairs = usableQuotes ? parser.source._quotePairs : undefined;
  const quotePairsLen = usableQuotes ? parser.source._quotePairsLen : 0;

  return yield* buildTagExpObj(exp, parser, expStart, false, quotePairs, quotePairsLen);
});

/**
 * @description Read a processing-instruction tag expression (`<?name attrs?>`). Uses the level-1 (inner) mark — see `readClosingTagName()` for rationale.
 *
 * @param parser - Parser context.
 *
 * @returns An effect producing the parsed tag expression. Fails with `UNEXPECTED_END` on a chunk boundary mid-PI-tag, `UNCLOSED_QUOTE` when `?>` is
 *   found inside an unterminated quoted value.
 */
export const readPiExp = Effect.fnUntracedEager(function* (parser: TagExpressionParser): Effect.fn.Return<TagExp, ParseError> {
  parser.source.markTokenStart(1);
  const expStart = absolutePosition(parser.source);
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let i: number;
  let EOE = false;

  for (i = 0; parser.source.canRead(i); i++) {
    const currentChar = parser.source.readChAt(i);
    const nextChar = parser.source.readChAt(i + 1);

    // Flat guards, so a character is classified by the first thing it matches.
    // A quote cannot also be the `?` of `?>`, so continuing past a quote toggle
    // skips a check that could not have fired.
    if (currentChar === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }
    if (currentChar === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }
    // `?>` ends the instruction only outside quotes — inside one it is content.
    if (currentChar === '?' && nextChar === '>' && !inSingleQuotes && !inDoubleQuotes) {
      EOE = true;
      break;
    }
  }

  if (!EOE) {
    // Buffer exhausted before '?>' — chunk boundary mid-PI-tag.
    return yield* new UnexpectedEnd({ reading: `'?>'`, message: "Unexpected closing of source waiting for '?>'" });
  } else if (inSingleQuotes || inDoubleQuotes) {
    // '?>' found but a quote was never closed — real syntax error.
    return yield* new UnclosedQuote({ message: 'Invalid attribute expression. Quote is not properly closed in PI tag expression' });
  }

  // if (!parser.options.skip.attributes) {
  //   //TODO: use regex to verify attributes if not set to ignore
  // }

  const exp = parser.source.readStr(i);
  parser.source.updateBufferBoundary(i + 2);
  return yield* buildTagExpObj(exp, parser, expStart, true);
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * @description Parse a raw tag expression string into a structured tag descriptor.
 *
 * @param exp - Everything between `<` and `>` (exclusive).
 * @param parser - Parser context.
 * @param expStart - Absolute document offset where `exp` begins (i.e. right after `<` or `<?`). Used to compute each attribute's absolute document
 *   position (`tagExp._attrsExpStart`) for `addAttribute()`'s meta arg. Optional so callers that don't have/need it can omit it — attribute position
 *   metadata is simply unavailable in that case, not an error.
 * @param forceToReadAttrs - Read attributes even when the expression carries none. Set for PI tags, whose whole payload is attributes.
 * @param quotePairs - Flat `[openIdx, closeIdx, …]` list from `scanTagExpEnd()`, offsets relative to `exp`'s start. Passed through to
 *   `collectRawAttributes()` so `parseAttributes()` can skip re-scanning for quotes. Undefined when unavailable/unsafe for this source or call site
 *   (`readPiExp()` never supplies one) — `collectRawAttributes()` falls back to its own scan in that case.
 * @param quotePairsLen - How many entries in `quotePairs` are valid (it's a reused fixed-capacity array, not sized to this tag).
 *
 * @returns An effect producing the populated tag expression. Fails with `INVALID_TAG_NAME` when the name fails XML's `QName` production, plus
 *   anything the attribute pass reports.
 */
const buildTagExpObj = Effect.fnUntracedEager(function* (
  exp: string,
  parser: TagExpressionParser,
  expStart: number | undefined,
  forceToReadAttrs: boolean = false,
  quotePairs?: Int32Array,
  quotePairsLen: number = 0
): Effect.fn.Return<TagExp, ParseError> {
  const tagExp = new TagExp();

  if (exp[exp.length - 1] === '/') {
    tagExp.selfClosing = true;
    exp = exp.slice(0, -1); // Remove the trailing slash
  }

  const split = splitNameFromAttrs(exp);
  tagExp.tagName = split.name;
  tagExp._attrsExp = split.attrsExp;
  // Absolute document offset of the attribute expression, for each attribute's
  // `index`. Optional so callers that have no position for `exp` can omit it —
  // the metadata is then unavailable, not an error.
  if (expStart !== undefined) tagExp._attrsExpStart = expStart + split.attrsOffset;

  if (!(yield* parser.isValidQName(tagExp.tagName))) {
    return yield* new InvalidTagName({ name: tagExp.tagName, message: 'Invalid tag name' });
  }

  // Pass 1: collect raw attribute values for matcher.updateCurrent().
  // Pass 2 (flushAttributes) runs later in readOpeningTag, after updateCurrent()
  // — and is still gated by skip.attributes there, so output/matcher visibility
  // of attribute values is unaffected by the change below.
  //
  // This pass itself, however, always runs whenever an attribute expression is
  // present — even when skip.attributes is true. Malformed attribute syntax
  // (unquoted values, illegal duplicates, illegal control characters) is a
  // document-validity problem, not an output-shaping one, so skip.attributes
  // must not be able to silently let broken markup through.
  if (forceToReadAttrs || split.attrsExp.length > 0) {
    yield* collectRawAttributes(split.attrsExp, parser, tagExp, quotePairs, split.attrsOffset, quotePairsLen);
  }

  return tagExp;
});

/**
 * @description Split a raw tag expression into its tag name and its attribute expression, which the first whitespace separates. A tag with no whitespace has no
 * attributes, so the whole expression is the name.
 *
 * @param exp - Everything between `<` and `>` (exclusive), already stripped of a trailing `/`.
 *
 * @returns The tag name as written, trailing whitespace trimmed, plus the attribute expression and the offset it starts at within `exp`. The offset
 *   rebases the quote-pair positions `scanTagExpEnd` recorded against the whole expression, so `parseAttributes` can reuse them.
 */
function splitNameFromAttrs(exp: string): { name: string; attrsExp: string; attrsOffset: number } {
  for (let i = 0; i < exp.length; i++) {
    if (!isSpace(exp[i])) continue;
    return { name: exp.substring(0, i).trimEnd(), attrsExp: exp.substring(i + 1), attrsOffset: i + 1 };
  }

  return { name: exp, attrsExp: '', attrsOffset: 0 };
}
