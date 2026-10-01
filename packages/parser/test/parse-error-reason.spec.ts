import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { ErrorCodeValue, ParseError } from '#/index.ts';

import {
  AlreadyStreaming,
  BooleanAttributeRejected,
  DataMustBeString,
  DependencyError,
  DuplicateAttribute,
  EncodingMismatch,
  EntityInvalidKey,
  EntityInvalidValue,
  EntityMaxCount,
  EntityMaxExpandedLength,
  EntityMaxExpansions,
  EntityMaxSize,
  ErrorCode,
  IllegalCharacter,
  InvalidAttributeName,
  InvalidDecoder,
  InvalidInput,
  InvalidStream,
  InvalidTag,
  InvalidTagName,
  LimitMaxAttributes,
  LimitMaxNestedTags,
  MismatchedCloseTag,
  MultipleNamespaces,
  NotStreaming,
  SecurityPrototypePollution,
  SecurityReservedOption,
  SecurityRestrictedName,
  UnexpectedCloseTag,
  UnexpectedEnd,
  UnexpectedTrailingData,
  UnclosedQuote,
  UnsupportedEncoding,
  UnquotedAttributeValue,
  XMLParser,
  isParseError,
} from '#/index.ts';

/**
 * @description Every reason is its own class, so the assertions here are about what the class carries. Before, a handler that needed the ceiling it tripped, the
 * two tag names in a mismatch, or the character code of an illegal control character had exactly one route: parse the English sentence in `message`.
 * These specs pin the numbers and names to the fields, because a payload that is populated but wrong is worse than one that is absent — the first
 * fails silently, the second does not compile.
 */
describe('ParseError — a class per reason, carrying its payload', () => {
  it.effect('carries the ceiling and the depth that tripped a nesting limit', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 3 } });
      const result = yield* parser.parse('<a><b><c><d>x</d></c></b></a>').pipe(Effect.result);
      assert(Result.isFailure(result));
      const error = result.failure;

      expect(error).toBeInstanceOf(LimitMaxNestedTags);
      expect(error).toMatchObject({ limit: 3, depth: 4, _tag: 'LIMIT_MAX_NESTED_TAGS' });
      // The message is unchanged, and still names the tag — a caller reading only the prose is no worse off.
      expect((error as LimitMaxNestedTags).message).toContain('exceeds limit of 3');
    })
  );

  it.effect('carries the attribute ceiling, the count, and which tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } });
      const result = yield* parser.parse('<a x="1" y="2" z="3"/>').pipe(Effect.result);
      assert(Result.isFailure(result));
      const error = result.failure;

      expect(error).toBeInstanceOf(LimitMaxAttributes);
      expect(error).toMatchObject({ limit: 2, count: 3, tag: 'a' });
    })
  );

  it.effect('carries both tag names on a mismatched close', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<a><b></c></b></a>').pipe(Effect.result);
      assert(Result.isFailure(result));
      const error = result.failure;

      expect(error).toBeInstanceOf(MismatchedCloseTag);
      expect(error).toMatchObject({ tag: 'c', expected: 'b' });
    })
  );

  it.effect('carries the name a prototype-polluting check refused', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<__proto__>x</__proto__>').pipe(Effect.result);
      assert(Result.isFailure(result));
      const error = result.failure;

      expect(error).toBeInstanceOf(SecurityPrototypePollution);
      expect(error).toMatchObject({ name: '__proto__' });
    })
  );

  it.effect('carries the character code and which scanner found it', () =>
    Effect.gen(function* () {
      const contentParser = yield* XMLParser.make();
      const contentResult = yield* contentParser.parse('<a>x\x01y</a>').pipe(Effect.result);
      assert(Result.isFailure(contentResult));
      const inContent = contentResult.failure;
      const attrParser = yield* XMLParser.make({ skip: { attributes: false } });
      const attrResult = yield* attrParser.parse('<a x="q\x01"/>').pipe(Effect.result);
      assert(Result.isFailure(attrResult));

      // Same illegal code, two different scanners, and a caller treating them differently has to be able to tell them apart without the message.
      // The field is `charCode`, not `code`, because `code` is the class's own tag.
      expect(inContent).toBeInstanceOf(IllegalCharacter);
      expect(inContent).toMatchObject({ charCode: 1, in: 'content' });
      expect(attrResult.failure).toMatchObject({ charCode: 1, in: 'attribute' });
    })
  );

  it.effect('carries the option and the value a reserved-name check refused, and no position', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ nameFor: { text: '__proto__' } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      const error = result.failure;

      expect(error).toBeInstanceOf(SecurityReservedOption);
      expect(error).toMatchObject({ option: 'nameFor.text', value: '__proto__' });
      // A configuration is refused before the document is read, so there is no offset to report.
      expect((error as SecurityReservedOption).index).toBeUndefined();
    })
  );

  it.effect('tells a tag collision from an attribute collision', () =>
    Effect.gen(function* () {
      // A name has to be legal XML *and* reserved to collide, so `nameFor.cdata: 'raw'` is the shape that reaches the check — the obvious example, a
      // tag literally called `#text`, is rejected earlier as an invalid name.
      const tagParser = yield* XMLParser.make({ strictReservedNames: true, nameFor: { cdata: 'raw' } });
      const tagResult = yield* tagParser.parse('<a><raw>x</raw></a>').pipe(Effect.result);
      assert(Result.isFailure(tagResult));
      const attributeParser = yield* XMLParser.make({ strictReservedNames: true, attributes: { groupBy: 'g' }, skip: { attributes: false } });
      const attributeResult = yield* attributeParser.parse('<a g="x"/>').pipe(Effect.result);
      assert(Result.isFailure(attributeResult));

      expect(tagResult.failure).toBeInstanceOf(SecurityRestrictedName);
      expect(tagResult.failure).toMatchObject({ name: 'raw', kind: 'tag' });
      // Attributes are checked against `attributes.groupBy` only. `X2jOptions.strictReservedNames` also claims to cover `nameFor.*` for attributes, and
      // it does not — an attribute named like `nameFor.cdata` is accepted. That divergence predates this work and is left alone here rather than changed
      // silently; the spec pins what the parser actually does, so changing it has to be deliberate.
      expect(attributeResult.failure).toMatchObject({ name: 'g', kind: 'attribute' });
    })
  );
});

/**
 * @description A class per cause is what makes `instanceof` and `Effect.catchTag` work, and both are worth pinning: a caller that can name the failure it is
 * recovering from does not have to write a predicate over a string.
 */
describe('ParseError — narrowing and recovery', () => {
  it.effect('recovers from one reason with catchTag, with its payload in the handler', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 3 } });
      const program = parser.parse('<a><b><c><d>x</d></c></b></a>');

      const recovered = Effect.catchTag(program, ErrorCode.LIMIT_MAX_NESTED_TAGS, reason =>
        Effect.succeed({ rejected: true, atDepth: reason.depth, ceiling: reason.limit })
      );

      expect(yield* recovered).toEqual({ rejected: true, atDepth: 4, ceiling: 3 });
    })
  );

  it.effect('leaves every other reason failing rather than swallowing it', () =>
    Effect.gen(function* () {
      // The point of a per-reason catch is partial recovery. A catch-all here would be a lie about what the handler covers.
      const parser = yield* XMLParser.make();
      const result = yield* Effect.catchTag(parser.parse('<a><b></a>'), ErrorCode.LIMIT_MAX_NESTED_TAGS, () => Effect.succeed('caught')).pipe(
        Effect.result
      );

      assert(Result.isFailure(result));
    })
  );

  it.effect('recovers several reasons at once with catchTags', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 3 } });
      const program = parser.parse('<a><b><c><d>x</d></c></b></a>');
      const recovered = Effect.catchTags(program, {
        LIMIT_MAX_NESTED_TAGS: reason => Effect.succeed(`depth ${reason.depth}`),
        MISMATCHED_CLOSE_TAG: reason => Effect.succeed(`got ${reason.tag}`),
      });

      expect(yield* recovered).toBe('depth 4');
    })
  );

  it.effect('narrows an exhaustive switch to the payload of the matched reason', () =>
    Effect.gen(function* () {
      const describeReason = (error: ParseError): string => {
        switch (error._tag) {
          case 'LIMIT_MAX_NESTED_TAGS':
            return `depth ${error.depth} exceeds ${error.limit}`;
          case 'MISMATCHED_CLOSE_TAG':
            return `expected ${error.expected}, got ${error.tag}`;
          default:
            return error.message;
        }
      };

      const depthParser = yield* XMLParser.make({ limits: { maxNestedTags: 3 } });
      const depthResult = yield* depthParser.parse('<a><b><c><d>x</d></c></b></a>').pipe(Effect.result);
      assert(Result.isFailure(depthResult));
      const mismatchParser = yield* XMLParser.make();
      const mismatchResult = yield* mismatchParser.parse('<a><b></c></b></a>').pipe(Effect.result);
      assert(Result.isFailure(mismatchResult));

      expect(describeReason(depthResult.failure)).toBe('depth 4 exceeds 3');
      expect(describeReason(mismatchResult.failure)).toBe('expected b, got c');
    })
  );

  it.effect('answers "is this one of ours", which instanceof cannot on a union', () =>
    Effect.gen(function* () {
      // `ParseError` is a union of 33 classes, so `err instanceof ParseError` does not exist. `isParseError` is the substitute, and it must not be fooled
      // by anything that merely looks like one — which includes an `Error` subclass carrying one of our tags, since `_tag` is a plain string.
      class Foreign extends Error {
        readonly _tag = 'INVALID_INPUT';
      }

      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<a><b></a>').pipe(Effect.result);
      assert(Result.isFailure(result));
      const error = result.failure;

      expect(isParseError(error)).toBe(true);
      expect(isParseError(new MismatchedCloseTag({ tag: 'a', message: 'boom' }))).toBe(true);
      expect(isParseError(new Foreign('not ours'))).toBe(false);
      expect(isParseError(new Error('boom'))).toBe(false);
      expect(isParseError({ _tag: 'LIMIT_MAX_NESTED_TAGS', message: 'x' })).toBe(false);
      expect(isParseError(null)).toBe(false);
    })
  );
});

/**
 * @description `code` predates the classes and is the field most existing call sites read, so it has to keep working and it has to agree with the tag. Two names
 * for one value is normally a smell; this one is a compatibility alias and the agreement is the thing worth pinning.
 */
describe('ParseError — the code alias', () => {
  it.effect('reads the same as the tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const mismatchResult = yield* parser.parse('<a><b></a>').pipe(Effect.result);
      assert(Result.isFailure(mismatchResult));
      expect(mismatchResult.failure.code).toBe('MISMATCHED_CLOSE_TAG');
      // `maxNestedTags: 0` is refused at construction; `1` would not be, since the limit is "a positive integer".
      const invalidResult = yield* XMLParser.make({ limits: { maxNestedTags: 0 } }).pipe(Effect.result);
      assert(Result.isFailure(invalidResult));
      expect(invalidResult.failure.code).toBe('INVALID_INPUT');
    })
  );

  it('agrees with the tag on a constructed error', function () {
    const error = new MismatchedCloseTag({ tag: 'a', expected: 'b', message: 'boom', index: 3 });

    expect(error.code).toBe(error._tag);
    expect(error.code).toBe(ErrorCode.MISMATCHED_CLOSE_TAG);
    expect(error.index).toBe(3);
  });

  it('is a number-typed ErrorCodeValue, so a typo is a compile error', function () {
    // Compile-time only: a caller narrowing on `code` needs it to be the literal union, not `string`.
    const error = new LimitMaxNestedTags({ limit: 1, depth: 2, message: 'x' });
    const code: ErrorCodeValue = error.code;

    expect(code).toBe('LIMIT_MAX_NESTED_TAGS');
  });
});

/**
 * @description What one reason reports, read off the instance at construction rather than inside a spec. `code` and `toString` are written out by hand on all 33
 * classes, so they are the two members a copy can quietly lose: a class added without the getter, or with a `toString` that dropped the offset, looks
 * identical in review and fails a caller at runtime. A hand-written case cannot catch that, because it can only construct the one or two classes it
 * thought to. The generic parameter is what makes this work — it keeps each argument's own class, so `reason.code` is read on `AlreadyStreaming` when
 * that is the class being built, and a class missing the member fails to type-check here instead of shipping.
 *
 * @param reason - The instance to read.
 *
 * @returns Its tag, its `code`, and its printed form.
 */
const reports = <A extends ParseError>(reason: A) => ({ tag: reason._tag, code: reason.code, printed: reason.toString(), message: reason.message });

/**
 * @description One observation per reason class, carrying only the fields that class requires. Every entry sits at offset 7 so the printed form has something to
 * report; the one case with no offset is asserted separately.
 */
const EVERY_REASON = [
  reports(new InvalidInput({ message: 'invalid input', index: 7 })),
  reports(new InvalidStream({ message: 'not a stream', index: 7 })),
  reports(new AlreadyStreaming({ message: 'already streaming', index: 7 })),
  reports(new NotStreaming({ message: 'not streaming', index: 7 })),
  reports(new DataMustBeString({ received: 'number', message: 'not a string', index: 7 })),
  reports(new UnexpectedEnd({ message: 'unexpected end', index: 7 })),
  reports(new UnexpectedCloseTag({ tag: '/a', message: 'unexpected close', index: 7 })),
  reports(new MismatchedCloseTag({ tag: 'a', message: 'mismatched close', index: 7 })),
  reports(new UnexpectedTrailingData({ message: 'trailing data', index: 7 })),
  reports(new InvalidTag({ message: 'invalid tag', index: 7 })),
  reports(new UnclosedQuote({ message: 'unclosed quote', index: 7 })),
  reports(new InvalidTagName({ name: '1a', message: 'invalid tag name', index: 7 })),
  reports(new InvalidAttributeName({ name: '1a', message: 'invalid attribute name', index: 7 })),
  reports(new MultipleNamespaces({ name: 'a:b:c', message: 'multiple namespaces', index: 7 })),
  reports(new IllegalCharacter({ charCode: 1, in: 'content', message: 'illegal character', index: 7 })),
  reports(new DuplicateAttribute({ name: 'a', message: 'duplicate attribute', index: 7 })),
  reports(new UnquotedAttributeValue({ name: 'a', message: 'unquoted value', index: 7 })),
  reports(new BooleanAttributeRejected({ name: 'a', message: 'boolean attribute', index: 7 })),
  reports(new SecurityPrototypePollution({ name: '__proto__', message: 'prototype pollution', index: 7 })),
  reports(new SecurityReservedOption({ option: 'nameFor.text', value: '__proto__', message: 'reserved option', index: 7 })),
  reports(new SecurityRestrictedName({ name: 'raw', kind: 'tag', message: 'restricted name', index: 7 })),
  reports(new LimitMaxNestedTags({ limit: 3, depth: 4, message: 'too deep', index: 7 })),
  reports(new LimitMaxAttributes({ limit: 2, count: 3, tag: 'a', message: 'too many attributes', index: 7 })),
  reports(new EntityMaxCount({ actual: 2, limit: 1, message: 'too many entities', index: 7 })),
  reports(new EntityMaxSize({ actual: 2, limit: 1, name: 'amp', message: 'entity too large', index: 7 })),
  reports(new EntityMaxExpansions({ actual: 2, limit: 1, message: 'too many expansions', index: 7 })),
  reports(new EntityMaxExpandedLength({ actual: 2, limit: 1, message: 'expansion too long', index: 7 })),
  reports(new EntityInvalidKey({ name: 'amp', message: 'invalid entity key', index: 7 })),
  reports(new EntityInvalidValue({ message: 'invalid entity value', index: 7 })),
  reports(new UnsupportedEncoding({ encoding: 'EBCDIC', message: 'unsupported encoding', index: 7 })),
  reports(new InvalidDecoder({ message: 'invalid decoder', index: 7 })),
  reports(new EncodingMismatch({ declared: 'utf-8', actual: 'utf-16', message: 'encoding mismatch', index: 7 })),
  reports(new DependencyError({ package: '@endevops/builder', cause: 'boom', message: 'boom', index: 7 })),
] as const satisfies ReadonlyArray<{ tag: ErrorCodeValue; code: ErrorCodeValue; printed: string; message: string }>;

/**
 * @description One case per reason class, so a failure names the class that broke rather than pointing at a loop over all thirty-three. Both members are asserted
 * against literals rather than against the instance that produced them: the getter returning the tag is the contract, and comparing `code` to the
 * `_tag` the same object also carries would pass even if the getter returned anything the instance happened to agree with.
 */
describe('ParseError — every reason reports the same way', () => {
  it.each(EVERY_REASON)('$tag reports its code as its own tag', function ({ tag, code }) {
    expect(code).toBe(tag);
  });

  it.each(EVERY_REASON)('$tag prints the tag, the offset and the message', function ({ tag, printed, message }) {
    expect(printed).toBe(`${tag} at index 7: ${message}`);
  });

  it('drops the offset from the printed form when there is none', function () {
    // A configuration failure is refused before the document is read, so it has no index. ` at index undefined` would be the bug this catches.
    const { printed } = reports(new InvalidInput({ message: 'limit must be a positive integer' }));

    expect(printed).toBe('INVALID_INPUT: limit must be a positive integer');
  });
});
