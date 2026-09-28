import type { ValueParser, ValueParserRegistryLike } from './value-parser.ts';

import BooleanParser from './value-parsers/boolean-parser.ts';
import EntitiesValueParser from './value-parsers/entity-parser.ts';
import NumberValueParser from './value-parsers/number.ts';
import Trim from './value-parsers/trim.ts';
import WSNormalizer from './value-parsers/ws-normalizer.ts';

/**
 * @description The parsers available by name without registering anything, and the chain a builder gets when it configures nothing. Built once at module load and
 * shallow-copied per registry, so every registry starts from the same instances. That sharing is deliberate — it is what makes
 * `factory.registerValueParser('boolean', custom)` affect every builder the factory produces. A parser holding per-document state is reset by
 * {@link ValueParserRegistry.resetAll} before each parse, so sharing does not leak state between documents.
 */
const defaultValParsers: Record<string, ValueParser> = {
  entity: new EntitiesValueParser(),
  trim: new Trim(),
  ws: new WSNormalizer(),
  boolean: new BooleanParser(),
  number: new NumberValueParser({ hex: true, leadingZeros: true, eNotation: true }),
};

/**
 * @description The named value parsers a builder's chain can reference.
 */
export type BuiltInValueParserName = keyof typeof defaultValParsers;

/**
 * @description A name a chain can use. Built-in names plus anything registered on the factory.
 */
export type ValueParserName = BuiltInValueParserName | (string & {});

/**
 * @description Holds the value parsers a builder's pipelines draw on, keyed by name.
 */
export default class ValueParserRegistry implements ValueParserRegistryLike {
  /**
   * @description The parsers, by name. A shallow copy of the built-ins, so registering here does not affect any other registry.
   */
  readonly registered: Record<string, ValueParser>;

  constructor() {
    this.registered = { ...defaultValParsers };
  }

  /**
   * @description Add or replace a named parser. Validation is deliberately strict — a parser missing `reset` or `parse` is rejected here rather than failing later
   * inside a pipeline run, where the stack would point at the wrong place. `reset` is required even though {@link ValueParser} marks it optional,
   * because the pipeline calls it between documents and a parser that cannot be reset is a bug waiting to leak state.
   *
   * @param name - The name to register under.
   * @param parser - The parser.
   *
   * @throws {Error} `name must be a string`, `parser is required`, `parser must implement reset()`, or `parser must implement parse()`.
   */
  register(name: string, parser: ValueParser): void {
    if (!name || typeof name !== 'string') {
      throw new Error('name must be a string');
    }
    if (!parser) {
      throw new Error('parser is required');
    }
    if (!parser.reset || typeof parser.reset !== 'function') {
      throw new Error('parser must implement reset()');
    }
    if (!parser.parse || typeof parser.parse !== 'function') {
      throw new Error('parser must implement parse()');
    }
    this.registered[name] = parser;
  }

  /**
   * @description Reset one named parser.
   *
   * @param name - The parser to reset. An unregistered name is a no-op.
   */
  reset(name: string): void {
    this.registered[name]?.reset?.();
  }

  /**
   * @description Reset every registered parser.
   */
  resetAll(): void {
    for (const name in this.registered) {
      this.registered[name]?.reset?.();
    }
  }

  /**
   * @description Look up a parser by name.
   *
   * @param name - The parser name.
   *
   * @returns The parser.
   *
   * @throws {Error} `parser not found: <name>` if nothing is registered under that name.
   */
  get(name: string): ValueParser {
    const ret = this.registered[name];
    if (!ret) {
      throw new Error('parser not found: ' + name);
    }
    return ret;
  }
}
