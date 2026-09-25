// entity-encoder.ts
// Single-pass, allocation-light encoder. Two character classes are handled
// separately because they have opposite costs: the XML-unsafe ASCII characters
// are replaced from a fixed table with no lookup at all, while everything
// non-ASCII goes through the integer-keyed tries in `entity-tries.ts`.
// Splitting them is what keeps the ASCII path free of trie work.

import { trie1, trie2, trie3 } from './entity-tries.ts';

// Replacement strings indexed by char code — direct array access, no hashing.
// Dense rather than sparse so the index type is `string` and no read needs a
// non-null assertion. The 123 empty entries are never read: every read is
// guarded by IS_XML_UNSAFE, which marks exactly the five codes filled in below,
// so an empty slot cannot be concatenated by accident.
const XML_UNSAFE_REPLACEMENT: string[] = Array.from({ length: 128 }, () => '');
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
   * @param str - The string to encode.
   *
   * @returns The encoded string, which may be the identical string when there was nothing to replace or the budget was already spent.
   */
  encode(str: string): string {
    if (typeof str !== 'string' || str.length === 0) return str;
    if (!NEEDS_PROCESSING.test(str)) return str;

    const maxRep = this.maxReplacements;
    if (maxRep > 0 && this.replacementsCount >= maxRep) return str;

    // Hoist to locals — avoids `this` property lookup inside the hot loop
    const encodeXmlSafe = this.encodeXmlSafe;
    const encodeAllNamed = this.encodeAllNamed;

    const len = str.length;

    let result = '';
    let last = 0;
    let i = 0;
    let limitReached = false;

    // Main loop, running to len-2 so a three-character probe never needs a
    // bounds check. The last two characters are the tail block's problem.
    const mainEnd = len - 2;

    while (i <= mainEnd && !limitReached) {
      const c0 = str.charCodeAt(i);

      // ASCII branch
      if (c0 < 128) {
        if (encodeXmlSafe && IS_XML_UNSAFE[c0] === 1) {
          result += (str.substring(last, i) + XML_UNSAFE_REPLACEMENT[c0]) as string;
          last = ++i;
          if (maxRep > 0) {
            this.replacementsCount++;
            if (this.replacementsCount >= maxRep) {
              limitReached = true;
              break;
            }
          }
        } else {
          // Bulk-skip: advance to the next interesting position without
          // touching the outer loop overhead on every safe character
          i++;
          while (i <= mainEnd && !limitReached) {
            const c = str.charCodeAt(i);
            if (c >= 128 || (encodeXmlSafe && IS_XML_UNSAFE[c] === 1)) break;
            i++;
          }
        }
        continue;
      }

      // Non-ASCII: integer-keyed trie lookup, longest match first. c1 and c2
      // need no bounds checks because i <= mainEnd guarantees i+1 and i+2 are
      // both inside the string.
      let matchedEntity: string | null = null;
      let advance = 1;

      const mid3 = trie3.get(c0);
      if (mid3 !== undefined) {
        const c1 = str.charCodeAt(i + 1);
        const inner3 = mid3.get(c1);
        if (inner3 !== undefined) {
          const c2 = str.charCodeAt(i + 2);
          const candidate = inner3.get(c2);
          if (candidate !== undefined) {
            matchedEntity = candidate;
            advance = 3;
          }
        }
      }

      if (matchedEntity === null) {
        const inner2 = trie2.get(c0);
        if (inner2 !== undefined) {
          const c1 = str.charCodeAt(i + 1);
          const candidate = inner2.get(c1);
          if (candidate !== undefined) {
            matchedEntity = candidate;
            advance = 2;
          }
        }
      }

      if (matchedEntity === null && encodeAllNamed) {
        const candidate = trie1.get(c0);
        if (candidate !== undefined) {
          matchedEntity = candidate;
        }
      }

      if (matchedEntity !== null) {
        result += str.substring(last, i) + matchedEntity;
        i += advance;
        last = i;
        if (maxRep > 0) {
          this.replacementsCount++;
          if (this.replacementsCount >= maxRep) {
            limitReached = true;
            break;
          }
        }
      } else {
        i++;
      }
    }

    // Tail: the last one or two characters, where no three-character match is
    // possible
    while (i < len && !limitReached) {
      const c0 = str.charCodeAt(i);

      if (c0 < 128) {
        if (encodeXmlSafe && IS_XML_UNSAFE[c0] === 1) {
          result += (str.substring(last, i) + XML_UNSAFE_REPLACEMENT[c0]) as string;
          last = ++i;
          if (maxRep > 0) {
            this.replacementsCount++;
            if (this.replacementsCount >= maxRep) {
              limitReached = true;
              break;
            }
          }
        } else {
          i++;
        }
        continue;
      }

      // Non-ASCII tail — only two- and one-character matches are possible here
      let matchedEntity: string | null = null;
      let advance = 1;

      if (i + 1 < len) {
        const inner2 = trie2.get(c0);
        if (inner2 !== undefined) {
          const c1 = str.charCodeAt(i + 1);
          const candidate = inner2.get(c1);
          if (candidate !== undefined) {
            matchedEntity = candidate;
            advance = 2;
          }
        }
      }

      if (matchedEntity === null && encodeAllNamed) {
        const candidate = trie1.get(c0);
        if (candidate !== undefined) {
          matchedEntity = candidate;
        }
      }

      if (matchedEntity !== null) {
        result += str.substring(last, i) + matchedEntity;
        i += advance;
        last = i;
        if (maxRep > 0) {
          this.replacementsCount++;
          if (this.replacementsCount >= maxRep) {
            limitReached = true;
            break;
          }
        }
      } else {
        i++;
      }
    }

    // Flush any remaining literal suffix. This is also what copies the rest of
    // the input through when the budget ran out mid-string.
    if (last < len) result += str.substring(last);
    return result;
  }

  /**
   * @description Reset the replacement counter. The three options are untouched, so a limited encoder stays limited and only gets its budget back.
   */
  reset(): void {
    this.replacementsCount = 0;
  }
}
