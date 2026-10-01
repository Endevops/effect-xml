/**
 * @description Efficient path tracking and pattern matching for XML/JSON parsers. A parser walks the tree once, pushing and popping a {@link Matcher}. Configured
 * patterns — stop nodes, skip tags, value parsers, anything keyed on where you are — are compiled once into {@link Expression}s and held in an
 * {@link ExpressionSet}, which indexes them by depth and terminal tag so the per-tag check is a bucket lookup rather than a scan.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import { Expression, ExpressionSet, Matcher } from '@endevops/common-xml';
 *
 *   // Compile once at config time. `add` can fail on a sealed set, so it is an effect.
 *   const stopNodes = Effect.runSync(
 *   Effect.gen(function* () {
 *   const set = new ExpressionSet();
 *   yield* set.add(new Expression('root.users.user'));
 *   yield* set.add(new Expression('..script'));
 *   return set.seal();
 *   })
 *   );
 *
 *   // Walk the tree. Every read is plain.
 *   const matcher = new Matcher();
 *   matcher.push('root', {});
 *   matcher.push('users', {});
 *   matcher.push('user', { id: '123', type: 'admin' }, null, { keep: ['type'] });
 *
 *   stopNodes.matchesAny(matcher); // false
 *   matcher.matches(new Expression('root.users.user')); // true
 *   matcher.getAnyParentAttr('type'); // 'admin'
 *   ```;
 */

import type { ExpressionOptions, PositionSelector, Segment } from './expression.ts';
import type { KeptAttrEntry, MatcherOptions, MatcherSnapshot, PathNode, PushOptions, ReadOnlyMatcher, SiblingLevel } from './matcher.ts';

import ExpressionSet from './expression-set.ts';
import Expression from './expression.ts';
import { Matcher, MatcherView } from './matcher.ts';

export { Expression, ExpressionSet, Matcher, MatcherView };
export type {
  ExpressionOptions,
  KeptAttrEntry,
  MatcherOptions,
  MatcherSnapshot,
  PathNode,
  PositionSelector,
  PushOptions,
  ReadOnlyMatcher,
  Segment,
  SiblingLevel,
};
