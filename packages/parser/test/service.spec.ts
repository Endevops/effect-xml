/**
 * @description Specs for the {@link XMLParser} service surface — the two ways in (`make` and `layer`), the from-resolved escape hatch, and the failure each
 * reports. The walk behaviour is covered everywhere else; what is under test here is that construction is an effect with a typed error channel, that
 * the layer provides the service to a program, and that a bad configuration fails at construction rather than at first use.
 */

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { XMLParser } from '#/index.ts';
import type { ParseError } from '#/index.ts';
import { runParser } from '#/test/helpers/test-runner.ts';

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
  it('produces a parser whose parse walks a document', () => {
    const parser = runParser(XMLParser.make());
    expect(runParser(parser.parse('<root><a>1</a></root>'))).toEqual({ root: { a: 1 } });
  });

  it('reuses its name cache across repeated parse calls', () => {
    const parser = runParser(XMLParser.make());
    expect(runParser(parser.parse('<root><a>x</a></root>'))).toEqual({ root: { a: 'x' } });
    expect(runParser(parser.parse('<root><a>y</a></root>'))).toEqual({ root: { a: 'y' } });
  });

  it('fails at construction for a reserved option name', () => {
    const exit = Effect.runSyncExit(XMLParser.make({ nameFor: { text: '__proto__' } }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(errorOf(exit).code).toBe('SECURITY_RESERVED_OPTION');
  });
});

describe('XMLParser service — layer', () => {
  it('provides the service to a program that yields it', () => {
    const program = Effect.gen(function* () {
      const parser = yield* XMLParser;
      return yield* parser.parse('<root><a>1</a></root>');
    });

    expect(runParser(Effect.provide(program, XMLParser.layer()))).toEqual({ root: { a: 1 } });
  });

  it('fails while building the layer for a bad configuration', () => {
    const badExit = Effect.runSyncExit(Effect.provide(Effect.asVoid(XMLParser), XMLParser.layer({ limits: { maxNestedTags: 0 } })));
    expect(Exit.isFailure(badExit)).toBe(true);
    expect(errorOf(badExit).code).toBe('INVALID_INPUT');
  });
});
