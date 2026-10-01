import { Effect } from 'effect';

import type { AttributeMeta, ParsedAttribute, RawAttributeMatch, TagExpressionParser } from './internal/parser-types.ts';
import type { ParseError } from './parse-error.ts';

import {
  BooleanAttributeRejected,
  DuplicateAttribute,
  IllegalCharacter,
  LimitMaxAttributes,
  UnquotedAttributeValue,
  runBuilder,
} from './parse-error.ts';
import { isSpaceCode, errorPositionOf } from './util.ts';

/**
 * @description AttributeProcessor — owns all attribute parsing logic. Two-pass attribute processing:
 *
 * - **Pass 1 — `collectRawAttributes()`.** Populates the `rawAttributes` map from the raw attribute expression string. Called inside `buildTagExpObj()`
 *   (via `XmlPartReader`) so `rawAttributes` is ready before `readOpeningTag()` calls `matcher.updateCurrent(rawAttributes)`. The matcher must
 *   reflect all raw attribute values before any value-parser runs so that attribute-based path expressions (e.g. `"div[class=code]"`) resolve
 *   correctly during pass 2.
 * - **Pass 2 — `flushAttributes()`.** Calls `outputBuilder.addAttribute()` for each attribute, running the full value-parser chain. Called from
 *   `readOpeningTag()` AFTER `matcher.updateCurrent()`, so the read-only matcher already carries the complete attribute context when value parsers
 *   execute.
 */

// Module-level regex kept for reference only — no longer called from this
// module. parseAttributes() below replaces it with an O(n) linear scanner
// that is immune to catastrophic backtracking and stack overflow.
// const attrsRegx = new RegExp('([^\\s=]+)\\s*(=\\s*([\'"])([\\s\\S]*?)\\3)?', 'gm');

/**
 * @description True for character codes illegal as literal content anywhere in the document (mirrors `util.isIllegalControlCode` — not imported directly to keep
 * this hot loop free of a cross-module call for a one-line check).
 */
function isIllegalAttrCode(c: number): boolean {
  return c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31);
}

/**
 * @description What scanning one attribute produced: the match and where the next one starts, a value that was not quoted, the illegal control character in a
 * value, or the end of the expression — only whitespace left.
 */
type AttrReadResult =
  | { readonly kind: 'read'; readonly match: RawAttributeMatch; readonly next: number }
  | { readonly kind: 'unquoted'; readonly name: string }
  | { readonly kind: 'illegal'; readonly charCode: number }
  | { readonly kind: 'end' };

/**
 * @description The fold of one quoted attribute value, or the illegal control character that stopped it. A result rather than an effect: the fold runs once per
 * attribute of every tag, and returning a value keeps it out of the effect channel while {@link parseAttributes} still reports the failure in the same
 * typed channel.
 */
type AttrValueFold = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly charCode: number };

/**
 * @description Mutable cursor over the quote-pair list recorded by `scanTagExpEnd()`, carried across the attributes of one tag so each value can reuse the close
 * position already found for it.
 */
interface PairCursor {
  /**
   * @description Index of the next unread pair.
   */
  idx: number;
}

/**
 * @description Parse an attribute expression string into an array of match tuples. Each element is `{ name, value, startIndex }` — `value` is `undefined` for a
 * boolean attribute (no `=`). A single O(n) pass over char codes with no regex and no recursion, which is what makes it safe for arbitrarily long
 * attribute strings. The per-attribute step lives in {@link readOneAttribute} and the value fold in {@link foldAttributeValue}: both are plain
 * functions, not effects, because the old shape routed every attribute through two extra generators — an effect boundary is a generator, an iterator
 * pass and an exit allocation, and on a document of thousands of tags that was the bulk of the work. This generator keeps only the loop and the two
 * failures, so the error channel is unchanged.
 *
 * @param attrStr - The raw attribute expression.
 * @param quotePairs - Flat `[openIdx, closeIdx, …]` list from `scanTagExpEnd()`, offsets relative to the _tag expression_ (not `attrStr`). When a
 *   value's opening quote lines up with the next expected pair, the closing quote's position is taken directly instead of re-scanning for it — the
 *   per-character `!== quote` comparison is skipped entirely for that value. Falls back to the per-character scan (`undefined`, or a mismatch —
 *   belt-and-braces, should never trigger given how the pairs are produced, but costs nothing to check once per value) so correctness never depends
 *   on the fast path succeeding.
 * @param attrsOffset - Offset of `attrStr`'s first character within the coordinate system `quotePairs` is expressed in — required whenever
 *   `quotePairs` is passed.
 * @param quotePairsLen - How many entries in `quotePairs` are valid — it is a reused fixed-capacity typed array, not sized to this tag, so
 *   `quotePairs.length` itself is not the right bound to loop against.
 * @param parser - Parser context, used only to report error positions.
 *
 * @returns An effect producing the parsed match tuples. Fails with `UNQUOTED_ATTRIBUTE_VALUE` when a value is not wrapped in a quote,
 *   `ILLEGAL_CHARACTER` on an illegal control code.
 */
const parseAttributes = Effect.fnUntracedEager(function* (
  attrStr: string,
  quotePairs: Int32Array | undefined,
  attrsOffset: number | undefined,
  quotePairsLen: number = 0,
  parser?: TagExpressionParser
): Effect.fn.Return<Array<RawAttributeMatch>, ParseError> {
  const results: Array<RawAttributeMatch> = [];
  const len = attrStr.length;
  const usePairs = quotePairs !== undefined && quotePairsLen > 0;
  // `attrsOffset` is only absent on the paths that never reach here, but the
  // original arithmetic let it become NaN rather than 0. Preserved on purpose:
  // a mis-wired call then fails to match instead of silently matching against
  // pair indices from the wrong origin.
  const pairBase = attrsOffset as number;
  const cursor: PairCursor = { idx: 0 };

  let i = 0;
  while (true) {
    const read = readOneAttribute(attrStr, len, i, usePairs, quotePairs, quotePairsLen, pairBase, cursor);
    if (read.kind === 'end') break;

    if (read.kind === 'unquoted') {
      return yield* new UnquotedAttributeValue({
        name: read.name,
        message: `Attribute '${read.name}' has an unquoted value — attribute values must be wrapped in '"' or "'"`,
        index: parser ? errorPositionOf(parser.source).index : undefined,
      });
    }

    if (read.kind === 'illegal') {
      return yield* new IllegalCharacter({
        charCode: read.charCode,
        in: 'attribute',
        message: `Illegal control character 0x${read.charCode.toString(16).padStart(2, '0')} in attribute value`,
        index: parser ? errorPositionOf(parser.source).index : undefined,
      });
    }

    results.push(read.match);
    i = read.next;
  }

  return results;
});

/**
 * @description Read the one attribute starting at `from`, through its value or up to the end of a boolean attribute. Plain and synchronous: it reports what it
 * read, or which failure {@link parseAttributes} should raise, rather than failing in the effect channel itself.
 *
 * @param attrStr - The raw attribute expression.
 * @param len - `attrStr.length`.
 * @param from - Offset to start at, which may be whitespace.
 * @param usePairs - Whether the recorded quote pairs are usable for this expression.
 * @param pairs - The recorded quote pairs, or `undefined`.
 * @param pairsLen - How many entries in `pairs` are valid.
 * @param pairBase - Offset of `attrStr` within the coordinate system `pairs` is expressed in.
 * @param cursor - The pair cursor, advanced when a recorded pair is consumed.
 *
 * @returns What was read: a match and the next offset, an unquoted value, an illegal control character, or the end of the expression.
 */
// fallow-ignore-next-line complexity
function readOneAttribute(
  attrStr: string,
  len: number,
  from: number,
  usePairs: boolean,
  pairs: Int32Array | undefined,
  pairsLen: number,
  pairBase: number,
  cursor: PairCursor
): AttrReadResult {
  // Skip whitespace between attributes
  let i = skipSpaces(attrStr, from, len);
  if (i >= len) return { kind: 'end' };

  const nameStart = i;
  const { name, next } = readAttrName(attrStr, i, len);

  // Skip whitespace before '='
  i = skipSpaces(attrStr, next, len);

  // No '=' — a boolean attribute. It ends at the whitespace that stopped the name scan.
  if (i >= len || attrStr.charCodeAt(i) !== EQUALS) {
    return { kind: 'read', match: { name, value: undefined, startIndex: nameStart }, next: i };
  }

  i = skipSpaces(attrStr, i + 1, len); // past '='

  // The character right after '=' (mod whitespace) MUST be a quote — this is
  // never relaxed, in any mode. Reject before consuming anything, so an
  // unquoted value never partially reaches the output builder.
  const quote = attrStr.charCodeAt(i); // NaN when i >= len — rejects below
  if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) return { kind: 'unquoted', name };

  // Reuse a closing-quote position the tag-end scanner already recorded. When the pair recorded for
  // this attribute's opening quote lines up, its close is already known and rescanning for it is
  // wasted work. A mismatch falls through to the per-character scan, so correctness never depends
  // on the fast path succeeding.
  let closeLocal = -1;
  if (usePairs && cursor.idx + 1 < pairsLen && (pairs as Int32Array)[cursor.idx] === i + pairBase) {
    closeLocal = ((pairs as Int32Array)[cursor.idx + 1] as number) - pairBase;
    cursor.idx += 2;
  }

  i++; // skip opening quote
  const end = closeLocal >= 0 ? closeLocal : findClosingQuote(attrStr, i, len, quote);

  const folded = foldAttributeValue(attrStr, i, end);
  if (!folded.ok) return { kind: 'illegal', charCode: folded.charCode };

  return { kind: 'read', match: { name, value: folded.value, startIndex: nameStart }, next: end + 1 }; // skip closing quote
}

/**
 * @description Fold one quoted attribute value's whitespace per XML §3.3.3 and reject illegal control characters, in one pass. A real `\r\n` pair becomes one
 * space (not two); a lone `\r`, lone `\n` or literal tab becomes one space; any other illegal code is reported back. A `&#9;` reference is left
 * untouched — that is resolved later, by the entity value-parser, not here.
 *
 * @param attrStr - The expression the value came from.
 * @param start - Offset of the value's first character, past the opening quote.
 * @param end - Offset of the closing quote.
 *
 * @returns The folded value, or the illegal control character that stopped it.
 */
function foldAttributeValue(attrStr: string, start: number, end: number): AttrValueFold {
  let value = '';
  let segStart = start;
  for (let j = start; j < end; j++) {
    const c = attrStr.charCodeAt(j);
    if (c === 13) {
      value += attrStr.substring(segStart, j) + ' ';
      if (attrStr.charCodeAt(j + 1) === 10) j++;
      segStart = j + 1;
    } else if (c === 10 || c === 9) {
      value += attrStr.substring(segStart, j) + ' ';
      segStart = j + 1;
    } else if (isIllegalAttrCode(c)) {
      return { ok: false, charCode: c };
    }
  }
  value += attrStr.substring(segStart, end);
  return { ok: true, value };
}

/**
 * @description Character code of `=`, which terminates an attribute name.
 */
const EQUALS = 61;
/**
 * @description Character code of `"`, the double-quote attribute delimiter.
 */
const DOUBLE_QUOTE = 34;
/**
 * @description Character code of `'`, the single-quote attribute delimiter.
 */
const SINGLE_QUOTE = 39;

/**
 * @description Advance past XML whitespace, stopping at `len`. XML permits whitespace around `=` and between attributes, so this is needed in three places per
 * attribute and was the single largest source of duplicated scanning loops in `parseAttributes`.
 */
function skipSpaces(attrStr: string, from: number, len: number): number {
  let i = from;
  while (i < len && isSpaceCode(attrStr.charCodeAt(i))) i++;
  return i;
}

/**
 * @description Read the attribute name at `from`. A name runs to the first `=`, the first whitespace, or the end of the expression — any of which means either a
 * value follows or the attribute is boolean.
 *
 * @returns The name as written, and the offset just past it. The cursor is left
 * _before_ any whitespace, for the caller to skip.
 */
function readAttrName(attrStr: string, from: number, len: number): { name: string; next: number } {
  let i = from;
  while (i < len && attrStr.charCodeAt(i) !== EQUALS && !isSpaceCode(attrStr.charCodeAt(i))) i++;
  return { name: attrStr.substring(from, i), next: i };
}

/**
 * @description Find the closing quote for an attribute value by scanning forward from `from`.
 *
 * @returns The offset of the matching quote, or `len` if the value is unterminated — which `parseAttributes` reports rather than this function
 *   throwing, so the unterminated case keeps its existing error.
 */
function findClosingQuote(attrStr: string, from: number, len: number, quote: number): number {
  let end = from;
  while (end < len && attrStr.charCodeAt(end) !== quote) end++;
  return end;
}

/**
 * @description A `TagExp` mid-construction. Split out from `XmlPartReader.TagExp` so this module can describe what it populates without importing back.
 */
export interface TagExpAttributeTarget {
  /**
   * @description Raw attribute values keyed by the attribute name _as written_, for `matcher.push()`'s attribute-condition matching.
   */
  rawAttributes: Record<string, string | true>;
  /**
   * @description Number of attributes that survived name processing.
   */
  rawAttributesLen: number;
  /**
   * @description Total parsed attributes, including any dropped by `processAttrName()`. Kept for `maxAttributesPerTag` parity with the pre-processing behaviour.
   */
  _rawAttrMatchCount: number;
  /**
   * @description The processed-name/value list pass 2 consumes directly.
   */
  _parsedAttrs: Array<ParsedAttribute>;
}

/**
 * @description _Pass 1_*: extract raw (unparsed) attribute values into `rawAttributes`, AND build `tagExp._parsedAttrs` — the processed-name/value list pass 2
 * will consume directly. Pass 2 (`flushAttributes`) used to re-run `parseAttributes()` from scratch on the same `attrStr`, and re-ran
 * `parser.processAttrName()` (ns-prefix resolution + name validation + `sanitizeName` + reserved-name check) on every attribute a second time — full
 * re-tokenization plus full re-validation of work already done here. `processAttrName()` is a pure function of `(rawName, options)` — nothing between
 * pass 1 and pass 2 (`matcher.push`, stop/skip resolution) can change its result — so it's safe to compute once and cache. The matcher still gets the
 * _raw_ (pre-`resolveNsPrefix`/sanitize) name as its `rawAttributes` key, unchanged, since PEM's attribute-condition matching (`div[class=code]`)
 * matches against attribute names as written.
 *
 * @param attrStr - Raw attribute expression substring.
 * @param parser - Parser context (for `processAttrName` and error positions).
 * @param tagExp - `TagExp` to populate.
 * @param quotePairs - See `parseAttributes()`.
 * @param attrsOffset - See `parseAttributes()`.
 * @param quotePairsLen - See `parseAttributes()`.
 *
 * @returns An effect that populates `tagExp`. Fails with `DUPLICATE_ATTRIBUTE` under `attributes.duplicate: 'throw'`, `BOOLEAN_ATTRIBUTE_REJECTED`
 *   under `attributes.booleanType: 'throw'`, plus whatever `parseAttributes()` reports.
 */
export const collectRawAttributes = Effect.fnUntracedEager(function* (
  attrStr: string,
  parser: TagExpressionParser,
  tagExp: TagExpAttributeTarget,
  quotePairs?: Int32Array,
  attrsOffset?: number,
  quotePairsLen?: number
): Effect.fn.Return<void, ParseError> {
  if (!attrStr || attrStr.length === 0) return;

  const matches = yield* parseAttributes(attrStr, quotePairs, attrsOffset, quotePairsLen, parser);
  // total parsed attrs, incl. dropped (xmlns:) ones — for maxAttributesPerTag parity with old behavior
  tagExp._rawAttrMatchCount = matches.length;

  // attributes.duplicate: 'overwrite' (default) needs no bookkeeping — last
  // occurrence naturally wins via the rawAttributes object-assign + the
  // builder's own last-write-wins addAttribute() calls below, exactly as
  // before this option existed. 'ignore'/'throw' need to track names seen
  // so far on *this* tag only — a fresh Set per call, never shared across tags.
  const dupMode = parser.options.attributes?.duplicate || 'overwrite';
  const policy: AttrPolicy = {
    dupMode,
    seen: dupMode !== 'overwrite' ? new Set<string>() : null,
    boolMode: parser.options.attributes?.booleanType || 'allow',
  };

  const parsedAttrs = yield* keepAttributes(matches, parser, tagExp, policy);
  tagExp.rawAttributesLen = parsedAttrs.length;
  tagExp._parsedAttrs = parsedAttrs;
});

/**
 * @description The per-tag attribute policies `collectRawAttributes` applies, resolved once per tag. Split out because each is a separate decision the match loop
 * would otherwise be branching on, and two of them (`duplicate` and `booleanType`) have nothing to do with each other.
 */
interface AttrPolicy {
  /**
   * @description `attributes.duplicate`: which occurrence of a repeated name wins.
   */
  dupMode: 'overwrite' | 'ignore' | 'throw';
  /**
   * @description Names already seen on _this_ tag, or `null` under `'overwrite'` where last-write-wins needs no bookkeeping. Never shared across tags.
   */
  seen: Set<string> | null;
  /**
   * @description `attributes.booleanType`: what to do with a valueless attribute.
   */
  boolMode: 'allow' | 'ignore' | 'throw';
}

/**
 * @description What to do with one parsed attribute occurrence.
 */
type OccurrenceDecision = 'accept' | 'drop' | 'duplicate' | 'valueless';

/**
 * @description Decide whether one parsed occurrence of an attribute is processed at all. Duplicate detection runs first, so a repeated boolean attribute is
 * reported as a duplicate rather than as a second valueless one. Plain and synchronous: the decision is reported back and {@link keepAttributes}
 * raises the corresponding failure, which keeps the policy out of the effect channel while the failure still lands there.
 *
 * @param policy - Per-tag policies, with `policy.seen` updated on acceptance.
 * @param m - The parsed occurrence.
 *
 * @returns `'accept'` to process it, `'drop'` to skip it, or which failure to raise.
 */
function decideOccurrence(policy: AttrPolicy, m: RawAttributeMatch): OccurrenceDecision {
  if (policy.seen !== null) {
    if (policy.seen.has(m.name)) return policy.dupMode === 'throw' ? 'duplicate' : 'drop';
    policy.seen.add(m.name);
  }

  if (m.value !== undefined) return 'accept';

  // 'ignore' drops it silently, rest of tag unaffected; 'allow' falls through with the value becoming `true`.
  if (policy.boolMode === 'throw') return 'valueless';
  return policy.boolMode === 'allow' ? 'accept' : 'drop';
}

/**
 * @description Walk the parsed matches, apply the policies, process each surviving name once, and record what is left. `processAttrName()` is the expensive step
 * (ns-prefix resolution, name validation, sanitization, reserved-name check), so it runs only for occurrences the policies keep — and only once,
 * which is the whole point of pass 1 caching into `_parsedAttrs` for pass 2. The policy decision itself is {@link decideOccurrence}, a plain
 * function, so this generator carries only the loop and the two failures.
 *
 * @returns An effect producing the attributes that survived, in document order. Its length is also the surviving count, so `rawAttributesLen` needs
 *   no separate tally. Fails with `DUPLICATE_ATTRIBUTE` under `attributes.duplicate: 'throw'`, `BOOLEAN_ATTRIBUTE_REJECTED` under
 *   `attributes.booleanType: 'throw'`.
 */
const keepAttributes = Effect.fnUntracedEager(function* (
  matches: Array<RawAttributeMatch>,
  parser: TagExpressionParser,
  tagExp: TagExpAttributeTarget,
  policy: AttrPolicy
): Effect.fn.Return<Array<ParsedAttribute>, ParseError> {
  const parsedAttrs: Array<ParsedAttribute> = [];

  for (const m of matches) {
    const decision = decideOccurrence(policy, m);
    if (decision === 'drop') continue;

    if (decision === 'duplicate') {
      return yield* new DuplicateAttribute({ name: m.name, message: `Duplicate attribute '${m.name}'`, index: errorPositionOf(parser.source).index });
    }

    if (decision === 'valueless') {
      return yield* new BooleanAttributeRejected({
        name: m.name,
        message: `Valueless attribute '${m.name}' is not allowed`,
        index: errorPositionOf(parser.source).index,
      });
    }

    const attrName = yield* parser.processAttrName(m.name);
    if (attrName === false) continue;

    const attrVal = m.value !== undefined ? m.value : true;
    tagExp.rawAttributes[m.name] = attrVal;
    parsedAttrs.push({ name: attrName, value: attrVal, index: m.startIndex });
  }

  return parsedAttrs;
});

/**
 * @description _Pass 2_*: push each attribute (already parsed + name-processed by pass 1, see `tagExp._parsedAttrs`) to the output builder. No re-parsing, no
 * re-running `processAttrName` — this is a plain loop over cached data.
 *
 * @param parsedAttrs - `TagExp._parsedAttrs` from `collectRawAttributes()`.
 * @param parser - Parser context.
 * @param attrsExpStart - Absolute document offset where the attribute expression began (`tagExp._attrsExpStart`). When provided, each attribute's
 *   absolute document index is computed and passed to `addAttribute()` as a fourth argument. Line/col are intentionally NOT computed here — doing so
 *   would require re-scanning `attrStr` for newlines on every call, for a field most builders won't use; callers that need it can derive line/col
 *   from `index` plus the document text.
 * @param rawAttrMatchCount - `TagExp._rawAttrMatchCount`, used for the `maxAttributesPerTag` limit check (counts all parsed attributes, including any
 *   dropped by `processAttrName`, matching the limit's pre-existing semantics).
 * @param tagName - The name of the tag these attributes belong to, for the limit's error. Passed in rather than read from `parser.currentTagDetail`,
 *   because pass 2 runs from `readOpeningTag()` _before_ the tag is pushed — so `currentTagDetail` is still the parent, or the synthetic root, and
 *   the error named the wrong tag. It read as `Tag '' has 3 attributes` for a limit that is otherwise perfectly clear, and a caller had no way to
 *   tell which tag was refused.
 *
 * @returns An effect that pushes each attribute. Fails with `LIMIT_MAX_ATTRIBUTES` when the tag carries more attributes than the limit allows, or
 *   with a `DependencyError` when the builder's value-parser chain fails.
 */
export function flushAttributes(
  parsedAttrs: Array<ParsedAttribute> | undefined,
  parser: TagExpressionParser,
  attrsExpStart: number | undefined,
  rawAttrMatchCount: number,
  tagName: string
): Effect.Effect<void, ParseError> {
  // A tag with no attributes answers with the shared `Effect.void` before entering a generator. A
  // document has many attribute-less tags, and the loop below is worth a generator only when there is
  // at least one attribute to push.
  if (!parsedAttrs || parsedAttrs.length === 0) return Effect.void;

  const maxAttrs = parser.options.limits?.maxAttributesPerTag;
  if (maxAttrs !== undefined && maxAttrs !== null && rawAttrMatchCount > maxAttrs) {
    return Effect.fail(
      new LimitMaxAttributes({
        limit: maxAttrs,
        count: rawAttrMatchCount,
        tag: tagName,
        message: `Tag '${tagName}' has ${rawAttrMatchCount} attributes, exceeding limit of ${maxAttrs}`,
        index: errorPositionOf(parser.source).index,
      })
    );
  }

  return flushAttributesEager(parsedAttrs, parser, attrsExpStart);
}

/**
 * @description The loop for a tag that actually carries attributes: push each one, already parsed and name-processed by pass 1, to the output builder. The
 * builder's attribute pipeline can fail — an entity expansion limit, a caller-supplied value processor — so each call is run through `runBuilder`
 * rather than discarded.
 */
const flushAttributesEager = Effect.fnUntracedEager(function* (
  parsedAttrs: Array<ParsedAttribute>,
  parser: TagExpressionParser,
  attrsExpStart: number | undefined
): Effect.fn.Return<void, ParseError> {
  const len = parsedAttrs.length;
  for (let i = 0; i < len; i++) {
    const a = parsedAttrs[i] as ParsedAttribute;
    const attrMeta: AttributeMeta | undefined = attrsExpStart !== undefined ? { index: attrsExpStart + a.index } : undefined;
    yield* runBuilder(parser.outputBuilder.addAttribute(a.name, a.value, parser.readonlyMatcher, attrMeta));
  }
});
