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
  // A value can only be a keyword if it has one of the keywords' lengths, and lengths are few. Checking
  // the length first means a long text run never pays for `toLowerCase` — the default lists are
  // four and five characters, so almost every string in a document is rejected here.
  const keywordLengths = new Set<number>();
  for (const keyword of trues) keywordLengths.add(keyword.length);
  for (const keyword of falses) keywordLengths.add(keyword.length);

  const convert = (val: unknown): unknown => {
    if (typeof val === 'string' && keywordLengths.has(val.length)) {
      const temp = val.toLowerCase();
      if (trues.includes(temp)) return isFinal ? finalValue(true) : true;
      if (falses.includes(temp)) return isFinal ? finalValue(false) : false;
    }
    return val;
  };

  return {
    /**
     * @description Stateless, but the registry requires a `reset` so a parser holding state can be cleared between documents.
     */
    reset(): void {},
    /**
     * @description The synchronous spelling the pipeline runs when the whole chain is pure.
     */
    parseSync: convert,
    /**
     * @description Convert a recognised word to a boolean.
     *
     * @param val - The value.
     *
     * @returns The boolean for a recognised word, otherwise `val` unchanged.
     */
    parse(val: unknown): Effect.Effect<unknown, BuilderError> {
      return Effect.succeed(convert(val));
    },
  };
};
