import { Effect } from 'effect';

import type { XmlError } from '#/errors.ts';

import { XmlError as XmlErrorCtor } from '#/errors.ts';

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
  readonly segments: ReadonlyArray<Segment>;
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
  private constructor(pattern: string, separator: string, segments: ReadonlyArray<Segment>, data?: T) {
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
   * @description Whether the pattern contains a `..` deep wildcard, and so cannot be matched by depth.
   */
  get hasDeepWildcard(): boolean {
    return this.#hasDeepWildcard;
  }

  /**
   * @description Whether any segment carries an attribute condition.
   */
  get hasAttributeCondition(): boolean {
    return this.#hasAttributeCondition;
  }

  /**
   * @description Whether any segment carries a position selector.
   */
  get hasPositionSelector(): boolean {
    return this.#hasPositionSelector;
  }

  /**
   * @description The original pattern string, so a log line or error message can echo what was configured.
   */
  toString(): string {
    return this.pattern;
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
 * @description The bracketed suffix of a segment, split into the attribute name and value it carries. Empty `[]` carries neither, and `[attr=]` carries a name
 * with an empty value — which is a real condition, so the distinction from `[]` has to survive.
 */
interface AttributeCondition {
  /**
   * @description The attribute name, trimmed.
   */
  name: string;
  /**
   * @description The required value, trimmed, or `undefined` when the condition asked for presence only.
   */
  value: string | undefined;
}

/**
 * @description A segment's text split at its `::` namespace separator.
 */
interface NamespaceSplit {
  /**
   * @description The namespace prefix, or `undefined` when the text carried no `::`.
   */
  namespace: string | undefined;
  /**
   * @description The tag-and-position remainder, trimmed. The whole text when there was no separator, left as written.
   */
  rest: string;
}

/**
 * @description The `[^[]+` / `\[[^\]]*\]` / `.*` split of a segment into its leading text, its bracketed suffix and its trailing text. The leading group has to be
 * non-empty, so a segment opening with a bracket matches nothing here and is passed through whole.
 */
const BRACKET_PATTERN = /^([^[]+)(\[[^\]]*\])(.*)$/;

/**
 * @description Turn the text inside a segment's brackets into an attribute condition.
 *
 * @param content - The text between the brackets, without them.
 *
 * @returns The condition, or `undefined` for empty brackets.
 */
const readAttributeCondition = (content: string): AttributeCondition | undefined => {
  if (content === '') return undefined;

  const eqIndex = content.indexOf('=');
  if (eqIndex < 0) return { name: content.trim(), value: undefined };
  return { name: content.substring(0, eqIndex).trim(), value: content.substring(eqIndex + 1).trim() };
};

/**
 * @description Strip the bracketed attribute condition off a segment, if it carries one.
 *
 * @param part - The segment text, e.g. `"user[id=1]"`.
 *
 * @returns The text with the brackets removed, and the condition they held.
 */
const splitAttribute = (part: string): { withoutBrackets: string; condition: AttributeCondition | undefined } => {
  const match = BRACKET_PATTERN.exec(part);
  if (match === null) return { withoutBrackets: part, condition: undefined };

  const withoutBrackets = (match[1] ?? '') + (match[3] ?? '');
  return { withoutBrackets, condition: readAttributeCondition((match[2] ?? '').slice(1, -1)) };
};

/**
 * @description Split a segment at its `::` namespace separator, first occurrence. The double colon is unambiguous because a single colon is the position selector,
 * so `ns::user:first` names namespace `ns` and position `first`.
 *
 * @param text - The segment text with any brackets already stripped.
 *
 * @returns The namespace, and what is left of the text.
 */
const splitNamespace = (text: string): NamespaceSplit => {
  const separatorIndex = text.indexOf('::');
  if (separatorIndex < 0) return { namespace: undefined, rest: text };
  return { namespace: text.substring(0, separatorIndex).trim(), rest: text.substring(separatorIndex + 2).trim() };
};

/**
 * @description Split a segment at its single colon into a tag and a position selector, treating that colon as a selector only when what follows it is one of the
 * five recognised forms. Anything else after the colon belongs to the tag name, which is what makes `ns::first` a namespaced tag called `first`
 * rather than a namespace with no tag. A segment with no colon keeps its tag exactly as written.
 *
 * @param text - The segment text with brackets and namespace already stripped.
 *
 * @returns The tag, and the selector text when one followed the colon.
 */
const splitTagAndPosition = (text: string): { tag: string; position: string | undefined } => {
  if (!text.includes(':')) return { tag: text, position: undefined };

  // The last colon, so `ns::user:first` splits at the selector rather than the namespace.
  const colonIndex = text.lastIndexOf(':');
  const positionText = text.substring(colonIndex + 1).trim();
  if (!isPositionKeyword(positionText) && !NTH_SELECTOR.test(positionText)) {
    return { tag: text, position: undefined };
  }
  return { tag: text.substring(0, colonIndex).trim(), position: positionText };
};

/**
 * @description Resolve a selector's text into the form a {@link Segment} carries.
 *
 * @param selector - The text following a segment's single colon.
 *
 * @returns The selector and, for `nth(n)`, the occurrence it names. `undefined` when the text turns out not to be a selector.
 */
const readPositionSelector = (selector: string): { position: PositionSelector; positionValue: number | undefined } | undefined => {
  const nthMatch = NTH_SELECTOR.exec(selector);
  if (nthMatch !== null) {
    // Group 1 always participates: the pattern that matched requires \d+.
    return { position: 'nth', positionValue: parseInt(nthMatch[1] ?? '0', 10) };
  }
  return isPositionKeyword(selector) ? { position: selector, positionValue: undefined } : undefined;
};

/**
 * @description The fields a namespace split contributes to a segment — nothing when it named no namespace, so the key stays absent rather than
 * present-and-undefined.
 *
 * @param split - The namespace split.
 *
 * @returns The segment fields.
 */
const namespaceFields = (split: NamespaceSplit): Pick<Segment, 'namespace'> => (split.namespace === undefined ? {} : { namespace: split.namespace });

/**
 * @description The fields an attribute condition contributes to a segment — nothing when the segment carried none.
 *
 * @param condition - The bracketed condition, or `undefined`.
 *
 * @returns The segment fields.
 */
const attributeFields = (condition: AttributeCondition | undefined): Pick<Segment, 'attrName' | 'attrValue'> => {
  if (condition === undefined) return {};
  if (condition.value === undefined) return { attrName: condition.name };
  return { attrName: condition.name, attrValue: condition.value };
};

/**
 * @description The fields a position selector contributes to a segment — nothing when the segment carried none.
 *
 * @param position - The selector text, or `undefined`.
 *
 * @returns The segment fields.
 */
const positionFields = (position: string | undefined): Pick<Segment, 'position' | 'positionValue'> => {
  if (position === undefined) return {};
  const selector = readPositionSelector(position);
  if (selector === undefined) return {};
  if (selector.positionValue === undefined) return { position: selector.position };
  return { position: selector.position, positionValue: selector.positionValue };
};

/**
 * @description Parse one segment, in the order the syntax nests: brackets, then namespace, then tag and position. NAMESPACE AND POSITION SYNTAX (v2.0):
 * ================================ Namespace uses DOUBLE colon (::) Position uses SINGLE colon (:) Examples: "user" → tag "user:first" → tag +
 * position "user[id]" → tag + attribute "user[id]:first" → tag + attribute + position "ns::user" → namespace + tag "ns::user:first" → namespace + tag +
 * position "ns::user[id]" → namespace + tag + attribute "ns::user[id]:first" → namespace + tag + attribute + position "ns::first" → namespace + tag
 * named "first" (NO ambiguity!) This eliminates all ambiguity: :: = namespace separator : = position selector [] = attributes.
 *
 * @param part - The segment text, e.g. `"user"`, `"ns::user"`, `"user[id]"`, `"ns::user[id]:first"`.
 * @param pattern - The whole pattern, reported alongside the segment when parsing fails.
 *
 * @returns An effect producing the parsed segment. Fails with {@link XmlError} and the `InvalidPattern` reason — `EmptyNamespace` for a namespace
 *   separator with nothing before it, `MissingTag` for a segment that resolves to no tag at all.
 */
const parseSegment = (part: string, pattern: string): Effect.Effect<Segment, XmlError> =>
  Effect.gen(function* () {
    const { withoutBrackets, condition } = splitAttribute(part);
    const split = splitNamespace(withoutBrackets);

    if (split.namespace === '') {
      return yield* new XmlErrorCtor({
        reason: { _tag: 'InvalidPattern', pattern, segment: part, detail: 'EmptyNamespace' },
        message: `Invalid namespace in pattern: ${part}`,
      });
    }

    const { tag, position } = splitTagAndPosition(split.rest);
    if (tag === '') {
      return yield* new XmlErrorCtor({
        reason: { _tag: 'InvalidPattern', pattern, segment: part, detail: 'MissingTag' },
        message: `Invalid segment pattern: ${part}`,
      });
    }

    return { type: 'tag', tag, ...namespaceFields(split), ...attributeFields(condition), ...positionFields(position) };
  });

/**
 * @description What one separator-delimited step of a pattern consumes: a single separator breaks between segments, a doubled one is a `..` deep wildcard.
 */
interface SeparatorStep {
  /**
   * @description How many characters the step consumed.
   */
  width: number;
  /**
   * @description Whether the step was a doubled separator, and so stands for a `..`.
   */
  isDeepWildcard: boolean;
}

/**
 * @description Classify the pattern at a position the caller has already established is a separator.
 *
 * @param pattern - The whole pattern.
 * @param separator - The resolved separator.
 * @param index - The position of the separator.
 *
 * @returns The step it begins.
 */
const readSeparatorStep = (pattern: string, separator: string, index: number): SeparatorStep => {
  const isDeepWildcard = index + 1 < pattern.length && pattern.charAt(index + 1) === separator;
  return { width: isDeepWildcard ? 2 : 1, isDeepWildcard };
};

/**
 * @description Parse the part of a pattern gathered so far and append it to the segment list, unless it is blank. Every part is trimmed before it is parsed, so
 * whitespace around a separator never reaches a tag name.
 *
 * @param segments - The segment list to append to.
 * @param part - The gathered text.
 * @param pattern - The whole pattern, reported alongside the segment when parsing fails.
 *
 * @returns An effect that appends the parsed segment, if there was one to parse.
 */
const flushPart = (segments: Array<Segment>, part: string, pattern: string): Effect.Effect<void, XmlError> => {
  const trimmed = part.trim();
  if (trimmed === '') return Effect.void;
  return Effect.map(parseSegment(trimmed, pattern), segment => {
    segments.push(segment);
  });
};

/**
 * @description Split a pattern into segments, treating a doubled separator as a `deep-wildcard`.
 *
 * @param pattern - The pattern to split.
 * @param separator - The resolved separator, so a caller-chosen one is honoured rather than re-read from an instance.
 *
 * @returns An effect producing the segments, in path order. Fails with {@link XmlError} and the `InvalidPattern` reason on the first segment that
 *   will not parse, carrying the whole pattern and the offending segment.
 */
const parsePattern = (pattern: string, separator: string): Effect.Effect<Array<Segment>, XmlError> =>
  Effect.gen(function* () {
    const segments: Array<Segment> = [];

    // `charAt` rather than `pattern[i]`: both read one UTF-16 code unit, but
    // charAt is typed `string` instead of `string | undefined`, and the loop
    // bound already guarantees the index is in range.
    let i = 0;
    let currentPart = '';

    while (i < pattern.length) {
      const ch = pattern.charAt(i);

      if (ch !== separator) {
        currentPart += ch;
        i++;
        continue;
      }

      // A separator ends the part gathered so far, whether it stands alone or is
      // the first half of a `..`.
      const step = readSeparatorStep(pattern, separator, i);
      yield* flushPart(segments, currentPart, pattern);
      currentPart = '';
      if (step.isDeepWildcard) segments.push({ type: 'deep-wildcard' });
      i += step.width;
    }

    yield* flushPart(segments, currentPart, pattern);
    return segments;
  });
