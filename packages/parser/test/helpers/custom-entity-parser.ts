import type { SharedContext } from '@nodable/base-output-builder';
import type { EntityDecoderOptions } from '@nodable/entities';

// `EntityDecoder` is a NAMED export at runtime; `@nodable/entities`' index.d.ts
// declares it as the default export instead. The named import is what actually
// resolves (a default import gives `undefined` at runtime and
// "default is not a constructor" on use).
import { EntityDecoder } from '@nodable/entities';

/**
 * @description A value parser that expands DOCTYPE entities. `@nodable/entities`' `EntityDecoder` is a standalone decoder, not a `BaseValueParser`, so this adapts
 * it to the value-parser contract the builder's pipeline expects: `parse(val, context)` instead of `decode(str)`, plus the `init` / `reset` lifecycle
 * the pipeline calls. The DOCTYPE's entity map only arrives through the shared context, which the pipeline supplies after construction — so the
 * decoder is fed from the context rather than from constructor options.
 */
export default class EntityParser {
  /**
   * @description The shared context supplied by the pipeline, holding `xmlVersion` and `inputEntities`.
   */
  ctx: SharedContext | undefined;

  #decoder: EntityDecoder;
  #seen = false;

  constructor(options?: EntityDecoderOptions) {
    this.#decoder = new EntityDecoder(options);
  }

  /**
   * @description Receive the pipeline's shared context. Called once per document, before any value is parsed.
   */
  init(ctx: SharedContext): void {
    this.ctx = ctx;
  }

  /**
   * @description Push the DOCTYPE's entity map into the decoder, once. Guarded by `#seen` because `addInputEntities` merges into the decoder's table: running it
   * on every value would re-add the same entities for every text node in the document. `reset()` clears the flag so the next document starts clean.
   */
  #ensureDecoder(): void {
    if (!this.#seen) {
      const entities = this.ctx?.get('inputEntities');
      if (entities) this.#decoder.addInputEntities(entities as Parameters<EntityDecoder['addInputEntities']>[0]);
      this.#seen = true;
    }
  }

  /**
   * @description Register a single external entity. Exposed because callers hold the parser, not the decoder, and the decoder's own API is part of what these
   * tests exercise.
   */
  addExternalEntity(key: string, value: string): void {
    this.#decoder.addExternalEntity(key, value);
  }

  /**
   * @description Register a batch of external entities. See {@link addExternalEntity}.
   */
  setExternalEntities(map: Parameters<EntityDecoder['setExternalEntities']>[0]): void {
    this.#decoder.setExternalEntities(map);
  }

  /**
   * @description Clear the decoder state between documents. Called by the pipeline before each parse run.
   */
  reset(): void {
    this.#decoder.reset();
    this.#seen = false;
  }

  /**
   * @description Expand entity references in a string value. Non-strings pass through untouched.
   */
  parse(val: unknown): unknown {
    if (typeof val === 'string') {
      this.#ensureDecoder();
      return this.#decoder.decode(val);
    }

    return val;
  }
}
