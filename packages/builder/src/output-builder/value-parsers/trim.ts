import { Effect } from 'effect';

import type { BuilderError } from '../../errors.ts';

import BaseValueParser from './base-value-parser.ts';

/**
 * @description Trims leading and trailing whitespace from string values. Superseded by {@link WSNormalizer}, which also collapses internal runs, and kept because
 * existing chains name it.
 */
export default class Trim extends BaseValueParser {
  /**
   * @description Trim a string.
   *
   * @param val - The value.
   *
   * @returns The trimmed string, or `val` unchanged if it is not a string.
   */
  override parse(val: unknown): Effect.Effect<unknown, BuilderError> {
    if (typeof val === 'string') return Effect.succeed(val.trim());
    return Effect.succeed(val);
  }
}
