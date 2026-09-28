import { Effect } from 'effect';

import type { XmlError } from '../errors.ts';
import type Expression from './expression.ts';
import type Matcher from './matcher.ts';
import type { MatcherView } from './matcher.ts';

import { XmlError as XmlErrorCtor } from '../errors.ts';

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
      return yield* Effect.fail(
        new XmlErrorCtor({
          reason: { _tag: 'SealedExpressionSet', size: this.#patterns.size },
          message: 'ExpressionSet is sealed. Create a new ExpressionSet to add more expressions.',
        })
      );
    }

    // Deduplicate by pattern string
    if (this.#patterns.has(expression.pattern)) return this;
    this.#patterns.add(expression.pattern);

    if (yield* expression.hasDeepWildcard()) {
      // `..` breaks depth indexing, so these are indexed by terminal tag when
      // there is a concrete one, and fall back to an unindexed scan when the
      // last segment is a wildcard or has no tag to key on.
      const lastSeg = expression.segments[expression.segments.length - 1];
      const tag = lastSeg?.type === 'deep-wildcard' ? undefined : lastSeg?.tag;
      if (tag !== undefined && tag !== '*') {
        const bucket = this.#deepByTerminalTag.get(tag);
        if (bucket) {
          bucket.push(expression);
        } else {
          this.#deepByTerminalTag.set(tag, [expression]);
        }
      } else {
        this.#deepWildcards.push(expression);
      }
      return this;
    }

    const depth = yield* expression.length();
    const lastSeg = expression.segments[expression.segments.length - 1];
    const tag = lastSeg?.tag;

    if (!tag || tag === '*') {
      // Can index by depth but not by tag
      const bucket = this.#wildcardByDepth.get(depth);
      if (bucket) {
        bucket.push(expression);
      } else {
        this.#wildcardByDepth.set(depth, [expression]);
      }
    } else {
      // Tightest bucket: depth + tag
      const key = `${depth}:${tag}`;
      const bucket = this.#byDepthAndTag.get(key);
      if (bucket) {
        bucket.push(expression);
      } else {
        this.#byDepthAndTag.set(key, [expression]);
      }
    }

    return this;
  });

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

    // 1. Tightest bucket — most expressions live here
    const exactBucket = this.#byDepthAndTag.get(`${depth}:${tag}`);
    if (exactBucket) {
      for (const expression of exactBucket) {
        if (yield* (matcher as MatcherView).matches(expression)) return expression;
      }
    }

    // 2. Depth-matched wildcard-tag expressions
    const wildcardBucket = this.#wildcardByDepth.get(depth);
    if (wildcardBucket) {
      for (const expression of wildcardBucket) {
        if (yield* (matcher as MatcherView).matches(expression)) return expression;
      }
    }

    // 3. Deep wildcards — indexed by terminal tag, then unindexed fallback.
    // An empty path has no current tag, so there is no key to look up; the
    // unindexed list below still gets its turn.
    const deepBucket = tag === undefined ? undefined : this.#deepByTerminalTag.get(tag);
    if (deepBucket) {
      for (const expression of deepBucket) {
        if (yield* (matcher as MatcherView).matches(expression)) return expression;
      }
    }
    for (const expression of this.#deepWildcards) {
      if (yield* (matcher as MatcherView).matches(expression)) return expression;
    }

    return null;
  });
}
