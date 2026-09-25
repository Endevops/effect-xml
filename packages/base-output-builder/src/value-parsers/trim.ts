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
  override parse(val: unknown): unknown {
    if (typeof val === 'string') return val.trim();
    return val;
  }
}
