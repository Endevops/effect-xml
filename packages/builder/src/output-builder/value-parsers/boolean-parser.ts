import { Effect } from 'effect';

import type { BuilderError } from '#/errors.ts';
import type { ValueParser } from '#/output-builder/value-parser.ts';

import { finalValue } from '#/output-builder/value-parser.ts';

/**
 * @description Turns the strings `"true"` and `"false"` into booleans, case-insensitively. Anything not on either list passes through untouched, so a chain that
 * runs this before a number parser cannot turn `"0"` into `false`.
 *
 * @param trueList - Values to read as `true`. Defaults to `['true']`.
 * @param falseList - Values to read as `false`. Defaults to `['false']`.
 * @param isFinal - Whether a match ends the chain. Defaults to false.
 *
 * @returns The parser.
 */
export const makeBooleanParser = (trueList?: Array<string>, falseList?: Array<string>, isFinal = false): ValueParser => {
  const trues = trueList || ['true'];
  const falses = falseList || ['false'];

  return {
    /**
     * @description Stateless, but the registry requires a `reset` so a parser holding state can be cleared between documents.
     */
    reset(): void {},
    /**
     * @description Convert a recognised word to a boolean.
     *
     * @param val - The value.
     *
     * @returns The boolean for a recognised word, otherwise `val` unchanged.
     */
    parse(val: unknown): Effect.Effect<unknown, BuilderError> {
      if (typeof val === 'string') {
        const temp = val.toLowerCase();
        if (trues.includes(temp)) return Effect.succeed(isFinal ? finalValue(true) : true);
        if (falses.includes(temp)) return Effect.succeed(isFinal ? finalValue(false) : false);
      }
      return Effect.succeed(val);
    },
  };
};
