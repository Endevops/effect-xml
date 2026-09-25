/**
 * @description Type augmentation for `@nodable/entities@2.x`.
 *
 * Its `index.d.ts` declares `EntityDecoder` as the module's **default**
 * export, but the runtime exports it as a **named** export and has no default
 * at all:
 *
 * ```
 * import * as m from '@nodable/entities'
 * typeof m.default        // undefined
 * typeof m.EntityDecoder  // function
 * ```
 *
 * So the declaration is the inverse of reality, and both import forms are
 * broken by it in opposite directions: the default import compiles but throws
 * `default is not a constructor` at runtime, while the named import — the one
 * that actually works — is a `TS2724`. Declaring the class as a named export
 * makes the import that runs also the one that type-checks.
 *
 * Deliberately not removing the `default` declaration: doing so would be a
 * different kind of claim, and the augmentation here only has to make the real
 * export reachable by name.
 */

declare module '@nodable/entities' {
  /**
   * @description Expands XML/HTML entity references. The real, named export.
   */
  export class EntityDecoder {
    constructor(options?: EntityDecoderOptions);
    setExternalEntities(map: Record<string, string | { regex: RegExp; val: string }>): void;
    addExternalEntity(key: string, value: string): void;
    addInputEntities(map: Record<string, string | { regx: RegExp; val: string } | { regex: RegExp; val: string }>): void;
    reset(): this;
    decode(str: string): string;
  }

  /**
   * @description Options accepted by the `EntityDecoder` constructor.
   */
  export interface EntityDecoderOptions {
    /** Named entity groups to seed the decoder with, e.g. `COMMON_HTML`. */
    namedEntities?: Record<string, Record<string, string>> | Record<string, string>;
    /** Caps on entity expansion, guarding against expansion bombs. */
    limit?: import('@nodable/entities').EntityDecoderLimitOptions;
    /** Non-character-reference handling — which codepoints become what. */
    ncr?: import('@nodable/entities').EntityDecoderNCROptions;
  }
}
