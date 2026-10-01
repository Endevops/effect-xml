import type { EntityDecoderOptions, XmlError } from '@endevops/common-xml';

import { ENTITY_ACTION, EntityDecoder, XML } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { Context, SharedContext, ValueParser } from '#/output-builder/value-parser.ts';

import { BuilderError } from '#/errors.ts';
import { isUnsafeXml } from '#/output-builder/security/xml-unsafe.ts';

/**
 * @description The options for the entities parser: everything `EntityDecoder` accepts, plus a hook for deciding what to do with an entity declared in the
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
    new BuilderError({ reason: { _tag: 'EntityDecodingFailed', value, cause: cause.message }, message: cause.message });

/**
 * @description Expands XML and HTML entity references. The decoder is built on first use rather than at construction, because the document's XML version and its
 * DOCTYPE entities are not known until parsing reaches the first value — and both change how a reference resolves. They are read once, on that first
 * call, from the shared context. The decoder and the "have we read this document's version yet" flag are closed over, so there is no instance to
 * reset by reaching into it.
 *
 * @param options - Passed to `EntityDecoder`, except that `namedEntities` is merged over the standard XML set rather than replacing it — a caller
 *   adding one entity should not have to restate the other five.
 * @param isFinal - Whether an expansion ends the chain. Defaults to false. Unused, kept for chain-parity.
 *
 * @returns The parser.
 */
export const makeEntitiesValueParser = (options?: EntitiesValueParserOptions, isFinal = false): ValueParser => {
  void isFinal;
  const resolved: EntitiesValueParserOptions = {
    ...defaultOptions,
    ...options,
    // Additive merge: user-supplied namedEntities extend, not replace, the defaults.
    namedEntities: { ...defaultOptions.namedEntities, ...options?.namedEntities },
  };

  /**
   * @description The document's shared store, injected by the pipeline. `undefined` until then.
   */
  let sharedContext: SharedContext | undefined;
  /**
   * @description Whether the per-document decoder state has been consumed. Drives the one-time read of version and entities.
   */
  let seen = false;
  /**
   * @description The decoder, built on first string value.
   */
  let decoder: EntityDecoder | null = null;

  /**
   * @description Build the decoder on first use, then feed it this document's version and DOCTYPE entities exactly once. Both halves are effects, and both are
   * lazy: a parser that never sees a string never builds a decoder, and one that does is built once per document rather than once per value.
   */
  const ensureDecoder = Effect.fnUntracedEager(function* (): Effect.fn.Return<EntityDecoder, BuilderError> {
    // A local rather than the closed-over `decoder` throughout: assigning inside
    // the guard narrows the field to `never` for the rest of the body.
    let current = decoder;
    if (!current) {
      current = yield* Effect.mapErrorEager(EntityDecoder.make(resolved), fromDecoder(''));
      decoder = current;
    }
    if (!seen) {
      const version = sharedContext?.get('xmlVersion');
      const entities = sharedContext?.get('inputEntities');
      if (version) current.setXmlVersion(version as number);
      if (entities) yield* Effect.mapErrorEager(current.addInputEntities(entities as Record<string, string>), fromDecoder(''));
      seen = true;
    }
    return current;
  });

  return {
    /**
     * @description Receive the document's shared store.
     *
     * @param ctx - The document's store.
     */
    init: (ctx: SharedContext) => {
      sharedContext = ctx;
    },
    /**
     * @description Forget this document's version and entities, so the next parse re-reads them.
     */
    reset: () => {
      seen = false;
    },
    /**
     * @description Expand entity references in a string.
     *
     * @param val - The value. A non-string is returned untouched, so a number that reached this parser in a chain is not mangled.
     * @param _context - Unused; accepted to match the parser contract.
     *
     * @returns An effect producing the decoded string, or `val` unchanged if it is not a string. Fails with the `EntityDecodingFailed` reason when
     *   the decoder rejects a reference.
     */
    parse: Effect.fnUntracedEager(function* (val: unknown, _context?: Context): Effect.fn.Return<unknown, BuilderError> {
      if (typeof val !== 'string') return val;

      const current = yield* ensureDecoder();
      return yield* Effect.mapErrorEager(current.decode(val), fromDecoder(val));
    }),
  };
};
