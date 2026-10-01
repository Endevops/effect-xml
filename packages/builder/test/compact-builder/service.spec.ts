/**
 * @description Specs for the {@link CompactBuilderFactory} service surface — the two ways in (`make` and `layer`) and the failure each reports. The shape rules
 * themselves are covered by the per-shape specs; what is under test here is that the factory is a service whose per-document builders are produced in
 * an effect, that the layer provides it to a program, and that a bad configuration fails at construction rather than at first use.
 */

import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import { CompactBuilderFactory } from '#/index.ts';

describe('CompactBuilderFactory service — make', () => {
  it.effect('produces a factory that hands out a builder per document', () =>
    Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory.make();
      const builder = yield* factory.getInstance({}, null);
      expect(typeof builder.addElement).toBe('function');
      expect(typeof builder.closeElement).toBe('function');
    })
  );

  it.effect('fails at construction for an empty alwaysArray pattern', () =>
    Effect.gen(function* () {
      const result = yield* CompactBuilderFactory.make({ alwaysArray: [''] }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.reason._tag).toBe('InvalidOptionEntry');
    })
  );
});

describe('CompactBuilderFactory service — layer', () => {
  it.effect('provides the service to a program that yields it', () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const factory = yield* CompactBuilderFactory;
        return yield* factory.getInstance({}, null);
      });

      const builder = yield* Effect.provide(program, CompactBuilderFactory.layer());
      expect(typeof builder.addElement).toBe('function');
    })
  );

  it.effect('fails while building the layer for a bad configuration', () =>
    Effect.gen(function* () {
      const layer = CompactBuilderFactory.layer({ alwaysArray: [''] });
      const result = yield* Effect.provide(Effect.asVoid(CompactBuilderFactory), layer).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.reason._tag).toBe('InvalidOptionEntry');
    })
  );
});
