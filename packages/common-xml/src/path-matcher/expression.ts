import { Effect } from 'effect';

import type { XmlError } from '../errors.ts';

import { XmlError as XmlErrorCtor } from '../errors.ts';

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
  readonly #hasDeepWildcard: boolean;
  /**
   * @description Whether any segment carries an attribute condition. Cached for the same reason.
   */
  readonly #hasAttributeCondition: boolean;
  /**
   * @description Whether any segment carries a position selector. Cached for the same reason.
   */
  readonly #hasPositionSelector: boolean;

  /**
   * @description Build an expression from a pattern string. The parsing happens here rather than in a constructor, because a pattern that cannot be parsed is a
   * typed failure and a constructor has nowhere to put an error channel.
   *
   * @example
   *   ```typescript
   *   import { Effect } from 'effect';
   *   import { Expression } from '@endevops/common-xml';
   *
   *   const user = Effect.runSync(Effect.orElseSucceed(Expression.make('root.users.user'), () => null));
   *   user?.length; // 3
   *   ```;
   *
   * @param pattern - Pattern string, e.g. `"root.users.user"` or `"..user[id]"`.
   * @param options - Configuration options.
   * @param data - Opaque payload to carry on {@link Expression.data}.
   *
   * @returns An effect producing the expression. Fails with {@link XmlError} and the `InvalidPattern` reason for an empty namespace
   *   (`EmptyNamespace`) or a segment with no tag (`MissingTag`).
   */
  static make = <T = unknown>(pattern: string, options: ExpressionOptions = {}, data?: T): Effect.Effect<Expression<T>, XmlError> => {
    const separator = options.separator || '.';
    return parsePattern(pattern, separator).pipe(
      Effect.map((segments): Expression<T> => {
        const expression = new Expression<T>(pattern, separator, segments, data);
        return expression;
      })
    );
  };

  /**
   * @description Assemble an expression from an already-parsed pattern. Private because {@link Expression.make} is the supported way in, and because the cached
   * flags below assume the segments came from {@link parsePattern} rather than from a caller.
   *
   * @param pattern - The pattern string, kept verbatim for {@link Expression.pattern} and {@link Expression.toString}.
   * @param separator - The resolved separator, kept for the same reason.
   * @param segments - The parsed segments, in path order.
   * @param data - The opaque payload to carry.
   */
  private constructor(pattern: string, separator: string, segments: readonly Segment[], data?: T) {
    this.pattern = pattern;
    this.separator = separator;
    this.segments = segments;
    this.data = data;
    // Cache expensive checks for performance (O(1) instead of O(n))
    this.#hasDeepWildcard = segments.some(seg => seg.type === 'deep-wildcard');
    this.#hasAttributeCondition = segments.some(seg => seg.attrName !== undefined);
    this.#hasPositionSelector = segments.some(seg => seg.position !== undefined);
  }

  /**
   * @description How many segments the pattern parsed into.
   */
  length(): Effect.Effect<number, XmlError> {
    // Was a getter. A getter cannot return an effect, and the package has one shape
    // for its public surface, so it is a method now.
    return Effect.sync(() => {
      return this.segments.length;
    });
  }

  /**
   * @description Whether the pattern contains a `..` deep wildcard, and so cannot be matched by depth.
   */
  hasDeepWildcard(): Effect.Effect<boolean, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#hasDeepWildcard;
    });
  }

  /**
   * @description Whether any segment carries an attribute condition.
   */
  hasAttributeCondition(): Effect.Effect<boolean, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#hasAttributeCondition;
    });
  }

  /**
   * @description Whether any segment carries a position selector.
   */
  hasPositionSelector(): Effect.Effect<boolean, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.#hasPositionSelector;
    });
  }

  /**
   * @description The original pattern string, so a log line or error message can echo what was configured.
   */
  toString(): Effect.Effect<string, XmlError> {
    // The body cannot fail, so it is wrapped rather than rewritten into a generator: same
    // branches, and the compiler points at every call site that now has to run it.
    return Effect.sync(() => {
      return this.pattern;
    });
  }
}

// ---------------------------------------------------------------------------
// Pattern parsing
//
// Module-level rather than private methods: neither needs an instance, and
// keeping them out here means the failure channel is visible in the signature
// of the only thing that calls them, `Expression.make`.
// ---------------------------------------------------------------------------

/**
 * @description Parse one segment, in the order the syntax nests: brackets, then namespace, then tag and position, then attribute, then position value.
 *
 * @param part - The segment text, e.g. `"user"`, `"ns::user"`, `"user[id]"`, `"ns::user[id]:first"`.
 * @param pattern - The whole pattern, reported alongside the segment when parsing fails.
 *
 * @returns An effect producing the parsed segment. Fails with {@link XmlError} and the `InvalidPattern` reason — `EmptyNamespace` for a namespace
 *   separator with nothing before it, `MissingTag` for a segment that resolves to no tag at all.
 */
const parseSegment = (part: string, pattern: string): Effect.Effect<Segment, XmlError> =>
  Effect.gen(function* () {
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
        return yield* new XmlErrorCtor({
          reason: { _tag: 'InvalidPattern', pattern, segment: part, detail: 'EmptyNamespace' },
          message: `Invalid namespace in pattern: ${part}`,
        });
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
      return yield* new XmlErrorCtor({
        reason: { _tag: 'InvalidPattern', pattern, segment: part, detail: 'MissingTag' },
        message: `Invalid segment pattern: ${part}`,
      });
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
  });

/**
 * @description Split a pattern into segments, treating a doubled separator as a `deep-wildcard`.
 *
 * @param pattern - The pattern to split.
 * @param separator - The resolved separator, so a caller-chosen one is honoured rather than re-read from an instance.
 *
 * @returns An effect producing the segments, in path order. Fails with {@link XmlError} and the `InvalidPattern` reason on the first segment that
 *   will not parse, carrying the whole pattern and the offending segment.
 */
const parsePattern = (pattern: string, separator: string): Effect.Effect<Segment[], XmlError> =>
  Effect.gen(function* () {
    const segments: Segment[] = [];

    // Split by separator but handle ".." specially.
    // `charAt` rather than `pattern[i]`: both read one UTF-16 code unit, but
    // charAt is typed `string` instead of `string | undefined`, and the loop
    // bound already guarantees the index is in range.
    let i = 0;
    let currentPart = '';

    while (i < pattern.length) {
      const ch = pattern.charAt(i);

      if (ch === separator) {
        // Check if next char is also separator (deep wildcard)
        if (i + 1 < pattern.length && pattern.charAt(i + 1) === separator) {
          // Flush current part if any
          if (currentPart.trim()) {
            segments.push(yield* parseSegment(currentPart.trim(), pattern));
            currentPart = '';
          }
          // Add deep wildcard
          segments.push({ type: 'deep-wildcard' });
          i += 2; // Skip both separators
        } else {
          // Regular separator
          if (currentPart.trim()) {
            segments.push(yield* parseSegment(currentPart.trim(), pattern));
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
      segments.push(yield* parseSegment(currentPart.trim(), pattern));
    }

    return segments;
  });
