import { Effect } from 'effect';

import type { BuilderError } from '#/errors.ts';
import type { ValueParser } from '#/output-builder/value-parser.ts';

import { finalValue } from '#/output-builder/value-parser.ts';

import type { ToNumberOptions } from './to-number.ts';

import toNumber from './to-number.ts';

/**
 * @description The options the number parser accepts. Everything {@link toNumber} takes, passed through untouched.
 */
export type NumberParserOptions = ToNumberOptions;

/**
 * @description Converts numeric strings to numbers. Which strings count as numbers is {@link toNumber}'s decision, not this factory's. `"0x1f"`, `"1e3"` and
 * `"007"` are numbers or not according to the options given, and a value that does not convert comes back as the original string rather than as
 * `NaN`. That return shape is what makes the parser safe to leave in a chain unconditionally: a caller tells "this was a number" from "this was text"
 * by the type, without checking whether this parser was the one that converted anything.
 *
 * @param options - Which numeric forms to accept. See {@link ToNumberOptions}.
 * @param isFinal - Whether a conversion ends the chain. Defaults to false.
 *
 * @returns The parser.
 */
export const makeNumberValueParser = (options?: NumberParserOptions, isFinal = false): ValueParser => {
  const resolved = options ?? {};

  return {
    /**
     * @description Stateless, but the registry requires a `reset` so a parser holding state can be cleared between documents.
     */
    reset(): void {},
    /**
     * @description Convert a numeric string.
     *
     * @param val - The value. A non-string is returned untouched, so a boolean that reached this parser in a chain is not mangled.
     *
     * @returns The number when the value converted, otherwise `val` unchanged.
     */
    parse(val: unknown): Effect.Effect<unknown, BuilderError> {
      if (typeof val === 'string') {
        const converted = toNumber(val, resolved);
        // Preserved from the original: `typeof converted !== val` compares a
        // type name against a value and is therefore always true, so with the
        // final flag set this parser ends the chain even for input it did not
        // convert. The specs assert it, so it reads as a decision rather than
        // an accident.
        if (typeof converted !== val) {
          return Effect.succeed(isFinal ? finalValue(converted) : converted);
        }
      }
      return Effect.succeed(val);
    },
  };
};
