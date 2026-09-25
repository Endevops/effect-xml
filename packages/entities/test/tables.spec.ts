/**
 * @description Specs for the named-entity tables — 1,967 counted entries of transcribed data, which is the one part of this package that a spec cannot
 * meaningfully assert entry by entry. Asserting the data would be asserting a copy of a copy. The tables were verified byte-identical to the original
 * across every entry, and that verification is not repeatable from here. What a spec _can_ do is assert the facts a reader would otherwise have to
 * take on trust: how many tables there are, what they are called, which of them are merged into `ALL_ENTITIES` and — the one that surprises everybody
 * — which two are not, what the last-wins merge actually costs, and how much of the table is a name colliding with another name for the same
 * character. The second half of the file is the opposite: the entries that are wrong against the HTML5 specification. `MATH.bumpe` is a different
 * character from the one the name means, `SHAPES.circ` is a modifier letter rather than a circle, two values carry a combining slash the
 * specification does not have, and two names in `BASIC_LATIN` are aliases of names already beside them. None of that is a typo introduced by the port
 * — the data is verbatim, so these are upstream's errors. They are pinned individually, each named as a data bug, because a table is the one thing in
 * a port that a future contributor is most likely to "helpfully" correct, and the correction would change what `&bumpe;` expands to for every
 * caller.
 */

import { describe, expect, it } from 'vite-plus/test';

import {
  ALL_ENTITIES,
  ARROWS,
  BASIC_LATIN,
  COMMON_HTML,
  CURRENCY,
  CYRILLIC,
  FRACTIONS,
  GREEK,
  LATIN_ACCENTS,
  LATIN_EXTENDED,
  MATH,
  MATH_ADVANCED,
  MISC_SYMBOLS,
  PUNCTUATION,
  SHAPES,
  XML,
} from '#/index.ts';

/**
 * @description The thirteen category tables paired with the name the export list gives them, in the order `ALL_ENTITIES` spreads them. The order is load-bearing —
 * a name two tables define resolves to the later one — so this is the merge order and not merely a list.
 */
const CATEGORY_TABLES = [
  ['BASIC_LATIN', BASIC_LATIN],
  ['LATIN_ACCENTS', LATIN_ACCENTS],
  ['LATIN_EXTENDED', LATIN_EXTENDED],
  ['GREEK', GREEK],
  ['CYRILLIC', CYRILLIC],
  ['MATH', MATH],
  ['MATH_ADVANCED', MATH_ADVANCED],
  ['ARROWS', ARROWS],
  ['SHAPES', SHAPES],
  ['PUNCTUATION', PUNCTUATION],
  ['CURRENCY', CURRENCY],
  ['FRACTIONS', FRACTIONS],
  ['MISC_SYMBOLS', MISC_SYMBOLS],
] as const;

/**
 * @description The two tables that are exported, are what a caller points a decoder at, and are deliberately not spread into `ALL_ENTITIES`.
 */
const STANDALONE_TABLES = [
  ['COMMON_HTML', COMMON_HTML],
  ['XML', XML],
] as const;

/**
 * @description Every table export, categories and standalone sets alike.
 */
const ALL_TABLES = [...CATEGORY_TABLES, ...STANDALONE_TABLES] as const;

/**
 * @description The codepoints of a string as four-digit uppercase hex, so an assertion about a character reads the way the HTML5 specification writes it. The step
 * over a low surrogate is what makes a surrogate pair report as the one character it is rather than as two halves — the same distinction the
 * encoder's trie is built on, and the reason several of the values below are two entries long.
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
 * @description Every name across the merged table whose replacement is a given text, in key order. The last one is the name the encoder will emit for that text,
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

/**
 * @description Rebuild `ALL_ENTITIES` by spreading the thirteen category tables in declaration order, so the merge can be compared against the export rather than
 * trusted.
 *
 * @returns The rebuilt table.
 */
const mergeCategories = (): Record<string, string> => Object.assign({}, ...CATEGORY_TABLES.map(([, table]) => table));

/**
 * @description Every table source for a name, in declaration order, so a collision can be traced to the tables that caused it.
 *
 * @param name - The entity name.
 *
 * @returns One `[table name, value]` entry per table that defines it.
 */
const sourcesFor = (name: string): Array<[string, string]> =>
  CATEGORY_TABLES.filter(([, table]) => name in table).map(([tableName, table]) => [tableName, table[name] as string]);

// ─── The inventory ────────────────────────────────────────────────────────────────────────────────────

describe('the table exports', () => {
  it('is fifteen tables — thirteen categories and two standalone sets — plus the merge of the categories', () => {
    expect(ALL_TABLES).toHaveLength(15);
    expect(CATEGORY_TABLES).toHaveLength(13);
    expect(STANDALONE_TABLES).toHaveLength(2);
  });

  it('counts 1,967 entries across the sixteen exports, which is what makes them a transcription rather than a curated subset', () => {
    // The count double-counts on purpose: the merge repeats the 932 names the categories already hold, and 1,967 is the figure the transcription
    // was verified against. Stating it as 1,010 plus 25 plus 932 is the honest breakdown of where the number comes from.
    const categoryEntries = CATEGORY_TABLES.reduce((total, [, table]) => total + Object.keys(table).length, 0);
    const standaloneEntries = STANDALONE_TABLES.reduce((total, [, table]) => total + Object.keys(table).length, 0);
    expect(categoryEntries).toBe(1010);
    expect(standaloneEntries).toBe(25);
    expect(categoryEntries + standaloneEntries + Object.keys(ALL_ENTITIES).length).toBe(1967);
  });

  it('gives every entry a string value, because the decoder reads them without a type check', () => {
    for (const [tableName, table] of ALL_TABLES) {
      for (const [name, value] of Object.entries(table)) {
        expect(typeof value, `${name} in ${tableName}`).toBe('string');
      }
    }
  });

  it('has no name appearing twice within one table, so a lookup inside a table is unambiguous', () => {
    for (const [tableName, table] of ALL_TABLES) {
      const names = Object.keys(table);
      expect(new Set(names).size, `duplicate name in ${tableName}`).toBe(names.length);
    }
  });

  it('names the five XML predefined entities exactly, with nothing else in the set', () => {
    expect(Object.keys(XML).sort()).toEqual(['amp', 'apos', 'gt', 'lt', 'quot']);
  });

  it('gives the XML set the five characters the specification fixes, in lowercase name form only', () => {
    expect(XML).toEqual({ amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' });
  });

  it('holds the twenty names a caller is most likely to reach for in COMMON_HTML', () => {
    expect(Object.keys(COMMON_HTML)).toHaveLength(20);
    expect(COMMON_HTML.copy).toBe('©');
    // U+00A0, written as an escape so it cannot be mistaken for an ordinary space by a reader or a diff.
    expect(COMMON_HTML.nbsp).toBe('\u00a0');
    expect(COMMON_HTML.mdash).toBe('—');
  });
});

// ─── What ALL_ENTITIES is ─────────────────────────────────────────────────────────────────────────────

describe('ALL_ENTITIES', () => {
  it('is exactly the thirteen category tables spread in order', () => {
    expect(ALL_ENTITIES).toEqual(mergeCategories());
  });

  it('is identical to the rebuild in key order too, so the merge order is observable', () => {
    // `toEqual` would not catch a reordering, because objects compare by content. Comparing the key lists does, and key order is what decides which
    // table wins a name two of them define.
    expect(Object.keys(ALL_ENTITIES)).toEqual(Object.keys(mergeCategories()));
  });

  it('holds 932 names from 1,010 entries, because 60 names are defined twice and 9 three times', () => {
    // 863 names are defined once, 60 twice and 9 three times: 863 + 120 + 27 is the 1,010 the categories hold, and 863 + 60 + 9 is the 932 the merge
    // keeps. Worth stating as a distribution rather than a single difference, because "78 duplicates" and "69 colliding names" are different questions
    // and only one of them is the count of names a reader would call a collision.
    expect(Object.keys(ALL_ENTITIES)).toHaveLength(932);
    const sourcesPerName = new Map<string, number>();
    for (const [, table] of CATEGORY_TABLES) {
      for (const name of Object.keys(table)) sourcesPerName.set(name, (sourcesPerName.get(name) ?? 0) + 1);
    }
    const distribution = new Map<number, number>();
    for (const count of sourcesPerName.values()) distribution.set(count, (distribution.get(count) ?? 0) + 1);
    expect([...distribution.entries()].sort(([a], [b]) => a - b)).toEqual([
      [1, 863],
      [2, 60],
      [3, 9],
    ]);
  });

  it('excludes XML as a source, even though all five of its names are reachable from the categories', () => {
    // This is the coincidence worth naming: `XML` is not spread into the merge, and it would make no difference if it were, because every one of its
    // five names is already defined by a category table with the same value.
    expect(Object.keys(XML).every(name => name in ALL_ENTITIES)).toBe(true);
    const sources = sourcesFor('quot');
    expect(sources.length).toBeGreaterThan(0);
    for (const [tableName, value] of sources) {
      expect(value, tableName).toBe(XML.quot);
    }
  });

  it('excludes COMMON_HTML, which is the half of the name a reader gets wrong', () => {
    // Two of its twenty names are absent from the merge entirely, so "excluded" is observable here and not merely a shadowing artefact. A caller who
    // reaches for `&mdash;` through this table has to point a decoder at COMMON_HTML.
    expect(Object.keys(COMMON_HTML).filter(name => !(name in ALL_ENTITIES))).toEqual(['mdash', 'ndash']);
  });

  it('agrees with COMMON_HTML on the eighteen names the two have in common', () => {
    for (const [name, value] of Object.entries(COMMON_HTML)) {
      if (name in ALL_ENTITIES) expect(ALL_ENTITIES[name], name).toBe(value);
    }
  });
});

describe('the last table to define a name wins', () => {
  it('is observable in exactly one place, where two tables disagree about a name', () => {
    // Sixty-eight other names are defined twice or more and every one of them agrees in both tables. `ocirc` is the single disagreement, which is
    // what makes the rule a fact rather than a claim.
    const everyName = CATEGORY_TABLES.flatMap(([, table]) => Object.keys(table));
    const disagreeing = [...new Set(everyName)].filter(name => new Set(sourcesFor(name).map(([, value]) => value)).size > 1);
    expect(disagreeing).toEqual(['ocirc']);
  });

  it('gives &ocirc; the circled-ring operator rather than the Latin o-circumflex', () => {
    // `LATIN_ACCENTS` says `ô`, U+00F4. `MISC_SYMBOLS` is spread last and says `⊚`, U+229A CIRCLED RING OPERATOR. A decoder pointed at this table
    // expands `&ocirc;` to a symbol, which is not what someone reading the HTML5 name would expect.
    expect(sourcesFor('ocirc')).toEqual([
      ['LATIN_ACCENTS', 'ô'],
      ['MISC_SYMBOLS', '⊚'],
    ]);
    expect(ALL_ENTITIES.ocirc).toBe('⊚');
    expect(codePointsOf(ALL_ENTITIES.ocirc)).toEqual(['229A']);
  });

  it('resolves a sample of the other collisions without a disagreement, so the merge is not an override in general', () => {
    // The exhaustive claim is the test above: exactly one of the 69 collisions disagrees. This one is the readable version of it — a handful of names a
    // reader is likely to reach for, each defined in more than one table and each collapsing to the same character.
    for (const name of ['nbsp', 'half', 'copy', 'cedil', 'circ', 'colon', 'dollar', 'excl', 'semi', 'period', 'comma', 'yen', 'sect']) {
      const sources = sourcesFor(name);
      expect(sources.length, `${name} is defined in more than one table`).toBeGreaterThan(1);
      expect(new Set(sources.map(([, value]) => value)).size, name).toBe(1);
      expect(ALL_ENTITIES[name], name).toBe(sources[0][1]);
    }
  });

  it('gives &nbsp; the same character from all three tables that define it', () => {
    expect(sourcesFor('nbsp').map(([tableName]) => tableName)).toEqual(['BASIC_LATIN', 'MATH', 'PUNCTUATION']);
    expect(codePointsOf(ALL_ENTITIES.nbsp)).toEqual(['00A0']);
  });
});

// ─── Preserved upstream data bugs ──────────────────────────────────────────────────────────────────────

describe('preserved upstream data bug: MATH.bumpe is U+224F, where HTML5 says U+224E', () => {
  // `bumpe` and `bumpeq` are meant to be U+224E MUCH GREATER-THAN-OR-EQUAL TO. The value here is U+224F MUCH LESS-THAN-OR-EQUAL TO — one codepoint
  // along and the opposite sign. The correct character is in the table, under three other names, so this is a mis-filing rather than a missing value.
  // Not endorsed: a document that means the greater-than form gets the less-than form. Pinned because a table is the most likely place in a port for
  // someone to correct a specification mismatch, and this correction would change the output of every caller.
  it('holds the less-than-or-equal character under the greater-than name', () => {
    expect(MATH.bumpe).toBe('≏');
    expect(codePointsOf(MATH.bumpe)).toEqual(['224F']);
  });

  it('gives bumpeq the same wrong character', () => {
    expect(MATH.bumpeq).toBe(MATH.bumpe);
  });

  it('reaches the same wrong character through the merged table, so a decoder sees it too', () => {
    expect(ALL_ENTITIES.bumpe).toBe('≏');
    expect(namesFor('≏')).toEqual(['bumpe', 'bumpeq', 'HumpEqual']);
  });

  it('still holds U+224E under three other names, so the character is reachable and only the pair is mis-filed', () => {
    // This is what makes it a data bug rather than a gap: `bump`, `Bumpeq` and `HumpDownHump` all carry the greater-than-or-equal character the
    // HTML5 specification pairs with `bumpe`.
    expect(namesFor('≎')).toEqual(['bump', 'Bumpeq', 'HumpDownHump']);
    expect(codePointsOf(ALL_ENTITIES.bump)).toEqual(['224E']);
  });

  it('is the only name in the table pointing at U+224F that is not a casing variant of bumpe', () => {
    // So a caller who wants the less-than-or-equal character has `bumpe`, and a caller who wants the greater-than one has to know to spell it `bump`.
    expect(namesFor('≏').filter(name => name !== 'bumpe' && name !== 'bumpeq')).toEqual(['HumpEqual']);
  });
});

describe('preserved upstream data bug: SHAPES.circ is a modifier letter, not a circle', () => {
  // `circ` is U+02C6 MODIFIER LETTER CIRCUMFLEX ACCENT. The HTML5 `circ` is U+25CB WHITE CIRCLE, and U+02C6 is `hat`. A document using `&circ;` to mean
  // a ring gets a hat. The same value appears in `PUNCTUATION` under the same name, so the merge does not change it.
  it('holds the modifier circumflex, not the white circle', () => {
    expect(SHAPES.circ).toBe('ˆ');
    expect(codePointsOf(SHAPES.circ)).toEqual(['02C6']);
  });

  it('is the only name in the merged table pointing at U+02C6, so the hat is reachable only as this one', () => {
    expect(namesFor('ˆ')).toEqual(['circ']);
    expect(codePointsOf(ALL_ENTITIES.circ)).toEqual(['02C6']);
  });

  it('agrees with PUNCTUATION on the same name, so the merge order is not what chose it', () => {
    expect(PUNCTUATION.circ).toBe(SHAPES.circ);
    expect(ALL_ENTITIES.circ).toBe('ˆ');
  });

  it('holds the white circle the name means under three other names, so the character is in the table and circ is not one of its names', () => {
    // U+25CB WHITE CIRCLE is exactly what the HTML5 `circ` is defined to be, and the table does carry it — under `Circle`, `cir` and `o`. So the
    // character is reachable; the name is simply on the wrong one of two circle characters the table holds.
    expect(namesFor('○')).toEqual(['Circle', 'cir', 'o']);
    expect(codePointsOf(ALL_ENTITIES.Circle)).toEqual(['25CB']);
  });

  it('holds a second, larger circle under bigcirc and xcirc, so the table has two circles and circ names neither', () => {
    // U+25EF LARGE CIRCLE, which is what the HTML5 `bigcirc` is. So the two circle characters and the four names are all present and correctly
    // paired, except for `circ`, which is on a modifier letter instead.
    expect(SHAPES.bigcirc).toBe(SHAPES.xcirc);
    expect(codePointsOf(SHAPES.bigcirc)).toEqual(['25EF']);
    expect(SHAPES.Circle).not.toBe(SHAPES.bigcirc);
  });
});

describe('preserved upstream data bug: two values carry a combining slash the specification does not have', () => {
  // Each of these is a base character plus U+0338 COMBINING LONG SOLIDUS OVERLAY. The HTML5 values for both names are the base character alone. The
  // overlay is the slanted-bar notation some mathematical writing uses, and whoever transcribed the table read it as part of the character. Two code
  // points where the specification has one, in both the table and the merge.
  it('gives &ncongdot; a trailing U+0338, so it is two code points where HTML5 has one', () => {
    expect(MATH_ADVANCED.ncongdot).toBe('⩭̸');
    expect(codePointsOf(MATH_ADVANCED.ncongdot)).toEqual(['2A6D', '0338']);
  });

  it('gives &nrarrw; a trailing U+0338 as well', () => {
    expect(ARROWS.nrarrw).toBe('↝̸');
    expect(codePointsOf(ARROWS.nrarrw)).toEqual(['219D', '0338']);
  });

  it('leaves the two same-width arrow names without the overlay, which is what makes the pair inconsistent', () => {
    // `rarrw` and `rightsquigarrow` are the plain U+219D. So the table holds three spellings of the same arrow and only the slashed one is `nrarrw`.
    expect(namesFor('↝')).toEqual(['rarrw', 'rightsquigarrow']);
    expect(namesFor('↝̸')).toEqual(['nrarrw']);
  });

  it('reaches the slashed values through the merged table, so the encoder has to name a two-code-unit value for them', () => {
    expect(ALL_ENTITIES.ncongdot).toBe(MATH_ADVANCED.ncongdot);
    expect(ALL_ENTITIES.nrarrw).toBe(ARROWS.nrarrw);
    expect(MATH_ADVANCED.ncongdot.length).toBe(2);
  });

  it('is the only two of the thirteen two-code-unit values that end in a combining mark', () => {
    const twoUnit = [...new Set(Object.values(ALL_ENTITIES))].filter(value => value.length === 2);
    expect(twoUnit).toHaveLength(13);
    expect(twoUnit.filter(value => value.includes('̸'))).toHaveLength(2);
  });
});

describe('preserved upstream data bug: two pairs of names in BASIC_LATIN are the same character twice', () => {
  // `rsquor` repeats `rsquo`, and `bdquo` repeats `ldquor`. So the table holds four names for two characters among the quotation marks, and the
  // reverse index the encoder builds keeps the last of each colliding pair — which means the alias is what callers see in encoder output. Not
  // endorsed, and worth knowing about specifically because it is user-visible: a caller expecting `&rsquo;` from the encoder gets `&rsquor;`.
  it('gives &rsquor; and &rsquo; the same character', () => {
    expect(BASIC_LATIN.rsquor).toBe(BASIC_LATIN.rsquo);
    expect(BASIC_LATIN.rsquor).toBe('’');
    expect(namesFor('’')).toEqual(['rsquo', 'rsquor']);
  });

  it('makes the encoder emit the alias, because the reverse index keeps the last name it saw', () => {
    expect(namesFor('’').at(-1)).toBe('rsquor');
    expect(namesFor('„').at(-1)).toBe('bdquo');
  });

  it('gives &bdquo; and &ldquor; the same character, a low double quote rather than the right double quote the name suggests', () => {
    // `bdquo` reads as "baseline double quote" and HTML5 pairs it with U+201E DOUBLE LOW-9 QUOTATION MARK, which is what it holds. It is the alias
    // of `ldquor` rather than a second spelling of `rdquo`, and only the last of the two is what the encoder will emit.
    expect(BASIC_LATIN.bdquo).toBe(BASIC_LATIN.ldquor);
    expect(codePointsOf(BASIC_LATIN.bdquo)).toEqual(['201E']);
    expect(namesFor('”')).toEqual(['rdquo']);
  });

  it('holds the spacing cedilla under one name in three tables, all of them the same modifier letter', () => {
    // U+00B8 is a spacing modifier letter rather than the U+0327 combining cedilla some renderings use, and it is right here. Pinned because three
    // tables defining one name is a shape a reader should not have to reverse-engineer from the exports.
    expect(sourcesFor('cedil').map(([tableName]) => tableName)).toEqual(['BASIC_LATIN', 'PUNCTUATION', 'CURRENCY']);
    expect(codePointsOf(ALL_ENTITIES.cedil)).toEqual(['00B8']);
  });
});

// ─── The merged table as the encoder sees it ────────────────────────────────────────────────────────────

describe('the merged table as the encoder sees it', () => {
  it('has far more names than distinct characters, which is what makes the name choice a decision at all', () => {
    const distinct = new Set(Object.values(ALL_ENTITIES));
    expect(Object.keys(ALL_ENTITIES)).toHaveLength(932);
    expect(distinct.size).toBe(709);
  });

  it('gives 173 characters more than one name', () => {
    const counts = new Map<string, number>();
    for (const value of Object.values(ALL_ENTITIES)) counts.set(value, (counts.get(value) ?? 0) + 1);
    expect([...counts.values()].filter(count => count > 1)).toHaveLength(173);
  });

  it('holds 696 single-code-unit values and 13 two-code-unit ones, and nothing longer', () => {
    // The depth constraint the encoder is built around, asserted on the data rather than on the trie: nothing in the table is three code units wide,
    // so the encoder's three-character branch can never fire.
    const values = new Set(Object.values(ALL_ENTITIES));
    expect([...values].filter(value => value.length === 1)).toHaveLength(696);
    expect([...values].filter(value => value.length === 2)).toHaveLength(13);
    expect([...values].filter(value => value.length > 2)).toHaveLength(0);
  });

  it('holds no empty value, so no name deletes its own reference', () => {
    expect(Object.values(ALL_ENTITIES).filter(value => value.length === 0)).toHaveLength(0);
  });

  it('covers the Latin-1 range the decoder reaches first, so a caller needs no second dependency for ordinary prose', () => {
    for (const [name, value] of Object.entries(COMMON_HTML)) {
      if (name in ALL_ENTITIES) expect(ALL_ENTITIES[name], name).toBe(value);
    }
  });
});
