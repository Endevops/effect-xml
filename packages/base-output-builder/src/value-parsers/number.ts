import type { ToNumberOptions } from './to-number.ts';

import { FinalValue } from '../value-parser.ts';
import BaseValueParser from './base-value-parser.ts';
import toNumber from './to-number.ts';

/**
 * @description The options {@link NumberValueParser} accepts. Everything {@link toNumber} takes, passed through untouched.
 */
export type NumberParserOptions = ToNumberOptions;

/**
 * @description Converts numeric strings to numbers. Which strings count as numbers is {@link toNumber}'s decision, not this class's. `"0x1f"`, `"1e3"` and `"007"`
 * are numbers or not according to the options given, and a value that does not convert comes back as the original string rather than as `NaN`. That
 * return shape is what makes the parser safe to leave in a chain unconditionally: a caller tells "this was a number" from "this was text" by the
 * type, without checking whether this parser was the one that converted anything.
 */
export default class NumberValueParser extends BaseValueParser {
  /**
   * @description The conversion options in force.
   */
  readonly options: NumberParserOptions;

  /**
   * @description Create the parser.
   *
   * @param options - Which numeric forms to accept. See {@link ToNumberOptions}.
   * @param isFinal - Whether a conversion ends the chain. Defaults to false.
   */
  constructor(options?: NumberParserOptions, isFinal = false) {
    super(isFinal);
    this.options = options ?? {};
  }

  /**
   * @description Convert a numeric string.
   *
   * @param val - The value. A non-string is returned untouched, so a boolean that reached this parser in a chain is not mangled.
   *
   * @returns The number when the value converted, otherwise `val` unchanged.
   */
  override parse(val: unknown): unknown {
    if (typeof val === 'string') {
      const converted = toNumber(val, this.options);
      // `typeof` yields a type name, which never equals the value, so this is
      // always true — the original author's intent was plainly "did it change",
      // and the non-string return from toNumber is what makes the guard work.
      // Preserved as-is: with IS_FINAL set, this parser ends the chain even for
      // input it did not convert, and the specs assert that so it reads as a
      // decision rather than an accident.
      if (typeof converted !== val) {
        return this.IS_FINAL ? new FinalValue(converted) : converted;
      }
    }
    return val;
  }
}
