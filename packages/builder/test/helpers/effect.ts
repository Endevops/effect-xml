/**
 * @description Bridges between this package's `Effect` API and the synchronous style the specs are written in. Every fallible operation in the library returns an
 * `Effect`, so a spec asserting on a successful result has to run that effect, and a spec asserting on a failure has to read the error out of the
 * exit. Doing either inline, at every call site, would bury the assertions. These helpers keep each call site down to the one line that is actually
 * about the behaviour under test. Four shapes, and the choice between them is the interesting part:
 *
 * - {@link run} for a call that must succeed. A failure there is a bug in the library or the test rather than an expected outcome, so it throws
 *   carrying the error's own reason and message instead of reporting a vague mismatch.
 * - {@link failed} for a call that must fail, returning the {@link BuilderError} so the spec can assert on `reason` and `message`.
 * - {@link failedWith} for the same, asserting the specific reason tag — the `catchReason`-shaped assertion, so a spec reads as "this fails because the
 *   set is sealed" rather than as a repeated manual `_tag` comparison.
 * - {@link failureMessage} for a spec that collected messages once and now wants to compare a whole string. The two `make` factories —
 *   {@link makeBuilder} and {@link makeFactory} — exist because construction is where a builder compiles caller-supplied patterns, so `new
 *   XMLBuilder(...)` is no longer how one is built.
 */

import type { XmlError } from '@endevops/common-xml';

import { Effect, Exit, Option } from 'effect';
import { expect } from 'vite-plus/test';

import type { FactoryOptions } from '#/compact-builder/options.ts';
import type { BuilderError, BuilderErrorReason } from '#/errors.ts';
import type { XmlBuilderOptions } from '#/xml-builder/options.ts';
import type { XmlBuilder } from '#/xml-builder/xml-builder.ts';

import { CompactBuilderFactory } from '#/compact-builder/compact-builder.ts';
import { XMLBuilder } from '#/xml-builder/xml-builder.ts';

/**
 * @description The `BuilderError` inside a failed exit.
 *
 * @param exit - A failed exit, as `Effect.runSyncExit` produces.
 *
 * @returns The error, narrowed to `BuilderError` after asserting it really is one.
 *
 * @throws {Error} If the exit carried a defect rather than a typed failure. That distinction is the whole reason this package has an error channel: a
 *   defect means something threw where it should have failed, and the assertion says so rather than letting the spec pass on a value of the wrong
 *   shape.
 */
function errorOf(exit: Exit.Exit<unknown, BuilderError>): BuilderError {
  expect(Exit.hasDies(exit), 'expected a typed failure in the error channel, but the effect died').toBe(false);

  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  expect(error, 'expected a BuilderError in the error channel').toBeDefined();
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
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 */
export function run<A>(effect: Effect.Effect<A, BuilderError>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const error = errorOf(exit);
  throw new Error(`Expected success, got ${error.reason._tag}: ${error.message}`);
}

/**
 * @description Run an effect that is expected to fail, and return the {@link BuilderError} for the spec to assert on.
 *
 * @param effect - The effect to run.
 *
 * @returns The error, so a spec can narrow `reason` and compare `message`.
 */
export function failed(effect: Effect.Effect<unknown, BuilderError>): BuilderError {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) return errorOf(exit);

  throw new Error(`Expected a failure, but the effect succeeded with ${JSON.stringify(exit.value)}`);
}

/**
 * @description Assert that an effect fails for one specific {@link BuilderError} reason, and return the error.
 *
 * @param effect - The effect to run.
 * @param tag - The reason tag the failure must carry.
 *
 * @returns The error, for any further assertions on its payload.
 */
export function failedWith<A>(effect: Effect.Effect<A, BuilderError>, tag: BuilderErrorReason['_tag']): BuilderError {
  const error = failed(effect);
  expect(error.reason._tag, `expected the reason ${tag}`).toBe(tag);
  return error;
}

/**
 * @description Build an {@link XMLBuilder} synchronously. Construction compiles the caller's stop-node patterns, so it is a factory returning an effect. A spec
 * that configures a builder wants the builder, not the failure mode, so the failure is surfaced as a thrown message.
 *
 * @param options - The builder's options.
 *
 * @returns The builder.
 */
export function makeBuilder(options?: XmlBuilderOptions): XmlBuilder {
  return run(XMLBuilder.make(options));
}

/**
 * @description Build a {@link CompactBuilderFactory} synchronously, for the same reason as {@link makeBuilder}.
 *
 * @param options - The factory's options.
 *
 * @returns The factory.
 */
export function makeFactory(options: FactoryOptions = {}): CompactBuilderFactory {
  return run(CompactBuilderFactory.make(options));
}

/**
 * @description Run an effect from `common-xml`, whose error channel is `XmlError` rather than this package's `BuilderError`. The specs drive the matcher directly
 * — pushing onto one, reading a depth, asking for a read-only view — and every one of those is a `common-xml` effect. `run` is typed for this
 * package's channel and does not apply to them, so this is the runner for the other one.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {Error} If the effect fails. Its message is the `common-xml` one, which is what a matcher
 * failure says.
 */
export function runXml<A>(effect: Effect.Effect<A, XmlError>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  throw new Error(error === undefined ? 'the effect died rather than failing' : error.message);
}

/**
 * @description Run an effect from either package. The specs' document walks drive both — a builder method and the matcher's own — so the walk's channel is the
 * union of the two, and neither {@link run} nor {@link runXml} is typed for it. This is, and the message names which package reported so a failure says
 * where it came from.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 */
export function runAny<A>(effect: Effect.Effect<A, BuilderError | XmlError>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  if (error === undefined) {
    expect(Exit.hasDies(exit), 'expected a typed failure, but the effect died').toBe(false);
    throw new Error('the effect died rather than failing');
  }
  throw new Error(`Expected success, got ${error.reason._tag}: ${error.message}`);
}
