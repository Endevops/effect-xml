import type { AttributeMeta, ParsedAttribute, RawAttributeMatch, TagExpressionParser } from './internal/parser-types.ts';

import { ParseError, ErrorCode } from './ParseError.js';
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
      throw new ParseError(
        `Illegal control character 0x${c.toString(16).padStart(2, '0')} in attribute value`,
        ErrorCode.ILLEGAL_CHARACTER,
        parser ? errorPositionOf(parser.source) : {}
      );
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
  const len = attrStr.length;
  let i = 0;
  const usePairs = quotePairs !== undefined && quotePairsLen > 0;
  // `attrsOffset` is only absent on the paths that never reach here, but the
  // original arithmetic let it become NaN rather than 0. Preserved on purpose:
  // a mis-wired call then fails to match instead of silently matching against
  // pair indices from the wrong origin.
  const pairBase = attrsOffset as number;
  let pairIdx = 0;

  while (i < len) {
    // Skip whitespace between attributes
    while (i < len && isSpaceCode(attrStr.charCodeAt(i))) i++;
    if (i >= len) break;

    // Read name
    const nameStart = i;
    while (i < len && attrStr.charCodeAt(i) !== 61 && !isSpaceCode(attrStr.charCodeAt(i))) i++;
    const name = attrStr.substring(nameStart, i);

    // Skip whitespace before '='
    while (i < len && isSpaceCode(attrStr.charCodeAt(i))) i++;

    if (i >= len || attrStr.charCodeAt(i) !== 61) {
      // Boolean attribute — no '='
      results.push({ name, value: undefined, startIndex: nameStart });
      continue;
    }

    i++; // skip '='

    // Skip whitespace after '='
    while (i < len && isSpaceCode(attrStr.charCodeAt(i))) i++;

    // The character right after '=' (mod whitespace) MUST be a quote — this
    // is never relaxed, in any mode. Reject before consuming anything, so an
    // unquoted value never partially reaches the output builder.
    const quote = attrStr.charCodeAt(i); // NaN when i >= len — also fails both checks below
    if (quote !== 34 && quote !== 39) {
      // not " or '
      throw new ParseError(
        `Attribute '${name}' has an unquoted value — attribute values must be wrapped in '"' or "'"`,
        ErrorCode.UNQUOTED_ATTRIBUTE_VALUE,
        parser ? errorPositionOf(parser.source) : {}
      );
    }

    // Fast path: the tag-end scanner already found this exact quote pair
    // while looking for '>' — reuse its closing-quote position instead of
    // re-scanning character-by-character for it.
    let closeLocal = -1;
    if (usePairs && pairIdx + 1 < quotePairsLen && quotePairs?.[pairIdx] === i + pairBase) {
      closeLocal = (quotePairs[pairIdx + 1] as number) - pairBase;
      pairIdx += 2;
    }

    i++; // skip opening quote
    let end;
    if (closeLocal >= 0) {
      end = closeLocal;
    } else {
      end = i;
      while (end < len && attrStr.charCodeAt(end) !== quote) end++;
    }
    const value = scanAttrValue(attrStr, i, end, parser);
    i = end + 1; // skip closing quote
    results.push({ name, value, startIndex: nameStart });
  }

  return results;
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
  const len = matches.length;
  tagExp._rawAttrMatchCount = len; // total parsed attrs, incl. dropped (xmlns:) ones — for maxAttributesPerTag parity with old behavior
  const parsedAttrs: ParsedAttribute[] = [];
  let count = 0;

  // attributes.duplicate: 'overwrite' (default) needs no bookkeeping — last
  // occurrence naturally wins via the rawAttributes object-assign + the
  // builder's own last-write-wins addAttribute() calls below, exactly as
  // before this option existed. 'ignore'/'throw' need to track names seen
  // so far on *this* tag only — a fresh Set per call, never shared across tags.
  const dupMode = parser.options.attributes?.duplicate || 'overwrite';
  const seen = dupMode !== 'overwrite' ? new Set<string>() : null;
  const boolMode = parser.options.attributes?.booleanType || 'allow';

  for (let i = 0; i < len; i++) {
    const m = matches[i] as RawAttributeMatch;

    if (seen) {
      if (seen.has(m.name)) {
        if (dupMode === 'throw') {
          throw new ParseError(`Duplicate attribute '${m.name}'`, ErrorCode.DUPLICATE_ATTRIBUTE, errorPositionOf(parser.source));
        }
        continue; // 'ignore' — first occurrence wins, later ones dropped entirely
      }
      seen.add(m.name);
    }

    const rawVal = m.value;
    if (rawVal === undefined) {
      if (boolMode === 'throw') {
        throw new ParseError(`Valueless attribute '${m.name}' is not allowed`, ErrorCode.BOOLEAN_ATTRIBUTE_REJECTED, errorPositionOf(parser.source));
      }
      if (boolMode === 'ignore') continue; // drop silently, rest of tag unaffected
    }

    const attrName = parser.processAttrName(m.name);
    if (attrName === false) continue;
    count++;
    const attrVal = rawVal !== undefined ? rawVal : true;
    tagExp.rawAttributes[m.name] = attrVal;
    parsedAttrs.push({ name: attrName, value: attrVal, index: m.startIndex });
  }
  tagExp.rawAttributesLen = count;
  tagExp._parsedAttrs = parsedAttrs;
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
 *
 * @throws {ParseError} `LIMIT_MAX_ATTRIBUTES` when the tag carries more attributes than the limit allows.
 */
export function flushAttributes(
  parsedAttrs: ParsedAttribute[] | undefined,
  parser: TagExpressionParser,
  attrsExpStart: number | undefined,
  rawAttrMatchCount: number
): void {
  if (!parsedAttrs || parsedAttrs.length === 0) return;

  const maxAttrs = parser.options.limits?.maxAttributesPerTag;
  if (maxAttrs !== undefined && maxAttrs !== null && rawAttrMatchCount > maxAttrs) {
    const tagName = parser.currentTagDetail?.name ?? '(unknown)';
    throw new ParseError(
      `Tag '${tagName}' has ${rawAttrMatchCount} attributes, exceeding limit of ${maxAttrs}`,
      ErrorCode.LIMIT_MAX_ATTRIBUTES,
      errorPositionOf(parser.source)
    );
  }

  const len = parsedAttrs.length;
  for (let i = 0; i < len; i++) {
    const a = parsedAttrs[i] as ParsedAttribute;
    const attrMeta: AttributeMeta | undefined = attrsExpStart !== undefined ? { index: attrsExpStart + a.index } : undefined;
    parser.outputBuilder.addAttribute(a.name, a.value, parser.readonlyMatcher, attrMeta);
  }
}
