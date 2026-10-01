// oxlint-disable vitest/expect-expect
import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { ParseError } from '#/parse-error.ts';

import { ErrorCode, InvalidInput, UnexpectedCloseTag, isParseError } from '#/parse-error.ts';
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
  it.effect('should parse successfully when attribute count equals limit', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 3 } });
      const result = yield* parser.parse(tagWithAttrs(3)).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('should throw ParseError when attribute count exceeds limit by one', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 3 } });
      const result = yield* parser.parse(tagWithAttrs(4)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toBe(ErrorCode.LIMIT_MAX_ATTRIBUTES);
    })
  );

  it.effect('should include tag name and counts in error message', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } });
      const result = yield* parser.parse(tagWithAttrs(5)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(isParseError(result.failure)).toBe(true);
      expect(result.failure.message).toMatch(/5/); // actual count
      expect(result.failure.message).toMatch(/2/); // limit
    })
  );

  it.effect('should enforce limit: 0 (no attributes allowed)', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 0 } });
      const result = yield* parser.parse(`<root a="1"></root>`).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toBe(ErrorCode.LIMIT_MAX_ATTRIBUTES);
    })
  );

  it.effect('should not throw for limit: 0 when tag has no attributes', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 0 } });
      const result = yield* parser.parse('<root></root>').pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('should apply limit per-tag, not globally across all tags', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } });
      // Two tags each with 2 attrs: fine
      const xml = `<root a="1" b="2"><child c="3" d="4"/></root>`;
      const result = yield* parser.parse(xml).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('should throw when any single tag exceeds the limit', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxAttributesPerTag: 2 } });
      const xml = `<root a="1" b="2"><child c="3" d="4" e="5"/></root>`;
      const result = yield* parser.parse(xml).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toBe(ErrorCode.LIMIT_MAX_ATTRIBUTES);
    })
  );

  it.effect('should not check attributes when skip.attributes is true (default)', () =>
    Effect.gen(function* () {
      // With attributes skipped, flushAttributes is never called — limit is irrelevant
      const parser = yield* XMLParser.make({
        // skip.attributes defaults to true
        limits: { maxAttributesPerTag: 0 },
      });
      // Even though limit is 0, attributes are skipped entirely — no throw
      const result = yield* parser.parse(`<root a="1" b="2"></root>`).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('should not limit attributes when maxAttributesPerTag is null (default)', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false } });
      const result = yield* parser.parse(tagWithAttrs(50)).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );
});

// ─── Combined limits ──────────────────────────────────────────────────────────

describe('limits — combined maxNestedTags + maxAttributesPerTag', () => {
  it.effect('should enforce both limits simultaneously', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxNestedTags: 3, maxAttributesPerTag: 2 } });
      // Depth-first: nesting limit fires first before attrs on the deep tag
      const result = yield* parser.parse(nested(4)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toBe(ErrorCode.LIMIT_MAX_NESTED_TAGS);
    })
  );

  it.effect('attributes limit fires on a shallow tag with too many attrs', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxNestedTags: 10, maxAttributesPerTag: 2 } });
      const result = yield* parser.parse(tagWithAttrs(5)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.code).toBe(ErrorCode.LIMIT_MAX_ATTRIBUTES);
    })
  );

  it.effect('valid XML passes both limits', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false }, limits: { maxNestedTags: 5, maxAttributesPerTag: 3 } });
      const xml = `<a x="1" y="2"><b z="3"><c/></b></a>`;
      const result = yield* parser.parse(xml).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );
});

// ─── ParseError general contract ─────────────────────────────────────────────

describe('ParseError — general error contract', () => {
  it.effect('all parser errors should be recognisable as one of the reason classes', () =>
    Effect.gen(function* () {
      // `ParseError` is a union of 33 classes, so `instanceof ParseError` does not exist. `isParseError` is the substitute, and the test name says so
      // rather than naming a check that is no longer possible.
      const cases: Array<Effect.Effect<unknown, ParseError>> = [
        // Invalid input type — cast past the type so the runtime check is what rejects it
        (yield* XMLParser.make()).parse(12345 as never),
        // Unclosed tag (no autoClose)
        (yield* XMLParser.make()).parse('<root>'),
        // Mismatched closing tag
        (yield* XMLParser.make()).parse('<root></other>'),
      ];

      for (const effect of cases) {
        const result = yield* effect.pipe(Effect.result);
        assert(Result.isFailure(result));
        expect(isParseError(result.failure)).toBe(true);
        expect(typeof result.failure.code).toBe('string');
      }
    })
  );

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

  it.effect('limit errors carry position info', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ limits: { maxNestedTags: 2 } });
      const result = yield* parser.parse(nested(3)).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(isParseError(result.failure)).toBe(true);
      expect(result.failure.code).toBe(ErrorCode.LIMIT_MAX_NESTED_TAGS);
      expect(typeof result.failure.index).toBe('number');
    })
  );

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
