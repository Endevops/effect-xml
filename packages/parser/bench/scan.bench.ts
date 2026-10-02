/**
 * @description Benchmarks for the two character-level scans every opening tag goes through: {@link scanTagExpEnd}, which finds the `>` that ends a tag expression
 * and records the quote boundaries on the way, and {@link parseAttributes}, which reads the attribute expression it is handed. Together they are the
 * only part of a parse that examines every character of a tag rather than every token, so they set the floor for how fast a document can be read.
 * They are measured here rather than through the whole-document benchmark because the end-to-end rows cannot say which of the two moved, and a change
 * to either is a change to a loop over characters. The tags are the shapes a real document writes: a few short attributes, one long value, a value
 * containing the other quote and a `>`, a tag with a single attribute, and a tag with none. The single-attribute and no-attribute cases matter
 * because they are the common ones and the ones a fast path for the short case would target.
 */

import { Effect } from 'effect';
import { afterAll, expect, test } from 'vite-plus/test';

import { parseAttributes } from '#/attribute-processor.ts';
import StringSource from '#/input-source/string-source.ts';

/**
 * @description How to sample each suite. A tag expression is short, so a scan is sub-microsecond and a 1000ms window collects hundreds of thousands of samples.
 */
const BUDGET = { time: 1000, warmupTime: 50 } as const;

/**
 * @description Tag expressions as they appear after the leading `<`, each written to exercise one shape: several attributes, one long value, a value holding the
 * delimiting quote of the other kind, a value holding `>`, one attribute, and none.
 */
const TAGS = [
  'item id="12345" sku="SKU-12345" category="cat-7" active="true"',
  'item value="a longer attribute value with several words in it that goes on"',
  `item title="it's here" other="x"`,
  'item data="a > b" note="x"',
  'item id="1"',
  'item',
] as const;

/**
 * @description Accumulates a property of every scan result, so the work is observable and cannot be optimised away.
 */
let observed = 0;

afterAll(() => {
  expect(observed).toBeGreaterThan(0);
});

/**
 * @description One source, reused across iterations the way the parser reuses it across tags. The scan is a cursor walk over its buffer, and resetting the cursor
 * is what makes each iteration read the same bytes.
 */
const source = new StringSource(`<${TAGS[0]}>`);

function resetSource(tag: string): void {
  source.buffer = `<${tag}>`;
  source.startIndex = 0;
}

test('scanTagExpEnd — tag expressions of several shapes', async ({ bench }) => {
  await bench(`${TAGS.length} tags`, () => {
    let sink = 0;
    for (let i = 0; i < TAGS.length; i++) {
      resetSource(TAGS[i] as string);
      sink += source.scanTagExpEnd();
    }
    observed += sink;
  }).run(BUDGET);
});

test('scanTagExpEndFast — the same tags, no quote bookkeeping', async ({ bench }) => {
  await bench(`${TAGS.length} tags`, () => {
    let sink = 0;
    for (let i = 0; i < TAGS.length; i++) {
      resetSource(TAGS[i] as string);
      sink += source.scanTagExpEndFast();
    }
    observed += sink;
  }).run(BUDGET);
});

test('parseAttributes — attribute expressions of several shapes', async ({ bench }) => {
  await bench(`${TAGS.length} expressions`, () => {
    // One `runSync` per tag keeps the row a measure of the pass itself. Batching the whole loop into
    // one `runSync` would instead measure mostly the `Effect.all` combinator, which reported a
    // plausible-looking 0.03us for the whole loop before this was split.
    let sink = 0;
    for (let i = 0; i < TAGS.length; i++) {
      const tag = TAGS[i] as string;
      const cut = tag.indexOf(' ');
      const expression = cut === -1 ? '' : tag.slice(cut + 1);
      resetSource(tag);
      const end = source.scanTagExpEnd();
      const attrs = Effect.runSync(parseAttributes(expression, source._quotePairs, cut + 1, source._quotePairsLen, undefined));
      sink += end + attrs.length;
    }
    observed += sink;
  }).run(BUDGET);
});

test('scan then parse — one pass over each tag', async ({ bench }) => {
  await bench(`${TAGS.length} tags`, () => {
    let sink = 0;
    for (let i = 0; i < TAGS.length; i++) {
      const tag = TAGS[i] as string;
      resetSource(tag);
      const end = source.scanTagExpEnd();
      const cut = tag.indexOf(' ');
      const expression = cut === -1 ? '' : tag.slice(cut + 1);
      const attrs = Effect.runSync(parseAttributes(expression, source._quotePairs, cut + 1, source._quotePairsLen, undefined));
      sink += end + attrs.length;
    }
    observed += sink;
  }).run(BUDGET);
});
