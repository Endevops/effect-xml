/**
 * @description Measures the cost of the value chain a parse runs for each attribute value and each text node. The chain is `['entity', 'boolean', 'number']` for
 * attributes and `['ws', 'entity', 'boolean', 'number']` for element text, and three of its four parsers do nothing to a value that is not their
 * shape. The rows below separate the two questions that decides a change to it: what a whole token costs as it arrives, and what the `number` step
 * costs on its own for the token shapes a document actually produces. The point of the per-parser rows is that the chain rejects almost everything.
 * In a 500-row document the values are identifiers like `R-123` and `SKU-123`, labels like `Product number 123`, and small numbers like `0` and
 * `1.5`. Only the last of those is a number, so the `number` parser runs over two text-shaped values for every numeric one, at ~140ns when it cannot
 * reject.
 */

import { Effect } from 'effect';
import { afterAll, expect, test } from 'vite-plus/test';

import { makeValueParserPipeline, makeValueParserRegistry } from '#/output-builder/index.ts';

/**
 * @description How to sample each suite. Each iteration is a whole pass over the value list, several microseconds of work, so a 1000ms window collects tens of
 * thousands of samples and the run stays short.
 */
const BUDGET = { time: 1000, warmupTime: 50 } as const;

/**
 * @description The token shapes a document produces, which are the ones the chain has to reject. Attributes first, then element text.
 */
const TOKENS = ['R-123', 'SKU-1', 'Product number 123', '0', '1.5', 'cat-7', 'Ada Lovelace', 'A-1001', 'EUR', 'deliver after 5pm'] as const;

/**
 * @description The values the `number` parser alone is handed, in the same shapes as {@link TOKENS} plus a couple that are genuinely numeric.
 */
const NUMBER_INPUTS = ['R-123', 'SKU-1', 'Product number 123', 'cat-7', 'Ada Lovelace', 'EUR', '0', '1.5', '1234.56'] as const;

/**
 * @description Accumulates a property of every value the rows produce, so the work is observable and cannot be optimised away.
 */
let observed = 0;

afterAll(() => {
  expect(observed).toBeGreaterThan(0);
});

const attributeRegistry = makeValueParserRegistry();
const attributePipeline = makeValueParserPipeline(['entity', 'boolean', 'number'], attributeRegistry);

const textRegistry = makeValueParserRegistry();
const textPipeline = makeValueParserPipeline(['ws', 'entity', 'boolean', 'number'], textRegistry);

const run = <A>(effect: Effect.Effect<A, unknown>): A => Effect.runSync(effect);

test('value chain — attributes and text over a document token mix', async ({ bench }) => {
  await bench(`entity,boolean,number + ws [${TOKENS.length} values]`, () => {
    let sink = 0;
    for (let i = 0; i < TOKENS.length; i++) {
      const attribute = run(attributePipeline.run(TOKENS[i]));
      const text = run(textPipeline.run(TOKENS[i]));
      sink += typeof attribute === 'number' ? attribute : 1;
      sink += typeof text === 'number' ? text : 1;
    }
    observed += sink;
  }).run(BUDGET);
});

test('number parser alone — over the same token mix', async ({ bench }) => {
  const number = attributeRegistry.registered.number;
  await bench(`${NUMBER_INPUTS.length} values`, () => {
    let sink = 0;
    for (let i = 0; i < NUMBER_INPUTS.length; i++) {
      const result = run(number.parse(NUMBER_INPUTS[i]));
      sink += typeof result === 'number' ? result : 1;
    }
    observed += sink;
  }).run(BUDGET);
});
