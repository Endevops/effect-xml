/**
 * @description Type augmentations for `path-expression-matcher` v1.6.2. The shipped `index.d.ts` lags the runtime implementation in two ways this parser depends
 * on:
 *
 * 1. `Expression`'s constructor accepts a third `data` argument and stores it verbatim on `this.data` (see `Expression.js`), but the declaration only
 *    documents `pattern` and `options`. FXP uses that slot to carry per-entry `{ nested, skipEnclosures }` config alongside stop-node / skip-tag
 *    expressions, so one `ExpressionSet.findMatch()` returns the match _and_ its config without a second lookup (see
 *    `OptionsBuilder.normalizeTagEntry`).
 * 2. `ExpressionSet.findMatch()` yields the matched `Expression`, or a falsy value when nothing matches, but the declaration claims a bare `Expression`
 *    return type — so `matched ? … : …` narrowing at the call site is impossible. Both changes are additive: no declared member changes shape.
 *    Augmenting keeps `strict` mode working at the call sites instead of forcing a cast per read.
 */

import type { ExpressionOptions } from 'path-expression-matcher';

import type { TagExpressionConfig } from './internal/tag-expression.ts';

declare module 'path-expression-matcher' {
  interface Expression {
    /**
     * @description Opaque payload passed to the constructor and returned verbatim. `path-expression-matcher` itself never reads this field; it exists so an
     * embedding parser can carry its own per-expression config. FXP reserves it for {@link TagExpressionConfig} and never hands out an `Expression`
     * whose `data` holds anything else.
     */
    data: TagExpressionConfig | undefined;
  }

  interface ExpressionSet {
    /**
     * @description Find the first expression whose pattern matches the matcher's current path.
     *
     * @param matcher - A `Matcher` or a `MatcherView`, positioned at the tag being tested.
     *
     * @returns The matched `Expression`, or a falsy value when nothing matched.
     */
    findMatch(matcher: Matcher | MatcherView): Expression | null | undefined;
  }
}

/**
 * @description Constructor shape FXP actually calls. `Expression`'s published declaration stops at two parameters, so the three-argument form OptionsBuilder uses
 * would be a `TS2554` at every construction site. Aliasing the constructor once keeps the cast in a single documented place instead of scattering
 * it.
 */
export interface ConfigurableExpressionCtor {
  new (pattern: string, options: ExpressionOptions, data: TagExpressionConfig): Expression;
}
