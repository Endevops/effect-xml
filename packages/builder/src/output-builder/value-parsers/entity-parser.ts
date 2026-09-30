import type { EntityDecoderOptions, XmlError } from '@endevops/common-xml';

import { ENTITY_ACTION, EntityDecoder, XML } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { BuilderError } from '../../errors.ts';
import type { Context } from '../value-parser.ts';

import { BuilderError as BuilderErrorCtor } from '../../errors.ts';
import { isUnsafeXml } from '../security/xml-unsafe.ts';
import BaseValueParser from './base-value-parser.ts';

/**
 * @description The options for {@link EntitiesValueParser}: everything `EntityDecoder` accepts, plus a hook for deciding what to do with an entity declared in the
 * document's own DOCTYPE.
 */
export type EntitiesValueParserOptions = EntityDecoderOptions & {
  /**
   * @description Called for each entity the document declared, to decide whether to expand it. Return an {@link ENTITY_ACTION} to allow or block it. Defaults to
   * blocking anything the XML rules in `security/xml-unsafe.ts` reject.
   */
  onInputEntity?: (name: string, value: string) => unknown;
};

/**
 * @description The defaults: the standard XML entity set, numeric references allowed, and untrusted DOCTYPE entities blocked. The `onInputEntity` default is the
 * package's security posture, not a convenience. A DOCTYPE entity is attacker-controlled whenever the document is, so anything the XML rules in
 * `security/xml-unsafe.ts` flag is refused rather than expanded.
 */
const defaultOptions: EntitiesValueParserOptions = {
  namedEntities: { ...XML },
  numericAllowed: true,
  onInputEntity: (_name: string, value: string) => (isUnsafeXml(value) ? ENTITY_ACTION.BLOCK : ENTITY_ACTION.ALLOW),
};

/**
 * @description Expands XML and HTML entity references. The decoder is built on first use rather than in the constructor, because the document's XML version and
 * its DOCTYPE entities are not known until parsing reaches the first value — and both change how a reference resolves. They are read once, on that
 * first call, from the shared context.
 *
 * @example
 *   ```typescript
 *   const evp = new EntitiesValueParser({ ncr: { onNcr: 'allow' } });
 *   ```;
 */
/**
 * @description Map a `common-xml` failure from the decoder into this package's error type. The decoder is `common-xml`'s, so its whole error surface is
 * `common-xml`'s. Mapping at the two calls the builder makes is what keeps this package's channel one type rather than a union, and the message rides
 * along so nothing is lost.
 *
 * @param value - The value being decoded, carried in the reason.
 *
 * @returns A mapper for `Effect.mapError`.
 */
const fromDecoder =
  (value: string) =>
  (cause: XmlError): BuilderError =>
    new BuilderErrorCtor({ reason: { _tag: 'EntityDecodingFailed', value, cause: cause.message }, message: cause.message });

export default class EntitiesValueParser extends BaseValueParser {
  /**
   * @description Whether the per-document decoder state has been consumed. Drives the one-time read of version and entities.
   */
  #seen = false;
  /**
   * @description The decoder, built on first string value.
   */
  #decoder: EntityDecoder | null = null;
  /**
   * @description The resolved options.
   */
  #options: EntitiesValueParserOptions;

  /**
   * @description Create the parser.
   *
   * @param options - Passed to `EntityDecoder`, except that `namedEntities` is merged over the standard XML set rather than replacing it — a caller
   *   adding one entity should not have to restate the other five.
   * @param isFinal - Whether an expansion ends the chain. Defaults to false.
   */
  constructor(options?: EntitiesValueParserOptions, isFinal = false) {
    super(isFinal);
    this.#options = {
      ...defaultOptions,
      ...options,
      // Additive merge: user-supplied namedEntities extend, not replace, the defaults.
      namedEntities: { ...defaultOptions.namedEntities, ...options?.namedEntities },
    };
  }

  /**
   * @description Build the decoder on first use, then feed it this document's version and DOCTYPE entities exactly once. Both halves are effects, and both are
   * lazy: a parser that never sees a string never builds a decoder, which is the same as before, and one that does is built once per document rather
   * than once per value.
   */
  #ensureDecoder = Effect.fnUntraced(function* (this: EntitiesValueParser): Effect.fn.Return<EntityDecoder, BuilderError> {
    // A local rather than `this.#decoder` throughout: assigning inside the guard narrows the
    // field to `never` for the rest of the body, and every call below would type as one.
    let decoder = this.#decoder;
    if (!decoder) {
      decoder = yield* Effect.mapError(EntityDecoder.make(this.#options), fromDecoder(''));
      this.#decoder = decoder;
    }
    if (!this.#seen) {
      const version = this.ctx?.get('xmlVersion');
      const entities = this.ctx?.get('inputEntities');
      if (version) yield* Effect.mapError(decoder.setXmlVersion(version as number), fromDecoder(''));
      if (entities) yield* Effect.mapError(decoder.addInputEntities(entities as Record<string, string>), fromDecoder(''));
      this.#seen = true;
    }
    return decoder;
  });

  /**
   * @description Forget this document's version and entities, so the next parse re-reads them.
   *
   * @returns An effect that clears the per-document state. Infallible in practice; the channel is there to match the parser contract, which every
   *   member of the chain now satisfies.
   */
  override reset(): Effect.Effect<void, BuilderError> {
    this.#seen = false;
    if (!this.#decoder) return Effect.void;
    return Effect.mapError(this.#decoder.reset(), fromDecoder(''));
  }

  /**
   * @description Expand entity references in a string.
   *
   * @param val - The value. A non-string is returned untouched, so a number that reached this parser in a chain is not mangled.
   * @param context - Unused; accepted to match the parser contract.
   *
   * @returns An effect producing the decoded string, or `val` unchanged if it is not a string. Fails with the `EntityDecodingFailed` reason when the
   *   decoder rejects a reference — a malformed `&…;` or an input entity the security rules block. The decoder reports that as a `common-xml`
   *   `XmlError`, which is mapped here so this package keeps a single error channel.
   */
  override parse = Effect.fnUntraced(function* (this: EntitiesValueParser, val: unknown, context?: Context): Effect.fn.Return<unknown, BuilderError> {
    void context;
    if (typeof val !== 'string') return val;

    const decoder = yield* this.#ensureDecoder();
    if (!decoder) return val;
    return yield* Effect.mapError(decoder.decode(val), fromDecoder(val));
  });
}
