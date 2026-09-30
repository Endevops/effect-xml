import { Effect } from 'effect';

import type { XmlError } from '../errors.ts';
import type Expression from './expression.ts';
import type { PositionSelector, Segment } from './expression.ts';

import ExpressionSet from './expression-set.ts';

/**
 * @description Options for {@link Matcher}.
 */
export interface MatcherOptions {
  /**
   * @description Default path separator, used by {@link Matcher.toString} when it is not given one. Defaults to `'.'`.
   */
  separator?: string;
}

/**
 * @description One node on the matcher's path stack.
 */
export interface PathNode {
  /**
   * @description The tag name.
   */
  tag: string;
  /**
   * @description The tag's namespace, if the parser reported one.
   */
  namespace?: string;
  /**
   * @description Index among all children seen at this level, zero-based. This is the child index within its parent.
   */
  position: number;
  /**
   * @description How many times this tag name has appeared at this level, zero-based. Unlike {@link PathNode.position}, same-name siblings advance this one and
   * differently-named siblings do not — which is what `user:first` selects on.
   */
  counter: number;
  /**
   * @description Attribute values for this node. Only the top-of-stack node keeps them; pushing a new node clears the previous one's, so memory stays proportional
   * to the current node rather than the path depth. The explicit `| undefined` is what lets {@link Matcher.push} clear the value in place rather than
   * `delete`-ing the key — the difference matters on a path walked once per tag, and every read already guards for `undefined`.
   */
  values?: Record<string, unknown> | undefined;
}

/**
 * @description Sibling bookkeeping for one level of the path: how many times each tag name has been seen, and how many children in total.
 */
export interface SiblingLevel {
  /**
   * @description Occurrence count per tag name. The key includes the namespace when there is one, so `<ns:a>` and `<a>` count separately.
   */
  counts: Map<string, number>;
  /**
   * @description Running total of children seen at this level. Kept as a running number rather than re-derived from {@link SiblingLevel.counts} on every push,
   * which would make a push cost more the more distinct tag names the parent had.
   */
  total: number;
}

/**
 * @description A single entry in the matcher's kept-attributes stack: an attribute value explicitly retained at push time via {@link PushOptions.keep} so it stays
 * reachable from descendants after the owning node is no longer current.
 */
export interface KeptAttrEntry {
  /**
   * @description One-based path depth of the node that declared this kept attribute.
   */
  depth: number;
  /**
   * @description The attribute name.
   */
  name: string;
  /**
   * @description The attribute value at push time.
   */
  value: unknown;
}

/**
 * @description A copy of the matcher's whole state, for rewinding a parse or forking a sub-parse.
 */
export interface MatcherSnapshot {
  /**
   * @description Copy of the path stack.
   */
  path: PathNode[];
  /**
   * @description Copy of the per-level sibling bookkeeping.
   */
  siblingStacks: SiblingLevel[];
  /**
   * @description Copy of the kept-attributes stack. See {@link PushOptions.keep}.
   */
  keptAttrs: KeptAttrEntry[];
}

/**
 * @description Options for {@link Matcher.push}.
 */
export interface PushOptions {
  /**
   * @description Names of attributes to retain for ancestor lookup — {@link Matcher.getAnyParentAttr} and {@link Matcher.hasAnyParentAttr} — even after this node
   * stops being the current node. Use sparingly. This is for attributes you know you'll need much deeper in the tree, such as `xml:space` or a SOAP
   * envelope's `version`, not a general substitute for {@link Matcher.getAttrValue}. Cost is proportional to `keep.length` and independent of path
   * depth.
   */
  keep?: string[];
}

/**
 * @description A read-only view over a {@link Matcher}, safe to hand to user callbacks. Created once by the matcher and reused, so passing it around allocates
 * nothing. It holds a direct reference to the parent's state, so it always reflects the current position with no copying or freezing. The mutation
 * methods — `push`, `pop`, `reset`, `updateCurrent`, `restore` — are absent from this class, so misuse is caught by the compiler rather than at
 * runtime.
 *
 * @example
 *   ```typescript
 *   const matcher = new Matcher();
 *   const view = matcher.readOnly();
 *
 *   matcher.push('root', {});
 *   view.getCurrentTag(); // 'root'
 *   view.getDepth(); // 1
 *   ```;
 */
export class MatcherView {
  readonly #matcher: Matcher;

  /**
   * @description Wrap a matcher. Called by {@link Matcher} itself; there is no reason to construct one directly.
   *
   * @param matcher - The matcher to read from.
   */
  constructor(matcher: Matcher) {
    this.#matcher = matcher;
  }

  /**
   * @description The path separator the parent matcher was configured with.
   */
  get separator(): string {
    return this.#matcher.separator;
  }

  /**
   * @description The current tag name, or `undefined` on an empty path.
   */
  getCurrentTag(): Effect.Effect<string | undefined, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const path = this.#matcher.path;
      return path.length > 0 ? path[path.length - 1]?.tag : undefined;
    });
  }

  /**
   * @description The current tag's namespace, or `undefined` if it has none or the path is empty.
   */
  getCurrentNamespace(): Effect.Effect<string | undefined, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const path = this.#matcher.path;
      return path.length > 0 ? path[path.length - 1]?.namespace : undefined;
    });
  }

  /**
   * @description The current node's value for `attrName`, or `undefined` if the node has no such attribute.
   *
   * @param attrName - The attribute to read.
   *
   * @returns The attribute value, or `undefined`.
   */
  getAttrValue(attrName: string): Effect.Effect<unknown, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const path = this.#matcher.path;
      if (path.length === 0) return undefined;
      return path[path.length - 1]?.values?.[attrName];
    });
  }

  /**
   * @description Whether the current node has `attrName`.
   *
   * @param attrName - The attribute to test.
   *
   * @returns Whether the attribute is present on the current node.
   */
  hasAttr(attrName: string): Effect.Effect<boolean, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const path = this.#matcher.path;
      if (path.length === 0) return false;
      const current = path[path.length - 1];
      return current !== undefined && current.values !== undefined && attrName in current.values;
    });
  }

  /**
   * @description The value of a kept attribute, from the nearest ancestor — or the current node — that declared it via `push(tag, attrs, ns, { keep: [...] })`.
   *
   * @param attrName - The attribute to look for.
   *
   * @returns The value, or `undefined` if no ancestor kept this attribute.
   */
  getAnyParentAttr(attrName: string): Effect.Effect<unknown, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      return yield* this.#matcher.getAnyParentAttr(attrName);
    });
  }

  /**
   * @description Whether any ancestor — or the current node — kept `attrName` via `push(tag, attrs, ns, { keep: [...] })`.
   *
   * @param attrName - The attribute to look for.
   *
   * @returns Whether a kept entry with that name exists.
   */
  hasAnyParentAttr(attrName: string): Effect.Effect<boolean, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      return yield* this.#matcher.hasAnyParentAttr(attrName);
    });
  }

  /**
   * @description The current node's index among its siblings, or `-1` on an empty path.
   */
  getPosition(): Effect.Effect<number, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const path = this.#matcher.path;
      if (path.length === 0) return -1;
      return path[path.length - 1]?.position ?? 0;
    });
  }

  /**
   * @description The current node's occurrence count among same-named siblings, or `-1` on an empty path.
   */
  getCounter(): Effect.Effect<number, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const path = this.#matcher.path;
      if (path.length === 0) return -1;
      return path[path.length - 1]?.counter ?? 0;
    });
  }

  /**
   * @description Alias for {@link MatcherView.getPosition}.
   *
   * @deprecated Use {@link MatcherView.getPosition} or {@link MatcherView.getCounter} instead.
   *
   * @returns The current node's sibling index.
   */
  getIndex(): Effect.Effect<number, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      return yield* this.getPosition();
    });
  }

  /**
   * @description The current path depth, zero on an empty path.
   */
  getDepth(): Effect.Effect<number, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#matcher.path.length;
    });
  }

  /**
   * @description The current path as a string.
   *
   * @param separator - Separator to join with. Defaults to the matcher's own.
   * @param includeNamespace - Prefix each namespaced tag with its namespace. Defaults to true.
   *
   * @returns The joined path.
   */
  toString(separator?: string, includeNamespace = true): Effect.Effect<string, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.map(this.#matcher.toString(separator, includeNamespace), joined => joined);
  }

  /**
   * @description The current path as an array of tag names, namespaces omitted.
   *
   * @returns One entry per level, root first.
   */
  toArray(): Effect.Effect<string[], XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#matcher.path.map(n => n.tag);
    });
  }

  /**
   * @description Match the current path against one expression.
   *
   * @param expression - The expression to test.
   *
   * @returns Whether the current path matches.
   */
  matches(expression: Expression): Effect.Effect<boolean, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      return yield* this.#matcher.matches(expression);
    });
  }

  /**
   * @description Match the current path against every expression in a set. Published API on a type a caller receives in their own callback, so nothing inside this
   * repository calls it — every internal caller holds the {@link ExpressionSet} and calls `matchesAny` on that instead. Deleting it would be a
   * breaking change to a released package to satisfy a reachability check that cannot see a caller's code.
   *
   * @param exprSet - The set to test against.
   *
   * @returns Whether any expression in the set matches.
   */
  // fallow-ignore-next-line unused-class-member
  matchesAny(exprSet: ExpressionSet): Effect.Effect<boolean, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      return yield* exprSet.matchesAny(this.#matcher);
    });
  }
}

// ---------------------------------------------------------------------------
// Segment rules
//
// Pure functions over one pattern segment and one path node, so that each kind
// of condition reads on its own and `#matchSegment` collapses to a conjunction
// of them. None of these touches matcher state, which is what makes the
// attribute and position rules readable as plain predicates.
// ---------------------------------------------------------------------------

/**
 * @description Whether a segment's tag name selects a node. `'*'` selects any tag; a segment that resolved to no tag at all selects none.
 *
 * @param segment - The pattern segment.
 * @param node - The path node to test it against.
 *
 * @returns Whether the tag names agree.
 */
const tagNameMatches = (segment: Segment, node: PathNode): boolean => segment.tag === '*' || segment.tag === node.tag;

/**
 * @description Whether a segment's namespace qualifier selects a node. A segment that specified none matches any namespace, as does `'*'`.
 *
 * @param segment - The pattern segment.
 * @param node - The path node to test it against.
 *
 * @returns Whether the namespaces agree.
 */
const namespaceMatches = (segment: Segment, node: PathNode): boolean =>
  segment.namespace === undefined || segment.namespace === '*' || segment.namespace === node.namespace;

/**
 * @description Whether a segment's `[attr]` or `[attr=value]` condition holds. An attribute condition describes the tag being opened rather than an ancestor, so
 * it fails against every node but the current one. The value comparison is string-to-string, which is what lets `user[count=5]` match a numeric `5`.
 *
 * @param segment - The pattern segment.
 * @param node - The path node to test it against.
 * @param isCurrentNode - Whether `node` is the top of the stack.
 *
 * @returns Whether the condition holds, vacuously for a segment that carries none.
 */
const attributeConditionMatches = (segment: Segment, node: PathNode, isCurrentNode: boolean): boolean => {
  if (segment.attrName === undefined) return true;
  if (!isCurrentNode) return false;

  const values = node.values;
  if (!values || !(segment.attrName in values)) return false;
  if (segment.attrValue === undefined) return true;
  return String(values[segment.attrName]) === String(segment.attrValue);
};

/**
 * @description Whether a node's sibling counter satisfies a position selector. `last` is parsed and carried on a segment but has no rule here, so it never rejects
 * — the one selector that selects rather than filters.
 *
 * @param position - The selector the pattern asked for.
 * @param counter - The node's occurrence count among same-named siblings, zero-based.
 * @param positionValue - Which occurrence `nth` selects, for the `nth` selector only.
 *
 * @returns Whether the counter satisfies the selector.
 */
const counterSatisfies = (position: PositionSelector, counter: number, positionValue: number | undefined): boolean => {
  switch (position) {
    case 'first':
      return counter === 0;
    case 'odd':
      return counter % 2 === 1;
    case 'even':
      return counter % 2 === 0;
    case 'nth':
      return counter === positionValue;
    case 'last':
      return true;
  }
};

/**
 * @description Whether a segment's `:first` / `:odd` / `:even` / `:nth(n)` condition holds. Like an attribute condition, a position describes the tag being
 * opened, so it fails against every node but the current one.
 *
 * @param segment - The pattern segment.
 * @param node - The path node to test it against.
 * @param isCurrentNode - Whether `node` is the top of the stack.
 *
 * @returns Whether the condition holds, vacuously for a segment that carries none.
 */
const positionConditionMatches = (segment: Segment, node: PathNode, isCurrentNode: boolean): boolean => {
  if (segment.position === undefined) return true;
  if (!isCurrentNode) return false;
  return counterSatisfies(segment.position, node.counter ?? 0, segment.positionValue);
};

/**
 * @description The two counters a node pushed onto a level receives, read off that level's bookkeeping before it is advanced.
 */
interface SiblingCounters {
  /**
   * @description How many times this tag name had already appeared at this level, zero-based.
   */
  counter: number;
  /**
   * @description How many children in total had been seen at this level before this one.
   */
  position: number;
}

/**
 * @description Build the path node for a push. Namespace and attribute values are attached only when they were actually supplied, so a node with neither leaves
 * both keys absent rather than present-and-undefined.
 *
 * @param tagName - The tag being entered.
 * @param attrValues - Its attribute values, or `null`.
 * @param namespace - Its namespace, or `null`.
 * @param counters - The sibling counters read for this level.
 *
 * @returns The node to push.
 */
const buildPathNode = (
  tagName: string,
  attrValues: Record<string, unknown> | null,
  namespace: string | null,
  counters: SiblingCounters
): PathNode => {
  const node: PathNode = { tag: tagName, position: counters.position, counter: counters.counter };
  if (namespace !== null && namespace !== undefined) {
    node.namespace = namespace;
  }
  if (attrValues !== null && attrValues !== undefined) {
    node.values = attrValues;
  }
  return node;
};

/**
 * @description Where the deep-wildcard walk resumes, or how it ended. Returned as a value rather than signalled by a return type, so the walk hands a decision
 * back to its loop without the cursors and the sentinels sharing one return position.
 */
type DeepStep =
  | {
      /**
       * @description The segment at `segIdx` was placed against the node at `pathIdx`, and both cursors move inwards from there.
       */
      readonly status: 'matched';
      /**
       * @description The next path level to consider, one below the one just consumed.
       */
      readonly pathIdx: number;
      /**
       * @description The next pattern segment to place, one below the one just consumed.
       */
      readonly segIdx: number;
    }
  /**
   * @description The walk reached a `..` in final position, which absorbs everything still left of the path.
   */
  | { readonly status: 'exhausted' }
  /**
   * @description A segment could not be placed, so the pattern does not match.
   */
  | { readonly status: 'failed' };

/**
 * @description A `..` in final position, which absorbs every path level still left.
 */
const DEEP_STEP_EXHAUSTED: DeepStep = { status: 'exhausted' };

/**
 * @description A segment that could not be placed, so the pattern does not match.
 */
const DEEP_STEP_FAILED: DeepStep = { status: 'failed' };

/**
 * @description Tracks the current path through an XML/JSON tree and matches it against {@link Expression}s. The matcher keeps a stack of {@link PathNode}s from root
 * to the current tag, and only the topmost node retains attribute values, so memory stays proportional to one node rather than the depth. Sibling
 * bookkeeping per level yields {@link PathNode.position} and {@link PathNode.counter} automatically. Push and pop as the parser walks the tree, then
 * ask questions with {@link Matcher.matches} or hand a {@link MatcherView} to a callback.
 *
 * @example
 *   ```typescript
 *   const matcher = new Matcher();
 *   matcher.push('root', {});
 *   matcher.push('users', {});
 *   matcher.push('user', { id: '123', type: 'admin' });
 *
 *   matcher.matches(new Expression('root.users.user')); // true
 *
 *   matcher.pop();
 *   matcher.matches(new Expression('root.users.user')); // false
 *   ```;
 */
class Matcher {
  /**
   * @description The path separator, used by {@link Matcher.toString} when it is not given one.
   */
  readonly separator: string;
  /**
   * @description The path stack, root first. Attribute values live only on the last entry.
   */
  path: PathNode[];
  /**
   * @description Sibling bookkeeping, parallel to {@link Matcher.path}.
   */
  siblingStacks: SiblingLevel[];

  /**
   * @description Memoised result of the default-form {@link Matcher.toString}, dropped on every mutation.
   */
  #pathStringCache: string | null;
  /**
   * @description The single reusable view handed out by {@link Matcher.readOnly}.
   */
  readonly #view: MatcherView;
  /**
   * @description Depth-ordered stack of attributes retained via {@link PushOptions.keep}.
   */
  #keptAttrs: KeptAttrEntry[];

  /**
   * @description Create an empty matcher at the root.
   *
   * @param options - Configuration options.
   */
  constructor(options: MatcherOptions = {}) {
    this.separator = options.separator || '.';
    this.path = [];
    this.siblingStacks = [];
    this.#pathStringCache = null;
    this.#view = new MatcherView(this);
    this.#keptAttrs = [];
  }

  /**
   * @description The top-of-stack node, or `undefined` on an empty path.
   */
  get #current(): PathNode | undefined {
    return this.path[this.path.length - 1];
  }

  /**
   * @description Descend into a tag: extend the path, derive its sibling counters, and retain any attributes named in `options.keep`.
   *
   * @param tagName - The tag being entered.
   * @param attrValues - Its attribute values. Only the current node keeps these; the node it displaces drops its own.
   * @param namespace - Its namespace, if any. Part of the sibling key, so `<ns:a>` and `<a>` count separately.
   * @param options - Push options, e.g. `{ keep: ['version'] }`.
   */
  push(
    tagName: string,
    attrValues: Record<string, unknown> | null = null,
    namespace: string | null = null,
    options: PushOptions | null = null
  ): Effect.Effect<void, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      this.#pathStringCache = null;
      this.#releaseCurrentValues();
      const counters = this.#advanceSiblingCounters(tagName, namespace);
      this.path.push(buildPathNode(tagName, attrValues, namespace, counters));
      // `#retainKeptAttrs` reads the depth off the stack, so it runs after the push.
      this.#retainKeptAttrs(attrValues, options);
    });
  }

  /**
   * @description Drop the current node's attribute values, because the node it is about to become an ancestor must not hold them — memory stays proportional to
   * one node rather than to the path depth.
   */
  #releaseCurrentValues(): void {
    const previous = this.#current;
    if (previous !== undefined) {
      previous.values = undefined;
    }
  }

  /**
   * @description The sibling bookkeeping for the level the path is about to descend into, created on first descent into it.
   *
   * @param currentLevel - The depth being entered, which is the path's current length.
   *
   * @returns The level's bookkeeping.
   */
  #siblingLevelAt(currentLevel: number): SiblingLevel {
    const existing = this.siblingStacks[currentLevel];
    if (existing !== undefined) return existing;
    const created: SiblingLevel = { counts: new Map(), total: 0 };
    this.siblingStacks[currentLevel] = created;
    return created;
  }

  /**
   * @description Read the counters for a node about to be pushed at the current level, and advance that level's bookkeeping past it. The namespace is part of the
   * sibling key, so `<ns:a>` and `<a>` are counted as differently-named siblings.
   *
   * @param tagName - The tag being entered.
   * @param namespace - Its namespace, or `null`.
   *
   * @returns The counters to build the node with.
   */
  #advanceSiblingCounters(tagName: string, namespace: string | null): SiblingCounters {
    const level = this.#siblingLevelAt(this.path.length);
    const siblingKey = namespace ? `${namespace}:${tagName}` : tagName;
    const counter = level.counts.get(siblingKey) ?? 0;
    const position = level.total;
    level.counts.set(siblingKey, counter + 1);
    level.total++;
    return { counter, position };
  }

  /**
   * @description The attribute names a push asked to retain, or `undefined` when it asked for none. `options` is read exactly as the caller passed it, so an
   * explicit `null` and an absent argument behave identically.
   *
   * @param options - Push options, e.g. `{ keep: ['version'] }`.
   *
   * @returns The names to retain.
   */
  #keepNames(options: PushOptions | null): string[] | undefined {
    const keep = options !== null ? options.keep : null;
    return keep !== null && keep !== undefined && keep.length > 0 ? keep : undefined;
  }

  /**
   * @description Copy the requested attributes into the kept-attrs stack, so they stay reachable from descendants after this node stops being current. This is the
   * one part of `push` whose cost scales with input (O(keep.length)) rather than being O(1) — by design, since the caller is explicitly opting in for
   * specific attribute names. A name the pushed node does not carry produces no entry, and a node with no attributes at all produces none either.
   *
   * @param attrValues - The pushed node's attribute values.
   * @param options - Push options, e.g. `{ keep: ['version'] }`.
   */
  #retainKeptAttrs(attrValues: Record<string, unknown> | null, options: PushOptions | null): void {
    const keep = this.#keepNames(options);
    if (keep === undefined) return;
    if (attrValues === null || attrValues === undefined) return;

    const depth = this.path.length;
    for (const name of keep) {
      if (name === undefined || attrValues[name] === undefined) continue;
      this.#keptAttrs.push({ depth, name, value: attrValues[name] });
    }
  }

  /**
   * @description Ascend out of the current tag, dropping its attribute values and any kept attributes it owned.
   *
   * @returns The popped node, or `undefined` if the path was already empty.
   */
  pop(): Effect.Effect<PathNode | undefined, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      if (this.path.length === 0) return undefined;
      this.#pathStringCache = null;

      const node = this.path.pop();

      if (this.siblingStacks.length > this.path.length + 1) {
        this.siblingStacks.length = this.path.length + 1;
      }

      // Drop any kept attributes that belonged to the popped node (or deeper).
      // #keptAttrs is depth-ordered (push only ever appends increasing depths),
      // so this is a backward scan that stops at the first surviving entry —
      // typically O(1) since kept attrs are rare by design.
      const poppedDepth = this.path.length + 1;
      while (this.#keptAttrs.length > 0) {
        const last = this.#keptAttrs[this.#keptAttrs.length - 1];
        if (last === undefined || last.depth < poppedDepth) break;
        this.#keptAttrs.pop();
      }

      return node;
    });
  }

  /**
   * @description Set the current node's attribute values, for when they are only known after the push.
   *
   * @param attrValues - The attribute values.
   */
  updateCurrent(attrValues: Record<string, unknown>): Effect.Effect<void, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const current = this.#current;
      if (current !== undefined && attrValues !== null && attrValues !== undefined) {
        current.values = attrValues;
      }
    });
  }

  /**
   * @description The current tag name, or `undefined` on an empty path.
   */
  getCurrentTag(): Effect.Effect<string | undefined, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#current?.tag;
    });
  }

  /**
   * @description The current tag's namespace, or `undefined` if it has none or the path is empty.
   */
  getCurrentNamespace(): Effect.Effect<string | undefined, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#current?.namespace;
    });
  }

  /**
   * @description The current node's value for `attrName`, or `undefined` if the node has no such attribute.
   *
   * @param attrName - The attribute to read.
   *
   * @returns The attribute value, or `undefined`.
   */
  getAttrValue(attrName: string): Effect.Effect<unknown, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#current?.values?.[attrName];
    });
  }

  /**
   * @description Whether the current node has `attrName`.
   *
   * @param attrName - The attribute to test.
   *
   * @returns Whether the attribute is present on the current node.
   */
  hasAttr(attrName: string): Effect.Effect<boolean, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const current = this.#current;
      return current !== undefined && current.values !== undefined && attrName in current.values;
    });
  }

  /**
   * @description The value of a kept attribute, from the nearest ancestor — or the current node — that declared it via `push(tag, attrs, ns, { keep: [...] })`.
   * Unlike {@link Matcher.getAttrValue}, this keeps working however deep the path has gone since the attribute was pushed, but only for names that
   * were explicitly marked with `keep`. Cost is proportional to the number of currently-kept attributes, not to path depth.
   *
   * @param attrName - The attribute to look for.
   *
   * @returns The value, or `undefined` if no ancestor kept this attribute.
   */
  getAnyParentAttr(attrName: string): Effect.Effect<unknown, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const kept = this.#keptAttrs;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i]?.name === attrName) return kept[i]?.value;
      }
      return undefined;
    });
  }

  /**
   * @description Whether any ancestor — or the current node — kept `attrName` via `push(tag, attrs, ns, { keep: [...] })`.
   *
   * @param attrName - The attribute to look for.
   *
   * @returns Whether a kept entry with that name exists.
   */
  hasAnyParentAttr(attrName: string): Effect.Effect<boolean, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const kept = this.#keptAttrs;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i]?.name === attrName) return true;
      }
      return false;
    });
  }

  /**
   * @description The current node's index among its siblings, or `-1` on an empty path.
   */
  getPosition(): Effect.Effect<number, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const current = this.#current;
      if (current === undefined) return -1;
      return current.position ?? 0;
    });
  }

  /**
   * @description The current node's occurrence count among same-named siblings, or `-1` on an empty path.
   */
  getCounter(): Effect.Effect<number, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const current = this.#current;
      if (current === undefined) return -1;
      return current.counter ?? 0;
    });
  }

  /**
   * @description Alias for {@link Matcher.getPosition}.
   *
   * @deprecated Use {@link Matcher.getPosition} or {@link Matcher.getCounter} instead.
   *
   * Kept because it is already released: the whole point of a deprecated alias is that callers who never migrate keep working, so there is nothing left to
   * clean up once they do.
   *
   * @returns The current node's sibling index.
   */
  // fallow-ignore-next-line unused-class-member
  getIndex(): Effect.Effect<number, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      return yield* this.getPosition();
    });
  }

  /**
   * @description The current path depth, zero on an empty path.
   */
  getDepth(): Effect.Effect<number, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.path.length;
    });
  }

  /**
   * @description The current path as a string. The default form — the matcher's own separator, namespaces included — is memoised, because it is the form a
   * hot-path match asks for and the result only changes when the path does. Any other combination is computed directly.
   *
   * @param separator - Separator to join with. Defaults to the matcher's own.
   * @param includeNamespace - Prefix each namespaced tag with its namespace. Defaults to true.
   *
   * @returns The joined path.
   */
  toString(separator?: string, includeNamespace = true): Effect.Effect<string, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      const sep = separator || this.separator;
      const isDefault = sep === this.separator && includeNamespace === true;

      if (isDefault) {
        if (this.#pathStringCache !== null) {
          return this.#pathStringCache;
        }
        const result = this.path.map(n => (n.namespace ? `${n.namespace}:${n.tag}` : n.tag)).join(sep);
        this.#pathStringCache = result;
        return result;
      }

      return this.path.map(n => (includeNamespace && n.namespace ? `${n.namespace}:${n.tag}` : n.tag)).join(sep);
    });
  }

  /**
   * @description The current path as an array of tag names, namespaces omitted. Released API, kept. The internal callers read `path` directly, and the equivalent
   * member on {@link MatcherView} is the one a callback gets, so nothing here calls this — which is what a public method on a published class looks
   * like from inside its own repository.
   *
   * @returns One entry per level, root first.
   */
  // fallow-ignore-next-line unused-class-member
  toArray(): Effect.Effect<string[], XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.path.map(n => n.tag);
    });
  }

  /**
   * @description Return to the empty path, dropping the path, the sibling bookkeeping and every kept attribute.
   */
  reset(): Effect.Effect<void, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      this.#pathStringCache = null;
      this.path = [];
      this.siblingStacks = [];
      this.#keptAttrs = [];
    });
  }

  /**
   * @description Match the current path against one expression.
   *
   * @param expression - The expression to test.
   *
   * @returns Whether the current path matches.
   */
  matches(expression: Expression): Effect.Effect<boolean, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      const segments = expression.segments;

      if (segments.length === 0) {
        return false;
      }

      if (yield* expression.hasDeepWildcard()) {
        return yield* this.#matchWithDeepWildcard(segments);
      }

      return yield* this.#matchSimple(segments);
    });
  }

  /**
   * @description Depth-exact match: the path and the pattern must be the same length, segment for segment.
   *
   * @param segments - The pattern's segments.
   *
   * @returns Whether every segment matches.
   */
  #matchSimple(segments: readonly Segment[]): Effect.Effect<boolean, XmlError> {
    return Effect.gen({ self: this }, function* () {
      if (this.path.length !== segments.length) {
        return false;
      }

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const node = this.path[i];
        if (segment === undefined || node === undefined) return false;
        if (!(yield* this.#matchSegment(segment, node, i === this.path.length - 1))) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * @description Match with `..` allowed to absorb any number of levels, walking both sequences backwards. Runs right to left because a trailing `..` can absorb a
   * variable-length run of path levels: each time one is hit, the next literal segment is searched backwards for the deepest position it fits, and
   * matching resumes from there.
   *
   * @param segments - The pattern's segments.
   *
   * @returns Whether the pattern is exhausted against the path.
   */
  #matchWithDeepWildcard(segments: readonly Segment[]): Effect.Effect<boolean, XmlError> {
    return Effect.gen({ self: this }, function* () {
      let pathIdx = this.path.length - 1;
      let segIdx = segments.length - 1;

      while (segIdx >= 0 && pathIdx >= 0) {
        const step = yield* this.#deepStep(segments, segIdx, pathIdx);
        if (step.status === 'failed') return false;
        // A `..` in final position absorbs everything still left of the path.
        if (step.status === 'exhausted') return true;
        pathIdx = step.pathIdx;
        segIdx = step.segIdx;
      }

      // Running out of path first means the pattern still had segments to place.
      return segIdx < 0;
    });
  }

  /**
   * @description Take one step of the deep-wildcard walk: place the segment at `segIdx` against the node at `pathIdx`, or let a `..` absorb a run of path levels.
   *
   * @param segments - The pattern's segments.
   * @param segIdx - The segment the walk is currently on.
   * @param pathIdx - The path node the walk is currently on.
   *
   * @returns Where the walk resumes, or how it ended.
   */
  #deepStep(segments: readonly Segment[], segIdx: number, pathIdx: number): Effect.Effect<DeepStep, XmlError> {
    const segment = segments[segIdx];
    if (segment === undefined) return Effect.succeed(DEEP_STEP_FAILED);
    if (segment.type === 'deep-wildcard') return this.#deepStepWildcard(segments, segIdx, pathIdx);
    return this.#deepStepLiteral(segment, segIdx, pathIdx);
  }

  /**
   * @description The non-`..` arm of {@link Matcher.#deepStep}: the segment has to match the node at `pathIdx` exactly, and the walk continues from the level below
   * it.
   *
   * @param segment - The segment to place.
   * @param segIdx - The index the segment sits at.
   * @param pathIdx - The index the node sits at.
   *
   * @returns Where the walk resumes, or that it failed.
   */
  #deepStepLiteral(segment: Segment, segIdx: number, pathIdx: number): Effect.Effect<DeepStep, XmlError> {
    const node = this.path[pathIdx];
    if (node === undefined) return Effect.succeed(DEEP_STEP_FAILED);

    return Effect.map(this.#matchSegment(segment, node, pathIdx === this.path.length - 1), matched => {
      return matched ? { status: 'matched', pathIdx: pathIdx - 1, segIdx: segIdx - 1 } : DEEP_STEP_FAILED;
    });
  }

  /**
   * @description The `..` arm of {@link Matcher.#deepStep}. In final position the wildcard has absorbed everything left of the path. Otherwise the segment standing
   * directly above it is searched backwards from `pathIdx` for the deepest node it fits, so the wildcard absorbs the run of levels above that — zero
   * levels included, since the node at `pathIdx` is itself a candidate.
   *
   * @param segments - The pattern's segments.
   * @param segIdx - The index the wildcard sits at.
   * @param pathIdx - The deepest path level still available to the wildcard.
   *
   * @returns Where the walk resumes, or how it ended.
   */
  #deepStepWildcard(segments: readonly Segment[], segIdx: number, pathIdx: number): Effect.Effect<DeepStep, XmlError> {
    if (segIdx === 0) return Effect.succeed(DEEP_STEP_EXHAUSTED);
    const absorbed = segments[segIdx - 1];
    if (absorbed === undefined) return Effect.succeed(DEEP_STEP_FAILED);

    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    return Effect.gen({ self: this }, function* () {
      for (let i = pathIdx; i >= 0; i--) {
        const node = this.path[i];
        if (node === undefined) continue;
        if (yield* this.#matchSegment(absorbed, node, i === this.path.length - 1)) {
          // Placing `absorbed` consumes two pattern segments — the wildcard and
          // the segment above it — against one path level, so the pattern cursor
          // moves in by two while the path cursor moves in by one.
          return { status: 'matched', pathIdx: i - 1, segIdx: segIdx - 2 };
        }
      }
      return DEEP_STEP_FAILED;
    });
  }

  /**
   * @description Test one pattern segment against one path node, as the conjunction of one rule per kind of condition the segment may carry. Attribute and
   * position conditions only ever apply to the node the matcher is currently on — they describe the tag being opened, not an ancestor — so a segment
   * carrying either one fails against any other node.
   *
   * @param segment - The pattern segment.
   * @param node - The path node to test it against.
   * @param isCurrentNode - Whether `node` is the top of the stack.
   *
   * @returns Whether the segment matches the node.
   */
  #matchSegment(segment: Segment, node: PathNode, isCurrentNode: boolean): Effect.Effect<boolean, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return (
        tagNameMatches(segment, node) &&
        namespaceMatches(segment, node) &&
        attributeConditionMatches(segment, node, isCurrentNode) &&
        positionConditionMatches(segment, node, isCurrentNode)
      );
    });
  }

  /**
   * @description Match the current path against every expression in a set. Released API, kept, and the mirror of {@link MatcherView.matchesAny}: both exist so a
   * caller holding either side of the read-only split can ask the question without reaching for the other. Nothing inside the repository calls it.
   *
   * @param exprSet - The set to test against.
   *
   * @returns Whether any expression in the set matches.
   */
  // fallow-ignore-next-line unused-class-member
  matchesAny(exprSet: ExpressionSet): Effect.Effect<boolean, XmlError> {
    return exprSet.matchesAny(this);
  }

  /**
   * @description Copy the current state, so it can be rewound with {@link Matcher.restore} or forked for a sub-parse.
   *
   * @returns A deep-enough copy: the maps and nodes are new, so later pushes cannot reach back into the snapshot.
   */
  snapshot(): Effect.Effect<MatcherSnapshot, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return {
        path: this.path.map(node => ({ ...node })),
        siblingStacks: this.siblingStacks.map(level => (level ? { counts: new Map(level.counts), total: level.total } : level)),
        keptAttrs: this.#keptAttrs.map(entry => ({ ...entry })),
      };
    });
  }

  /**
   * @description Replace the current state with a snapshot's.
   *
   * @param snapshot - A snapshot from a previous {@link Matcher.snapshot} call.
   */
  restore(snapshot: MatcherSnapshot): Effect.Effect<void, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      this.#pathStringCache = null;
      this.path = snapshot.path.map(node => ({ ...node }));
      this.siblingStacks = snapshot.siblingStacks.map(level => (level ? { counts: new Map(level.counts), total: level.total } : level));
      // Tolerates a hand-built snapshot that predates kept attributes, which
      // `keptAttrs` being optional in the type would otherwise invite.
      this.#keptAttrs = (snapshot.keptAttrs ?? []).map(entry => ({ ...entry }));
    });
  }

  /**
   * @description The read-only view of this matcher. The same instance is returned every time, so it is safe to cache, and it always reflects current state. Pass
   * this to user callbacks rather than the matcher, so they cannot mutate the parse position.
   *
   * @example
   *   ```typescript
   *   const view = matcher.readOnly();
   *   view === matcher.readOnly(); // true — no allocation per call
   *   ```;
   *
   * @returns The reusable view.
   */
  readOnly(): Effect.Effect<MatcherView, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#view;
    });
  }
}

/**
 * @description The name {@link MatcherView} used to go by.
 *
 * @deprecated Use {@link MatcherView} instead.
 */
export type ReadOnlyMatcher = MatcherView;

export { Matcher };

export default Matcher;
