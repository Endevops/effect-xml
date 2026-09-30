import type { AttributeMeta, ParsedAttribute, RawAttributeMatch, TagExpressionParser } from './internal/parser-types.ts';

import {
  BooleanAttributeRejected,
  DuplicateAttribute,
  IllegalCharacter,
  LimitMaxAttributes,
  UnquotedAttributeValue,
  runBuilder,
} from './parse-error.js';
import { isSpaceCode, errorPositionOf } from './util.js';

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
 * @description Scan one quoted attribute value's characters from `i` up to `end` (exclusive), folding whitespace per XML §3.3.3 and rejecting illegal control
 * characters. Shared by both the fast path (closing quote position already known from `scanTagExpEnd`'s quote pairs) and the slow path (closing quote
 * found by scanning for `quote`) below — same rules either way.
 *
 * - Real `\r\n` pair → exactly one space (not two)
 * - Lone `\r` or lone `\n` → one space
 * - Literal tab (0x09) → one space (a `&#9;` reference is left untouched — that's resolved later, by the entity value-parser, not here)
 * - Other illegal control code → throws `ILLEGAL_CHARACTER`
 *
 * @returns The folded value, without the closing quote.
 *
 * @throws {ParseError} `ILLEGAL_CHARACTER` on an illegal control code.
 */
function scanAttrValue(attrStr: string, i: number, end: number, parser: TagExpressionParser | undefined): string {
  let value = '';
  let segStart = i;
  for (; i < end; i++) {
    const c = attrStr.charCodeAt(i);
    if (c === 13) {
      // \r — possibly paired with a following \n
      value += attrStr.substring(segStart, i) + ' ';
      if (attrStr.charCodeAt(i + 1) === 10) i++;
      segStart = i + 1;
    } else if (c === 10 || c === 9) {
      // lone \n, or literal tab
      value += attrStr.substring(segStart, i) + ' ';
      segStart = i + 1;
    } else if (isIllegalAttrCode(c)) {
      throw new IllegalCharacter({
        charCode: c,
        in: 'attribute',
        message: `Illegal control character 0x${c.toString(16).padStart(2, '0')} in attribute value`,
        index: parser ? errorPositionOf(parser.source).index : undefined,
      });
    }
  }
  value += attrStr.substring(segStart, i);
  return value;
}

/**
 * @description Parse an attribute expression string into an array of match tuples. Each element is `{ name, value, startIndex }` — `value` is `undefined` for a
 * boolean attribute (no `=`). A single O(n) pass over char codes with no regex and no recursion, which is what makes it safe for arbitrarily long
 * attribute strings. State machine: SEEK_NAME — skipping whitespace looking for the start of an attr name; IN_NAME — accumulating a name token until
 * whitespace or `=`; SEEK_VALUE — saw name + optional whitespace, now expecting `=` or the next name; IN_VALUE — inside a quoted value, accumulating
 * until the closing quote.
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
 * @throws {ParseError} `UNQUOTED_ATTRIBUTE_VALUE` when a value is not wrapped in a quote, `ILLEGAL_CHARACTER` on an illegal control code.
 */
function parseAttributes(
  attrStr: string,
  quotePairs: Int32Array | undefined,
  attrsOffset: number | undefined,
  quotePairsLen: number = 0,
  parser?: TagExpressionParser
): RawAttributeMatch[] {
  const results: RawAttributeMatch[] = [];
  const ctx: AttrScanContext = {
    str: attrStr,
    len: attrStr.length,
    pairs: quotePairs,
    pairsLen: quotePairsLen,
    usePairs: quotePairs !== undefined && quotePairsLen > 0,
    // `attrsOffset` is only absent on the paths that never reach here, but the
    // original arithmetic let it become NaN rather than 0. Preserved on purpose:
    // a mis-wired call then fails to match instead of silently matching against
    // pair indices from the wrong origin.
    pairBase: attrsOffset as number,
    pairIdx: 0,
    parser,
  };

  let i = 0;
  while (i < ctx.len) {
    const attr = readAttribute(ctx, i);
    // Only whitespace left — the expression is fully consumed.
    if (attr === null) break;
    results.push(attr.match);
    i = attr.next;
  }

  return results;
}

/**
 * @description Everything `parseAttributes`' per-attribute step needs that does not change from one attribute to the next. Bundled because the step touches eight
 * inputs and threading them as parameters made the signature worse than the loop it replaced.
 */
interface AttrScanContext {
  /**
   * @description The raw attribute expression being parsed.
   */
  str: string;
  /**
   * @description `str.length`, carried so the helpers need not re-read it.
   */
  len: number;
  /**
   * @description Flattened `[open, close, …]` quote offsets recorded by the tag-end scanner, if any.
   */
  pairs: Int32Array | undefined;
  /**
   * @description Number of filled slots in `pairs`.
   */
  pairsLen: number;
  /**
   * @description Whether `pairs` is usable, decided once per expression.
   */
  usePairs: boolean;
  /**
   * @description Offset of `str` within the buffer `pairs` was recorded against.
   */
  pairBase: number;
  /**
   * @description Index of the next unread pair, advanced as pairs are consumed.
   */
  pairIdx: number;
  /**
   * @description Parser context, used only to report error positions.
   */
  parser: TagExpressionParser | undefined;
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
 * @description Parse the one attribute starting at `from`, through its value or up to the end of a boolean attribute.
 *
 * @param ctx - Expression-wide scan state. `ctx.pairIdx` advances when a recorded quote pair is consumed.
 * @param from - Offset to start at, which may be whitespace.
 *
 * @returns The match and the offset the next attribute starts at, or `null` when `from` is at or past the end of the expression.
 *
 * @throws {ParseError} `UNQUOTED_ATTRIBUTE_VALUE` when a value is not wrapped in a quote, plus whatever `scanAttrValue` throws for a value that is
 *   terminated but contains illegal characters.
 */
function readAttribute(ctx: AttrScanContext, from: number): { match: RawAttributeMatch; next: number } | null {
  // Skip whitespace between attributes
  let i = skipSpaces(ctx.str, from, ctx.len);
  if (i >= ctx.len) return null;

  const nameStart = i;
  const { name, next } = readAttrName(ctx.str, i, ctx.len);

  // Skip whitespace before '='
  i = skipSpaces(ctx.str, next, ctx.len);

  // No '=' — a boolean attribute. It ends at the whitespace that stopped the name scan.
  if (i >= ctx.len || ctx.str.charCodeAt(i) !== EQUALS) {
    return { match: { name, value: undefined, startIndex: nameStart }, next: i };
  }

  i = skipSpaces(ctx.str, i + 1, ctx.len); // past '='

  // The character right after '=' (mod whitespace) MUST be a quote — this is
  // never relaxed, in any mode. Reject before consuming anything, so an
  // unquoted value never partially reaches the output builder.
  const quote = ctx.str.charCodeAt(i); // NaN when i >= len — also fails both checks below
  if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) {
    throw new UnquotedAttributeValue({
      name,
      message: `Attribute '${name}' has an unquoted value — attribute values must be wrapped in '"' or "'"`,
      index: ctx.parser ? errorPositionOf(ctx.parser.source).index : undefined,
    });
  }

  const closeLocal = ctx.usePairs ? takeQuotePair(ctx, i) : -1;

  i++; // skip opening quote
  const end = closeLocal >= 0 ? closeLocal : findClosingQuote(ctx.str, i, ctx.len, quote);
  const value = scanAttrValue(ctx.str, i, end, ctx.parser);
  return { match: { name, value, startIndex: nameStart }, next: end + 1 }; // skip closing quote
}

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
 * @description Reuse a closing-quote position the tag-end scanner already recorded. `scanTagExpEnd` walks every attribute value on its way to the `>` that ends
 * the tag, recording where each quote pair opened and closed. When the pair recorded for this attribute's opening quote lines up, its close position
 * is already known and re-scanning for it character by character is wasted work — the difference between this and the slow path is a whole attribute
 * value per attribute on every tag.
 *
 * @param ctx - Expression-wide scan state; `ctx.pairIdx` advances by two on a hit.
 * @param openAt - Offset of this attribute's opening quote within `ctx.str`.
 *
 * @returns The closing-quote offset relative to `ctx.str`, or `-1` when no pair lines up and the caller should scan for it.
 */
function takeQuotePair(ctx: AttrScanContext, openAt: number): number {
  if (ctx.pairs === undefined || ctx.pairIdx + 1 >= ctx.pairsLen) return -1;
  if (ctx.pairs[ctx.pairIdx] !== openAt + ctx.pairBase) return -1;

  const closeLocal = (ctx.pairs[ctx.pairIdx + 1] as number) - ctx.pairBase;
  ctx.pairIdx += 2;
  return closeLocal;
}

/**
 * @description Find the closing quote for an attribute value by scanning forward from `from`.
 *
 * @returns The offset of the matching quote, or `len` if the value is unterminated — which `scanAttrValue` reports rather than this function
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
  _parsedAttrs: ParsedAttribute[];
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
 * @throws {ParseError} `DUPLICATE_ATTRIBUTE` under `attributes.duplicate: 'throw'`, `BOOLEAN_ATTRIBUTE_REJECTED` under `attributes.booleanType:
 *   'throw'`, plus whatever `parseAttributes()` throws.
 */
export function collectRawAttributes(
  attrStr: string,
  parser: TagExpressionParser,
  tagExp: TagExpAttributeTarget,
  quotePairs?: Int32Array,
  attrsOffset?: number,
  quotePairsLen?: number
): void {
  if (!attrStr || attrStr.length === 0) return;

  const matches = parseAttributes(attrStr, quotePairs, attrsOffset, quotePairsLen, parser);
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

  const parsedAttrs = keepAttributes(matches, parser, tagExp, policy);
  tagExp.rawAttributesLen = parsedAttrs.length;
  tagExp._parsedAttrs = parsedAttrs;
}

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
 * @description Decide whether one parsed occurrence of an attribute is processed at all. Duplicate detection runs first, so a repeated boolean attribute is
 * reported as a duplicate rather than as a second valueless one.
 *
 * @param policy - Per-tag policies, with `policy.seen` updated on acceptance.
 * @param m - The parsed occurrence.
 * @param parser - Parser context, used to report error positions.
 *
 * @returns `true` when this occurrence should be recorded.
 *
 * @throws {ParseError} `DUPLICATE_ATTRIBUTE` under `attributes.duplicate: 'throw'`, `BOOLEAN_ATTRIBUTE_REJECTED` under `attributes.booleanType:
 *   'throw'`.
 */
function acceptOccurrence(policy: AttrPolicy, m: RawAttributeMatch, parser: TagExpressionParser): boolean {
  if (policy.seen !== null) {
    if (policy.seen.has(m.name)) {
      if (policy.dupMode === 'throw') {
        throw new DuplicateAttribute({ name: m.name, message: `Duplicate attribute '${m.name}'`, index: errorPositionOf(parser.source).index });
      }
      return false; // 'ignore' — first occurrence wins, later ones dropped entirely
    }
    policy.seen.add(m.name);
  }

  if (m.value !== undefined) return true;

  if (policy.boolMode === 'throw') {
    throw new BooleanAttributeRejected({
      name: m.name,
      message: `Valueless attribute '${m.name}' is not allowed`,
      index: errorPositionOf(parser.source).index,
    });
  }
  // 'ignore' drops it silently, rest of tag unaffected; 'allow' falls through with the value becoming `true` below.
  return policy.boolMode === 'allow';
}

/**
 * @description Walk the parsed matches, apply the policies, process each surviving name once, and record what is left. `processAttrName()` is the expensive step
 * (ns-prefix resolution, name validation, sanitization, reserved-name check), so it runs only for occurrences the policies keep — and only once,
 * which is the whole point of pass 1 caching into `_parsedAttrs` for pass 2.
 *
 * @returns The attributes that survived, in document order. Its length is also
 * the surviving count, so `rawAttributesLen` needs no separate tally.
 */
function keepAttributes(
  matches: RawAttributeMatch[],
  parser: TagExpressionParser,
  tagExp: TagExpAttributeTarget,
  policy: AttrPolicy
): ParsedAttribute[] {
  const parsedAttrs: ParsedAttribute[] = [];

  for (const m of matches) {
    if (!acceptOccurrence(policy, m, parser)) continue;

    const attrName = parser.processAttrName(m.name);
    if (attrName === false) continue;

    const attrVal = m.value !== undefined ? m.value : true;
    tagExp.rawAttributes[m.name] = attrVal;
    parsedAttrs.push({ name: attrName, value: attrVal, index: m.startIndex });
  }

  return parsedAttrs;
}

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
 * @throws {ParseError} `LIMIT_MAX_ATTRIBUTES` when the tag carries more attributes than the limit allows.
 */
export function flushAttributes(
  parsedAttrs: ParsedAttribute[] | undefined,
  parser: TagExpressionParser,
  attrsExpStart: number | undefined,
  rawAttrMatchCount: number,
  tagName: string
): void {
  if (!parsedAttrs || parsedAttrs.length === 0) return;

  const maxAttrs = parser.options.limits?.maxAttributesPerTag;
  if (maxAttrs !== undefined && maxAttrs !== null && rawAttrMatchCount > maxAttrs) {
    throw new LimitMaxAttributes({
      limit: maxAttrs,
      count: rawAttrMatchCount,
      tag: tagName,
      message: `Tag '${tagName}' has ${rawAttrMatchCount} attributes, exceeding limit of ${maxAttrs}`,
      index: errorPositionOf(parser.source).index,
    });
  }

  const len = parsedAttrs.length;
  for (let i = 0; i < len; i++) {
    const a = parsedAttrs[i] as ParsedAttribute;
    const attrMeta: AttributeMeta | undefined = attrsExpStart !== undefined ? { index: attrsExpStart + a.index } : undefined;
    // The builder's attribute pipeline can fail — an entity expansion limit, a
    // caller-supplied value processor — so this runs the effect rather than
    // discarding it.
    runBuilder(parser.outputBuilder.addAttribute(a.name, a.value, parser.readonlyMatcher, attrMeta));
  }
}
