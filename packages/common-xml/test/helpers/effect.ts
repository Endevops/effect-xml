/**
 * @description Bridges between this package's `Effect` API and the synchronous style the specs are written in. Every fallible operation in the library returns an
 * `Effect`, so a spec asserting on a successful result has to run that effect, and a spec asserting on a failure has to read the error out of the
 * exit. Doing either inline, at four hundred call sites, would bury the assertions. These helpers keep each call site down to the one line that is
 * actually about the behaviour under test. Four shapes, and the choice between them is the interesting part:
 *
 * - {@link run} for a call that must succeed. A failure there is a bug in the library or the test rather than an expected outcome, so it throws
 *   carrying the error's own reason and message instead of reporting a vague mismatch.
 * - {@link failed} for a call that must fail, returning the {@link XmlError} so the spec can assert on `reason` and `message`.
 * - {@link failedWith} for the same, asserting the specific reason tag — the `catchReason`-shaped assertion, so a spec reads as "this fails because the
 *   set is sealed" rather than as a repeated manual `_tag` comparison.
 * - {@link expr} for building a valid {@link Expression}. Construction is `Expression.make`, which returns an effect, and in a matching test the
 *   pattern is fixed input rather than the thing under test. A spec that needs to check a bad pattern uses `failed(Expression.make(...))` directly,
 *   so the assertion stays about the error rather than about this module.
 */

import { Effect, Exit, Option } from 'effect';
import { expect } from 'vite-plus/test';

import type { XmlError, XmlErrorReason } from '#/errors.ts';
import type Expression from '#/path-matcher/expression.ts';
import type { ExpressionOptions } from '#/path-matcher/expression.ts';

import ExpressionClass from '#/path-matcher/expression.ts';

/**
 * @description Read the {@link XmlError} out of a failed exit.
 *
 * @param exit - A failed exit, as `Effect.runSyncExit` produces.
 *
 * @returns The error, narrowed to `XmlError` after asserting it really is one.
 *
 * @throws {Error} If the exit carried a defect rather than a typed failure. That distinction is the whole reason this package has an error channel: a
 *   defect here means something threw where it should have failed, and the assertion says so rather than letting the spec pass on a value of the
 *   wrong shape.
 */
function errorOf(exit: Exit.Exit<unknown, XmlError>): XmlError {
  expect(Exit.hasDies(exit), 'expected a typed failure in the error channel, but the effect died').toBe(false);

  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  expect(error, 'expected an XmlError in the error channel').toBeDefined();
  if (error === undefined) {
    // Unreachable past the assertion above, but the return type needs it and a
    // throw is the honest way to say so rather than a cast.
    throw new Error('unreachable: the error channel was empty');
  }
  return error;
}

/**
 * @description Run an effect that is expected to succeed, and return its value.
 *
 * @param effect - The effect to run. Its error type is constrained to {@link XmlError}, the only error this package reports.
 *
 * @returns The successful value.
 */
export function run<A>(effect: Effect.Effect<A, XmlError>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const error = errorOf(exit);
  throw new Error(`Expected success, got ${error.reason._tag}: ${error.message}`);
}

/**
 * @description Run an effect that is expected to fail, and return the {@link XmlError} for the spec to assert on.
 *
 * @param effect - The effect to run.
 *
 * @returns The error, so a spec can narrow `reason` and compare `message`.
 *
 * @throws {Error} If the effect succeeded, which is itself a test failure — and doing it here means the message names the call rather than surfacing
 *   as a confusing type error at the assertion.
 */
export function failed(effect: Effect.Effect<unknown, XmlError>): XmlError {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) return errorOf(exit);

  throw new Error(`Expected a failure, but the effect succeeded with ${JSON.stringify(exit.value)}`);
}

/**
 * @description Assert that an effect fails for one specific {@link XmlError} reason, and return the error.
 *
 * @param effect - The effect to run.
 * @param tag - The reason tag the failure must carry.
 *
 * @returns The error, for any further assertions on its payload.
 */
export function failedWith<A>(effect: Effect.Effect<A, XmlError>, tag: XmlErrorReason['_tag']): XmlError {
  const error = failed(effect);
  expect(error.reason._tag, `expected the InvalidPattern-style reason ${tag}`).toBe(tag);
  return error;
}

/**
 * @description The message an effect failed with, or a marker if it succeeded. For the specs that collect error messages once and then assert on several
 * properties of them — that a message carries a given prefix, names a given character — where reaching the message is not the thing under test.
 *
 * @param effect - The effect to run.
 *
 * @returns The `XmlError`'s `message`, or a marker naming the success, so a spec that expected a failure fails on a mismatched message rather than
 *   silently comparing `'undefined'`.
 */
export function failureMessage(effect: Effect.Effect<unknown, XmlError>): string {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) return errorOf(exit).message;
  return '(nothing thrown)';
}

/**
 * @description Build a valid {@link Expression} synchronously.
 *
 * @param pattern - The pattern string.
 * @param options - Expression options, as for `Expression.make`.
 * @param data - The opaque payload to carry.
 *
 * @returns The expression.
 */
export function expr<T = unknown>(pattern: string, options?: ExpressionOptions, data?: T): Expression<T> {
  return run(ExpressionClass.make<T>(pattern, options, data));
}
