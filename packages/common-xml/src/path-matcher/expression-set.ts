import { Effect } from 'effect';

import type { XmlError } from '../errors.ts';
import type Expression from './expression.ts';
import type Matcher from './matcher.ts';
import type { MatcherView } from './matcher.ts';

import { XmlError as XmlErrorCtor } from '../errors.ts';

/**
 * @description The failure a sealed set reports, built here so `add` reads as the guard rather than as the error's shape.
 *
 * @param size - How many patterns the sealed set holds, reported alongside the failure.
 *
 * @returns The effect that fails with it.
 */
const sealedSetFailure = (size: number): Effect.Effect<never, XmlError> =>
  Effect.fail(
    new XmlErrorCtor({
      reason: { _tag: 'SealedExpressionSet', size },
      message: 'ExpressionSet is sealed. Create a new ExpressionSet to add more expressions.',
    })
  );

/**
 * @description File an expression in an index bucket, creating that bucket on first use. Every index in the set routes through here, so "does this bucket exist
 * yet" is asked in one place rather than at each of the four call sites.
 *
 * @param buckets - The index to file into.
 * @param key - The bucket's key.
 * @param expression - The expression to file.
 */
const appendToBucket = <T>(buckets: Map<string | number, Expression<T>[]>, key: string | number, expression: Expression<T>): void => {
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, [expression]);
    return;
  }
  bucket.push(expression);
};

/**
 * @description The first expression in a bucket that matches, or `null` for an absent or exhausted bucket. This is the per-tag hot path, so an index with no
 * bucket for the current key costs one `Effect.succeed` rather than a scan.
 *
 * @param bucket - The expressions to try, or `undefined` when the index has no bucket for this key.
 * @param matcher - The matcher whose current path is tested against each of them.
 *
 * @returns The first matching expression, or `null`.
 */
const firstMatching = <T>(
  bucket: readonly Expression<T>[] | undefined,
  matcher: Matcher | MatcherView
): Effect.Effect<Expression<T> | null, XmlError> => {
  if (bucket === undefined) return Effect.succeed(null);

  return Effect.gen(function* () {
    for (const expression of bucket) {
      if (yield* (matcher as MatcherView).matches(expression)) return expression;
    }
    return null;
  });
};

/**
 * @description The deep-wildcard bucket for a terminal tag, or `undefined` on an empty path, which has no current tag and so no key to look up. The unindexed
 * deep-wildcard list still gets its turn in that case.
 *
 * @param byTag - The deep-wildcard index.
 * @param tag - The current tag, or `undefined` on an empty path.
 *
 * @returns The bucket, or `undefined`.
 */
const deepBucketFor = <T>(byTag: Map<string, Expression<T>[]>, tag: string | undefined): readonly Expression<T>[] | undefined =>
  tag === undefined ? undefined : byTag.get(tag);

/**
 * @description An indexed collection of {@link Expression}s for efficient bulk matching. Instead of iterating every expression on every tag, an `ExpressionSet`
 * pre-indexes them at insertion time by depth and terminal tag name. At match time only the relevant bucket is evaluated — typically reducing checks
 * from O(E) to an O(1) lookup plus a small bucket. `T` is the payload type of the expressions' {@link Expression.data}. Declare it to get that payload
 * back from {@link ExpressionSet.findMatch} without a cast; omit it and `data` is `unknown`.
 *
 * @example
 *   ```typescript
 *   // Build once at config time
 *   const stopNodes = new ExpressionSet();
 *   stopNodes.add(new Expression('root.users.user'));
 *   stopNodes.add(new Expression('root.config.setting'));
 *   stopNodes.add(new Expression('..script'));
 *
 *   // Query on every tag — hot path
 *   if (stopNodes.matchesAny(matcher)) {
 *     // handle stop node
 *   }
 *   ```;
 */
export default class ExpressionSet<T = unknown> {
  /**
   * @description Exact depth + exact tag name. The tightest bucket, and where most expressions live.
   */
  readonly #byDepthAndTag: Map<string, Expression<T>[]>;
  /**
   * @description Exact depth, terminal tag `*`. Indexed by depth only.
   */
  readonly #wildcardByDepth: Map<number, Expression<T>[]>;
  /**
   * @description Expressions containing `..` whose terminal segment is a wildcard, so they cannot be indexed by tag either.
   */
  readonly #deepWildcards: Expression<T>[];
  /**
   * @description Expressions containing `..` with a concrete terminal tag, indexed by that tag.
   */
  readonly #deepByTerminalTag: Map<string, Expression<T>[]>;
  /**
   * @description Pattern strings already added, for deduplication and for {@link ExpressionSet.size}.
   */
  readonly #patterns: Set<string>;
  /**
   * @description Whether {@link ExpressionSet.seal} has been called.
   */
  #sealed: boolean;

  constructor() {
    this.#byDepthAndTag = new Map();
    this.#wildcardByDepth = new Map();
    this.#deepWildcards = [];
    this.#deepByTerminalTag = new Map();
    this.#patterns = new Set();
    this.#sealed = false;
  }

  /**
   * @description Add one expression to the set, choosing its bucket from the pattern's shape. Duplicate patterns — same {@link Expression.pattern} string — are
   * silently ignored, so this is safe to call twice on the same input.
   *
   * @param expression - A pre-constructed expression.
   *
   * @returns An effect producing `this`, for chaining. Fails with {@link XmlError} and the `SealedExpressionSet` reason if the set has been sealed —
   *   a sealed set is the compiled snapshot a parser consults per tag, so mutating it after sealing would change what the hot path reads.
   */
  add = Effect.fnUntraced(function* (this: ExpressionSet<T>, expression: Expression<T>): Effect.fn.Return<ExpressionSet<T>, XmlError> {
    if (this.#sealed) {
      return yield* sealedSetFailure(this.#patterns.size);
    }

    // Deduplicate by pattern string
    if (this.#patterns.has(expression.pattern)) return this;
    this.#patterns.add(expression.pattern);

    if (yield* expression.hasDeepWildcard()) {
      this.#indexDeepWildcard(expression);
      return this;
    }

    yield* this.#indexByDepth(expression);
    return this;
  });

  /**
   * @description File a `..` expression. `..` breaks depth indexing, so these go by terminal tag when there is a concrete one, and into the unindexed list when
   * the last segment is itself a wildcard or has no tag to key on.
   *
   * @param expression - The expression to file.
   */
  #indexDeepWildcard(expression: Expression<T>): void {
    const lastSegment = expression.segments[expression.segments.length - 1];
    const tag = lastSegment?.type === 'deep-wildcard' ? undefined : lastSegment?.tag;

    if (tag === undefined || tag === '*') {
      this.#deepWildcards.push(expression);
      return;
    }
    appendToBucket(this.#deepByTerminalTag, tag, expression);
  }

  /**
   * @description File a depth-exact expression: by depth alone when its terminal tag is a wildcard or absent, and by depth plus tag when it names one, which is
   * the tightest bucket and where most expressions live.
   *
   * @param expression - The expression to file.
   *
   * @returns An effect that files it.
   */
  #indexByDepth(expression: Expression<T>): Effect.Effect<void, XmlError> {
    return Effect.map(expression.length(), depth => {
      const tag = expression.segments[expression.segments.length - 1]?.tag;

      if (!tag || tag === '*') {
        appendToBucket(this.#wildcardByDepth, depth, expression);
        return;
      }
      appendToBucket(this.#byDepthAndTag, `${depth}:${tag}`, expression);
    });
  }

  /**
   * @description Add several expressions at once.
   *
   * @param expressions - The expressions to register.
   *
   * @returns An effect producing `this`, for chaining. Fails with {@link XmlError} and the `SealedExpressionSet` reason if the set has been sealed.
   *   The expressions added before the failure are kept — the set is not rolled back, matching the original behaviour of a throw mid-loop.
   */
  addAll = Effect.fnUntraced(function* (this: ExpressionSet<T>, expressions: readonly Expression<T>[]) {
    for (const expr of expressions) {
      yield* this.add(expr);
    }
    return this;
  });

  /**
   * @description Whether an expression with the same pattern string is already in the set.
   *
   * @param expression - The expression to look up. Only its {@link Expression.pattern} is read, so any payload type is accepted.
   *
   * @returns An effect producing whether that pattern was already added. Infallible; the channel is empty because the package has one shape for its
   *   public surface.
   */
  has(expression: Expression<unknown>): Effect.Effect<boolean, XmlError> {
    return Effect.succeed(this.#patterns.has(expression.pattern));
  }

  /**
   * @description How many distinct patterns the set holds. Was a getter. A getter cannot return an effect, and the package has one shape for its public surface,
   * so it is a method now.
   *
   * @returns An effect producing the count. Infallible; the channel is empty.
   */
  size(): Effect.Effect<number, XmlError> {
    return Effect.succeed(this.#patterns.size);
  }

  /**
   * @description Whether {@link ExpressionSet.seal} has been called. A method rather than a getter, for the same reason as {@link ExpressionSet.size}.
   *
   * @returns An effect producing whether the set is sealed. Infallible; the channel is empty.
   */
  isSealed(): Effect.Effect<boolean, XmlError> {
    return Effect.succeed(this.#sealed);
  }

  /**
   * @description Seal the set against further additions, so a half-built config cannot be mutated once parsing has started. Reads still work.
   *
   * @returns An effect producing `this`, for chaining. Infallible; the channel is empty.
   */
  seal(): Effect.Effect<this, XmlError> {
    return Effect.sync(() => {
      this.#sealed = true;
      return this;
    });
  }

  /**
   * @description Whether the matcher's current path matches any expression in the set. Evaluation order, cheapest first:
   *
   * 1. Exact depth + tag bucket — an O(1) lookup, typically 0–2 expressions
   * 2. Depth-only wildcard bucket — an O(1) lookup, rare
   * 3. Deep-wildcard lists — always scanned, but usually small
   *
   * @example
   *   ```typescript
   *   if (stopNodes.matchesAny(matcher)) {
   *     // current tag is a stop node
   *   }
   *   ```;
   *
   * @param matcher - A `Matcher`, or a `MatcherView` obtained from {@link Matcher.readOnly}.
   *
   * @returns An effect producing whether at least one expression matches the current path.
   */
  matchesAny(matcher: Matcher | MatcherView): Effect.Effect<boolean, XmlError> {
    return Effect.map(this.findMatch(matcher), found => found !== null);
  }

  /**
   * @description The first expression in the set that matches the matcher's current path, or `null` if none does. Evaluates the same buckets as
   * {@link ExpressionSet.matchesAny}, in the same order, and returns the winner — so a caller that needs both the match and its {@link Expression.data}
   * pays for one lookup rather than a `matchesAny` followed by a scan.
   *
   * @param matcher - A `Matcher`, or a `MatcherView` obtained from {@link Matcher.readOnly}.
   *
   * @returns An effect producing the first matching expression, or `null`.
   */
  findMatch = Effect.fnUntraced(function* (this: ExpressionSet<T>, matcher: Matcher | MatcherView): Effect.fn.Return<Expression<T> | null, XmlError> {
    const depth = yield* matcher.getDepth();
    const tag = yield* matcher.getCurrentTag();

    // Cheapest bucket first: an O(1) depth+tag lookup where most expressions
    // live, then the depth-only wildcard bucket, then the deep-wildcard lists.
    // `??` short-circuits, so a bucket that matches nothing costs no more than
    // the lookup that found it empty.
    return (
      (yield* firstMatching(this.#byDepthAndTag.get(`${depth}:${tag}`), matcher)) ??
      (yield* firstMatching(this.#wildcardByDepth.get(depth), matcher)) ??
      (yield* firstMatching(deepBucketFor(this.#deepByTerminalTag, tag), matcher)) ??
      (yield* firstMatching(this.#deepWildcards, matcher))
    );
  });
}
