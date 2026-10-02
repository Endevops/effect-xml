/**
 * @description Throughput benchmarks for the whole-shot and chunked parse paths, run by Vitest's benchmark mode rather than by a hand-rolled timing loop. The
 * `.bench.ts` suffix is what puts this file in the benchmark project, so `vp test` ignores it entirely and `vp test bench` (or `vp run bench` from
 * the workspace root) runs only these files, reporting throughput, mean and percentiles in place of the old `console.log` lines. Tinybench runs its
 * own warmup, so the manual warmup loops the hand-rolled version needed are gone. The document is generated rather than read from disk so the shape
 * under measurement is fixed and the run is reproducible. The generated text is deliberately varied in length and includes attributes of several
 * shapes, so the benchmark exercises tag parsing, attribute parsing and value coercion rather than measuring a single hot loop in isolation. `src/`
 * is imported rather than `dist/` on purpose: this file has to run from a clean clone, where the gitignored build output does not exist yet and could
 * in any case be stale. The price is Vite's module-runner export getters, which turn every cross-module call inside the parser into an accessor call.
 * {@link Parser} removes that overhead for the class under test, but the getters on the parser's own internal imports remain and are counted against
 * every number reported here.
 */

import type { X2jOptions } from '@endevops/parser';

import { XMLParser } from '@endevops/parser';
import { Effect } from 'effect';
import { afterAll, expect, test } from 'vite-plus/test';

/**
 * @description How to sample each suite, and how long to warm it up first. A 20k-item catalog is roughly a second of work per parse, and Tinybench runs a task
 * until either `time` elapses or `iterations` samples have been collected — whichever comes last. Its defaults (1000ms, 64 iterations) therefore
 * demand 64 full-document parses per task, a minute of work in a runner that fails any `test` at 60s; the whole-document and chunked suites here both
 * timed out on exactly that. Pinning `iterations` to a small number bounds each task to a handful of samples while the longer `time` window keeps the
 * sample from being a single parse's noise.
 */
const BUDGET = { time: 2000, iterations: 3, warmupTime: 500, warmupIterations: 1 } as const;

/**
 * @description Generate a catalog document with `n` items.
 *
 * @param n - Number of `<item>` elements to generate.
 *
 * @returns A complete catalog document.
 */
function buildDoc(n: number): string {
  let s = '<catalog>';
  for (let i = 0; i < n; i++) {
    s += `<item id="${i}" sku="SKU-${i}" category="cat-${i % 20}" active="true" featured="false" weight="${(i * 1.5).toFixed(2)}">`;
    s += `<name>Item number ${i}</name><desc>Some description text for item ${i} with a bit more content to simulate real text nodes.</desc>`;
    s += `</item>`;
  }
  s += '</catalog>';
  return s;
}

/**
 * @description Count the keys on a parse result. `parse()` and `end()` are typed `unknown`, so this both narrows the value and turns it into something a benchmark
 * body can fold into a number — see {@link observed} for why the result cannot simply be discarded.
 *
 * @param result - Whatever the parser returned.
 *
 * @returns The number of top-level keys, or 0 for a non-object.
 */
const rootKeyCount = (result: unknown): number => (typeof result === 'object' && result !== null ? Object.keys(result).length : 0);

/**
 * @description Accumulates a property of every result the benchmarks below produce. A benchmark whose result is dropped is a benchmark the JIT is free to optimise
 * into a no-op, which reports a meaningless number rather than an obviously wrong one. The `afterAll` below reads this back, so the work is
 * observable and the accumulator cannot itself be optimised away.
 */
let observed = 0;

/**
 * @description The document under measurement, fixed at collection time so every iteration in every suite parses byte-identical input.
 */
const doc = buildDoc(20_000);

console.log(`doc size (chars): ${doc.length}`);

// `skip.nameValidation`, `skip.protoValidation` and `asciiOnlyName` used to be
// set here. None of them exists any more: name validation and the
// prototype-pollution defence are unconditional in the current parser, so
// there is no longer a switch to turn on. Left out rather than left as dead
// keys the type-checker now correctly rejects.
const options: X2jOptions = {
  skip: { attributes: false },
  // tags: { stopNodes: ['..script'] }
};

/**
 * @description Chunk size for the incremental path, in characters. This matters: a very small chunk makes nearly every token straddle a boundary and measures the
 * mark/rewind path, while a large chunk approaches the whole-shot path. 4KB is a realistic feed size.
 */
const CHUNK_SIZE = 4096;

afterAll(() => {
  // If the sink is still empty, the benchmark bodies never reached the line
  // that reads the parse result — which means the numbers in the table
  // describe a run that did not do the work.
  expect(observed).toBeGreaterThan(0);
});

/**
 * @description Parse the whole document in one shot: construct a parser, then parse. One effect, so the benchmark runs the same pipeline a caller writes.
 */
const wholeDocument = Effect.gen(function* () {
  const parser = yield* XMLParser.make(options);
  return yield* parser.parse(doc);
});

/**
 * @description Parse the document in `CHUNK_SIZE` pieces: construct a parser, feed every chunk, then end.
 */
const chunkedDocument = Effect.gen(function* () {
  const parser = yield* XMLParser.make(options);
  for (let offset = 0; offset < doc.length; offset += CHUNK_SIZE) {
    yield* parser.feed(doc.slice(offset, offset + CHUNK_SIZE));
  }
  return yield* parser.end();
});

test('parse() — whole document', async ({ bench }) => {
  await bench('20k-item catalog', () => {
    observed += rootKeyCount(Effect.runSync(wholeDocument));
  }).run(BUDGET);
});

test('feed()/end() — chunked', async ({ bench }) => {
  await bench(`4KB chunks (${Math.ceil(doc.length / CHUNK_SIZE)} feed calls)`, () => {
    observed += rootKeyCount(Effect.runSync(chunkedDocument));
  }).run(BUDGET);
});
