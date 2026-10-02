// entity-encoder.ts
// Single-pass, allocation-light encoder. Two character classes are handled
// separately because they have opposite costs: the XML-unsafe ASCII characters
// are replaced from a fixed table with no lookup at all, while everything
// non-ASCII goes through the integer-keyed tries in `entity-tries.ts`.
// Splitting them is what keeps the ASCII path free of trie work.

import { Predicate } from 'effect';

import { trie1, trie2, trie3 } from './entity-tries.ts';

// Replacement strings indexed by char code — direct array access, no hashing.
// Dense rather than sparse so the index type is `string` and no read needs a
// non-null assertion. The 123 empty entries are never read: every read is
// guarded by IS_XML_UNSAFE, which marks exactly the five codes filled in below,
// so an empty slot cannot be concatenated by accident.
const XML_UNSAFE_REPLACEMENT: Array<string> = Array.from({ length: 128 }, () => '');
XML_UNSAFE_REPLACEMENT[38] = '&amp;'; // &
XML_UNSAFE_REPLACEMENT[60] = '&lt;'; // <
XML_UNSAFE_REPLACEMENT[62] = '&gt;'; // >
XML_UNSAFE_REPLACEMENT[34] = '&quot;'; // "
XML_UNSAFE_REPLACEMENT[39] = '&apos;'; // '

// Typed bitmask for O(1) "is this ASCII code XML-unsafe?" check. Kept in step
// with XML_UNSAFE_REPLACEMENT above: a code is 1 here exactly when that table
// has an entry for it, which is what lets the two assertions in `encode` stand.
const IS_XML_UNSAFE = new Uint8Array(128);
IS_XML_UNSAFE[38] = 1;
IS_XML_UNSAFE[60] = 1;
IS_XML_UNSAFE[62] = 1;
IS_XML_UNSAFE[34] = 1;
IS_XML_UNSAFE[39] = 1;

// Fast pre-scan: bail out immediately if nothing needs encoding. A string with
// no ampersand, quote, or non-ASCII character in it cannot be changed by
// anything below, whatever the options say.
const NEEDS_PROCESSING = /[&<>"'\u0080-\uFFFF]/;

/**
 * @description The state one pass of the walk hands to the next. Both passes keep their own copy in locals and build this once on the way out, so the
 * per-character loop never reads or writes an instance field — an earlier shape threaded the walk through a mutable object on the instance and
 * measured roughly 7% slower on the ASCII path, where every character touches it.
 */
interface ScanState {
  /**
   * @description Everything emitted so far: the literal runs already copied plus the replacements already appended.
   */
  result: string;

  /**
   * @description Index of the first character not yet copied into `result`, where the next literal run starts.
   */
  last: number;

  /**
   * @description Index the pass stopped at, which is where the next pass picks up. A pass that ran out of budget leaves this where it was.
   */
  i: number;

  /**
   * @description Whether the replacement budget ran out inside this pass. The next pass stops immediately when it did.
   */
  limitReached: boolean;
}

/**
 * @description Options for {@link EntityEncoder}. Every field is optional and every field's default is the permissive one, so `new EntityEncoder()` encodes
 * XML-unsafe ASCII _and_ non-ASCII named entities.
 */
export interface EntityEncoderOptions {
  /**
   * @description Whether to escape the XML-unsafe characters `&`, `<`, `>`, `"` and `'`. Turning it off makes all five pass through literally. It does not fall
   * back to the named-entity trie for them: the encoder's ASCII branch never consults the tries, so the `&amp;` and `&lt;` entries that sit in the
   * one-character trie for those codes are unreachable from here. Defaults to true.
   */
  encodeXmlSafe?: boolean;

  /**
   * @description Whether a _single_ non-ASCII character is replaced by the named entity for it, using the built-in trie. Turning it off leaves single characters
   * as themselves, but it does not disable longer matches: a two- or three-code-unit value is replaced unconditionally, so a combining sequence or an
   * astral-plane letter still becomes a named entity with this off. Defaults to true.
   */
  encodeAllNamed?: boolean;

  /**
   * @description Maximum number of replacements performed cumulatively across all `encode` calls on one instance. `0` means unlimited. Once the budget is spent,
   * `encode` returns its input unchanged until {@link EntityEncoder.reset} clears the counter. Defaults to 0.
   */
  maxReplacements?: number;
}

/**
 * @description Replaces characters with XML and HTML entities in one pass. Escapes the five XML-unsafe ASCII characters, and replaces non-ASCII characters with
 * the named entity for the sequence they start — longest match first, up to three UTF-16 code units. `maxReplacements` caps the total replacements
 * one instance will make and persists across `encode` calls until `reset`.
 *
 * @example
 *   ```typescript
 *   const encoder = new EntityEncoder();
 *   encoder.encode('<foo>'); // '&lt;foo&gt;'
 *   encoder.encode('© 2025'); // '&COPY; 2025' — see the note below
 *
 *   // With a limit
 *   const limited = new EntityEncoder({ maxReplacements: 2 });
 *   limited.encode('<>&'); // '&lt;&gt;&' — the third replacement is skipped, and the rest of the input is copied through
 *   limited.reset();
 *   ```
 *
 *   The name chosen for a character with several names is decided by the order of
 *   the table, not by a preference: `©` resolves to `&COPY;` rather than
 *   `&copy;`. Every name is equally correct as a decode target, so this is only
 *   surprising to a reader who expects a particular spelling.
 */
export class EntityEncoder {
  /**
   * @description Whether the five XML-unsafe ASCII characters are escaped, resolved from {@link EntityEncoderOptions.encodeXmlSafe} at construction. Only an
   * explicit `false` turns it off, so an absent option cannot disable it by accident.
   */
  readonly encodeXmlSafe: boolean;

  /**
   * @description Whether a single non-ASCII character is replaced by a named entity, resolved from {@link EntityEncoderOptions.encodeAllNamed} at construction.
   * Only an explicit `false` turns it off.
   */
  readonly encodeAllNamed: boolean;

  /**
   * @description The replacement budget for this instance, resolved from {@link EntityEncoderOptions.maxReplacements} at construction. Only a positive value limits
   * anything; `0`, a negative number, and `NaN` all mean unlimited.
   */
  readonly maxReplacements: number;

  /**
   * @description Replacements made since the last {@link EntityEncoder.reset}. The budget in {@link EntityEncoder.maxReplacements} is measured against this, which
   * is what makes it cumulative across `encode` calls — and what makes the counter readable, since a caller with a budget needs to know how much of
   * it is left.
   */
  replacementsCount: number;

  /**
   * @description The entity text {@link EntityEncoder.#matchEntity} last found, or `null` when nothing starts at the position it probed. This is a scratch slot
   * rather than a return value because the main pass probes once per non-ASCII character: returning a `{ entity, advance }` pair allocated one
   * two-field object per probe, on a path where the probe itself is the work. Null rather than `''` because `null` cannot collide with a real entity
   * the way an empty string could. Read by the walk step that called the probe, before the next probe can run — `#matchEntity` is synchronous and
   * nothing inside `encode` calls back out, so there is no re-entrant reader to interleave with.
   */
  #matchText: string | null = null;

  /**
   * @description How many UTF-16 code units {@link EntityEncoder.#matchText} replaces. Written by the same {@link EntityEncoder.#record} that writes the text, so
   * the two cannot disagree. Left holding the failing width when {@link EntityEncoder.#matchText} is `null`, where nothing reads it.
   */
  #matchWidth = 1;

  /**
   * @description Create an encoder. The option handling happens once here so `encode` reads plain booleans rather than re-deriving them per character.
   *
   * @param options - Configuration. See {@link EntityEncoderOptions}.
   */
  constructor(options: EntityEncoderOptions = {}) {
    this.encodeXmlSafe = options.encodeXmlSafe !== false;
    this.encodeAllNamed = options.encodeAllNamed !== false;
    this.maxReplacements = options.maxReplacements || 0;
    this.replacementsCount = 0;
  }

  /**
   * @description Replace the XML-unsafe characters and, unless told otherwise, the named non-ASCII entities in a string. A string with nothing to replace is
   * returned as-is, and so is any input once `maxReplacements` is spent. A non-string is returned unchanged rather than coerced, so a value that
   * reached the encoder from untyped code passes through instead of being stringified.
   *
   * @example
   *   ```typescript
   *   import { EntityEncoder } from '@endevops/common-xml';
   *
   *   const encoder = new EntityEncoder();
   *   encoder.encode('<a href="x">& é'); // '&lt;a href=&QUOT;x&QUOT;&gt;&amp; &COPY; é'
   *   ```;
   *
   * @param str - The string to encode.
   *
   * @returns The encoded string, which may be the identical string when there was nothing to replace or the budget was already spent. Escaping a
   *   character has nothing to fail about, and the replacement budget is a budget rather than a limit — running out stops the work instead of failing
   *   it.
   */
  encode(str: string): string {
    if (!Predicate.isString(str) || str.length === 0) return str;
    if (!NEEDS_PROCESSING.test(str)) return str;
    if (this.maxReplacements > 0 && this.replacementsCount >= this.maxReplacements) return str;

    // Two passes of one walk. The main one stops at `len - 2` so a three-character
    // probe there is still readable without a bounds check; the tail covers what
    // is left, where no such match is possible.
    const len = str.length;
    const main = this.#encodeMain(str, len - 2);
    const tail = this.#encodeTail(str, main.i, main.last, main.result, main.limitReached);

    // Flush any remaining literal suffix. This is also what copies the rest of
    // the input through when the budget ran out mid-string.
    let { result, last } = tail;
    if (last < len) result += str.substring(last);

    return result;
  }

  /**
   * @description The main pass of the walk: from the start of the string up to `mainEnd`, which the caller sets two characters short of the end so a
   * three-character probe there needs no bounds check. Everything it accumulates stays in locals — see {@link ScanState} — and the option is hoisted
   * out of `this` for the same reason, since every character of an ASCII run would otherwise re-read a property. Two branches are the whole of the
   * per-character work: the fixed-table escape for the five XML-unsafe ASCII codes, and {@link EntityEncoder.#matchEntity} for everything non-ASCII.
   * Safe ASCII does no work at all, so a run of it is handed to {@link EntityEncoder.#skipRun} in one call rather than paying this loop's own
   * bookkeeping once per character. Split out of `encode` because this and {@link EntityEncoder.#encodeTail} are the same walk with one rule changed,
   * and `encode` reads better as three guards and two calls than as a preamble and two loops.
   *
   * @param str - The string being scanned.
   * @param mainEnd - The last index a three-character probe may start at, i.e. `str.length - 2`.
   *
   * @returns The walk state at the point this pass hands over to {@link EntityEncoder.#encodeTail}.
   */
  #encodeMain(str: string, mainEnd: number): ScanState {
    const encodeXmlSafe = this.encodeXmlSafe;

    let result = '';
    let last = 0;
    let i = 0;
    let limitReached = false;

    while (i <= mainEnd && !limitReached) {
      const c0 = str.charCodeAt(i);

      if (c0 < 128) {
        if (encodeXmlSafe && IS_XML_UNSAFE[c0] === 1) {
          result += str.substring(last, i) + XML_UNSAFE_REPLACEMENT[c0];
          last = ++i;
          // Assigned rather than tested under `if`: the loop condition has
          // already established `limitReached` is false, so the branch would
          // only be a second spelling of what `#spendBudget` returns.
          limitReached = this.#spendBudget();
        } else {
          // Safe ASCII needs no work, so advance over the whole run in one call
          // rather than paying this loop's own bookkeeping per character. `i` is
          // known safe, so the run after it starts at the next index and
          // `#skipRun` never re-tests a character already decided on.
          i = this.#skipRun(str, i + 1, mainEnd);
        }
        continue;
      }

      // Non-ASCII: integer-keyed trie lookup, longest match first. c1 and c2
      // need no bounds checks because i <= mainEnd guarantees i+1 and i+2 are
      // both inside the string.
      this.#matchEntity(str, i, true);

      const text = this.#matchText;
      if (text === null) {
        i++;
        continue;
      }

      result += str.substring(last, i) + text;
      i += this.#matchWidth;
      last = i;
      limitReached = this.#spendBudget();
    }

    return { result, last, i, limitReached };
  }

  /**
   * @description Advance over a run of characters that need no replacement, starting from `from`. The loop lives here rather than inline in
   * {@link EntityEncoder.#encodeMain} so the caller's own bookkeeping — the outer condition and the character-class dispatch — is not paid once per
   * character of input that is mostly plain text, which is the common shape. The caller has already established that the character before `from`
   * needed no replacement, which is why `from` is one past the character it decided about rather than that character itself.
   *
   * @param str - The string being scanned.
   * @param from - Where the run starts; every index below it has already been dealt with.
   * @param end - The last index this pass may reach.
   *
   * @returns The index of the first character at or after `from` that does need a replacement, or `end + 1` if the run reaches the end of the region.
   */
  #skipRun(str: string, from: number, end: number): number {
    const encodeXmlSafe = this.encodeXmlSafe;

    let i = from;
    while (i <= end) {
      const c = str.charCodeAt(i);
      if (c >= 128 || (encodeXmlSafe && IS_XML_UNSAFE[c] === 1)) break;
      i++;
    }

    return i;
  }

  /**
   * @description The tail pass: from wherever {@link EntityEncoder.#encodeMain} stopped to the end of the string. Split out because it is the same walk with one
   * rule changed — no three-character entity can start within two characters of the end, so the probe is skipped rather than bounds-checked. Two or
   * three characters is the whole of it, so this runs once per `encode` rather than per character, and its locals cost nothing.
   *
   * @param str - The string being scanned.
   * @param from - Where the main pass stopped.
   * @param last - Where the next literal run starts.
   * @param result - What has been emitted so far.
   * @param limitReached - Whether the budget was already spent, in which case this returns immediately.
   *
   * @returns The extended walk state. `i` is the end of the string — this pass has nothing left to hand on to — and `limitReached` is whether it
   *   spent the budget here.
   */
  #encodeTail(str: string, from: number, last: number, result: string, limitReached: boolean): ScanState {
    const encodeXmlSafe = this.encodeXmlSafe;
    const len = str.length;

    let i = from;
    let done = limitReached;

    while (i < len && !done) {
      const c0 = str.charCodeAt(i);

      if (c0 < 128) {
        if (encodeXmlSafe && IS_XML_UNSAFE[c0] === 1) {
          result += str.substring(last, i) + XML_UNSAFE_REPLACEMENT[c0];
          last = ++i;
          done = this.#spendBudget();
        } else {
          i++;
        }
        continue;
      }

      // Non-ASCII tail — only two- and one-character matches are possible here
      this.#matchEntity(str, i, false);

      const text = this.#matchText;
      if (text === null) {
        i++;
        continue;
      }

      result += str.substring(last, i) + text;
      i += this.#matchWidth;
      last = i;
      done = this.#spendBudget();
    }

    return { result, last, i, limitReached: done };
  }

  /**
   * @description Longest named entity starting at `index`, and how many characters it spans, recorded into {@link EntityEncoder.#matchText} and
   * {@link EntityEncoder.#matchWidth} for the caller to read — see those fields for why this is not a return value. Three- then two- then
   * one-character, so a three-code-unit name wins over a shorter prefix of itself. `threeCharOK` is the caller's bounds guarantee rather than a
   * re-check: the main pass has already established that `index + 2` is inside the string, and the tail has not.
   *
   * @param str - The string being scanned.
   * @param index - Where the entity would start.
   * @param threeCharOK - Whether three characters are readable from `index`.
   */
  #matchEntity(str: string, index: number, threeCharOK: boolean): void {
    const first = str.charCodeAt(index);

    if (threeCharOK) {
      const three = this.#matchThree(str, index, first);
      if (three !== undefined) return this.#record(three, 3);
    }

    const two = this.#matchTwo(str, index, first);
    if (two !== undefined) return this.#record(two, 2);

    const one = this.#matchOne(first);
    if (one !== undefined) return this.#record(one, 1);

    this.#matchText = null;
  }

  /**
   * @description The three-code-unit entity starting at `index`, if the HTML5 table has one. Reads two codes past the first, which is safe only because
   * `threeCharOK` in {@link EntityEncoder.#matchEntity} has already established that they are inside the string.
   *
   * @param str - The string being scanned.
   * @param index - Where the entity would start.
   * @param first - The char code at `index`, which the caller has already read.
   *
   * @returns The `&name;` text, or `undefined` when no three-code-unit entity starts here.
   */
  #matchThree(str: string, index: number, first: number): string | undefined {
    const rest = trie3.get(first)?.get(str.charCodeAt(index + 1));
    return rest?.get(str.charCodeAt(index + 2));
  }

  /**
   * @description The two-code-unit entity starting at `index`, if the HTML5 table has one and there is a second code unit to read. This is the probe the tail pass
   * uses on its own, and the only one whose bounds the caller has not already guaranteed.
   *
   * @param str - The string being scanned.
   * @param index - Where the entity would start.
   * @param first - The char code at `index`, which the caller has already read.
   *
   * @returns The `&name;` text, or `undefined` when no two-code-unit entity starts here or `index` is the last code unit in the string.
   */
  #matchTwo(str: string, index: number, first: number): string | undefined {
    if (index + 1 >= str.length) return undefined;
    return trie2.get(first)?.get(str.charCodeAt(index + 1));
  }

  /**
   * @description The one-code-unit entity for a char code, if the table has one and {@link EntityEncoder.encodeAllNamed} allows a single character to be replaced.
   * The only one of the three probes an option can switch off.
   *
   * @param first - The char code at the probed position, which the caller has already read.
   *
   * @returns The `&name;` text, or `undefined` when single-character replacement is off or the code has no name.
   */
  #matchOne(first: number): string | undefined {
    if (!this.encodeAllNamed) return undefined;
    return trie1.get(first);
  }

  /**
   * @description Record a probe hit as this position's match.
   *
   * @param text - The `&name;` text the caller should emit.
   * @param width - How many UTF-16 code units it replaces. Taken from the trie that was probed, because nothing about `text` itself gives it away:
   *   `&COPY;` is seven characters long and replaces one.
   */
  #record(text: string, width: number): void {
    this.#matchText = text;
    this.#matchWidth = width;
  }

  /**
   * @description Charge one replacement against the budget.
   *
   * @returns Whether that spent the last of it, in which case the scan stops where it stands. Both passes assign this straight into their stop flag,
   *   which the loop condition has already cleared — so the check is written once here rather than once per call site — and the accounting stays in
   *   one place.
   */
  #spendBudget(): boolean {
    if (this.maxReplacements <= 0) return false;
    this.replacementsCount++;
    return this.replacementsCount >= this.maxReplacements;
  }

  /**
   * @description Reset the replacement counter. The three options are untouched, so a limited encoder stays limited and only gets its budget back.
   *
   * @returns Nothing.
   */
  reset(): void {
    this.replacementsCount = 0;
  }
}
