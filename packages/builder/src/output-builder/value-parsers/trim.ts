import { Effect } from 'effect';

import type { BuilderError } from '#/errors.ts';
import type { ValueParser } from '#/output-builder/value-parser.ts';

/**
 * @description Trims leading and trailing whitespace from string values. Superseded by the whitespace normalizer, which also collapses internal runs, and kept
 * because existing chains name it.
 *
 * @returns The parser.
 */
export const makeTrim = (): ValueParser => ({
  /**
   * @description Stateless, but the registry requires a `reset` so a parser holding state can be cleared between documents.
   */
  reset(): void {},
  /**
   * @description Trim a string.
   *
   * @param val - The value.
   *
   * @returns The trimmed string, or `val` unchanged if it is not a string.
   */
  parse(val: unknown): Effect.Effect<unknown, BuilderError> {
    if (typeof val === 'string') return Effect.succeed(val.trim());
    return Effect.succeed(val);
  },
});
