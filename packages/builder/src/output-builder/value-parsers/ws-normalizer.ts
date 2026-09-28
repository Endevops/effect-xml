import type { Expression } from '@endevops/common-xml';

import { ExpressionSet } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { BuilderError } from '../../errors.ts';
import type { Context } from '../value-parser.ts';

import { addToSet, compilePattern, liftXml } from '../../errors.ts';
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
   * @description Create a normalizer from an already-compiled exclusion set. Private because compiling that set can fail — see {@link WSNormalizer.make}.
   *
   * @param set - The compiled, sealed exclusion set.
   * @param isFinal - Whether a normalization ends the chain.
   */
  private constructor(set: ExpressionSet, isFinal: boolean) {
    super(isFinal);
    this.#excludeSet = set;
  }

  /**
   * @description The built-in default: a normalizer with no exclusions. Synchronous, and deliberately so. With no `exclude` there is nothing to compile, so this
   * case cannot fail — which is what lets {@link defaultValParsers} stay a module-level constant and lets every registry share the same instances.
   * Anything that _can_ fail goes through {@link WSNormalizer.make}.
   *
   * @param isFinal - Whether a normalization ends the chain. Defaults to false.
   *
   * @returns A normalizer with an empty, sealed exclusion set.
   */
  static builtin(isFinal = false): WSNormalizer {
    const set = new ExpressionSet();
    set.seal();
    return new WSNormalizer(set, isFinal);
  }

  /**
   * @description Build a normalizer, compiling the configured exclusion paths. A factory rather than a constructor, because compiling the exclusions can fail — a
   * path that will not parse, or an add after a seal — and a constructor has nowhere to put an error channel.
   *
   * @param options - `exclude` lists the paths to leave alone.
   * @param isFinal - Whether a normalization ends the chain. Defaults to false.
   *
   * @returns An effect producing the normalizer. Fails with the `PatternCompilationFailed` reason when
   * an exclusion does not compile.
   */
  static make = (options?: WSNormalizerOptions, isFinal = false): Effect.Effect<WSNormalizer, BuilderError> =>
    Effect.gen(function* () {
      const exclude = options?.exclude ?? [];
      const set = new ExpressionSet();
      for (const entry of exclude) {
        const compiled = typeof entry === 'string' ? yield* compilePattern(entry) : entry;
        yield* addToSet(set, compiled);
      }
      set.seal();
      return new WSNormalizer(set, isFinal);
    });

  /**
   * @description Normalize a value's whitespace, unless an exclusion applies.
   *
   * @param val - The value.
   * @param ctx - Where the value came from.
   *
   * @returns The normalized string, or `val` unchanged when normalization does not apply.
   */
  override parse = Effect.fnUntraced(function* (this: WSNormalizer, val: unknown, ctx?: Context): Effect.fn.Return<unknown, BuilderError> {
    if (typeof val !== 'string') return val;

    if (ctx) {
      // Only normalize element text, not attribute values
      if (ctx.isAttribute) return val;

      if (ctx.matcher) {
        // Respect xml:space="preserve" on any ancestor
        if ((yield* liftXml(ctx.matcher.getAnyParentAttr('xml:space'))) === 'preserve') return val;

        // Respect user-configured exclusion paths
        const size = yield* liftXml(this.#excludeSet.size());
        if (size > 0 && (yield* liftXml(this.#excludeSet.matchesAny(ctx.matcher)))) return val;
      }
    }

    return val.replace(/[ \t\r\n]+/g, ' ').trim();
  });
}
