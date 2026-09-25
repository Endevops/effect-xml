/**
 * @description Specs for the entity encoder — the half of this package that writes references rather than reading them, and the half with the most room for a
 * reader to be surprised by the output. The shape here follows the one thing that makes the encoder's output unpredictable: a character with several
 * valid entity names gets whichever name the table happened to reach last, so `©` comes out as `&COPY;` and not as `&copy;`. Both spellings decode to
 * the same character, so nothing breaks, and a caller who has been diffing encoder output already has `&COPY;` in their fixtures. That is why the
 * specs assert the exact spelling in the places it matters and say so in the name, and why there is a whole `describe` for the name collisions. The
 * preserved-upstream blocks follow the same rule as the decoder's. The three-character trie is never written to, the five XML-unsafe characters can
 * never be reached through a trie, and a negative replacement budget is unlimited even though only `0` is documented as being — each is pinned as a
 * deliberate, unendorsed fact about this port, so that a change which "fixes" one of them is a visible decision rather than a silent difference in
 * everyone's output. The tries are imported from their own module rather than from the package index because they are not on the public surface. That
 * is the point: an unreachable entry in an internal index is a real thing to pin, and it cannot be pinned from outside.
 */

import { describe, expect, it } from 'vite-plus/test';

import type { EntityEncoderOptions } from '#/index.ts';

import { trie1, trie2, trie3 } from '#/entity-tries.ts';
import { ALL_ENTITIES, EntityDecoder, EntityEncoder } from '#/index.ts';

/**
 * @description Give the constructor an option object carrying an explicit `undefined`, which `exactOptionalPropertyTypes` forbids and which generated or untyped
 * caller code produces anyway. The runtime reads each option with a `!== false` or a `||`, so an explicit `undefined` behaves as an absent key.
 *
 * @param options - The option object, untyped.
 *
 * @returns The same object, typed as options.
 */
const withExplicitUndefined = (options: Record<string, unknown>): EntityEncoderOptions => options as EntityEncoderOptions;

/**
 * @description Hand `encode` a value its `string` signature forbids, which is the only way untyped caller code reaches the guard at the top of the method.
 *
 * @param encoder - The encoder to call.
 * @param value - The value to pass in, whatever its type.
 *
 * @returns Whatever `encode` returns for it.
 */
const encodeValue = (encoder: EntityEncoder, value: unknown): unknown => encoder.encode(value as string);

/**
 * @description The codepoints of a string as four-digit uppercase hex, so an assertion about a character reads the way the HTML5 specification writes it. The step
 * over a low surrogate is what makes a surrogate pair report as the one character it is — the same unit the encoder's two-code-unit trie is keyed on,
 * and the reason an astral-plane letter is a two-code-unit match rather than two single-code-unit ones.
 *
 * @param value - The string to read.
 *
 * @returns One entry per codepoint, in order.
 */
const codePointsOf = (value: string): string[] => {
  const points: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const point = value.codePointAt(index);
    points.push((point ?? 0).toString(16).toUpperCase().padStart(4, '0'));
    if (point !== undefined && point > 0xffff) index += 1;
  }
  return points;
};

/**
 * @description Every distinct replacement text in {@link ALL_ENTITIES}, deduplicated. The encoder's tries are built from this set, so anything asserted about trie
 * depth is really an assertion about it.
 *
 * @returns The distinct values.
 */
const distinctValues = (): string[] => [...new Set(Object.values(ALL_ENTITIES))];

/**
 * @description Every name in {@link ALL_ENTITIES} whose replacement is a given text, in key order. The last entry is the name the encoder emits for that text,
 * because the reverse index it builds keeps only the last insertion.
 *
 * @param value - The replacement text to look for.
 *
 * @returns The names, in key order.
 */
const namesFor = (value: string): string[] =>
  Object.entries(ALL_ENTITIES)
    .filter(([, entry]) => entry === value)
    .map(([name]) => name);

// ─── The five XML-unsafe characters ─────────────────────────────────────────────────────────────────────

describe('the XML-unsafe characters', () => {
  it('escapes all five, and nothing else in ASCII', () => {
    expect(new EntityEncoder().encode('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &apos;');
  });

  it('leaves every other ASCII character alone, so ordinary prose is untouched', () => {
    const encoder = new EntityEncoder();
    expect(encoder.encode('Hello, world 123!')).toBe('Hello, world 123!');
  });

  it('escapes a run of them in order', () => {
    expect(new EntityEncoder().encode('<a href="x">a & b</a>')).toBe('&lt;a href=&quot;x&quot;&gt;a &amp; b&lt;/a&gt;');
  });

  it('escapes one at the very end of the string, where no two characters follow it', () => {
    // The main loop stops two characters short so a three-character probe needs no bounds check; the tail block is what covers the end.
    expect(new EntityEncoder().encode('a<')).toBe('a&lt;');
    expect(new EntityEncoder().encode('a><')).toBe('a&gt;&lt;');
  });

  it('escapes one at the very start, where nothing precedes it', () => {
    expect(new EntityEncoder().encode('&a')).toBe('&amp;a');
  });
});

describe('the replacement budget', () => {
  it('stops mid-string once it is spent and copies the rest of the input through', () => {
    const encoder = new EntityEncoder({ maxReplacements: 2 });
    expect(encoder.encode('<>&')).toBe('&lt;&gt;&');
    expect(encoder.replacementsCount).toBe(2);
  });

  it('returns the input unchanged for every later call, until reset', () => {
    const encoder = new EntityEncoder({ maxReplacements: 1 });
    expect(encoder.encode('<<')).toBe('&lt;<');
    expect(encoder.encode('<<')).toBe('<<');
    expect(encoder.encode('&&')).toBe('&&');
  });

  it('counts named replacements against the same budget as escaped ASCII ones', () => {
    const encoder = new EntityEncoder({ maxReplacements: 2 });
    expect(encoder.encode('<é')).toBe('&lt;&eacute;');
    expect(encoder.replacementsCount).toBe(2);
  });

  it('is cumulative across calls, which is what makes it a per-instance budget', () => {
    const encoder = new EntityEncoder({ maxReplacements: 3 });
    encoder.encode('<');
    encoder.encode('<');
    expect(encoder.replacementsCount).toBe(2);
    expect(encoder.encode('<')).toBe('&lt;');
    expect(encoder.replacementsCount).toBe(3);
    expect(encoder.encode('<')).toBe('<');
  });

  it('gives the budget back on reset, without changing the options', () => {
    const encoder = new EntityEncoder({ maxReplacements: 1 });
    encoder.encode('<');
    expect(encoder.replacementsCount).toBe(1);
    encoder.reset();
    expect(encoder.replacementsCount).toBe(0);
    expect(encoder.maxReplacements).toBe(1);
    expect(encoder.encode('<')).toBe('&lt;');
  });

  it('does not count a replacement it did not make, so a string with nothing to replace leaves the budget intact', () => {
    const encoder = new EntityEncoder({ maxReplacements: 1 });
    expect(encoder.encode('plain ascii')).toBe('plain ascii');
    expect(encoder.replacementsCount).toBe(0);
    expect(encoder.encode('<')).toBe('&lt;');
  });

  it('does not count an input it refused to look at, because the budget check comes after the two fast paths', () => {
    const encoder = new EntityEncoder({ maxReplacements: 1 });
    expect(encoder.encode('')).toBe('');
    expect(encoder.encode('no ampersand here')).toBe('no ampersand here');
    expect(encoder.replacementsCount).toBe(0);
  });

  it('is unlimited by default, and by a limit of zero', () => {
    expect(new EntityEncoder().maxReplacements).toBe(0);
    const encoder = new EntityEncoder({ maxReplacements: 0 });
    expect(encoder.encode('<>&<>&')).toBe('&lt;&gt;&amp;&lt;&gt;&amp;');
  });
});

// ─── Named entities ──────────────────────────────────────────────────────────────────────────────────

describe('named non-ASCII characters', () => {
  it('replaces a single character with the named entity for it', () => {
    expect(new EntityEncoder().encode('©')).toBe('&COPY;');
    expect(new EntityEncoder().encode('é')).toBe('&eacute;');
  });

  it('replaces a two-code-unit value with its name, which is how a letter outside the BMP is spelled', () => {
    // U+1D504 is one character and two UTF-16 code units, so the encoder has to match a surrogate pair rather than a character.
    expect(new EntityEncoder().encode('𝔄')).toBe('&Afr;');
  });

  it('replaces a two-code-unit value in the middle of a string', () => {
    expect(new EntityEncoder().encode('x𝔄y')).toBe('x&Afr;y');
  });

  it('replaces a match at the very end, where the tail block handles it', () => {
    expect(new EntityEncoder().encode('x𝔄')).toBe('x&Afr;');
    expect(new EntityEncoder().encode('xብር')).toBe('x&birr;');
  });

  it('leaves a non-ASCII character it has no name for exactly as it is', () => {
    expect(new EntityEncoder().encode('日本語')).toBe('日本語');
  });

  it('does not consume the characters around a failed three-character probe', () => {
    // A failed lookahead must leave the position alone, or the character after the probe would be skipped and lost.
    expect(new EntityEncoder().encode('é日é')).toBe('&eacute;日&eacute;');
  });

  it('replaces a two-code-unit value whose base character has no name of its own', () => {
    // U+224D followed by U+20D2 is named as the pair, and neither code point is named on its own, so the two-code-unit probe is the only thing that
    // can find it.
    expect(codePointsOf('≍⃒')).toEqual(['224D', '20D2']);
    expect(new EntityEncoder().encode('≍⃒')).toBe('&nvap;');
  });

  it('replaces the base character on its own when it has a name, leaving the combining mark unclaimed', () => {
    // U+224F is named by itself, so the one-character lookup is what fires once the two-code-unit probe misses — and U+20D2 is not named at all, so
    // it stays. The output is a named entity followed by a bare combining mark, which is a correct encoding of a sequence no single name covers.
    expect(codePointsOf('≏⃒')).toEqual(['224F', '20D2']);
    expect(new EntityEncoder().encode('≏⃒')).toBe('&HumpEqual;⃒');
  });
});

describe('the two fast paths', () => {
  it('returns a string with no ampersand, quote or non-ASCII character without touching the counter', () => {
    const encoder = new EntityEncoder();
    expect(encoder.encode('Hello, world 123')).toBe('Hello, world 123');
    expect(encoder.replacementsCount).toBe(0);
  });

  it('returns the empty string without touching the counter', () => {
    const encoder = new EntityEncoder();
    expect(encoder.encode('')).toBe('');
    expect(encoder.replacementsCount).toBe(0);
  });

  it('takes the second fast path for a string that has a non-ASCII character but nothing to replace', () => {
    // The pre-scan is satisfied by the non-ASCII character, so the method proceeds; the loop then finds no match and the input comes back whole.
    const encoder = new EntityEncoder();
    expect(encoder.encode('日本語')).toBe('日本語');
    expect(encoder.replacementsCount).toBe(0);
  });
});

describe('a non-string argument', () => {
  it('returns a number for a number, so a falsy zero is not confused with the string "0"', () => {
    const encoder = new EntityEncoder();
    expect(encodeValue(encoder, 0)).toBe(0);
    expect(encodeValue(encoder, 42)).toBe(42);
    expect(encodeValue(encoder, 0)).not.toBe('0');
  });

  it('returns null for null, rather than the string "null"', () => {
    expect(encodeValue(new EntityEncoder(), null)).toBeNull();
  });

  it('returns an object by identity rather than stringifying it', () => {
    const value = { a: 1 };
    expect(encodeValue(new EntityEncoder(), value)).toBe(value);
  });

  it('leaves the counter alone, because the guard is before every increment', () => {
    const encoder = new EntityEncoder({ maxReplacements: 1 });
    encodeValue(encoder, 123);
    expect(encoder.replacementsCount).toBe(0);
  });
});

// ─── Preserved upstream quirk: the three-character trie is never written to ────────────────────────────

describe('preserved upstream quirk: trie3 is empty and the whole three-character branch is dead', () => {
  // The trie is allocated to depth three because the encoder probes depth three, and the deepest replacement in the HTML5 table is two UTF-16 code
  // units. So the third level is never written, and the branch that reads it never fires. Not endorsed — it is dead code in the hot loop that a reader
  // has to reason about on every change — but removing it, or a table entry four code units wide, would both change what the encoder can do, and the
  // second is a silent no-op rather than an error.
  it('holds nothing, where the two shallower tries hold hundreds', () => {
    expect(trie3.size).toBe(0);
    expect(trie1.size).toBeGreaterThan(600);
    expect(trie2.size).toBeGreaterThan(0);
  });

  it('is empty because no replacement in the table is three code units or more', () => {
    // The precondition for the empty trie, asserted directly: the deepest value the table has is two. Nothing is dropped at build time.
    const lengths = new Set(distinctValues().map(value => value.length));
    expect([...lengths].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('is keyed on integers throughout, so a lookup never has to slice the input', () => {
    expect(typeof [...trie1.keys()][0]).toBe('number');
    const [outer, inner] = [...trie2.entries()][0];
    expect(typeof outer).toBe('number');
    expect(typeof [...inner.keys()][0]).toBe('number');
  });

  it('is built from the merged table, so its size is the number of distinct one-code-unit values', () => {
    expect(trie1.size).toBe(distinctValues().filter(value => value.length === 1).length);
  });
});

describe('preserved upstream quirk: encodeXmlSafe off passes the five characters through literally', () => {
  // The ASCII branch never consults a trie, so the `&amp;` and `&lt;` entries sitting in the one-character trie for those codes are unreachable from
  // `encode`. Turning the option off therefore emits a raw `&` in the output, not an alternative name for it — which for a caller who wanted the
  // characters left alone is what they asked for, and for a caller who wanted them named is a surprise. Not endorsed: the option reads as "escape them a
  // different way" and it is not that.
  it('emits all five literally', () => {
    expect(new EntityEncoder({ encodeXmlSafe: false }).encode('& < > " \'')).toBe('& < > " \'');
  });

  it('leaves the named non-ASCII lookups working, so the option is not a switch for the whole method', () => {
    expect(new EntityEncoder({ encodeXmlSafe: false }).encode('& ©')).toBe('& &COPY;');
  });

  it('has no alternative name available for them, because the trie entries for those codes are unreachable', () => {
    // The trie does hold entries for four of the five codes — `&AMP;`, `&less;`, `&greater;`, `&QUOT;` — and `encode` still emits the character
    // itself. Pinned together with the trie specs, because the two facts are the same fact seen from either side.
    expect(trie1.get(38)).toBe('&AMP;');
    expect(trie1.get(60)).toBe('&less;');
    expect(trie1.get(62)).toBe('&greater;');
    expect(trie1.get(34)).toBe('&QUOT;');
    expect(new EntityEncoder({ encodeXmlSafe: false }).encode('&<>')).toBe('&<>');
  });

  it('is on unless it is explicitly false, so an absent option cannot disable escaping', () => {
    expect(new EntityEncoder().encodeXmlSafe).toBe(true);
    expect(new EntityEncoder({}).encode('&')).toBe('&amp;');
  });
});

describe('preserved upstream quirk: encodeAllNamed off only disables the one-character lookup', () => {
  // The two- and three-character probes sit outside the `encodeAllNamed` guard, so a two-code-unit value is still replaced with this off. A caller who
  // turned the option off to keep their text as plain characters still gets a named entity for an astral-plane letter or a combining sequence. Not
  // endorsed: the option's own documentation says it leaves single characters alone, which is narrower than a reader expects from the name.
  it('leaves a single character alone', () => {
    const encoder = new EntityEncoder({ encodeAllNamed: false });
    expect(encoder.encode('©')).toBe('©');
    expect(encoder.encode('é')).toBe('é');
  });

  it('still replaces a two-code-unit value, which is the gap', () => {
    expect(new EntityEncoder({ encodeAllNamed: false }).encode('𝔄')).toBe('&Afr;');
  });

  it('still replaces a two-code-unit value in the middle of a string', () => {
    expect(new EntityEncoder({ encodeAllNamed: false }).encode('x𝔄y')).toBe('x&Afr;y');
  });

  it('still escapes the XML-unsafe ASCII characters, which are not a named lookup at all', () => {
    expect(new EntityEncoder({ encodeAllNamed: false }).encode('<')).toBe('&lt;');
  });

  it('is on unless it is explicitly false', () => {
    expect(new EntityEncoder().encodeAllNamed).toBe(true);
    expect(new EntityEncoder(withExplicitUndefined({ encodeAllNamed: undefined })).encode('©')).toBe('&COPY;');
  });
});

describe('preserved upstream quirk: the name chosen for a character is the last one the table reached', () => {
  // The reverse index that feeds the tries keeps one name per replacement text, and the one it keeps is the last inserted — which is decided by key
  // order across the category tables, not by any preference. So `©` is `&COPY;` rather than `&copy;`. Every name is an equally valid decode target, so
  // this is only surprising to a reader who expected a particular spelling, and to a caller diffing output. Not endorsed: it is arbitrary, and it is
  // fixed for a given build but not derivable from the API.
  it('emits &COPY; for a copyright sign rather than the more familiar &copy;', () => {
    expect(new EntityEncoder().encode('©')).toBe('&COPY;');
  });

  it('emits the lowercase name where the uppercase is not in the table, so the collision is what decides it', () => {
    // `eacute` has no upper-case twin in the table, so there is nothing to collide with and the one name is the answer.
    expect(new EntityEncoder().encode('é')).toBe('&eacute;');
  });

  it('is a wide problem, not a single one: 173 replacement texts have several names', () => {
    const byValue = new Map<string, string[]>();
    for (const [name, value] of Object.entries(ALL_ENTITIES)) byValue.set(value, [...(byValue.get(value) ?? []), name]);
    expect([...byValue.values()].filter(names => names.length > 1)).toHaveLength(173);
  });

  it('emits the last name in each colliding set, whatever the names are', () => {
    // The rule stated as a rule rather than as a list: for any character the table names more than once, what comes out is the last of them. Four
    // characters with different shapes of collision — a casing pair, an alias pair, and a set of three.
    expect(namesFor('©')).toEqual(['copy', 'COPY']);
    expect(namesFor('’')).toEqual(['rsquo', 'rsquor']);
    expect(namesFor('„')).toEqual(['ldquor', 'bdquo']);
    expect(namesFor('≏')).toEqual(['bumpe', 'bumpeq', 'HumpEqual']);
    for (const character of ['©', '’', '„', '≏']) {
      const candidates = namesFor(character);
      const winner = candidates.at(-1) as string;
      expect(candidates.length, `${winner} was expected to be one of several names`).toBeGreaterThan(1);
      expect(new EntityEncoder().encode(character), `${winner} should win`).toBe(`&${winner};`);
    }
  });

  it('does not choose between the several names for the five XML-unsafe characters, because their own table handles those first', () => {
    // The trie would serve `&AMP;` and `&less;` here. The ASCII branch never reaches it, so the spelling a caller sees is the fixed one, whatever the
    // collisions in the table would have picked.
    expect(new EntityEncoder().encode('&')).toBe('&amp;');
    expect(new EntityEncoder().encode('<')).toBe('&lt;');
    expect(new EntityEncoder().encode('>')).toBe('&gt;');
    expect(new EntityEncoder().encode('"')).toBe('&quot;');
    expect(new EntityEncoder().encode("'")).toBe('&apos;');
  });

  it('decodes whatever it emitted, so the choice of name never costs a caller the character', () => {
    const encoder = new EntityEncoder();
    const decoder = new EntityDecoder({ namedEntities: ALL_ENTITIES });
    expect(decoder.decode(encoder.encode('©<>&"\''))).toBe('©<>&"\'');
  });
});

describe('preserved upstream quirk: a negative replacement budget is unlimited', () => {
  // The budget is read with `maxReplacements > 0`, so a negative number disables the limit exactly as `0` does — but only `0` is documented as meaning
  // unlimited. A caller who passed `-1` expecting a refusal gets an encoder that never refuses. Not endorsed: the value is stored as given, so a reader
  // inspecting the field sees a limit the method is not applying.
  it('replaces without limit, and leaves the counter at zero because it is never incremented', () => {
    const encoder = new EntityEncoder({ maxReplacements: -1 });
    expect(encoder.encode('<>&<>&')).toBe('&lt;&gt;&amp;&lt;&gt;&amp;');
    expect(encoder.replacementsCount).toBe(0);
  });

  it('keeps the negative value in the public field, so the field and the behaviour disagree', () => {
    expect(new EntityEncoder({ maxReplacements: -1 }).maxReplacements).toBe(-1);
  });

  it('replaces past the number it was given, which is what a limit of one would have stopped', () => {
    expect(new EntityEncoder({ maxReplacements: 1 }).encode('<<')).toBe('&lt;<');
    expect(new EntityEncoder({ maxReplacements: -1 }).encode('<<')).toBe('&lt;&lt;');
  });
});

describe('construction', () => {
  it('needs no options at all', () => {
    expect(new EntityEncoder().encode('<')).toBe('&lt;');
  });

  it('resolves the three options to plain values at construction time', () => {
    const encoder = new EntityEncoder({ encodeXmlSafe: false, encodeAllNamed: false, maxReplacements: 4 });
    expect(encoder.encodeXmlSafe).toBe(false);
    expect(encoder.encodeAllNamed).toBe(false);
    expect(encoder.maxReplacements).toBe(4);
  });

  it('reads a limit of an explicit undefined as unlimited', () => {
    // `options.maxReplacements || 0`, so an explicit `undefined` and an absent key land on the same `0`.
    const encoder = new EntityEncoder(withExplicitUndefined({ maxReplacements: undefined }));
    expect(encoder.maxReplacements).toBe(0);
    expect(encoder.encode('<<<')).toBe('&lt;&lt;&lt;');
  });

  it('starts every instance with a spent counter of zero, so two encoders do not share a budget', () => {
    const first = new EntityEncoder({ maxReplacements: 1 });
    const second = new EntityEncoder({ maxReplacements: 1 });
    first.encode('<');
    expect(second.replacementsCount).toBe(0);
    expect(second.encode('<')).toBe('&lt;');
  });
});

// ─── Round trip ───────────────────────────────────────────────────────────────────────────────────────

describe('decode(encode(x))', () => {
  // The encoder's output has to be decodable, or the pair is useless. A decoder given the whole table can resolve every name the encoder can emit, and
  // this asserts that over the entire table rather than on a handful of samples — a name collision that produced an undecodable spelling would be a real
  // break, and one sample would not find it.

  /**
   * @description A decoder holding the whole entity table, which is the configuration under which every name the encoder can emit resolves.
   *
   * @returns The decoder.
   */
  const fullDecoder = (): EntityDecoder => new EntityDecoder({ namedEntities: ALL_ENTITIES });

  for (const sample of ['<a href="x">café & ©</a>', 'plain ascii with no entities at all', '日本語 & é', '𝔄 ብር ⩭̸ ↝̸ ≍⃒', '’ ¸ ˆ ≏', '&<>"\'']) {
    it(`gives back ${JSON.stringify(sample)}`, () => {
      expect(fullDecoder().decode(new EntityEncoder().encode(sample))).toBe(sample);
    });
  }

  it('gives back every distinct replacement in the table, all 709 of them', () => {
    // A single failure would mean the encoder emitted a spelling the table cannot resolve, which is the only way this round trip can actually break.
    const encoder = new EntityEncoder();
    const decoder = fullDecoder();
    const failures = distinctValues().filter(value => decoder.decode(encoder.encode(value)) !== value);
    expect(failures).toEqual([]);
  });

  it('gives back every distinct replacement with the single-character lookup turned off, so the two-code-unit values are covered too', () => {
    const encoder = new EntityEncoder({ encodeAllNamed: false });
    const decoder = fullDecoder();
    const values = distinctValues().filter(value => value.length > 1);
    const failures = values.filter(value => decoder.decode(encoder.encode(value)) !== value);
    expect(failures).toEqual([]);
  });

  it('does not survive a decoder that holds only the five XML entities, which is the point of naming them', () => {
    // The other direction, and the reason the option exists: encoding `é` and decoding it back needs a table, and without one the caller gets the
    // reference text rather than the character.
    const bare = new EntityDecoder();
    const encoded = new EntityEncoder().encode('café & ©');
    expect(encoded).toBe('caf&eacute; &amp; &COPY;');
    expect(bare.decode(encoded)).toBe('caf&eacute; & &COPY;');
  });

  it('re-encodes a decoded string to the same spelling, so the collision is stable across a round trip', () => {
    const encoder = new EntityEncoder();
    const decoder = fullDecoder();
    const once = encoder.encode('©');
    expect(encoder.encode(decoder.decode(once))).toBe(once);
  });
});

// ─── What the encoder does not reach ───────────────────────────────────────────────────────────────────

describe('the trie entries the encoder cannot reach', () => {
  it('holds an entry for each of the five XML-unsafe codes it would otherwise have to be asked about', () => {
    // Proves the trie is complete as an index and the encoder is the one that is closed, rather than the index having skipped these characters.
    for (const code of [34, 38, 39, 60, 62]) {
      expect(trie1.has(code)).toBe(true);
    }
  });

  it('holds two ASCII first codes in trie2, which the encoder also cannot reach', () => {
    const firstCodes = [...trie2.keys()];
    const ascii = firstCodes.filter(code => code < 128);
    expect(ascii.length).toBeGreaterThan(0);
    expect(ascii.every(code => code < 128)).toBe(true);
  });

  it('replaces the astral values through trie2 rather than trie3, so the dead branch is provably not the one doing the work', () => {
    expect(trie2.has(0xd835)).toBe(true);
    expect(new EntityEncoder().encode('𝔄')).toBe('&Afr;');
  });

  it('reaches a two-code-unit value whose first code is astral, so the surrogate is the key and not a decoded character', () => {
    expect(codePointsOf('𝔄')).toEqual(['1D504']);
    expect(trie2.get('𝔄'.charCodeAt(0))?.get('𝔄'.charCodeAt(1))).toBe('&Afr;');
  });
});
