import { FinalValue } from '../value-parser.ts';
import BaseValueParser from './base-value-parser.ts';

/**
 * @description Turns the strings `"true"` and `"false"` into booleans, case-insensitively. Anything not on either list passes through untouched, so a chain that
 * runs this before a number parser cannot turn `"0"` into `false`.
 */
export default class BooleanParser extends BaseValueParser {
  /**
   * @description Values recognised as `true`, compared lowercased.
   */
  readonly trueList: string[];
  /**
   * @description Values recognised as `false`, compared lowercased.
   */
  readonly falseList: string[];

  /**
   * @description Create the parser.
   *
   * @param trueList - Values to read as `true`. Defaults to `['true']`.
   * @param falseList - Values to read as `false`. Defaults to `['false']`.
   * @param isFinal - Whether a match ends the chain. Defaults to false.
   */
  constructor(trueList?: string[], falseList?: string[], isFinal = false) {
    super(isFinal);
    this.trueList = trueList || ['true'];
    this.falseList = falseList || ['false'];
  }

  /**
   * @description Convert a recognised word to a boolean.
   *
   * @param val - The value.
   *
   * @returns The boolean for a recognised word, otherwise `val` unchanged.
   */
  override parse(val: unknown): unknown {
    if (typeof val === 'string') {
      const temp = val.toLowerCase();
      if (this.trueList.includes(temp)) return this.IS_FINAL ? new FinalValue(true) : true;
      if (this.falseList.includes(temp)) return this.IS_FINAL ? new FinalValue(false) : false;
    }
    return val;
  }
}
