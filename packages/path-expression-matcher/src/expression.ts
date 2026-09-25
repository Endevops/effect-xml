/**
 * @description Options for {@link Expression}.
 */
export interface ExpressionOptions {
  /**
   * @description Path separator character. Defaults to `'.'`.
   */
  separator?: string;
}

/**
 * @description Which occurrence of a repeated sibling a segment selects.
 */
export type PositionSelector = 'first' | 'last' | 'odd' | 'even' | 'nth';

/**
 * @description The four named selectors. `nth(n)` is the fifth form and is recognised separately, by {@link NTH_SELECTOR}.
 */
const POSITION_KEYWORDS = ['first', 'last', 'odd', 'even'] as const;

/**
 * @description An `nth(n)` position selector, capturing its zero-based index.
 */
const NTH_SELECTOR = /^nth\((\d+)\)$/;

/**
 * @description Narrows to the four named selectors, which {@link Segment.position} stores directly.
 *
 * @param text - The text following a segment's single colon.
 *
 * @returns Whether `text` is one of the four keywords.
 */
const isPositionKeyword = (text: string): text is Exclude<PositionSelector, 'nth'> => POSITION_KEYWORDS.some(keyword => keyword === text);

/**
 * @description One segment of a parsed pattern. A segment is either a tag — optionally qualified by a namespace, an attribute condition and a position selector —
 * or a `deep-wildcard`, the `..` form. Only `type` is always present; every other field appears only when the pattern asked for it, which is why they
 * are all optional.
 */
export interface Segment {
  /**
   * @description Which kind of segment this is.
   */
  type: 'tag' | 'deep-wildcard';
  /**
   * @description Tag name, or `'*'` for a wildcard. Present only when `type` is `'tag'`.
   */
  tag?: string;
  /**
   * @description Namespace prefix, as in `ns::user`. Present only when the pattern specified one.
   */
  namespace?: string;
  /**
   * @description Attribute name to match, as in `user[id]`. Present only when an attribute condition exists.
   */
  attrName?: string;
  /**
   * @description Attribute value to match, as in `user[id=123]`. Present only when the condition specifies a value.
   */
  attrValue?: string;
  /**
   * @description Position selector kind. Present only when the segment has one.
   */
  position?: PositionSelector;
  /**
   * @description Which occurrence `nth` selects, zero-based. Present only when `position` is `'nth'`.
   */
  positionValue?: number;
}

/**
 * @description A parsed path pattern, ready to match against a {@link Matcher}. The pattern string is parsed once, in the constructor, into a segment list that
 * matching walks directly — so a hot-path match costs a walk over pre-split segments rather than a re-parse per tag. `T` is the type of the opaque
 * {@link Expression.data} payload. This package never reads it; it exists so an embedding parser can hang its own per-expression config off a compiled
 * expression and get it back from {@link ExpressionSet.findMatch} without a second lookup.
 *
 * @example
 *   ```typescript
 *   const expr = new Expression('root.users.user');
 *   const deep = new Expression('..user[id]:first');
 *   const slashed = new Expression('root/users/user', { separator: '/' });
 *   ```
 *
 *   Pattern syntax:
 *
 *   | Pattern                | Matches                                              |
 *   | ---------------------- | ---------------------------------------------------- |
 *   | `root.users.user`      | that exact path                                       |
 *   | `..user`               | `user` at any depth                                   |
 *   | `user[id]`             | a `user` carrying an `id` attribute                  |
 *   | `user[id=123]`         | a `user` whose `id` is `123` (compared as a string)  |
 *   | `user:first`           | the first `user` among its same-named siblings        |
 *   | `ns::user`             | a `user` in namespace `ns`                            |
 *   | `ns::user[id]:first`   | namespace, attribute and position combined            |
 */
export default class Expression<T = unknown> {
  /**
   * @description The pattern string this was parsed from.
   */
  readonly pattern: string;
  /**
   * @description The separator in use, resolved from the options at construction time.
   */
  readonly separator: string;
  /**
   * @description The parsed segments, in path order.
   */
  readonly segments: readonly Segment[];
  /**
   * @description The payload handed to the constructor, returned verbatim. Never read by this package.
   */
  readonly data: T | undefined;

  /**
   * @description Whether any segment is a `deep-wildcard`. Cached at construction because matching consults it on every tag.
   */
  private readonly _hasDeepWildcard: boolean;
  /**
   * @description Whether any segment carries an attribute condition. Cached for the same reason.
   */
  private readonly _hasAttributeCondition: boolean;
  /**
   * @description Whether any segment carries a position selector. Cached for the same reason.
   */
  private readonly _hasPositionSelector: boolean;

  /**
   * @description Parse a pattern string into a matcher-ready expression.
   *
   * @param pattern - Pattern string, e.g. `"root.users.user"` or `"..user[id]"`.
   * @param options - Configuration options.
   * @param data - Opaque payload to carry on {@link Expression.data}.
   *
   * @throws {Error} `Invalid namespace in pattern: …` for an empty namespace, `Invalid segment pattern: …` for a segment with no tag.
   */
  constructor(pattern: string, options: ExpressionOptions = {}, data?: T) {
    this.pattern = pattern;
    this.separator = options.separator || '.';
    this.segments = this._parse(pattern);
    this.data = data;
    // Cache expensive checks for performance (O(1) instead of O(n))
    this._hasDeepWildcard = this.segments.some(seg => seg.type === 'deep-wildcard');
    this._hasAttributeCondition = this.segments.some(seg => seg.attrName !== undefined);
    this._hasPositionSelector = this.segments.some(seg => seg.position !== undefined);
  }

  /**
   * @description Split a pattern into segments, treating a doubled separator as a `deep-wildcard`.
   *
   * @param pattern - The pattern to split.
   *
   * @returns The segments, in path order.
   */
  private _parse(pattern: string): Segment[] {
    const segments: Segment[] = [];

    // Split by separator but handle ".." specially.
    // `charAt` rather than `pattern[i]`: both read one UTF-16 code unit, but
    // charAt is typed `string` instead of `string | undefined`, and the loop
    // bound already guarantees the index is in range.
    let i = 0;
    let currentPart = '';

    while (i < pattern.length) {
      const ch = pattern.charAt(i);

      if (ch === this.separator) {
        // Check if next char is also separator (deep wildcard)
        if (i + 1 < pattern.length && pattern.charAt(i + 1) === this.separator) {
          // Flush current part if any
          if (currentPart.trim()) {
            segments.push(this._parseSegment(currentPart.trim()));
            currentPart = '';
          }
          // Add deep wildcard
          segments.push({ type: 'deep-wildcard' });
          i += 2; // Skip both separators
        } else {
          // Regular separator
          if (currentPart.trim()) {
            segments.push(this._parseSegment(currentPart.trim()));
          }
          currentPart = '';
          i++;
        }
      } else {
        currentPart += ch;
        i++;
      }
    }

    // Flush remaining part
    if (currentPart.trim()) {
      segments.push(this._parseSegment(currentPart.trim()));
    }

    return segments;
  }

  /**
   * @description Parse one segment, in the order the syntax nests: brackets, then namespace, then tag and position, then attribute, then position value.
   *
   * @param part - The segment text, e.g. `"user"`, `"ns::user"`, `"user[id]"`, `"ns::user[id]:first"`.
   *
   * @returns The parsed segment.
   *
   * @throws {Error} `Invalid namespace in pattern: …` or `Invalid segment pattern: …`.
   */
  private _parseSegment(part: string): Segment {
    const segment: Segment = { type: 'tag' };

    // NAMESPACE AND POSITION SYNTAX (v2.0):
    // ================================
    // Namespace uses DOUBLE colon (::)
    // Position uses SINGLE colon (:)
    //
    // Examples:
    //   "user"              → tag
    //   "user:first"        → tag + position
    //   "user[id]"          → tag + attribute
    //   "user[id]:first"    → tag + attribute + position
    //   "ns::user"          → namespace + tag
    //   "ns::user:first"    → namespace + tag + position
    //   "ns::user[id]"      → namespace + tag + attribute
    //   "ns::user[id]:first" → namespace + tag + attribute + position
    //   "ns::first"         → namespace + tag named "first" (NO ambiguity!)
    //
    // This eliminates all ambiguity:
    //   :: = namespace separator
    //   :  = position selector
    //   [] = attributes

    // Step 1: Extract brackets [attr] or [attr=value]
    let bracketContent: string | undefined;
    let withoutBrackets = part;

    const bracketMatch = /^([^[]+)(\[[^\]]*\])(.*)$/.exec(part);
    if (bracketMatch) {
      withoutBrackets = (bracketMatch[1] ?? '') + (bracketMatch[3] ?? '');
      if (bracketMatch[2]) {
        const content = bracketMatch[2].slice(1, -1);
        if (content) {
          bracketContent = content;
        }
      }
    }

    // Step 2: Check for namespace (double colon ::)
    let namespace: string | undefined;
    let tagAndPosition = withoutBrackets;

    if (withoutBrackets.includes('::')) {
      const nsIndex = withoutBrackets.indexOf('::');
      namespace = withoutBrackets.substring(0, nsIndex).trim();
      tagAndPosition = withoutBrackets.substring(nsIndex + 2).trim(); // Skip ::

      if (!namespace) {
        throw new Error(`Invalid namespace in pattern: ${part}`);
      }
    }

    // Step 3: Parse tag and position (single colon :)
    let tag: string | undefined;
    let positionMatch: string | undefined;

    if (tagAndPosition.includes(':')) {
      const colonIndex = tagAndPosition.lastIndexOf(':'); // Use last colon for position
      const tagPart = tagAndPosition.substring(0, colonIndex).trim();
      const posPart = tagAndPosition.substring(colonIndex + 1).trim();

      // Verify position is one of the five selector forms. Anything else after
      // the colon is part of the tag name, which is what makes `ns::first` a
      // namespaced tag called `first` rather than a namespace with no tag.
      if (isPositionKeyword(posPart) || NTH_SELECTOR.test(posPart)) {
        tag = tagPart;
        positionMatch = posPart;
      } else {
        // Not a valid position keyword, treat whole thing as tag
        tag = tagAndPosition;
      }
    } else {
      tag = tagAndPosition;
    }

    if (!tag) {
      throw new Error(`Invalid segment pattern: ${part}`);
    }

    segment.tag = tag;
    if (namespace) {
      segment.namespace = namespace;
    }

    // Step 4: Parse attributes
    if (bracketContent) {
      if (bracketContent.includes('=')) {
        const eqIndex = bracketContent.indexOf('=');
        segment.attrName = bracketContent.substring(0, eqIndex).trim();
        segment.attrValue = bracketContent.substring(eqIndex + 1).trim();
      } else {
        segment.attrName = bracketContent.trim();
      }
    }

    // Step 5: Parse position selector
    if (positionMatch) {
      const nthMatch = NTH_SELECTOR.exec(positionMatch);
      if (nthMatch) {
        segment.position = 'nth';
        // Group 1 always participates: the pattern that matched requires \d+.
        segment.positionValue = parseInt(nthMatch[1] ?? '0', 10);
      } else if (isPositionKeyword(positionMatch)) {
        segment.position = positionMatch;
      }
    }

    return segment;
  }

  /**
   * @description How many segments the pattern parsed into.
   */
  get length(): number {
    return this.segments.length;
  }

  /**
   * @description Whether the pattern contains a `..` deep wildcard, and so cannot be matched by depth.
   */
  hasDeepWildcard(): boolean {
    return this._hasDeepWildcard;
  }

  /**
   * @description Whether any segment carries an attribute condition.
   */
  hasAttributeCondition(): boolean {
    return this._hasAttributeCondition;
  }

  /**
   * @description Whether any segment carries a position selector.
   */
  hasPositionSelector(): boolean {
    return this._hasPositionSelector;
  }

  /**
   * @description The original pattern string, so a log line or error message can echo what was configured.
   */
  toString(): string {
    return this.pattern;
  }
}
