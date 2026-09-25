/**
 * @description Throughput benchmark for the whole-shot and chunked parse paths. Not a test — there are no assertions, only timings, so it lives outside the suite
 * and `vp test` does not pick it up. The document is generated rather than read from disk so the shape under measurement is fixed and the run is
 * reproducible. Executing it needs a TypeScript-aware runner: `src/` imports its own modules with `.js` specifiers (the right convention for emitted
 * output), which bare `node --experimental-strip-types` cannot resolve. There is no `package.json` script or `vite.config.ts` task for it — that gap
 * predates this typing work and is left visible rather than papered over with a runner-specific import rewrite that would stop matching `src/`.
 */

import type { X2jOptions } from '#/options.ts';

import XMLParser from '#/XMLParser.ts';

/**
 * @description Generate a catalog document with `n` items. The generated text is deliberately varied in length and includes attributes of several shapes, so the
 * benchmark exercises tag parsing, attribute parsing and value coercion rather than measuring a single hot loop in isolation.
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
 * @description Elapsed wall-clock milliseconds for `body`, in `nanoseconds` from `process.hrtime.bigint`.
 *
 * @param body - The measured work.
 *
 * @returns Elapsed time in milliseconds.
 */
function timeMs(body: () => void): number {
  const start = process.hrtime.bigint();
  body();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

const doc = buildDoc(20000);
console.log('doc size (chars):', doc.length);

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
 * @description Time repeated whole-document parses. Two warmup iterations run first so JIT tiering has happened before the clock starts; without them the first
 * measured parse pays compilation cost that no real workload would.
 *
 * @param label - Name printed with the result.
 * @param iterations - How many timed parses to average over.
 */
function run(label: string, iterations: number): void {
  for (let i = 0; i < 2; i++) {
    new XMLParser(options).parse(doc);
  }
  const ms = timeMs(() => {
    for (let i = 0; i < iterations; i++) {
      new XMLParser(options).parse(doc);
    }
  });
  console.log(`${label}: ${iterations} iterations, total ${ms.toFixed(1)}ms, avg ${(ms / iterations).toFixed(2)}ms/parse`);
}

run('parse()', 15);

/**
 * @description Time repeated chunked parses, to compare the `feed()`/`end()` path against the whole-shot one. Chunk size matters: a very small chunk makes nearly
 * every token straddle a boundary and measures the mark/rewind path, while a large chunk approaches the whole-shot path.
 *
 * @param label - Name printed with the result.
 * @param iterations - How many timed parses to average over.
 * @param chunkSize - Characters handed to each `feed()` call.
 */
function runFeed(label: string, iterations: number, chunkSize: number): void {
  const once = (): void => {
    const p = new XMLParser(options);
    for (let off = 0; off < doc.length; off += chunkSize) p.feed(doc.slice(off, off + chunkSize));
    p.end();
  };

  for (let i = 0; i < 2; i++) once();

  const ms = timeMs(() => {
    for (let i = 0; i < iterations; i++) once();
  });
  console.log(`${label}: ${iterations} iterations, chunk=${chunkSize}, total ${ms.toFixed(1)}ms, avg ${(ms / iterations).toFixed(2)}ms/parse`);
}

runFeed('feed()/end() 4KB chunks', 10, 4096);
