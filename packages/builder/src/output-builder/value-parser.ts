import type { MatcherView } from '@endevops/common-xml';

import { Effect, Exit } from 'effect';

import type { BuilderError } from '#/errors.ts';

/**
 * @description Where one value came from, handed to every {@link ValueParser.parse} call. A plain value built by {@link makeContext} rather than a class: it holds
 * nothing but what the parser was told, and a constructor with no behaviour would only be somewhere for a hidden write to live.
 */
export interface Context {
  /**
   * @description The tag or attribute name the value belongs to.
   */
  readonly elementName: string;
  /**
   * @description The parser's live path at this point, or `null` when the builder was constructed without one.
   */
  readonly matcher: MatcherView | null;
  /**
   * @description Whether the element has no child elements, or `null` when the parser has not determined it yet.
   */
  readonly isLeafNode: boolean | null;
  /**
   * @description Whether the value is an attribute value rather than element text, or `null` when not yet known.
   */
  readonly isAttribute: boolean | null;
}

/**
 * @description Build a {@link Context}.
 *
 * @param elementName - The tag or attribute name.
 * @param matcher - The live path, or `null`.
 * @param isLeafNode - Whether the element has no child elements, or `null`.
 * @param isAttribute - Whether the value is an attribute value. Defaults to `false`.
 *
 * @returns The context.
 */
export const makeContext = (
  elementName: string,
  matcher: MatcherView | null,
  isLeafNode: boolean | null,
  isAttribute: boolean | null = false
): Context => ({ elementName, matcher, isLeafNode, isAttribute });

/**
 * @description The key a {@link FinalValue} carries. A symbol rather than a `kind` string, so a value parser that legitimately returns a record with a `kind` field
 * is never mistaken for the sentinel.
 */
const FINAL_VALUE: unique symbol = Symbol.for('@endevops/builder/FinalValue');

/**
 * @description A sentinel a value parser returns to end the pipeline immediately. `ValueParserPipeline.run()` unwraps `.value` and returns it without running any
 * later parser. Whether to emit one is the parser's own decision, made through its `IS_FINAL` option — the pipeline never injects it.
 *
 * @example
 *   ```typescript
 *   const stopOnNull: ValueParser = {
 *     parse: val => Effect.succeed(val === 'null' ? finalValue(null) : val),
 *   };
 *   ```;
 */
export interface FinalValue {
  /**
   * @description The value the pipeline returns.
   */
  readonly value: unknown;
  /**
   * @description The brand that makes {@link isFinalValue} recognisable.
   */
  readonly [FINAL_VALUE]: true;
}

/**
 * @description Wrap a value to end the pipeline.
 *
 * @param value - The resolved value.
 *
 * @returns The sentinel.
 */
export const finalValue = (value: unknown): FinalValue => ({ [FINAL_VALUE]: true, value });

/**
 * @description Whether a value is a {@link FinalValue}. A guard rather than `instanceof`, because the sentinel is now a plain object and the brand is a symbol.
 *
 * @param value - The value to test.
 *
 * @returns Whether it ends the pipeline.
 */
export const isFinalValue = (value: unknown): value is FinalValue => typeof value === 'object' && value !== null && FINAL_VALUE in value;

/**
 * @description A mutable key-value store shared with every value parser that opts in via `init(ctx)`. A fresh instance is created per document parse, so nothing
 * leaks between documents. Two keys are written by the output builder and read by the built-in parsers:
 *
 * - `'xmlVersion'` — the version from the `<?xml version="…"?>` declaration, as a number
 * - `'inputEntities'` — the entity map from the DOCTYPE block Parsers may also write their own keys to communicate with later parsers in the same
 *   chain.
 */
export interface SharedContext {
  /**
   * @description Store a value.
   *
   * @param key - The key.
   * @param value - The value.
   */
  set(key: string, value: unknown): void;
  /**
   * @description Read a value.
   *
   * @param key - The key.
   *
   * @returns The stored value, or `undefined` if the key was never set.
   */
  get(key: string): unknown;
  /**
   * @description Remove every entry.
   */
  clear(): void;
}

/**
 * @description Create a {@link SharedContext}. The store is closed over rather than held on an instance, so the accessors are the whole contract and nothing can
 * reach in to bypass the `clear()` guarantee.
 *
 * @returns A fresh store.
 */
export const makeSharedContext = (): SharedContext => {
  let data: Record<string, unknown> = {};
  return {
    set: (key, value) => {
      data[key] = value;
    },
    get: key => data[key],
    clear: () => {
      data = {};
    },
  };
};

/**
 * @description A value transform. The pipeline calls {@link ValueParser.parse} for each value; `reset` and `init` are optional.
 */
export interface ValueParser {
  /**
   * @description Transform one value.
   *
   * @param val - The incoming value, which may be the output of the previous parser in the chain.
   * @param context - Where the value came from.
   *
   * @returns The transformed value, or a {@link FinalValue} to end the chain. Fails with {@link BuilderError} — a chain is a sequence of fallible
   *   transforms, which is the shape Effect exists for, and it lets a parser reject one value without failing the whole document.
   */
  parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError>;
  /**
   * @description Clear internal state between document parses. Optional — a stateless parser need not implement it.
   */
  reset?(): void;
  /**
   * @description Receive the document's {@link SharedContext}. Optional, and called by the pipeline rather than the caller.
   */
  init?(ctx: SharedContext): void;
}

/**
 * @description The part of the value-parser registry a pipeline depends on, declared separately so the pipeline is not coupled to the concrete registry — a test
 * or an embedder can supply its own.
 */
export interface ValueParserRegistryLike {
  /**
   * @description Look up a parser by name.
   *
   * @param name - The registry name.
   *
   * @returns An effect producing the parser, failing with the `ValueParserNotFound` reason if no parser is registered under `name`.
   */
  get(name: string): Effect.Effect<ValueParser, BuilderError>;
  /**
   * @description Add or replace a named parser.
   *
   * @param name - The registry name.
   * @param parser - The parser.
   *
   * @returns An effect that registers the parser, failing with the `InvalidValueParser` reason.
   */
  register(name: string, parser: ValueParser): Effect.Effect<void, BuilderError>;
}

/**
 * @description Runs a configured chain of value parsers over each value, in order. A builder gets two of these from its factory: `tagsPipeline` for element text
 * and `attrsPipeline` for attribute values. Both share one {@link SharedContext} and one registry, and both are rebuilt per document, so a parser that
 * implements `init` always sees the current document's context rather than a stale one.
 *
 * @example
 *   ```typescript
 *   const pipeline = makeValueParserPipeline(['ws', 'boolean', 'number'], registry);
 *   pipeline.run('  true  '); // → true
 *   ```;
 */
export interface ValueParserPipeline {
  /**
   * @description The chain, as registry names or instances. Names are resolved against {@link ValueParserPipeline.registry} on every run, so a parser registered
   * after construction takes effect without rebuilding the pipeline.
   */
  readonly valParsers: Array<string | ValueParser>;
  /**
   * @description Where names in {@link ValueParserPipeline.valParsers} resolve.
   */
  readonly registry: ValueParserRegistryLike;
  /**
   * @description The document-scoped store handed to every parser that implements `init`.
   */
  readonly sharedContext: SharedContext;
  /**
   * @description Run the chain over one value. Each parser receives the previous one's output. A parser returning a {@link FinalValue} ends the chain and its
   * `.value` is returned; a name that does not resolve is skipped, so a chain may reference a parser registered later without failing the run.
   *
   * @param val - The value to transform.
   * @param runtimeContext - Where the value came from.
   *
   * @returns The transformed value. Fails with {@link BuilderError} — `ValueParserNotFound` for a name nothing is registered under, or whatever the
   *   failing parser in the chain reports.
   */
  run(val: unknown, runtimeContext?: Context): Effect.Effect<unknown, BuilderError>;
  /**
   * @description Reset every parser in the chain, for a parser holding state across a document.
   */
  resetAll(): void;
  /**
   * @description Add or replace a named parser, calling its `init` immediately so it is ready before the next run.
   *
   * @param name - The registry name.
   * @param instance - The parser.
   *
   * @returns An effect that registers the parser.
   */
  register(name: string, instance: ValueParser): Effect.Effect<void, BuilderError>;
}

/**
 * @description Build a pipeline and wire up its parsers.
 *
 * @param valParsers - The chain, as names or instances.
 * @param registry - Where names resolve.
 * @param sharedContext - The store to hand each parser. A fresh one is created when omitted.
 *
 * @returns The pipeline.
 */
export const makeValueParserPipeline = (
  valParsers: Array<string | ValueParser> = [],
  registry: ValueParserRegistryLike,
  sharedContext: SharedContext | null = null
): ValueParserPipeline => {
  const context = sharedContext || makeSharedContext();

  /**
   * @description Look a name up, or `undefined` when it is not registered.
   */
  const tryGet = (name: string): ValueParser | undefined => {
    const exit = Effect.runSyncExit(registry.get(name));
    return Exit.isSuccess(exit) ? exit.value : undefined;
  };

  /**
   * @description Call `init(sharedContext)` on each parser that implements it. A local `Set` deduplicates, for the case where one instance is registered under two
   * names. A module-level `WeakSet` is deliberately not used: pipelines are rebuilt per document, so each parser must receive `init` afresh with the
   * new context rather than being skipped as already-seen.
   *
   * @param instances - The chain entries, as names or instances.
   */
  const initAll = (instances: Array<string | ValueParser>): void => {
    const seen = new Set<ValueParser>();
    for (const entry of instances) {
      // Same skip-an-unregistered-name rule as `resetAll`: the factory wires up
      // whatever is there, and a name registered later gets its `init` from
      // `register` instead.
      const parser = typeof entry === 'string' ? tryGet(entry) : entry;
      if (parser && typeof parser.init === 'function' && !seen.has(parser)) {
        seen.add(parser);
        parser.init(context);
      }
    }
  };

  initAll(valParsers);

  return {
    valParsers,
    registry,
    sharedContext: context,
    run: (val, runtimeContext) =>
      Effect.gen(function* () {
        for (let i = 0; i < valParsers.length; i++) {
          const entry = valParsers[i];
          // A name is resolved on every run, so a parser registered after
          // construction takes effect without rebuilding the pipeline.
          const parser = typeof entry === 'string' ? yield* registry.get(entry) : entry;
          if (parser) {
            const result = yield* parser.parse(val, runtimeContext);
            if (isFinalValue(result)) return result.value;
            val = result;
          }
        }
        return val;
      }),
    resetAll: () => {
      for (let i = 0; i < valParsers.length; i++) {
        const entry = valParsers[i];
        // A name that no longer resolves is skipped rather than failing: this
        // runs between documents, where throwing would abandon a parse over a
        // chain entry that has since been unregistered.
        const parser = typeof entry === 'string' ? tryGet(entry) : entry;
        if (parser?.reset) parser.reset();
      }
    },
    register: (name, instance) =>
      Effect.map(registry.register(name, instance), () => {
        if (instance.init) instance.init(context);
      }),
  };
};
