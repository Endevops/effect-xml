import type { StrnumOptions } from 'strnum';

// `strnum` is ESM but exposes its converter as the module's *default* export,
// with no named export at all. A named import here type-checks against the
// declaration below and then fails at load with "does not provide an export
// named 'toNumber'".
import toNumber from 'strnum';

import { FinalValue } from '../value-parser.ts';
import BaseValueParser from './base-value-parser.ts';

/**
 * @description The options `strnum` accepts. Passed through untouched, so `strnum`'s own documentation is the reference.
 */
export type NumberParserOptions = StrnumOptions;

/**
 * @description Converts numeric strings to numbers via `strnum`. Which strings count as numbers is entirely `strnum`'s decision — `"0x1f"`, `"1e3"` and `"007"`
 * are all numbers or not according to the options given. A value that does not convert comes back unchanged, so the parser is safe to leave in a
 * chain unconditionally.
 */
export default class NumberValueParser extends BaseValueParser {
  /**
   * @description The `strnum` options in force.
   */
  readonly options: NumberParserOptions;

  /**
   * @description Create the parser.
   *
   * @param options - `strnum` options, e.g. `{ hex: true, leadingZeros: true, eNotation: true }`. Defaults to none.
   * @param isFinal - Whether a conversion ends the chain. Defaults to false.
   */
  constructor(options?: NumberParserOptions, isFinal = false) {
    super(isFinal);
    this.options = options ?? {};
  }

  /**
   * @description Convert a numeric string.
   *
   * @param val - The value.
   *
   * @returns The number when `strnum` converted it, otherwise `val` unchanged.
   */
  override parse(val: unknown): unknown {
    if (typeof val === 'string') {
      const newval = toNumber(val, this.options);
      // `typeof` yields a type name, which never equals the value, so this is
      // always true — the original author's intent was plainly "did it change",
      // and the non-string return from strnum is what makes the guard work.
      if (typeof newval !== val) {
        return this.IS_FINAL ? new FinalValue(newval) : newval;
      }
    }
    return val;
  }
}
