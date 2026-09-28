import type { BuilderError, SharedContext } from '@endevops/builder';
import type { EntityDecoderOptions } from '@endevops/common-xml';
import type { Effect } from 'effect';

import { BuilderError as BuilderErrorCtor } from '@endevops/builder';
import { EntityDecoder } from '@endevops/common-xml';
import { Effect as Eff } from 'effect';

import { runParser } from '#/test/helpers/test-runner.ts';

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

  /**
   * @description `EntityDecoder.make` rather than `new EntityDecoder`, because building a decoder can fail — a `null` options object is a caller who wrote
   * something the signature does not allow, and `common-xml` reports that as its own error rather than quietly building the decoder nobody asked for.
   * Construction here is a `runParser` of that effect, so the refusal surfaces as a thrown `XmlError` at the one place that builds this.
   *
   * @param options - Decoder options.
   */
  constructor(options?: EntityDecoderOptions) {
    this.#decoder = runParser(EntityDecoder.make(options));
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
   * `addInputEntities` answers with an `Effect`, and an effect is lazy: writing the call as a bare statement constructs the value and throws it away,
   * so no entity is ever registered and every `&name;` reference comes back unexpanded. It is run here, deliberately, because this method's own
   * signature is `void` and the registration is not something the value-parser pipeline can be asked to do later.
   */
  #ensureDecoder(): void {
    if (!this.#seen) {
      const entities = this.ctx?.get('inputEntities');
      if (entities) runParser(this.#decoder.addInputEntities(entities as Parameters<EntityDecoder['addInputEntities']>[0]));
      this.#seen = true;
    }
  }

  /**
   * @description Register a single external entity. Exposed because callers hold the parser, not the decoder, and the decoder's own API is part of what these
   * tests exercise. Run for its value — see {@link EntityParser.reset} for why that matters.
   */
  addExternalEntity(key: string, value: string): void {
    runParser(this.#decoder.addExternalEntity(key, value));
  }

  /**
   * @description Register a batch of external entities. See {@link addExternalEntity}.
   */
  setExternalEntities(map: Parameters<EntityDecoder['setExternalEntities']>[0]): void {
    runParser(this.#decoder.setExternalEntities(map));
  }

  /**
   * @description Clear the decoder state between documents. Called by the pipeline before each parse run. `EntityDecoder.reset` answers with an `Effect`, so it is
   * run rather than merely called — a discarded effect here would leave the previous document's entities in the table and the flag below would
   * suppress re-registration, so the second document would silently inherit the first one's DOCTYPE.
   */
  reset(): void {
    runParser(this.#decoder.reset());
    this.#seen = false;
  }

  /**
   * @description Expand entity references in a string value. Non-strings pass through untouched. The decoder reports failures as `common-xml`'s `XmlError`, while
   * the value-parser contract the pipeline calls is `@endevops/builder`'s `BuilderError`. The two are distinct tagged classes, so the failure is
   * mapped rather than left to widen the channel a caller has to branch on — the same mapping `EntitiesValueParser.fromDecoder` performs, and for the
   * same reason. The message is carried through verbatim, because these tests assert on the `[EntityReplacer] …` text and a reworded message would
   * stop matching.
   */
  parse(val: unknown): Effect.Effect<unknown, BuilderError> {
    if (typeof val === 'string') {
      this.#ensureDecoder();
      return Eff.mapError(
        this.#decoder.decode(val),
        cause => new BuilderErrorCtor({ reason: { _tag: 'EntityDecodingFailed', value: val, cause: cause.message }, message: cause.message })
      );
    }

    return Eff.succeed(val);
  }
}
