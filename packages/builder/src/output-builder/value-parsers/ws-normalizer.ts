import type { Expression } from '@endevops/common-xml';

import { ExpressionSet } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { BuilderError } from '../../errors.ts';
import type { Context, ValueParser } from '../value-parser.ts';

import { addToSet, compilePattern } from '../../errors.ts';

/**
 * @description Options for the whitespace normalizer.
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
 * 4. The tag path matches a configured exclusion The exclusion set is built once and closed over, so nothing can add to it mid-parse.
 *
 * @param excludeSet - The compiled, sealed exclusion set.
 *
 * @returns The parser.
 */
const makeNormalizer = (excludeSet: ExpressionSet): ValueParser => ({
  /**
   * @description Stateless, but the registry requires a `reset` so a parser holding state can be cleared between documents.
   */
  reset(): void {},
  /**
   * @description Normalize a value's whitespace, unless an exclusion applies.
   *
   * @param val - The value.
   * @param ctx - Where the value came from.
   *
   * @returns The normalized string, or `val` unchanged when normalization does not apply.
   */
  parse: (val: unknown, ctx?: Context): Effect.Effect<unknown, BuilderError> => {
    if (typeof val !== 'string') return Effect.succeed(val);

    if (ctx) {
      // Only normalize element text, not attribute values
      if (ctx.isAttribute) return Effect.succeed(val);

      if (ctx.matcher) {
        // Respect xml:space="preserve" on any ancestor
        if (ctx.matcher.getAnyParentAttr('xml:space') === 'preserve') return Effect.succeed(val);

        // Respect user-configured exclusion paths
        if (excludeSet.size > 0 && excludeSet.matchesAny(ctx.matcher)) return Effect.succeed(val);
      }
    }

    return Effect.succeed(val.replace(/[ \t\r\n]+/g, ' ').trim());
  },
});

/**
 * @description The built-in default: a normalizer with no exclusions. Synchronous, and deliberately so. With no `exclude` there is nothing to compile, so this
 * case cannot fail — which is what lets the default registry stay a module-level value and lets every registry share the same instance. Anything that
 * _can_ fail goes through {@link makeWSNormalizer}.
 *
 * @param isFinal - Whether a normalization ends the chain. Defaults to false.
 *
 * @returns A normalizer with an empty, sealed exclusion set.
 */
export const wsNormalizerBuiltin = (isFinal = false): ValueParser => {
  void isFinal; // The normalizer never ends the chain; kept for chain-parity with the other parsers.
  const set = new ExpressionSet();
  set.seal();
  return makeNormalizer(set);
};

/**
 * @description Build a normalizer, compiling the configured exclusion paths. A factory rather than a constructor, because compiling the exclusions can fail — a
 * path that will not parse, or an add after a seal — and a constructor has nowhere to put an error channel.
 *
 * @param options - `exclude` lists the paths to leave alone.
 * @param isFinal - Whether a normalization ends the chain. Defaults to false.
 *
 * @returns An effect producing the normalizer. Fails with the `PatternCompilationFailed` reason when an exclusion does not compile.
 */
export const makeWSNormalizer = (options?: WSNormalizerOptions, isFinal = false): Effect.Effect<ValueParser, BuilderError> =>
  Effect.gen(function* () {
    void isFinal; // The normalizer never ends the chain; kept for chain-parity with the other parsers.
    const exclude = options?.exclude ?? [];
    const set = new ExpressionSet();
    for (const entry of exclude) {
      const compiled = typeof entry === 'string' ? yield* compilePattern(entry) : entry;
      yield* addToSet(set, compiled);
    }
    set.seal();
    return makeNormalizer(set);
  });
