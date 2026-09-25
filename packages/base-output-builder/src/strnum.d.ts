/**
 * @description Minimal declarations for `strnum`, which ships none. Only `toNumber` is declared, and only as far as this package uses it. The parameter list
 * mirrors the library's own documented signature rather than guessing at its internals: the first argument is the candidate string and the second is
 * an options bag whose every field is optional. Anything finer — what each flag admits — is `strnum`'s contract to document, and re-declaring it here
 * would be a second source of truth that drifts.
 */

declare module 'strnum' {
  /**
   * @description The `strnum` options bag. Every field is optional; an absent field means "not permitted".
   */
  export interface StrnumOptions {
    /**
     * @description Accept `0x`-prefixed hexadecimal.
     */
    hex?: boolean;
    /**
     * @description Accept `0b`-prefixed binary. Off by default.
     */
    binary?: boolean;
    /**
     * @description Accept `0o`-prefixed octal. Off by default.
     */
    octal?: boolean;
    /**
     * @description Treat a leading zero as significant rather than a sign of octal. On by default.
     */
    leadingZeros?: boolean;
    /**
     * @description Accept exponent notation. On by default.
     */
    eNotation?: boolean;
    /**
     * @description Normalise unicode digits before matching. Off by default.
     */
    unicode?: boolean;
    /**
     * @description Return this string unchanged, however numeric it looks. Useful for a path where a numeric value would be wrong.
     */
    skipLike?: RegExp;
    /**
     * @description What to do with `Infinity` and `-Infinity`: `'original'` returns the string as written, `'null'` returns `null`, `'string'` returns
     * `'Infinity'` or `'-Infinity'`, `'infinity'` returns the numeric value.
     */
    infinity?: 'original' | 'null' | 'string' | 'infinity';
  }

  /**
   * @description Convert a numeric string to a number. The module's only export, and its **default** — there is no named export, so this must be imported as
   * `import toNumber from 'strnum'`.
   *
   * @param source - The candidate string.
   * @param options - Which numeric forms to accept.
   *
   * @returns The number, or `source` unchanged when it is not numeric under `options`.
   */
  export default function toNumber(source: string, options?: StrnumOptions): string | number;
}
