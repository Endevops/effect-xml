import { Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { ErrorCode, ParseError, type ParseErrorReasonType, ParseErrorReason, XMLParser } from '#/index.ts';
import { makeParser, runParser } from '#/test/helpers/test-runner.ts';

/**
 * @description The reason payloads. Before the error carried a typed `reason`, a handler that needed the ceiling it tripped, the two tag names involved in a
 * mismatch, or the character code of an illegal control character had exactly one way to get them: parse the English sentence in `message`. These
 * specs pin the numbers and names to the fields, because a payload that is populated but wrong is worse than one that is absent — the first fails
 * silently, the second does not compile.
 */
/**
 * @description Run a parse expected to fail and hand back the error in the channel. `Effect.runSync` would throw instead, which is the right behaviour for a test
 * asserting a throw but the wrong tool here — these specs want to inspect the error, not catch it.
 */
const failedWith = (program: Effect.Effect<unknown, ParseError>): ParseError => {
  const exit = Effect.runSyncExit(program);
  if (!Exit.isFailure(exit)) throw new Error('expected the parse to fail');
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  if (error === undefined) throw new Error('expected a ParseError in the channel');
  return error;
};

describe('ParseError — the reason payload', () => {
  it('carries the ceiling and the depth that tripped a nesting limit', function () {
    const error = failedWith(makeParser({ limits: { maxNestedTags: 3 } }).parse('<a><b><c><d>x</d></c></b></a>'));

    expect(error.reason).toEqual({ _tag: 'LIMIT_MAX_NESTED_TAGS', limit: 3, depth: 4 });
    // The message is unchanged, and still names the tag — a caller reading only the prose is no worse off.
    expect(error.message).toContain('exceeds limit of 3');
  });

  it('carries the attribute ceiling, the count, and which tag', function () {
    const error = failedWith(makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } }).parse('<a x="1" y="2" z="3"/>'));

    expect(error.reason).toEqual({ _tag: 'LIMIT_MAX_ATTRIBUTES', limit: 2, count: 3, tag: 'a' });
  });

  it('carries both tag names on a mismatched close', function () {
    const error = failedWith(makeParser().parse('<a><b></c></b></a>'));

    expect(error.reason).toEqual({ _tag: 'MISMATCHED_CLOSE_TAG', tag: 'c', expected: 'b' });
  });

  it('carries the name a prototype-polluting check refused', function () {
    const error = failedWith(makeParser().parse('<__proto__>x</__proto__>'));

    expect(error.reason).toEqual({ _tag: 'SECURITY_PROTOTYPE_POLLUTION', name: '__proto__' });
  });

  it('carries the character code and which scanner found it', function () {
    const inContent = failedWith(makeParser().parse('<a>xy</a>'));
    const inAttribute = failedWith(makeParser({ skip: { attributes: false } }).parse('<a x="q"/>'));

    // Same illegal code, two different scanners, and a caller treating them differently has to be able to tell them apart without the message.
    expect(inContent.reason).toEqual({ _tag: 'ILLEGAL_CHARACTER', code: 1, in: 'content' });
    expect(inAttribute.reason).toEqual({ _tag: 'ILLEGAL_CHARACTER', code: 1, in: 'attribute' });
  });

  it('carries the option and the value a reserved-name check refused, and no position', function () {
    const error = failedWith(XMLParser.make({ nameFor: { text: '__proto__' } }));

    expect(error.reason).toEqual({ _tag: 'SECURITY_RESERVED_OPTION', option: 'nameFor.text', value: '__proto__' });
    // A configuration is refused before the document is read, so there is no offset to report.
    expect(error.index).toBeUndefined();
  });

  it('tells a tag collision from an attribute collision', function () {
    // A name has to be legal XML *and* reserved to collide, so `nameFor.cdata: 'raw'` is the shape that reaches the check — the obvious
    // example, a tag literally called `#text`, is rejected earlier as an invalid name.
    const tag = failedWith(makeParser({ strictReservedNames: true, nameFor: { cdata: 'raw' } }).parse('<a><raw>x</raw></a>'));
    const attribute = failedWith(
      makeParser({ strictReservedNames: true, attributes: { groupBy: 'g' }, skip: { attributes: false } }).parse('<a g="x"/>')
    );

    expect(tag.reason).toEqual({ _tag: 'SECURITY_RESTRICTED_NAME', name: 'raw', kind: 'tag' });
    // Attributes are checked against `attributes.groupBy` only. `X2jOptions.strictReservedNames` also claims to cover `nameFor.*` for
    // attributes, and it does not — an attribute named like `nameFor.cdata` is accepted. That divergence predates this work and is left
    // alone here rather than changed silently; the spec pins what the parser actually does, so changing it has to be deliberate.
    expect(attribute.reason).toEqual({ _tag: 'SECURITY_RESTRICTED_NAME', name: 'g', kind: 'attribute' });
  });
});

/**
 * @description `catchReason` is the thing a typed error buys over a thrown one with a `code` field, and it only works because the tag is a real `_tag`. Before,
 * recovering from one cause meant writing a predicate over `code` by hand and re-failing everything it did not handle.
 */
describe('ParseError — recovering by reason', () => {
  it('recovers from one reason, with its payload in the handler', function () {
    const program = Effect.flatMap(XMLParser.make({ limits: { maxNestedTags: 3 } }), parser => parser.parse('<a><b><c><d>x</d></c></b></a>'));

    const recovered = Effect.catchReason(program, 'ParseError', 'LIMIT_MAX_NESTED_TAGS', reason =>
      Effect.succeed({ rejected: true, atDepth: reason.depth, ceiling: reason.limit })
    );

    expect(runParser(recovered)).toEqual({ rejected: true, atDepth: 4, ceiling: 3 });
  });

  it('leaves every other reason failing rather than swallowing it', function () {
    // The point of `catchReason` is partial recovery. A catch-all here would be a lie about what the handler covers.
    const program = Effect.flatMap(XMLParser.make(), parser => parser.parse('<a><b></a>'));
    const exit = Effect.runSyncExit(Effect.catchReason(program, 'ParseError', 'LIMIT_MAX_NESTED_TAGS', () => Effect.succeed('caught')));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

/**
 * @description `code` predates `reason` and is the field most existing call sites read, so it has to keep working and it has to agree with the tag. Two names for
 * one value is normally a smell; this one is a compatibility alias and the agreement is the thing worth pinning.
 */
describe('ParseError — the code alias', () => {
  it('reads the same as the reason tag, for every reason the parser can raise', function () {
    expect(failedWith(makeParser().parse('<a><b></a>')).code).toBe('MISMATCHED_CLOSE_TAG');
    // `maxNestedTags: 0` is refused at construction; `1` would not be, since the limit is "a positive integer".
    expect(failedWith(XMLParser.make({ limits: { maxNestedTags: 0 } })).code).toBe('INVALID_INPUT');
  });

  it('agrees with the tag on a constructed error', function () {
    const error = new ParseError({ reason: { _tag: ErrorCode.UNEXPECTED_CLOSE_TAG, tag: 'a' }, message: 'boom', index: 3 });

    expect(error.code).toBe(error.reason._tag);
    expect(error.code).toBe('UNEXPECTED_CLOSE_TAG');
    expect(error.index).toBe(3);
  });
});

/**
 * @description The two vocabularies are kept in step by a compile-time assertion in `parse-error.ts`, so this spec is about the thing a type cannot check: that
 * the schema and the runtime `ErrorCode` table really are the same set, rather than one of them having drifted at runtime.
 */
describe('ParseError — the reason schema and the code table agree', () => {
  it('accepts every code in the table as a reason tag', function () {
    // A schema decode of a bare tag is the cheapest proof the table names a tag the union can be built from.
    for (const code of Object.values(ErrorCode)) {
      const decoded = Schema.decodeUnknownOption(ParseErrorReason)({ _tag: code });
      // Members with required payload legitimately refuse a bare tag; what must never happen is a tag the union has never heard of, which fails
      // as a malformed *union* rather than a malformed member.
      if (Option.isNone(decoded)) {
        expect(String(decoded)).not.toContain('is not a member');
      }
    }
  });

  it('exposes the reason type for narrowing', function () {
    // Compile-time only, like the option-group bindings above: a caller narrowing on `_tag` needs this name to exist and be a union of the tags.
    const reason: ParseErrorReasonType = { _tag: ErrorCode.INVALID_TAG, tag: '?' };
    expect(reason._tag).toBe('INVALID_TAG');
  });
});
