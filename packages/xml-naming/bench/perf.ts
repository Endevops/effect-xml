/**
 * @description Throughput benchmark for the five boolean validators across every `xmlVersion`/`asciiOnly` combination. Not a test — there are no assertions, only
 * timings, so it lives outside the suite and `vp test` does not pick it up. The point is the `asciiOnly` column: the same inputs are measured with
 * and without the fast path so the cost of the unicode-aware regex is visible rather than assumed. Run it with `vp exec bench/perf.ts`, or from an
 * editor's run configuration. Executing it needs a TypeScript-aware runner: `src/` imports its own modules with `.ts` specifiers, which bare `node
 * --experimental-strip-types` cannot resolve.
 */

import { performance } from 'node:perf_hooks';

import type { Production, ValidationOptions } from '#/index.ts';

import * as xmlNaming from '#/index.ts';

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const ITERATIONS = 100_000; // per measurement
const WARMUP_ITERATIONS = 10_000; // discard first run to stabilise

// Test cases: label -> input string
const testCases: Record<string, string> = {
  'ASCII valid short': 'foo123',
  'ASCII invalid (starts with -)': '-bar',
  'Unicode valid short': 'élément',
  'Unicode invalid (combining start)': '\u0300abc',
  'ASCII long (1000 chars)': 'a'.repeat(1000),
  'Unicode long (1000 chars)': 'é'.repeat(1000),
};

// Validator functions to test
const functions: Production[] = ['name', 'ncName', 'qName', 'nmToken', 'nmTokens'];

// Option combinations
const optionSets: ValidationOptions[] = [
  { xmlVersion: '1.0', asciiOnly: false },
  { xmlVersion: '1.1', asciiOnly: false },
  { xmlVersion: '1.0', asciiOnly: true },
];

/**
 * @description Throughput of a zero-argument closure.
 */
interface Stats {
  opsPerSec: number;
  elapsedMs: number;
}

/**
 * @description One row of the results table: which configuration, which production, which input, and how fast.
 */
interface Row {
  config: string;
  fn: string;
  case: string;
  opsPerSec: number;
}

/**
 * @description Timings for one validator, keyed by input label.
 */
type CaseStats = Record<string, Stats>;

/**
 * @description Timings for one configuration, keyed by production.
 */
type ProductionStats = Record<string, CaseStats>;

/**
 * @description Every measurement in the run, keyed by configuration.
 */
type Results = Record<string, ProductionStats>;

// ----------------------------------------------------------------------------
// Benchmark helper
// ----------------------------------------------------------------------------

/**
 * @description Runs `fn` `WARMUP_ITERATIONS` times to let the JIT settle, then `iterations` times under measurement.
 *
 * @param fn - The work to measure. Takes no arguments so the call site cannot hoist anything out of the loop.
 * @param iterations - Measured iterations.
 *
 * @returns Operations per second and total elapsed milliseconds.
 */
function measure(fn: () => void, iterations: number): Stats {
  // warm-up
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn();
  // measurement
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const end = performance.now();
  const elapsedMs = end - start;
  const opsPerSec = (iterations / elapsedMs) * 1000;
  return { opsPerSec, elapsedMs };
}

// ----------------------------------------------------------------------------
// Run benchmarks
// ----------------------------------------------------------------------------

const results: Results = {};

for (const opts of optionSets) {
  const configKey = `xml${opts.xmlVersion}${opts.asciiOnly ? '-asciiOnly' : ''}`;

  // Built into locals and assigned once, rather than written through
  // `results[configKey][fnName] = …` — a read-modify-write on a nested index
  // is `| undefined` under noUncheckedIndexedAccess, even though the key is
  // always present.
  const byProduction: ProductionStats = {};

  for (const fnName of functions) {
    const byCase: CaseStats = {};
    const validator = xmlNaming[fnName];

    for (const [label, input] of Object.entries(testCases)) {
      // Closure to avoid re-binding on each loop
      const fn = (): boolean => validator(input, opts);
      byCase[label] = measure(fn, ITERATIONS);
    }

    byProduction[fnName] = byCase;
  }

  results[configKey] = byProduction;
}

// ----------------------------------------------------------------------------
// Print results
// ----------------------------------------------------------------------------

console.log('\n=== xml-naming performance (ops/sec) ===');
console.log(`(iterations per measurement: ${ITERATIONS.toLocaleString()})\n`);

// Build a table with columns: config, function, case, ops/sec
const rows: Row[] = [];

for (const [configKey, configResults] of Object.entries(results)) {
  for (const [fnName, fnResults] of Object.entries(configResults)) {
    for (const [label, stats] of Object.entries(fnResults)) {
      rows.push({ config: configKey, fn: fnName, case: label, opsPerSec: stats.opsPerSec });
    }
  }
}

// Sort: config → function → case
rows.sort((a, b) => a.config.localeCompare(b.config) || a.fn.localeCompare(b.fn) || a.case.localeCompare(b.case));

// Print as a table (simple alignment)
const colWidths = { config: 20, fn: 10, case: 25, ops: 14 };

const header = `| ${'Configuration'.padEnd(colWidths.config)} | ${'Function'.padEnd(colWidths.fn)} | ${'Input case'.padEnd(colWidths.case)} | ${'ops/sec'.padEnd(colWidths.ops)} |`;
console.log(header);
console.log('-'.repeat(header.length));

for (const row of rows) {
  const line =
    `| ${row.config.padEnd(colWidths.config)} ` +
    `| ${row.fn.padEnd(colWidths.fn)} ` +
    `| ${row.case.padEnd(colWidths.case)} ` +
    `| ${row.opsPerSec.toFixed(0).padEnd(colWidths.ops)} |`;
  console.log(line);
}
