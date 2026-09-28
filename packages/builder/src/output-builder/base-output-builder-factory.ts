import type { MatcherView } from '@endevops/common-xml';

import { Effect } from 'effect';

import type { BuilderError } from '../errors.ts';
import type { BuiltInValueParserOptions } from './options.ts';
import type { ValueParser, ValueParserRegistryLike } from './value-parser.ts';

import { BuilderError as BuilderErrorCtor } from '../errors.ts';
import BaseOutputBuilder from './base-output-builder.ts';
import ValueParserRegistry from './value-parser-registry.ts';

/**
 * @description The base every builder factory extends. A factory is the parser's entry point into a builder: the parser holds one, calls `getInstance` before each
 * document, and gets a fresh builder back. That is what keeps per-document state — the shared context, any value parser holding state — from leaking
 * between parses. Subclasses implement `getInstance` and normally resolve their own options in the constructor.
 */
export default class BaseOutputBuilderFactory {
  /**
   * @description This builder's options, with defaults applied.
   */
  builderOptions: BuiltInValueParserOptions;
  /**
   * @description The value parsers available by name, shared with every builder this factory produces.
   */
  readonly registry: ValueParserRegistryLike;

  /**
   * @description Create a factory.
   *
   * @param builderOptions - This builder's options. Defaults are applied by the subclass, since only it knows the full option set.
   */
  constructor(builderOptions: BuiltInValueParserOptions = {}) {
    this.builderOptions = builderOptions;
    this.registry = new ValueParserRegistry();
  }

  /**
   * @description Add or replace a named value parser, affecting every builder this factory produces afterwards.
   *
   * @param name - The name chains will reference.
   * @param parserInstance - The parser.
   *
   * @returns An effect that registers the parser. Fails with the `InvalidValueParser` reason — the same checks {@link ValueParserRegistry.register}
   *   makes, run here so a caller configuring a factory sees the failure at configuration time rather than mid-parse.
   */
  registerValueParser(name: string, parserInstance: ValueParser): Effect.Effect<void, BuilderError> {
    return this.registry.register(name, parserInstance);
  }

  /**
   * @description Produce a fresh builder for one document. Implemented by every subclass.
   *
   * @param parserOptions - The parser's options.
   * @param readonlyMatcher - The live path, or `null`.
   *
   * @returns An effect producing a builder for this document. Fails with {@link BuilderError} and the `NotImplemented` reason, always, in the base
   *   class.
   */
  getInstance(parserOptions: object, readonlyMatcher: MatcherView | null): Effect.Effect<BaseOutputBuilder, BuilderError> {
    void parserOptions;
    void readonlyMatcher;
    return Effect.fail(
      new BuilderErrorCtor({ reason: { _tag: 'NotImplemented', member: 'getInstance' }, message: 'getInstance is not implemented' })
    );
  }
}
