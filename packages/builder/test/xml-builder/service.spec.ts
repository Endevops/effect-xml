/**
 * @description Specs for the {@link XMLBuilder} service surface — the two ways in (`make` and `layer`) and the failure each reports. The build behaviour itself is
 * covered by the per-shape specs; what is under test here is that construction is an effect with a typed error channel, that the layer provides the
 * service to a program, and that a bad configuration fails at construction rather than at first use.
 */

import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import { XMLBuilder } from '#/index.ts';

describe('XMLBuilder service — make', () => {
  it.effect('produces a builder whose build walks an object to XML', () =>
    Effect.gen(function* () {
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false });
      expect(yield* builder.build({ a: { '@_id': '1', '#text': 'hello' } })).toBe('<a id="1">hello</a>');
    })
  );

  it.effect('defaults the options, so `make()` is valid', () =>
    Effect.gen(function* () {
      const builder = yield* XMLBuilder.make();
      expect(yield* builder.build({ a: 'hello' })).toBe('<a>hello</a>');
    })
  );

  it.effect('fails at construction for a stop-node pattern that will not compile', () =>
    Effect.gen(function* () {
      const result = yield* XMLBuilder.make({ stopNodes: ['::user'] }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.reason._tag).toBe('PatternCompilationFailed');
    })
  );
});

describe('XMLBuilder service — layer', () => {
  it.effect('provides the service to a program that yields it', () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const builder = yield* XMLBuilder;
        return yield* builder.build({ a: { '@_id': '1', '#text': 'hello' } });
      });

      const xml = yield* Effect.provide(program, XMLBuilder.layer({ ignoreAttributes: false }));
      expect(xml).toBe('<a id="1">hello</a>');
    })
  );

  it.effect('fails while building the layer for a bad configuration', () =>
    Effect.gen(function* () {
      const layer = XMLBuilder.layer({ stopNodes: ['::user'] });
      const result = yield* Effect.provide(Effect.asVoid(XMLBuilder), layer).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.reason._tag).toBe('PatternCompilationFailed');
    })
  );
});
