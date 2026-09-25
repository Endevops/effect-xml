import type { EntityDecoderOptions } from '@nodable/entities';

import { COMMON_HTML, ENTITY_ACTION, EntityDecoder, XML } from '@nodable/entities';
import { VALID_CONTEXTS, isUnsafe } from 'is-unsafe';

import type { Context } from '../value-parser.ts';

import BaseValueParser from './base-value-parser.ts';

/**
 * @description The options for {@link EntitiesValueParser}: everything `EntityDecoder` accepts, plus a hook for deciding what to do with an entity declared in the
 * document's own DOCTYPE.
 */
export type EntitiesValueParserOptions = EntityDecoderOptions & {
  /**
   * @description Called for each entity the document declared, to decide whether to expand it. Return an {@link ENTITY_ACTION} to allow or block it. Defaults to
   * blocking anything `is-unsafe` rejects in an XML context.
   */
  onInputEntity?: (name: string, value: string) => unknown;
};

/**
 * @description The defaults: the standard XML entity set, numeric references allowed, and untrusted DOCTYPE entities blocked. The `onInputEntity` default is the
 * package's security posture, not a convenience. A DOCTYPE entity is attacker-controlled whenever the document is, so anything `is-unsafe` flags for
 * an XML context is refused rather than expanded.
 */
const defaultOptions: EntitiesValueParserOptions = {
  namedEntities: { ...XML },
  numericAllowed: true,
  onInputEntity: (_name: string, value: string) => (isUnsafe(value, [VALID_CONTEXTS.XML]) ? ENTITY_ACTION.BLOCK : ENTITY_ACTION.ALLOW),
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
   * @description Build the decoder on first use, then feed it this document's version and DOCTYPE entities exactly once.
   */
  #ensureDecoder(): void {
    if (!this.#decoder) {
      this.#decoder = new EntityDecoder(this.#options);
    }
    if (!this.#seen) {
      const version = this.ctx?.get('xmlVersion');
      const entities = this.ctx?.get('inputEntities');
      if (version) this.#decoder.setXmlVersion(version as number);
      if (entities) this.#decoder.addInputEntities(entities as Record<string, string>);
      this.#seen = true;
    }
  }

  /**
   * @description Forget this document's version and entities, so the next parse re-reads them.
   */
  override reset(): void {
    this.#seen = false;
    if (this.#decoder) {
      this.#decoder.reset();
    }
  }

  /**
   * @description Expand entity references in a string.
   *
   * @param val - The value. A non-string is returned untouched, so a number that reached this parser in a chain is not mangled.
   * @param context - Unused; accepted to match the parser contract.
   *
   * @returns The decoded string, or `val` unchanged if it is not a string.
   */
  override parse(val: unknown, context?: Context): unknown {
    void context;
    if (typeof val !== 'string') return val;
    this.#ensureDecoder();
    return this.#decoder?.decode(val);
  }
}

/**
 * @description The standard HTML entity set, re-exported so a caller building a custom `namedEntities` map does not need a second dependency.
 */
export { COMMON_HTML };
