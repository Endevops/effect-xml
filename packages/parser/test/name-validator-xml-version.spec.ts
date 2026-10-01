import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import { XMLParser } from '#/xml-parser.ts';

describe('name-validator xmlVersion cache (getNameValidator premature memoization bug)', function () {
  const oneDotOneOnlyChar = '\u0487'; // Combining Cyrillic Millions Sign: valid NameChar in XML 1.1 only

  it.effect('accepts an XML-1.1-only tag name when the document declares version="1.1"', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const xml = `<?xml version="1.1"?><a${oneDotOneOnlyChar}>text</a${oneDotOneOnlyChar}>`;
      const result = (yield* parser.parse(xml)) as ParsedNode;
      expect(result[`a${oneDotOneOnlyChar}`]).toBe('text');
    })
  );

  it.effect('still rejects that same name when no declaration (defaults to 1.0) is present', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const xml = `<a${oneDotOneOnlyChar}>text</a${oneDotOneOnlyChar}>`;
      const result = yield* parser.parse(xml).pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.effect('still rejects that name when the document explicitly declares version="1.0"', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const xml = `<?xml version="1.0"?><a${oneDotOneOnlyChar}>text</a${oneDotOneOnlyChar}>`;
      const result = yield* parser.parse(xml).pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.effect('accepts an XML-1.1-only attribute name when version="1.1" is declared', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { attributes: false } });
      const xml = `<?xml version="1.1"?><root b${oneDotOneOnlyChar}="v">text</root>`;
      const result = (yield* parser.parse(xml)) as ParsedNode;
      expect(result.root[`@_b${oneDotOneOnlyChar}`]).toBe('v');
    })
  );
});
