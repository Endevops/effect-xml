// entity-tries.ts
// Integer-keyed tries for entity lookup. Every key is a plain charCode number,
// so the encoder can match a character sequence without ever slicing the input
// or allocating a string.
//
// Why a trie and not a `Map<string, string>`: the encoder asks, at each position,
// "does the text starting here have a named entity, longest match first?". A
// string key answers that by calling `substring` once per candidate length —
// three substrings per character, plus the UTF-16 code-unit arithmetic that goes
// with them. A trie asks the same question in the order the characters actually
// arrive: one `Map.get` per character, on the number `charCodeAt` just produced.
//
// Depth is capped at three. That is the longest match the encoder attempts, and
// it is the only depth the HTML5 table needs: its deepest entity value is two
// UTF-16 code units wide, so the third level is allocated but never written to.
// The encoder's hot loop is shaped around the same bound — see the `mainEnd`
// computation in `entity-encoder.ts`, which exists so a three-character probe
// never needs a bounds check.

import { ALL_ENTITIES } from './entity-tables.ts';

/**
 * @description A one-character entity trie: a first character code to the `&name;` that replaces it.
 */
export type SingleCharTrie = Map<number, string>;

/**
 * @description A two-character entity trie: a first character code to the entities keyed by the second character code.
 */
export type TwoCharTrie = Map<number, SingleCharTrie>;

/**
 * @description A three-character entity trie: a first character code to a {@link TwoCharTrie} over the remaining two character codes.
 */
export type ThreeCharTrie = Map<number, TwoCharTrie>;

/**
 * @description Reverse index from an entity's replacement text to the name that produces it, built once at module load. Several names share the same text — `amp`
 * and `AMP` are both `&`, `lt`, `LT` and `less` are all `<` — and this map keeps only the last one inserted, which is the one the tries will then
 * serve. The winner is decided by key order in the tables, so it is fixed for a given build but arbitrary from a caller's point of view: the encoder
 * emits `&COPY;` for `©`, not `&copy;`. The two-character tries collapse the same way. Callers that need a specific name should decode and compare
 * rather than assume a particular one was chosen.
 */
const CHAR_TO_ENTITY: Map<string, string> = new Map();
for (const [name, chars] of Object.entries(ALL_ENTITIES)) {
  CHAR_TO_ENTITY.set(chars, `&${name};`);
}

/**
 * @description Entities whose replacement is a single UTF-16 code unit, keyed by that code. Codes below 128 are never read by the encoder — its ASCII branch is
 * closed to the tries — so those five entries exist for completeness of the index rather than for use.
 */
export const trie1: SingleCharTrie = new Map();

/**
 * @description Entities whose replacement is two UTF-16 code units, keyed by both. Two of the twelve first codes are ASCII and therefore unreachable from the
 * encoder for the same reason as {@link trie1}'s low codes.
 */
export const trie2: TwoCharTrie = new Map();

/**
 * @description Entities whose replacement is three UTF-16 code units, keyed by all three. Nothing in the current table reaches this depth, so it is always empty;
 * it is kept because the encoder probes it, and because a future table with a longer value would populate it without an encoder change.
 */
export const trie3: ThreeCharTrie = new Map();

for (const [chars, entity] of CHAR_TO_ENTITY) {
  const len = chars.length;

  if (len === 1) {
    const c0 = chars.charCodeAt(0);
    trie1.set(c0, entity);
  } else if (len === 2) {
    const c0 = chars.charCodeAt(0);
    const c1 = chars.charCodeAt(1);
    let inner = trie2.get(c0);
    if (inner === undefined) {
      inner = new Map();
      trie2.set(c0, inner);
    }
    inner.set(c1, entity);
  } else if (len === 3) {
    const c0 = chars.charCodeAt(0);
    const c1 = chars.charCodeAt(1);
    const c2 = chars.charCodeAt(2);
    let mid = trie3.get(c0);
    if (mid === undefined) {
      mid = new Map();
      trie3.set(c0, mid);
    }
    let inner = mid.get(c1);
    if (inner === undefined) {
      inner = new Map();
      mid.set(c1, inner);
    }
    inner.set(c2, entity);
  }
  // A longer value has no trie to live in. The HTML5 named-entity table has none today, so this is unreachable rather than merely unlikely — a longer
  // value would be dropped silently, and dropping it degrades to a no-op at the encoder rather than to a wrong replacement.
}
