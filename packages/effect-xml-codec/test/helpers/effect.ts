/**
 * @description Bridges between this package's `Effect` API and the synchronous style the specs are written in. `resolveName` and `isValidName` are the codec's two
 * entry points into the naming package, and both of those are effects now, so both are. A spec asserting on a name still wants the name, and a spec
 * asserting on a refusal still wants the reason — so the two shapes below are the whole surface. The two runners differ only in which error type they
 * can accept, and a spec that is asserting on a success has no reason to care: a failure there is a bug in the library or the test, and it throws
 * carrying the message rather than reporting a mismatch between two objects.
 */

import type { XmlError } from '@endevops/common-xml';

import { Effect, Exit, Option } from 'effect';
import { expect } from 'vite-plus/test';

import { XmlParseError } from '#/errors.ts';

/**
 * @description Run a `common-xml` effect.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {Error} If the effect fails.
 */
export function runXml<A>(effect: Effect.Effect<A, XmlError>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  throw new Error(error === undefined ? 'the effect died rather than failing' : error.message);
}

/**
 * @description Run a codec effect, returning the value.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {Error} If the effect fails, carrying the message. A spec asserting on success has no other outcome in mind, and the message is what it
 *   would have wanted to see.
 */
export function run<A>(effect: Effect.Effect<A, XmlParseError>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  expect(Exit.hasDies(exit), 'expected a typed failure in the error channel, but the effect died').toBe(false);
  throw new Error(error === undefined ? 'the effect died rather than failing' : error.message);
}

/**
 * @description The message a codec effect failed with, or a marker if it succeeded. For the specs that collect failure messages once and then assert on several
 * properties of them.
 *
 * @param effect - The effect to run.
 *
 * @returns The failure's message, or a marker naming the success.
 */
export function failureMessage(effect: Effect.Effect<unknown, XmlParseError>): string {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) {
    const error = Option.getOrUndefined(Exit.findErrorOption(exit));
    return error === undefined ? '(the effect died)' : error.message;
  }
  return '(nothing failed)';
}
