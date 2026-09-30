import { Effect } from 'effect';

import type { BuilderError } from '../errors.ts';
import type { ValueParser, ValueParserRegistryLike } from './value-parser.ts';

import { BuilderError as BuilderErrorCtor } from '../errors.ts';
import { makeBooleanParser } from './value-parsers/boolean-parser.ts';
import { makeEntitiesValueParser } from './value-parsers/entity-parser.ts';
import { makeNumberValueParser } from './value-parsers/number.ts';
import { makeTrim } from './value-parsers/trim.ts';
import { wsNormalizerBuiltin } from './value-parsers/ws-normalizer.ts';

/**
 * @description The parsers available by name without registering anything, and the chain a builder gets when it configures nothing. Built once at module load and
 * shallow-copied per registry, so every registry starts from the same instances. That sharing is deliberate — it is what makes
 * `factory.registerValueParser('boolean', custom)` affect every builder the factory produces. A parser holding per-document state is reset by
 * {@link ValueParserRegistry.resetAll} before each parse, so sharing does not leak state between documents.
 */
export const defaultValParsers: Record<string, ValueParser> = {
  entity: makeEntitiesValueParser(),
  trim: makeTrim(),
  ws: wsNormalizerBuiltin(),
  boolean: makeBooleanParser(),
  number: makeNumberValueParser({ hex: true, leadingZeros: true, eNotation: true }),
};

/**
 * @description The named value parsers a builder's chain can reference, plus the mutations a factory makes between documents.
 */
export interface ValueParserRegistry extends ValueParserRegistryLike {
  /**
   * @description The parsers, by name. A shallow copy of the built-ins, so registering here does not affect any other registry.
   */
  readonly registered: Record<string, ValueParser>;
  /**
   * @description Reset one named parser.
   *
   * @param name - The parser to reset. An unregistered name is a no-op.
   */
  reset(name: string): void;
  /**
   * @description Reset every registered parser.
   */
  resetAll(): void;
}

/**
 * @description Create a registry, seeded with a shallow copy of the built-ins.
 *
 * @returns The registry.
 */
export const makeValueParserRegistry = (): ValueParserRegistry => {
  const registered: Record<string, ValueParser> = { ...defaultValParsers };

  return {
    registered,
    /**
     * @description Add or replace a named parser. Validation is deliberately strict — a parser missing `reset` or `parse` is rejected here rather than failing
     * later inside a pipeline run, where the stack would point at the wrong place.
     *
     * @param name - The name to register under.
     * @param parser - The parser.
     *
     * @returns An effect that registers the parser. Fails with the `InvalidValueParser` reason.
     */
    register: (name, parser) =>
      registerChecked(name, parser).pipe(
        Effect.map(() => {
          registered[name] = parser;
        })
      ),
    reset: name => {
      registered[name]?.reset?.();
    },
    resetAll: () => {
      for (const name in registered) {
        registered[name]?.reset?.();
      }
    },
    /**
     * @description Look up a parser by name.
     *
     * @param name - The parser name.
     *
     * @returns An effect producing the parser. Fails with the `ValueParserNotFound` reason if nothing is registered under that name.
     */
    get: (name: string): Effect.Effect<ValueParser, BuilderError> => {
      const ret = registered[name];
      if (ret) return Effect.succeed(ret);
      return Effect.fail(new BuilderErrorCtor({ reason: { _tag: 'ValueParserNotFound', name }, message: 'parser not found: ' + name }));
    },
  };
};

/**
 * @description The four checks a registration makes, as an effect. Split out so the pipeline can validate a parser it was handed directly without going through a
 * registry, and so each failure names the problem in one place.
 *
 * @param name - The name the parser would be registered under.
 * @param parser - The parser to check.
 *
 * @returns `Effect.void` when the parser is usable, or the `InvalidValueParser` failure.
 */
const registerChecked = (name: string, parser: ValueParser): Effect.Effect<void, BuilderError> => {
  const reject = (problem: 'name must be a string' | 'parser is required' | 'parser must implement reset()' | 'parser must implement parse()') =>
    Effect.fail(new BuilderErrorCtor({ reason: { _tag: 'InvalidValueParser', name: String(name), problem }, message: problem }));

  if (!name || typeof name !== 'string') return reject('name must be a string');
  if (!parser) return reject('parser is required');
  if (!parser.reset || typeof parser.reset !== 'function') return reject('parser must implement reset()');
  if (!parser.parse || typeof parser.parse !== 'function') return reject('parser must implement parse()');
  return Effect.void;
};
