/**
 * @description Specs for the {@link XMLParser} service surface — the two ways in (`make` and `layer`), the from-resolved escape hatch, and the failure each
 * reports. The walk behaviour is covered everywhere else; what is under test here is that construction is an effect with a typed error channel, that
 * the layer provides the service to a program, and that a bad configuration fails at construction rather than at first use.
 */

import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Result } from 'effect';

import type { ParseError } from '#/parse-error.ts';

import { XMLParser } from '#/index.ts';
import { buildOptions } from '#/options-builder.ts';

/**
 * @description The `ParseError` inside a failed exit, so a spec can assert on its reason.
 *
 * @param exit - A failed exit.
 *
 * @returns The error.
 */
function errorOf(exit: Exit.Exit<unknown, ParseError>): ParseError {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  if (error === undefined) throw new Error('expected a typed failure in the error channel');
  return error;
}

describe('XMLParser service — make', () => {
  it.effect('produces a parser whose parse walks a document', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      expect(yield* parser.parse('<root><a>1</a></root>')).toEqual({ root: { a: 1 } });
    })
  );

  it.effect('reuses its name cache across repeated parse calls', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      expect(yield* parser.parse('<root><a>x</a></root>')).toEqual({ root: { a: 'x' } });
      expect(yield* parser.parse('<root><a>y</a></root>')).toEqual({ root: { a: 'y' } });
    })
  );

  it.effect('fails at construction for a reserved option name', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(XMLParser.make({ nameFor: { text: '__proto__' } }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(errorOf(exit).code).toBe('SECURITY_RESERVED_OPTION');
    })
  );
});

describe('XMLParser service — layer', () => {
  it.effect('provides the service to a program that yields it', () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const parser = yield* XMLParser;
        return yield* parser.parse('<root><a>1</a></root>');
      });

      const result = yield* Effect.provide(program, XMLParser.layer()).pipe(Effect.result);
      assert(Result.isSuccess(result));
      expect(result.success).toEqual({ root: { a: 1 } });
    })
  );

  it.effect('fails while building the layer for a bad configuration', () =>
    Effect.gen(function* () {
      const badExit = yield* Effect.exit(Effect.provide(Effect.asVoid(XMLParser), XMLParser.layer({ limits: { maxNestedTags: 0 } })));
      expect(Exit.isFailure(badExit)).toBe(true);
      expect(errorOf(badExit).code).toBe('INVALID_INPUT');
    })
  );
});

describe('XMLParser service — fromResolved escape hatch', () => {
  it.effect('builds a parser straight from already-resolved options', () =>
    Effect.gen(function* () {
      // A caller cannot resolve by hand — resolving is where the security checks,
      // the defaults and the expression compilation live — so the escape hatch
      // takes `buildOptions`'s output, the same shape `XMLParser.make` feeds it.
      const resolved = yield* buildOptions();
      const parser = XMLParser.fromResolved(resolved);
      expect(yield* parser.parse('<root><a>1</a></root>')).toEqual({ root: { a: 1 } });
    })
  );
});
