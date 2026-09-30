/**
 * @description Specs for the {@link CompactBuilderFactory} service surface — the two ways in (`make` and `layer`) and the failure each reports. The shape rules
 * themselves are covered by the per-shape specs; what is under test here is that the factory is a service whose per-document builders are produced in
 * an effect, that the layer provides it to a program, and that a bad configuration fails at construction rather than at first use.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { CompactBuilderFactory } from '#/index.ts';
import { failedWith, run } from '#/test/helpers/effect.ts';

describe('CompactBuilderFactory service — make', () => {
  it('produces a factory that hands out a builder per document', () => {
    const factory = run(CompactBuilderFactory.make());
    const builder = run(factory.getInstance({}, null));
    expect(typeof builder.addElement).toBe('function');
    expect(typeof builder.closeElement).toBe('function');
  });

  it('fails at construction for an empty alwaysArray pattern', () => {
    const error = failedWith(CompactBuilderFactory.make({ alwaysArray: [''] }), 'InvalidOptionEntry');
    expect(error.reason._tag).toBe('InvalidOptionEntry');
  });
});

describe('CompactBuilderFactory service — layer', () => {
  it('provides the service to a program that yields it', () => {
    const program = Effect.gen(function* () {
      const factory = yield* CompactBuilderFactory;
      return yield* factory.getInstance({}, null);
    });

    const builder = run(Effect.provide(program, CompactBuilderFactory.layer()));
    expect(typeof builder.addElement).toBe('function');
  });

  it('fails while building the layer for a bad configuration', () => {
    const layer = CompactBuilderFactory.layer({ alwaysArray: [''] });
    const error = failedWith(Effect.provide(Effect.asVoid(CompactBuilderFactory), layer), 'InvalidOptionEntry');
    expect(error.reason._tag).toBe('InvalidOptionEntry');
  });
});
