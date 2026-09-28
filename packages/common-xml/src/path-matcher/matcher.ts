import { Effect } from 'effect';

import type { XmlError } from '../errors.ts';
import type Expression from './expression.ts';
import type { Segment } from './expression.ts';

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
    const self = this;
    return Effect.gen(function* () {
      return yield* self.#matcher.getAnyParentAttr(attrName);
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
    const self = this;
    return Effect.gen(function* () {
      return yield* self.#matcher.hasAnyParentAttr(attrName);
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
    const self = this;
    return Effect.gen(function* () {
      return yield* self.getPosition();
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
    const self = this;
    return Effect.gen(function* () {
      return yield* self.#matcher.matches(expression);
    });
  }

  /**
   * @description Match the current path against every expression in a set.
   *
   * @param exprSet - The set to test against.
   *
   * @returns Whether any expression in the set matches.
   */
  matchesAny(exprSet: ExpressionSet): Effect.Effect<boolean, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    const self = this;
    return Effect.gen(function* () {
      return yield* exprSet.matchesAny(self.#matcher);
    });
  }
}

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
export default class Matcher {
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
    const self = this;
    return Effect.gen(function* () {
      self.#pathStringCache = null;

      // Remove values from previous current node (now becoming ancestor)
      const previous = self.#current;
      if (previous) {
        previous.values = undefined;
      }

      // Get or create sibling tracking for current level
      const currentLevel = self.path.length;
      let level = self.siblingStacks[currentLevel];
      if (!level) {
        level = { counts: new Map(), total: 0 };
        self.siblingStacks[currentLevel] = level;
      }

      // Create a unique key for sibling tracking that includes namespace
      const siblingKey = namespace ? `${namespace}:${tagName}` : tagName;

      // Calculate counter (how many times this tag appeared at this level)
      const counter = level.counts.get(siblingKey) ?? 0;

      // Position = total children at this level seen before this one.
      const position = level.total;

      // Update sibling count for this tag, and the level's running total.
      level.counts.set(siblingKey, counter + 1);
      level.total++;

      // Create new node
      const node: PathNode = { tag: tagName, position, counter };

      if (namespace !== null && namespace !== undefined) {
        node.namespace = namespace;
      }

      if (attrValues !== null && attrValues !== undefined) {
        node.values = attrValues;
      }

      self.path.push(node);

      // Depth of the node we just pushed (1-based, matches self.path.length)
      const depth = self.path.length;

      // Copy only the requested attributes into the kept-attrs stack. This is
      // the one part of push() whose cost scales with input (O(keep.length))
      // rather than being O(1) — by design, since the caller is explicitly
      // opting in for specific attribute names. No options/keep => zero added
      // cost beyond the property reads below.
      const keep = options !== null ? options.keep : null;
      if (keep !== null && keep !== undefined && keep.length > 0 && attrValues) {
        for (let i = 0; i < keep.length; i++) {
          const name = keep[i];
          if (name !== undefined && attrValues[name] !== undefined) {
            self.#keptAttrs.push({ depth, name, value: attrValues[name] });
          }
        }
      }
    });
  }

  /**
   * @description Ascend out of the current tag, dropping its attribute values and any kept attributes it owned.
   *
   * @returns The popped node, or `undefined` if the path was already empty.
   */
  pop(): Effect.Effect<PathNode | undefined, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    const self = this;
    return Effect.gen(function* () {
      if (self.path.length === 0) return undefined;
      self.#pathStringCache = null;

      const node = self.path.pop();

      if (self.siblingStacks.length > self.path.length + 1) {
        self.siblingStacks.length = self.path.length + 1;
      }

      // Drop any kept attributes that belonged to the popped node (or deeper).
      // #keptAttrs is depth-ordered (push only ever appends increasing depths),
      // so this is a backward scan that stops at the first surviving entry —
      // typically O(1) since kept attrs are rare by design.
      const poppedDepth = self.path.length + 1;
      while (self.#keptAttrs.length > 0) {
        const last = self.#keptAttrs[self.#keptAttrs.length - 1];
        if (last === undefined || last.depth < poppedDepth) break;
        self.#keptAttrs.pop();
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
   * @returns The current node's sibling index.
   */
  getIndex(): Effect.Effect<number, XmlError> {
    // A generator passed to `Effect.gen` is a plain function, so `this` inside it is
    // not the instance. Captured here, once, and the body reads as it did.
    const self = this;
    return Effect.gen(function* () {
      return yield* self.getPosition();
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
   * @description The current path as an array of tag names, namespaces omitted.
   *
   * @returns One entry per level, root first.
   */
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
    const self = this;
    return Effect.gen(function* () {
      const segments = expression.segments;

      if (segments.length === 0) {
        return false;
      }

      if (yield* expression.hasDeepWildcard()) {
        return yield* self.#matchWithDeepWildcard(segments);
      }

      return yield* self.#matchSimple(segments);
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
    const self = this;
    return Effect.gen(function* () {
      if (self.path.length !== segments.length) {
        return false;
      }

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const node = self.path[i];
        if (segment === undefined || node === undefined) return false;
        if (!(yield* self.#matchSegment(segment, node, i === self.path.length - 1))) {
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
    const self = this;
    return Effect.gen(function* () {
      let pathIdx = self.path.length - 1;
      let segIdx = segments.length - 1;

      while (segIdx >= 0 && pathIdx >= 0) {
        const segment = segments[segIdx];
        if (segment === undefined) return false;

        if (segment.type === 'deep-wildcard') {
          segIdx--;

          if (segIdx < 0) {
            return true;
          }

          const nextSeg = segments[segIdx];
          if (nextSeg === undefined) return false;
          let found = false;

          for (let i = pathIdx; i >= 0; i--) {
            const node = self.path[i];
            if (node !== undefined && (yield* self.#matchSegment(nextSeg, node, i === self.path.length - 1))) {
              pathIdx = i - 1;
              segIdx--;
              found = true;
              break;
            }
          }

          if (!found) {
            return false;
          }
        } else {
          const node = self.path[pathIdx];
          if (node === undefined || !(yield* self.#matchSegment(segment, node, pathIdx === self.path.length - 1))) {
            return false;
          }
          pathIdx--;
          segIdx--;
        }
      }

      return segIdx < 0;
    });
  }

  /**
   * @description Test one pattern segment against one path node. Attribute and position conditions only ever apply to the node the matcher is currently on — they
   * describe the tag being opened, not an ancestor — so a segment carrying either one fails against any other node.
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
      if (segment.tag !== '*' && segment.tag !== node.tag) {
        return false;
      }

      if (segment.namespace !== undefined) {
        if (segment.namespace !== '*' && segment.namespace !== node.namespace) {
          return false;
        }
      }

      if (segment.attrName !== undefined) {
        if (!isCurrentNode) {
          return false;
        }

        if (!node.values || !(segment.attrName in node.values)) {
          return false;
        }

        if (segment.attrValue !== undefined) {
          if (String(node.values[segment.attrName]) !== String(segment.attrValue)) {
            return false;
          }
        }
      }

      if (segment.position !== undefined) {
        if (!isCurrentNode) {
          return false;
        }

        const counter = node.counter ?? 0;

        if (segment.position === 'first' && counter !== 0) {
          return false;
        } else if (segment.position === 'odd' && counter % 2 !== 1) {
          return false;
        } else if (segment.position === 'even' && counter % 2 !== 0) {
          return false;
        } else if (segment.position === 'nth' && counter !== segment.positionValue) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * @description Match the current path against every expression in a set.
   *
   * @param exprSet - The set to test against.
   *
   * @returns Whether any expression in the set matches.
   */
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
