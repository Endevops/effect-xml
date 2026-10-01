// oxlint-disable vitest/expect-expect
import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { ErrorCodeValue } from '#/options.ts';
import type { ParseError } from '#/parse-error.ts';

import { ErrorCode, InvalidInput, UnexpectedCloseTag, isParseError } from '#/parse-error.ts';
import { makeParser, runParser } from '#/test/helpers/test-runner.ts';
import { XMLParser } from '#/xml-parser.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function nested(depth: number, content: string = 'x'): string {
  let xml = '';
  for (let i = 0; i < depth; i++) xml += `<n${i}>`;
  xml += content;
  for (let i = depth - 1; i >= 0; i--) xml += `</n${i}>`;
  return xml;
}

function tagWithAttrs(count: number): string {
  let attrs = '';
  for (let i = 0; i < count; i++) attrs += ` a${i}="v${i}"`;
  return `<root${attrs}></root>`;
}

/**
 * @description Assert `fn` throws a `ParseError`, optionally with a specific code. Written as try/catch rather than `expect(fn).toThrow()` so the failure message
 * can name the code that was actually produced — `toThrow` on a ParseError only surfaces the message, and the code is the part a reader debugging a
 * limit needs.
 *
 * @deprecated
 */
function expectParseError(fn: () => unknown, code?: ErrorCodeValue): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  // Vitest's matchers take no custom message, so the detail that a jasmine
  // message used to carry is asserted on the value itself — `toBe` reports
  // both sides on failure.
  expect(thrown).toBeDefined();
  const err = thrown as ParseError;
  expect(isParseError(err)).toBe(true);
  if (code) {
    expect(err!.code).toBe(code);
  }
}

// ─── Option validation ────────────────────────────────────────────────────────
describe('limits option — constructor validation', () => {
  it.effect('should accept limits: null (no limits)', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ limits: null }).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('should accept limits: {} (empty object, uses defaults)', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ limits: {} }).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect.each([1, 1000] as const)('should accept valid maxNestedTags (%d)', maxNestedTags =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ limits: { maxNestedTags } }).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect.each([0, 500] as const)('should accept valid maxAttributesPerTag (%d)', maxAttributesPerTag =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ limits: { maxAttributesPerTag } }).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect.each([0, -1, 1.5, '10'])('should reject maxNestedTags: %o', maxNestedTags =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ limits: { maxNestedTags: maxNestedTags as never } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toEqual(ErrorCode.INVALID_INPUT);
    })
  );

  it.effect.each([-1, 1.5, '10'])('should reject maxAttributesPerTag: %o', maxAttributesPerTag =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ limits: { maxAttributesPerTag: maxAttributesPerTag as never } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toEqual(ErrorCode.INVALID_INPUT);
    })
  );

  it.effect('should reject maxAttributesPerTag: %o', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ limits: '50' as never }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toEqual(ErrorCode.INVALID_INPUT);
    })
  );
});

// ─── maxNestedTags ────────────────────────────────────────────────────────────

describe('limits.maxNestedTags — enforcement', () => {
  it.effect('should parse successfully when depth equals limit', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 3 } });

      // depth 3: <n0><n1><n2>x</n2></n1></n0>
      const result = yield* parser.parse(nested(3)).pipe(Effect.result);
      assert(Result.isSuccess(result));
      expect(result.success).toMatchInlineSnapshot(`
        {
          "n0": {
            "n1": {
              "n2": "x",
            },
          },
        }
      `);
    })
  );

  it.effect('should throw ParseError when depth exceeds limit by one', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 3 } });
      const result = yield* parser.parse(nested(4)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toEqual(ErrorCode.LIMIT_MAX_NESTED_TAGS);
    })
  );

  it.effect('should throw ParseError when depth far exceeds limit', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 5 } });
      const result = yield* parser.parse(nested(20)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toEqual(ErrorCode.LIMIT_MAX_NESTED_TAGS);
    })
  );

  it.effect('should include tag name in the error message', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 2 } });
      const result = yield* parser.parse(nested(3)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/n2/);
    })
  );

  it.effect('ParseError should carry position info (index)', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 2 } });
      const result = yield* parser.parse(nested(3)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.index).toBeTypeOf('number');
    })
  );

  it.effect('should allow limit: 1 (only root tag)', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 1 } });
      const result = yield* parser.parse('<root>text</root>').pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('should throw for limit: 1 with one level of nesting', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 1 } });
      const result = yield* parser.parse('<root><child>text</child></root>').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toEqual(ErrorCode.LIMIT_MAX_NESTED_TAGS);
    })
  );

  it.effect('should not limit depth when maxNestedTags is null (default)', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      // 50 levels deep should be fine without a limit
      const result = yield* parser.parse(nested(50)).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('depth limit applies to multiple sibling branches independently', () =>
    Effect.gen(function* () {
      // Each sibling resets depth — only deeper nesting should fail
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 2 } });
      const xml = `<root><a><b/></a><c><d/></c></root>`;
      const result = yield* parser.parse(xml).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).not.toEqual("[LIMIT_MAX_NESTED_TAGS] at index 9: Nesting depth 3 exceeds limit of 2 (tag: 'b')");
    })
  );

  it.effect('should throw on feed/end (feedable source) when depth exceeded', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 3 } });
      const xml = nested(4);

      const chunk = 20;
      for (let i = 0; i < xml.length; i += chunk) {
        yield* parser.feed(xml.slice(i, i + chunk));
      }
      const result = yield* parser.end().pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toEqual(ErrorCode.LIMIT_MAX_NESTED_TAGS);
    })
  );
});

// ─── maxAttributesPerTag ──────────────────────────────────────────────────────

describe('limits.maxAttributesPerTag — enforcement', () => {
  it('should parse successfully when attribute count equals limit', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 3 } });
    expect(() => runParser(parser.parse(tagWithAttrs(3)))).not.toThrow();
  });

  it('should throw ParseError when attribute count exceeds limit by one', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 3 } });
    expectParseError(() => runParser(parser.parse(tagWithAttrs(4))), ErrorCode.LIMIT_MAX_ATTRIBUTES);
  });

  it('should include tag name and counts in error message', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } });
    let err: ParseError | undefined;
    try {
      runParser(parser.parse(tagWithAttrs(5)));
    } catch (e) {
      err = e as ParseError;
    }
    expect(isParseError(err)).toBe(true);
    expect(err!.message).toMatch(/5/); // actual count
    expect(err!.message).toMatch(/2/); // limit
  });

  it('should enforce limit: 0 (no attributes allowed)', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 0 } });
    expectParseError(() => runParser(parser.parse(`<root a="1"></root>`)), ErrorCode.LIMIT_MAX_ATTRIBUTES);
  });

  it('should not throw for limit: 0 when tag has no attributes', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 0 } });
    expect(() => runParser(parser.parse('<root></root>'))).not.toThrow();
  });

  it('should apply limit per-tag, not globally across all tags', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } });
    // Two tags each with 2 attrs: fine
    const xml = `<root a="1" b="2"><child c="3" d="4"/></root>`;
    expect(() => runParser(parser.parse(xml))).not.toThrow();
  });

  it('should throw when any single tag exceeds the limit', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } });
    const xml = `<root a="1" b="2"><child c="3" d="4" e="5"/></root>`;
    expectParseError(() => runParser(parser.parse(xml)), ErrorCode.LIMIT_MAX_ATTRIBUTES);
  });

  it('should not check attributes when skip.attributes is true (default)', () => {
    // With attributes skipped, flushAttributes is never called — limit is irrelevant
    const parser = makeParser({
      // skip.attributes defaults to true
      limits: { maxAttributesPerTag: 0 },
    });
    // Even though limit is 0, attributes are skipped entirely — no throw
    expect(() => runParser(parser.parse(`<root a="1" b="2"></root>`))).not.toThrow();
  });

  it('should not limit attributes when maxAttributesPerTag is null (default)', () => {
    const parser = makeParser({ skip: { attributes: false } });
    expect(() => runParser(parser.parse(tagWithAttrs(50)))).not.toThrow();
  });
});

// ─── Combined limits ──────────────────────────────────────────────────────────

describe('limits — combined maxNestedTags + maxAttributesPerTag', () => {
  it('should enforce both limits simultaneously', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxNestedTags: 3, maxAttributesPerTag: 2 } });
    // Depth-first: nesting limit fires first before attrs on the deep tag
    expectParseError(() => runParser(parser.parse(nested(4))), ErrorCode.LIMIT_MAX_NESTED_TAGS);
  });

  it('attributes limit fires on a shallow tag with too many attrs', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxNestedTags: 10, maxAttributesPerTag: 2 } });
    expectParseError(() => runParser(parser.parse(tagWithAttrs(5))), ErrorCode.LIMIT_MAX_ATTRIBUTES);
  });

  it('valid XML passes both limits', () => {
    const parser = makeParser({ skip: { attributes: false }, limits: { maxNestedTags: 5, maxAttributesPerTag: 3 } });
    const xml = `<a x="1" y="2"><b z="3"><c/></b></a>`;
    expect(() => runParser(parser.parse(xml))).not.toThrow();
  });
});

// ─── ParseError general contract ─────────────────────────────────────────────

describe('ParseError — general error contract', () => {
  it('all parser errors should be recognisable as one of the reason classes', () => {
    // `ParseError` is a union of 33 classes, so `instanceof ParseError` does not exist. `isParseError` is the substitute, and the test name says so
    // rather than naming a check that is no longer possible.
    const cases = [
      // Invalid input type
      () => runParser(makeParser().parse(12345)),
      // Unclosed tag (no autoClose)
      () => runParser(makeParser().parse('<root>')),
      // Mismatched closing tag
      () => runParser(makeParser().parse('<root></other>')),
    ];

    for (const fn of cases) {
      let err: ParseError | undefined;
      try {
        fn();
      } catch (e) {
        err = e as ParseError;
      }
      expect(err).toBeDefined();
      expect(isParseError(err)).toBe(true);
      expect(typeof err!.code).toBe('string');
    }
  });

  it('ParseError should have a meaningful toString()', () => {
    const e = new UnexpectedCloseTag({ tag: 'b', message: 'bad tag', index: 50 });
    const str = e.toString();
    // The line is the tag, the offset, then the message. There is no `ParseError` prefix to print any more: every reason is its own class, so the
    // tag *is* the identity, and a second name in front of it would be saying the same thing twice.
    expect(str).toBe('UNEXPECTED_CLOSE_TAG at index 50: bad tag');
  });

  it('ParseError without position still has a useful toString()', () => {
    const e = new InvalidInput({ option: 'limits', message: 'bad input' });
    expect(e.index).toBeUndefined();
    // A configuration failure has no offset, and says so by leaving it out rather than printing `undefined`.
    expect(e.toString()).toBe('INVALID_INPUT: bad input');
  });

  it('limit errors carry position info', () => {
    const parser = makeParser({ limits: { maxNestedTags: 2 } });
    let err: ParseError | undefined;
    try {
      runParser(parser.parse(nested(3)));
    } catch (e) {
      err = e as ParseError;
    }
    expect(isParseError(err)).toBe(true);
    expect(err!.code).toBe(ErrorCode.LIMIT_MAX_NESTED_TAGS);
    expect(typeof err!.index).toBe('number');
  });

  it('ErrorCode export contains all expected codes', () => {
    const expected = [
      'INVALID_INPUT',
      'INVALID_STREAM',
      'ALREADY_STREAMING',
      'NOT_STREAMING',
      'DATA_MUST_BE_STRING',
      'UNEXPECTED_END',
      'UNEXPECTED_CLOSE_TAG',
      'MISMATCHED_CLOSE_TAG',
      'UNEXPECTED_TRAILING_DATA',
      'INVALID_TAG',
      'UNCLOSED_QUOTE',
      'MULTIPLE_NAMESPACES',
      'SECURITY_PROTOTYPE_POLLUTION',
      'SECURITY_RESERVED_OPTION',
      'SECURITY_RESTRICTED_NAME',
      'LIMIT_MAX_NESTED_TAGS',
      'LIMIT_MAX_ATTRIBUTES',
      'ENTITY_MAX_COUNT',
      'ENTITY_MAX_SIZE',
      'ENTITY_MAX_EXPANSIONS',
      'ENTITY_MAX_EXPANDED_LENGTH',
      'ENTITY_INVALID_KEY',
      'ENTITY_INVALID_VALUE',
    ];
    for (const code of expected) {
      expect((ErrorCode as Record<string, string>)[code]).toBe(code);
    }
  });
});
