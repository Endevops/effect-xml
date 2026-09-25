/**
 * @description Type augmentation for `@nodable/entities@2.x`. Its `index.d.ts` declares `EntityDecoder` as the module's **default** export, but the runtime
 * exports it as a **named** export and has no default at all:
 *
 * ```ts
 * import * as m from '@nodable/entities';
 * typeof m.default; // undefined
 * typeof m.EntityDecoder; // function
 * ```
 *
 * So the declaration is the inverse of reality, and both import forms break in opposite directions: the default import the types invite compiles but
 * throws `default is not a constructor` at runtime, while the named import — the one that actually works — is a `TS2724`. Declaring the class as a
 * named export makes the import that runs also the one that type-checks.
 *
 * ## Why the top-level import matters
 *
 * `declare module '<specifier>'` is only an _augmentation_ — one that merges with the package's own declarations, leaving `COMMON_HTML`, `CURRENCY`,
 * `EntityDecoderOptions` and the rest reachable — when the containing file is a module. A `.d.ts` with no top-level import or export is a global
 * script, and there the same declaration is an _ambient module declaration_ that silently replaces the real module wholesale. The `import type` below
 * is what makes this file a module, and dropping it would hide every other export of the package. The `default` declaration is deliberately left in
 * place: removing it would be a different kind of claim, and the only thing this file has to do is make the real export reachable by name.
 */

import type { EntityDecoderOptions } from '@nodable/entities';

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
}
