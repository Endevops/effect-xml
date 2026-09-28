import type { Expression } from '@endevops/path-expression-matcher';

import { Expression as CompiledExpression, ExpressionSet } from '@endevops/path-expression-matcher';

import type { Context } from '../value-parser.ts';

import BaseValueParser from './base-value-parser.ts';

/**
 * @description Options for {@link WSNormalizer}.
 */
export interface WSNormalizerOptions {
  /**
   * @description Tag paths whose whitespace must survive untouched — `["..pre", "..code"]` for verbatim blocks. Accepts pattern strings or pre-compiled
   * `Expression`s.
   */
  exclude?: (string | Expression)[];
}

/**
 * @description Collapses runs of whitespace to a single space and trims both ends. This is the `'ws'` parser in the default tag chain, replacing the older
 * `'trim'`. It leaves a value alone in four cases, each of which is a case where collapsing would lose information the document explicitly asked to
 * keep:
 *
 * 1. The value is not a string — there is no whitespace to speak of
 * 2. The value is an attribute — attribute whitespace is significant and is not layout
 * 3. An ancestor set `xml:space="preserve"` — the document opted out of normalization
 * 4. The tag path matches a configured exclusion
 *
 * @example
 *   ```typescript
 *   const ws = new WSNormalizer({ exclude: ['..pre', '..code'] });
 *   ```;
 */
export default class WSNormalizer extends BaseValueParser {
  /**
   * @description The compiled exclusion patterns, sealed at construction so nothing can add to them mid-parse.
   */
  readonly #excludeSet: ExpressionSet;

  /**
   * @description Create the parser.
   *
   * @param options - `exclude` lists the paths to leave alone.
   * @param isFinal - Whether a normalization ends the chain. Defaults to false.
   */
  constructor(options?: WSNormalizerOptions, isFinal = false) {
    super(isFinal);
    const exclude = options?.exclude ?? [];

    const set = new ExpressionSet();
    for (const entry of exclude) {
      set.add(typeof entry === 'string' ? new CompiledExpression(entry) : entry);
    }
    set.seal();

    this.#excludeSet = set;
  }

  /**
   * @description Normalize a value's whitespace, unless an exclusion applies.
   *
   * @param val - The value.
   * @param ctx - Where the value came from.
   *
   * @returns The normalized string, or `val` unchanged when normalization does not apply.
   */
  override parse(val: unknown, ctx?: Context): unknown {
    if (typeof val !== 'string') return val;

    if (ctx) {
      // Only normalize element text, not attribute values
      if (ctx.isAttribute) return val;

      if (ctx.matcher) {
        // Respect xml:space="preserve" on any ancestor
        if (ctx.matcher.getAnyParentAttr('xml:space') === 'preserve') return val;

        // Respect user-configured exclusion paths
        if (this.#excludeSet.size > 0 && this.#excludeSet.matchesAny(ctx.matcher)) return val;
      }
    }

    return val.replace(/[ \t\r\n]+/g, ' ').trim();
  }
}
