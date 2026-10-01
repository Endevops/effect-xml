import type { BuilderError } from '@endevops/builder';

import { describe, it, expect } from '@effect/vitest';
import { CompactBuilderFactory, makeNumberValueParser } from '@endevops/builder';
import { Effect } from 'effect';

import type { ParseError } from '#/parse-error.ts';
import type { XMLParser } from '#/xml-parser.ts';

import { runAcrossAllInputSources, parseInput, INPUT_TYPES } from '#/test/helpers/test-runner.ts';
import { XMLParser as XMLParserService } from '#/xml-parser.ts';

// Helper: build a parser with a custom NumberValueParser configuration.
const makeParser = (numOpts = {}, parserOpts = {}): Effect.Effect<XMLParser, ParseError | BuilderError> =>
  Effect.gen(function* () {
    const builder = yield* CompactBuilderFactory.make();
    yield* builder.registerValueParser('number', makeNumberValueParser(numOpts));
    return yield* XMLParserService.make({ ...parserOpts, OutputBuilder: builder });
  });

describe('Number Parsing - Unified Tests Across All Input Sources', function () {
  // Basic integer parsing — default number parser handles these
  runAcrossAllInputSources('should parse positive integers', '<root><num>123</num></root>', result => {
    expect(result.root.num).toBe(123);
    expect(typeof result.root.num).toBe('number');
  });

  runAcrossAllInputSources('should parse negative integers', '<root><num>-456</num></root>', result => {
    expect(result.root.num).toBe(-456);
  });

  // Floating point numbers
  runAcrossAllInputSources('should parse floating point numbers', '<root><num>123.456</num></root>', result => {
    expect(result.root.num).toBe(123.456);
  });

  runAcrossAllInputSources('should parse numbers with leading decimal', '<root><num>0.789</num></root>', result => {
    expect(result.root.num).toBe(0.789);
  });

  // Hexadecimal numbers
  INPUT_TYPES.forEach(inputType => {
    it.effect(`should parse hexadecimal numbers when enabled [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ hex: true });
        const result = yield* parseInput(parser, '<root><num>0xFF</num></root>', inputType);
        expect(result.root.num).toBe(255);
      })
    );

    it.effect(`should not parse hexadecimal when disabled [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ hex: false });
        const result = yield* parseInput(parser, '<root><num>0xFF</num></root>', inputType);
        expect(result.root.num).toBe('0xFF');
        expect(typeof result.root.num).toBe('string');
      })
    );
  });

  // Leading zeros
  INPUT_TYPES.forEach(inputType => {
    it.effect(`should parse numbers with leading zeros when enabled [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ leadingZeros: true });
        const result = yield* parseInput(parser, '<root><num>007</num></root>', inputType);
        expect(result.root.num).toBe(7);
      })
    );

    it.effect(`should reject leading zeros when disabled [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ leadingZeros: false });
        const result = yield* parseInput(parser, '<root><num>007</num></root>', inputType);
        expect(result.root.num).toBe('007');
        expect(typeof result.root.num).toBe('string');
      })
    );
  });

  // E-notation
  INPUT_TYPES.forEach(inputType => {
    it.effect(`should parse e-notation when enabled [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ eNotation: true });
        const result = yield* parseInput(parser, '<root><num>1.5e3</num></root>', inputType);
        expect(result.root.num).toBe(1500);
      })
    );

    it.effect(`should not parse e-notation when disabled [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ eNotation: false });
        const result = yield* parseInput(parser, '<root><num>1.5e3</num></root>', inputType);
        expect(result.root.num).toBe('1.5e3');
      })
    );
  });

  // Infinity handling
  INPUT_TYPES.forEach(inputType => {
    it.effect(`should handle infinity with 'original' option (default) [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ infinity: 'original' });
        const result = yield* parseInput(parser, '<root><num>1e1000</num></root>', inputType);
        expect(result.root.num).toBe('1e1000');
        expect(typeof result.root.num).toBe('string');
      })
    );

    it.effect(`should handle infinity with 'infinity' option [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ infinity: 'infinity' });
        const result = yield* parseInput(parser, '<root><num>1e1000</num></root>', inputType);
        expect(result.root.num).toBe(Infinity);
      })
    );

    it.effect(`should handle infinity with 'string' option [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ infinity: 'string' });
        const result = yield* parseInput(parser, '<root><num>1e1000</num></root>', inputType);
        expect(result.root.num).toBe('Infinity');
        expect(typeof result.root.num).toBe('string');
      })
    );

    it.effect(`should handle infinity with 'null' option [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ infinity: 'null' });
        const result = yield* parseInput(parser, '<root><num>1e1000</num></root>', inputType);
        expect(result.root.num).toBe(null);
      })
    );
  });

  // Edge cases — default parser handles these
  runAcrossAllInputSources('should parse zero', '<root><num>0</num></root>', result => {
    expect(result.root.num).toBe(0);
  });

  runAcrossAllInputSources('should not parse non-numeric strings', '<root><num>abc</num></root>', result => {
    expect(result.root.num).toBe('abc');
    expect(typeof result.root.num).toBe('string');
  });

  runAcrossAllInputSources('should handle mixed alphanumeric', '<root><num>123abc</num></root>', result => {
    expect(result.root.num).toBe('123abc');
    expect(typeof result.root.num).toBe('string');
  });

  // Multiple numbers in same document
  INPUT_TYPES.forEach(inputType => {
    it.effect(`should parse multiple numbers correctly [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ hex: true });
        const result = yield* parseInput(parser, '<root><a>123</a><b>456.789</b><c>0xFF</c></root>', inputType);
        expect(result.root.a).toBe(123);
        expect(result.root.b).toBe(456.789);
        expect(result.root.c).toBe(255);
      })
    );
  });
});

// Advanced number parsing scenarios — previously registered via
// describeAcrossAllInputSources, now an explicit loop over the input types.
INPUT_TYPES.forEach(inputType => {
  describe(`Advanced Number Parsing Scenarios [${inputType}]`, function () {
    it.effect('should handle complex XML with multiple number formats', () =>
      Effect.gen(function* () {
        const xml = `
      <data>
        <int>42</int>
        <float>3.14159</float>
        <hex>0xDEADBEEF</hex>
        <scientific>6.022e23</scientific>
        <negative>-273.15</negative>
      </data>
    `;

        // A custom builder is built manually for this test.
        const builder = yield* CompactBuilderFactory.make();
        yield* builder.registerValueParser('number', makeNumberValueParser({ hex: true }));
        const parser = yield* XMLParserService.make({ OutputBuilder: builder });
        const result = yield* parseInput(parser, xml, inputType);

        expect(result.data.int).toBe(42);
        expect(result.data.float).toBeCloseTo(3.14159, 5);
        expect(result.data.hex).toBe(3735928559);
        expect(result.data.scientific).toBe(6.022e23);
        expect(result.data.negative).toBe(-273.15);
      })
    );

    it.effect('should preserve strings that look like numbers when tags.valueParsers is empty', () =>
      Effect.gen(function* () {
        const xml = '<root><num>123</num></root>';
        const parser = yield* XMLParserService.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [] } }) });
        const result = yield* parseInput(parser, xml, inputType);
        expect(result.root.num).toBe('123');
        expect(typeof result.root.num).toBe('string');
      })
    );

    it(`should work consistently for ${inputType} input type`, function () {
      expect(inputType).toMatch(/^(string|buffer|feedable)$/);
    });
  });
});

describe('Security - Infinity Handling', function () {
  // Default parser uses 'original' — Infinity stays as string
  runAcrossAllInputSources('should prevent DoS from infinite values (default: original)', '<root><num>1e1000</num></root>', result => {
    expect(result.root.num).toBe('1e1000');
    expect(typeof result.root.num).toBe('string');
    expect(Number.isFinite(result.root.num)).toBe(false);
  });

  runAcrossAllInputSources('should handle negative infinity safely', '<root><num>-1e1000</num></root>', result => {
    expect(result.root.num).toBe('-1e1000');
    expect(typeof result.root.num).toBe('string');
  });

  INPUT_TYPES.forEach(inputType => {
    it.effect(`should allow explicit infinity conversion when opted in [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ infinity: 'infinity' });
        const result = yield* parseInput(parser, '<root><num>1e1000</num></root>', inputType);
        expect(result.root.num).toBe(Infinity);
      })
    );

    it.effect(`should convert infinity to null when configured [${inputType}]`, () =>
      Effect.gen(function* () {
        const parser = yield* makeParser({ infinity: 'null' });
        const result = yield* parseInput(parser, '<root><num>1e1000</num></root>', inputType);
        expect(result.root.num).toBe(null);
      })
    );
  });
});
