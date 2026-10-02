/**
 * @description Focused benchmarks for {@link toNumber}, the numeric-string converter behind the `number` value parser. It runs once per attribute value and once
 * per text node in every parse, so it is on the hot path of both the parser and the builder, and a change to its fast paths is easy to lose inside
 * the end-to-end comparison rows. This file measures it directly, split by the shapes it actually sees. The inputs are split into the two cases that
 * matter, because they are not symmetric. Text that is obviously not a number is the common case in a real document — a name, a description, a
 * category — and it is the case a fast reject is supposed to make cheap. Numeric text is the other case, and it is the one the full rule set has to
 * run for. A single mixed row would report the average of those two and hide a regression in either. The project pins `@endevops/builder` to its
 * built `dist/` entry, so run `pnpm build` first. The price is Vite's module-runner export getters, which add overhead to every cross-module call;
 * `{@link toNumber}` is a direct import, so only the one call per iteration is affected, not the loop inside it.
 */

import { toNumber } from '@endevops/builder';
import { afterAll, expect, test } from 'vite-plus/test';

/**
 * @description How to sample each suite. A conversion is sub-microsecond, so Tinybench's default 64 iterations is far too few to be meaningful and the default
 * 1000ms window already collects tens of thousands of samples — the same shape the comparison benchmark uses for its small-document rows. Warmup is
 * short because the function is pure and the JIT settles immediately.
 */
const BUDGET = { time: 1000, warmupTime: 50 } as const;

/**
 * @description Text a document hands the number parser that is not a number: names, descriptions, identifiers. The list covers the shapes a fast reject has to
 * handle — a short word, a long sentence, a leading letter, a leading `#` and a value that looks numeric until it does not.
 */
const TEXT = [
  'Hello',
  'Item number 12345',
  'SKU-1',
  'cat-7',
  'Ada Lovelace',
  'ada@example.com',
  '#tag',
  'true',
  'false',
  'deliver after 5pm',
  'a very long description text node that runs on for a while and contains a number 42 near the end',
] as const;

/**
 * @description Text that is a number, in each spelling the converter accepts. Every one of these runs the full rule set, so this row is the cost of the parser
 * doing its job rather than of it failing fast.
 */
const NUMERIC = ['42', '1234.56', '-0.5', '007', '1e3', '0x1f', '19.99', '834.58', '2020', '3.14159'] as const;

/**
 * @description The document-shaped mix: many more text values than numeric ones, which is what a document of names, descriptions and a few real numbers looks
 * like. This is the row that should track the end-to-end parse cost most closely.
 */
const MIXED = [...TEXT, ...TEXT, ...TEXT, ...NUMERIC] as const;

/**
 * @description Accumulates the type of every conversion, so the work is observable and cannot be optimised away. `toNumber` returns the number when it converted
 * and the original string when it did not, so the length of a string result and the value of a numeric one are both cheap to fold in without changing
 * what was computed.
 */
let observed = 0;

afterAll(() => {
  // If the sink is still empty, the benchmark bodies never ran to the line that reads a result — which
  // means the numbers describe a run that did not do the work.
  expect(observed).toBeGreaterThan(0);
});

/**
 * @description Convert every value in `values` and fold the results into {@link observed}. `% values.length` keeps the index in range inside the loop, so a
 * benchmark iteration walks the whole list rather than one element.
 *
 * @param values - The values to convert.
 */
const convertAll = (values: ReadonlyArray<string>): void => {
  let sink = 0;
  for (let i = 0; i < values.length; i++) {
    const result = toNumber(values[i] as string);
    sink += typeof result === 'number' ? result : (result?.length ?? 0);
  }
  observed += sink;
};

test('toNumber — non-numeric text', async ({ bench }) => {
  await bench(`${TEXT.length} text values`, () => {
    convertAll(TEXT);
  }).run(BUDGET);
});

test('toNumber — numeric text', async ({ bench }) => {
  await bench(`${NUMERIC.length} numeric values`, () => {
    convertAll(NUMERIC);
  }).run(BUDGET);
});

test('toNumber — document-shaped mix', async ({ bench }) => {
  await bench(`${MIXED.length} values (${NUMERIC.length} numeric)`, () => {
    convertAll(MIXED);
  }).run(BUDGET);
});
