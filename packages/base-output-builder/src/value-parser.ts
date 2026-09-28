import type { MatcherView } from '@endevops/path-expression-matcher';

/**
 * @description The context handed to every value parser's `parse` call, describing the value being transformed.
 */
export class Context {
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

  /**
   * @description Build a context.
   *
   * @param elementName - The tag or attribute name.
   * @param matcher - The live path, or `null`.
   * @param isLeafNode - Whether the element has no child elements, or `null`.
   * @param isAttribute - Whether the value is an attribute value. Defaults to `false`.
   */
  constructor(elementName: string, matcher: MatcherView | null, isLeafNode: boolean | null, isAttribute: boolean | null = false) {
    this.elementName = elementName;
    this.matcher = matcher;
    this.isLeafNode = isLeafNode;
    this.isAttribute = isAttribute;
  }
}

/**
 * @description A sentinel a value parser returns to end the pipeline immediately. `ValueParserPipeline.run()` unwraps `.value` and returns it without running any
 * later parser. Whether to emit one is the parser's own decision, made through its `IS_FINAL` constructor option — the pipeline never injects it.
 *
 * @example
 *   ```typescript
 *   class StopOnNull extends BaseValueParser {
 *     parse(val: unknown): unknown {
 *       return val === 'null' ? new FinalValue(null) : val;
 *     }
 *   }
 *   ```;
 */
export class FinalValue {
  /**
   * @description The value the pipeline returns.
   */
  readonly value: unknown;

  /**
   * @description Wrap a value to end the pipeline.
   *
   * @param value - The resolved value.
   */
  constructor(value: unknown) {
    this.value = value;
  }
}

/**
 * @description A mutable key-value store shared with every value parser that opts in via `init(ctx)`. A fresh instance is created per document parse, so nothing
 * leaks between documents. Two keys are written by {@link BaseOutputBuilder} and read by the built-in parsers:
 *
 * - `'xmlVersion'` — the version from the `<?xml version="…"?>` declaration, as a number
 * - `'inputEntities'` — the entity map from the DOCTYPE block Parsers may also write their own keys to communicate with later parsers in the same
 *   chain.
 */
export class SharedContext {
  /**
   * @description Backing store. Private because the accessors below are the whole contract — a parser reaching in directly would bypass the `clear()`-on-reset
   * guarantee.
   */
  #data: Record<string, unknown> = {};

  /**
   * @description Store a value.
   *
   * @param key - The key.
   * @param value - The value.
   */
  set(key: string, value: unknown): void {
    this.#data[key] = value;
  }

  /**
   * @description Read a value.
   *
   * @param key - The key.
   *
   * @returns The stored value, or `undefined` if the key was never set.
   */
  get(key: string): unknown {
    return this.#data[key];
  }

  /**
   * @description Remove every entry.
   */
  clear(): void {
    this.#data = {};
  }
}

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
   * @returns The transformed value, or a {@link FinalValue} to end the chain.
   */
  parse(val: unknown, context?: Context): unknown;
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
 * @description Runs a configured chain of value parsers over each value, in order. A builder gets two of these from its factory: `tagsPipeline` for element text
 * and `attrsPipeline` for attribute values. Both share one {@link SharedContext} and one registry, and both are rebuilt per document, so a parser that
 * implements `init` always sees the current document's context rather than a stale one.
 *
 * @example
 *   ```typescript
 *   const pipeline = new ValueParserPipeline(['ws', 'boolean', 'number'], registry);
 *   pipeline.run('  true  '); // → true
 *   ```;
 */
export class ValueParserPipeline {
  /**
   * @description The chain, as registry names or instances. Names are resolved against {@link ValueParserPipeline.registry} on every run, so a parser registered
   * after construction takes effect without rebuilding the pipeline.
   */
  readonly valParsers: (string | ValueParser)[];
  /**
   * @description Where names in {@link ValueParserPipeline.valParsers} resolve.
   */
  readonly registry: ValueParserRegistryLike;
  /**
   * @description The document-scoped store handed to every parser that implements `init`.
   */
  readonly sharedContext: SharedContext;

  /**
   * @description Build a pipeline and wire up its parsers.
   *
   * @param valParsers - The chain, as names or instances.
   * @param registry - Where names resolve.
   * @param sharedContext - The store to hand each parser. A fresh one is created when omitted.
   */
  constructor(valParsers: (string | ValueParser)[] = [], registry: ValueParserRegistryLike, sharedContext: SharedContext | null = null) {
    this.valParsers = valParsers;
    this.registry = registry;
    this.sharedContext = sharedContext || new SharedContext();

    this.#initAll(valParsers);
  }

  /**
   * @description Run the chain over one value. Each parser receives the previous one's output. A parser returning a {@link FinalValue} ends the chain and its
   * `.value` is returned; a name that does not resolve is skipped, so a chain may reference a parser registered later without failing the run.
   *
   * @param val - The value to transform.
   * @param runtimeContext - Where the value came from.
   *
   * @returns The transformed value.
   */
  run(val: unknown, runtimeContext?: Context): unknown {
    for (let i = 0; i < this.valParsers.length; i++) {
      const entry = this.valParsers[i];
      const parser = typeof entry === 'string' ? this.registry.get(entry) : entry;
      if (parser) {
        const result = parser.parse(val, runtimeContext);
        if (result instanceof FinalValue) return result.value;
        val = result;
      }
    }
    return val;
  }

  /**
   * @description Reset every parser in the chain, for a parser holding state across a document.
   */
  resetAll(): void {
    for (let i = 0; i < this.valParsers.length; i++) {
      const entry = this.valParsers[i];
      const parser = typeof entry === 'string' ? this.registry.get(entry) : entry;
      if (parser?.reset) parser.reset();
    }
  }

  /**
   * @description Add or replace a named parser, calling its `init` immediately so it is ready before the next run.
   *
   * @param name - The registry name.
   * @param instance - The parser.
   */
  register(name: string, instance: ValueParser): void {
    this.registry.register(name, instance);
    if (instance.init) instance.init(this.sharedContext);
  }

  /**
   * @description Call `init(sharedContext)` on each parser that implements it. A local `Set` deduplicates, for the case where one instance is registered under two
   * names. A module-level `WeakSet` is deliberately not used: pipelines are rebuilt per document, so each parser must receive `init` afresh with the
   * new context rather than being skipped as already-seen.
   *
   * @param instances - The chain entries, as names or instances.
   */
  #initAll(instances: (string | ValueParser)[]): void {
    if (!this.sharedContext) return;
    const seen = new Set<ValueParser>();
    for (const entry of instances) {
      const parser = typeof entry === 'string' ? this.registry.get(entry) : entry;
      if (parser && typeof parser.init === 'function' && !seen.has(parser)) {
        seen.add(parser);
        parser.init(this.sharedContext);
      }
    }
  }
}

/**
 * @description The part of {@link ValueParserRegistry} a pipeline depends on, declared separately so the pipeline is not coupled to the concrete registry — a test
 * or an embedder can supply its own.
 */
export interface ValueParserRegistryLike {
  /**
   * @description Look up a parser by name.
   *
   * @param name - The registry name.
   *
   * @returns The parser.
   *
   * @throws {Error} If no parser is registered under `name`.
   */
  get(name: string): ValueParser;
  /**
   * @description Add or replace a named parser.
   *
   * @param name - The registry name.
   * @param parser - The parser.
   */
  register(name: string, parser: ValueParser): void;
}
