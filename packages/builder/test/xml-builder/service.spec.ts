/**
 * @description Specs for the {@link XMLBuilder} service surface — the two ways in (`make` and `layer`) and the failure each reports. The build behaviour itself is
 * covered by the per-shape specs; what is under test here is that construction is an effect with a typed error channel, that the layer provides the
 * service to a program, and that a bad configuration fails at construction rather than at first use.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { XMLBuilder } from '#/index.ts';
import { failedWith, run } from '#/test/helpers/effect.ts';

describe('XMLBuilder service — make', () => {
  it('produces a builder whose build walks an object to XML', () => {
    const builder = run(XMLBuilder.make({ ignoreAttributes: false }));
    expect(run(builder.build({ a: { '@_id': '1', '#text': 'hello' } }))).toBe('<a id="1">hello</a>');
  });

  it('defaults the options, so `make()` is valid', () => {
    const builder = run(XMLBuilder.make());
    expect(run(builder.build({ a: 'hello' }))).toBe('<a>hello</a>');
  });

  it('fails at construction for a stop-node pattern that will not compile', () => {
    const error = failedWith(XMLBuilder.make({ stopNodes: ['::user'] }), 'PatternCompilationFailed');
    expect(error.reason._tag).toBe('PatternCompilationFailed');
  });
});

describe('XMLBuilder service — layer', () => {
  it('provides the service to a program that yields it', () => {
    const program = Effect.gen(function* () {
      const builder = yield* XMLBuilder;
      return yield* builder.build({ a: { '@_id': '1', '#text': 'hello' } });
    });

    const xml = run(Effect.provide(program, XMLBuilder.layer({ ignoreAttributes: false })));
    expect(xml).toBe('<a id="1">hello</a>');
  });

  it('fails while building the layer for a bad configuration', () => {
    const layer = XMLBuilder.layer({ stopNodes: ['::user'] });
    const error = failedWith(Effect.provide(Effect.asVoid(XMLBuilder), layer), 'PatternCompilationFailed');
    expect(error.reason._tag).toBe('PatternCompilationFailed');
  });
});
