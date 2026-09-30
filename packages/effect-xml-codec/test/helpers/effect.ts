/**
 * @description Bridges between this package's `Effect` API and the synchronous style the specs are written in. Every codec entry point is an effect, so a spec
 * asserting on a successful value has to run it first. A failure there is a bug in the library or the test rather than an expected outcome, so the
 * runner throws carrying the message instead of reporting a mismatch between two objects.
 */

import { Effect, Exit, Option } from 'effect';
import { expect } from 'vite-plus/test';

import type { XmlParseError } from '#/errors.ts';

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
