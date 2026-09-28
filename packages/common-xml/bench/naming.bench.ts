/**
 * @description Throughput benchmarks for the five boolean validators, run by Vitest's benchmark mode rather than by a hand-rolled timing loop. The `.bench.ts`
 * suffix is what puts this file in the benchmark project, so `vp test` ignores it entirely and `vp test bench` (or `vp run bench` from the workspace
 * root) runs only these files, reporting throughput, mean and percentiles in place of the old hand-padded table of ops/sec. Tinybench runs its own
 * warmup and picks the iteration count per input, so the hand-rolled version's fixed `ITERATIONS`/`WARMUP_ITERATIONS` pair and its manual warmup loop
 * are both gone. The point is the `asciiOnly` row: the same work is measured with and without the fast path, so the cost of the unicode-aware regex
 * is visible rather than assumed. The 5 productions × 6 inputs × 3 option sets grid is measured along two axes rather than all three at once. Every
 * cell was a benchmark in the hand-rolled version, and printing all 90 of them in one file buried the comparison anyone actually reads — the same
 * production under `asciiOnly` against the unicode-aware default, which is two tables of identical rows read against each other. Splitting the input
 * axis out costs the cross-product and buys output you can read:
 *
 * - One test per option set, one benchmark per production, each running the whole input set — the asciiOnly comparison, apples to apples;
 * - One test for input shape, one benchmark per input with the fast path off and on — where the length and unicode costs actually show up.
 */

import { afterAll, expect, test } from 'vite-plus/test';

import type { Production, ValidationOptions } from '#/index.ts';

import * as xmlNaming from '#/index.ts';

/**
 * @description The five productions under test, in the order the runtime error message lists them.
 */
const PRODUCTIONS: readonly Production[] = ['name', 'ncName', 'qName', 'nmToken', 'nmTokens'];

/**
 * @description The option sets to measure, labelled for the suite name. These three are the only combinations that select a different compiled regex set: 1.0 and
 * 1.1 without the fast path, and the single ASCII-only set that both versions collapse onto.
 */
const OPTION_SETS: readonly { label: string; options: Required<ValidationOptions> }[] = [
  { label: 'xml 1.0 — unicode-aware', options: { xmlVersion: '1.0', asciiOnly: false } },
  { label: 'xml 1.1 — unicode-aware (/u)', options: { xmlVersion: '1.1', asciiOnly: false } },
  { label: 'xml 1.0 — asciiOnly fast path', options: { xmlVersion: '1.0', asciiOnly: true } },
];

/**
 * @description Inputs to validate, labelled for the benchmark name. The set spans the shapes where the `asciiOnly` fast path should differ most from the
 * unicode-aware default: ASCII and non-ASCII, short and long, and two inputs that fail for a character-class reason rather than a first-character
 * reason, so the failure path is measured too.
 */
const CASES = {
  'ASCII valid short': 'foo123',
  'ASCII invalid (starts with -)': '-bar',
  'Unicode valid short': 'élément',
  'Unicode invalid (combining start)': '\u0300abc',
  'ASCII long (1000 chars)': 'a'.repeat(1000),
  'Unicode long (1000 chars)': 'é'.repeat(1000),
} as const satisfies Record<string, string>;

/**
 * @description {@link CASES} as a list, for the benchmarks that validate every input in one go.
 */
const INPUTS: readonly string[] = Object.values(CASES);

/**
 * @description Accumulates the outcome of every validation the benchmarks below perform. A regex `test()` whose result is discarded is exactly the kind of call a
 * JIT is free to optimise away, and a validator benchmark that silently measured nothing looks like an extremely fast validator rather than like a
 * bug, so the result is folded into this counter instead. The `afterAll` below reads it back, so the work is observable and the counter cannot itself
 * be optimised away.
 */
let observed = 0;

/**
 * @description How long to sample the benchmarks in one group, in milliseconds, and how long to warm them up first. The validators run in well under a
 * microsecond, so Tinybench's 1000ms default would spend most of a minute on this file for no extra precision; 200ms still collects tens of thousands
 * of samples per benchmark.
 */
const BUDGET = { time: 200, warmupTime: 50 } as const;

/**
 * @description Bound a validator to a local. Reading it off the namespace object would go through the module runner's export getter on every call, which is
 * measurable at the iteration counts a 200ms sample reaches.
 *
 * @param production - Which production to bind.
 *
 * @returns The validator.
 */
const validatorFor = (production: Production): ((input: string, options?: ValidationOptions) => boolean) => xmlNaming[production];

afterAll(() => {
  // If the sink is still empty, the benchmark bodies never reached the line
  // that reads the validator's result — which means the numbers in the tables
  // describe a run that did not do the work.
  expect(observed).toBeGreaterThan(0);
});

for (const { label, options } of OPTION_SETS) {
  test(label, async ({ bench }) => {
    // One registration per production. The validator is bound before the body
    // runs rather than read inside it — see `validatorFor`.
    const measurements = PRODUCTIONS.map(production => {
      const validate = validatorFor(production);

      return bench(production, () => {
        // The whole input set in one benchmark, so every option set and every
        // production does byte-identical work and the rows compare directly.
        // The two 1000-character inputs dominate the per-op time here, which
        // is why the next test measures the shapes separately.
        for (const input of INPUTS) observed += validate(input, options) ? 1 : 0;
      });
    });

    await bench.compare(...measurements, BUDGET);
  });
}

test('input shape — name production', async ({ bench }) => {
  const validate = validatorFor('name');

  const measurements = Object.entries(CASES).flatMap(([caseLabel, input]) =>
    [false, true].map(asciiOnly =>
      bench(`${caseLabel} / asciiOnly=${asciiOnly}`, () => {
        observed += validate(input, { xmlVersion: '1.0', asciiOnly }) ? 1 : 0;
      })
    )
  );

  await bench.compare(...measurements, BUDGET);
});
