import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { X2jOptions } from '#/options.ts';
import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import { runAcrossAllInputSources, runAcrossAllInputSourcesWithException } from '#/test/helpers/test-runner.ts';
import { XMLParser } from '#/xml-parser.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Default behaviour — still throws (no regression)
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — default behaviour (throw)', function () {
  runAcrossAllInputSourcesWithException('should throw when a tag is not closed at EOF', '<root><a><b></b>', /Unexpected data in the end of document/);

  runAcrossAllInputSourcesWithException('should throw on mismatched closing tag', '<root><a></b></root>', /Unexpected closing tag/);

  it.effect('should throw a proper Error (not ReferenceError) for incomplete closing tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<div></div').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure).toBeInstanceOf(Error);
      expect(result.failure).not.toBeInstanceOf(ReferenceError);
    })
  );

  it.effect('should throw a proper Error for incomplete mismatched closing tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<div></p').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/Unexpected/);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. onEof: 'closeAll'
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — onEof: closeAll', function () {
  const opts: X2jOptions = { autoClose: { onEof: 'closeAll' } };

  runAcrossAllInputSources(
    'should close a single unclosed tag at EOF',
    '<root><a></a>',
    result => {
      expect(result.root).toBeDefined();
    },
    opts
  );

  runAcrossAllInputSources(
    'should close multiple unclosed tags at EOF',
    '<root><a><b>hello</b>',
    result => {
      expect(result.root.a.b).toBe('hello');
    },
    opts
  );

  runAcrossAllInputSources(
    'should handle deeply truncated document',
    '<root><a><b><c><d>text</d>',
    result => {
      expect(result.root.a.b.c.d).toBe('text');
    },
    opts
  );

  runAcrossAllInputSources(
    'should handle text inside unclosed tag',
    '<root><a><b>hello',
    result => {
      expect(result.root.a.b).toBe('hello');
    },
    opts
  );

  runAcrossAllInputSources(
    'should not affect a fully valid document',
    '<root><a>1</a><b>2</b></root>',
    result => {
      expect(result.root.a).toBe(1);
      expect(result.root.b).toBe(2);
    },
    opts
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. onMismatch: 'recover'
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — onMismatch: recover', function () {
  const opts: X2jOptions = { autoClose: { onMismatch: 'recover' } };

  runAcrossAllInputSources(
    'should recover when inner tag is not closed before parent closes',
    '<root><outer><inner>text</outer></root>',
    result => {
      expect(result.root.outer.inner).toBe('text');
    },
    opts
  );

  runAcrossAllInputSources(
    'should recover when closing tag matches an ancestor not the direct parent',
    '<root><a><b><c>val</c></a></root>',
    result => {
      expect(result.root.a.b.c).toBe('val');
    },
    opts
  );

  runAcrossAllInputSources(
    'should not affect a valid document',
    '<root><a><b>x</b></a></root>',
    result => {
      expect(result.root.a.b).toBe('x');
    },
    opts
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. onMismatch: 'discard'
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — onMismatch: discard', function () {
  runAcrossAllInputSources(
    'should discard a mismatched closing tag and continue',
    '<root><a>text</a></z><b>more</b></root>',
    result => {
      expect(result.root.a).toBe('text');
      expect(result.root.b).toBe('more');
    },
    { autoClose: { onMismatch: 'discard' } }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Phantom close tag
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — phantom close tag', function () {
  it.effect('should discard a phantom closing tag and log it', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onMismatch: 'recover', collectErrors: true } });
      yield* parser.parse('<root><a>text</a></z></root>');
      const errors = parser.getParseErrors();
      expect(errors.some(e => e.type === 'phantom-close' && e.tag === 'z')).toBe(true);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. collectErrors — getParseErrors() API
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — collectErrors / getParseErrors()', function () {
  it.effect('should return errors via getParseErrors() for unclosed-eof', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      yield* parser.parse('<root><a><b>hi</b>');
      const errors = parser.getParseErrors();
      expect(Array.isArray(errors)).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
      const err = errors[0];
      expect(err.type).toBe('unclosed-eof');
      expect(err.tag).toBe('a');
      expect(typeof err.index).toBe('number');
    })
  );

  it.effect('should return errors via getParseErrors() for mismatched-close', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onMismatch: 'recover', collectErrors: true } });
      yield* parser.parse('<root><outer><inner>x</outer></root>');
      const errors = parser.getParseErrors();
      const err = errors.find(e => e.type === 'mismatched-close')!;
      expect(err).toBeDefined();
      expect(err.tag).toBe('inner');
    })
  );

  it.effect('should return empty array when collectErrors is false', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: false } });
      yield* parser.parse('<root><a>');
      expect(parser.getParseErrors()).toEqual([]);
    })
  );

  it.effect('should return empty array when document is valid', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      yield* parser.parse('<root><a>ok</a></root>');
      expect(parser.getParseErrors()).toEqual([]);
    })
  );

  it.effect('should not pollute the result object', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      const result = (yield* parser.parse('<root><a>')) as ParsedNode;
      expect(result.__parseErrors).toBeUndefined();
    })
  );

  it.effect('getParseErrors() returns empty array when autoClose is not configured', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      yield* parser.parse('<root><a>ok</a></root>');
      expect(parser.getParseErrors()).toEqual([]);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. HTML preset
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — html preset', function () {
  it.effect('should parse HTML fragment with unclosed tags without throwing', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html' });
      const result = (yield* parser.parse('<html><body><p>Hello<br>World</body></html>')) as ParsedNode;
      expect(result.html.body.p).toBeDefined();
      expect(result.html.body.p.br).toBe('');
    })
  );

  it.effect('should handle text inside unclosed tags', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html' });
      const result = (yield* parser.parse('<div><p>text')) as ParsedNode;
      expect(result.div.p).toBe('text');
    })
  );

  it.effect('should handle truncated document with no content', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html' });
      const result = (yield* parser.parse('<div><p>partial')) as ParsedNode;
      expect(result.div.p).toBe('partial');
    })
  );

  it.effect('should include HTML void elements in unpaired list', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html', skip: { attributes: false } });
      const result = (yield* parser.parse('<html><head><meta charset="UTF-8"><link rel="stylesheet" href="a.css"></head></html>')) as ParsedNode;
      expect(result.html.head.meta['@_charset']).toBe('UTF-8');
      expect(result.html.head.link['@_rel']).toBe('stylesheet');
    })
  );

  it.effect('should collect errors accessible via getParseErrors()', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html' });
      yield* parser.parse('<div><p>text');
      expect(parser.getParseErrors().some(e => e.type === 'unclosed-eof')).toBe(true);
    })
  );

  it.effect('should not put __parseErrors on the result', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html' });
      const result = (yield* parser.parse('<div><p>text')) as ParsedNode;
      expect(result.__parseErrors).toBeUndefined();
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Position tracking
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — position tracking', function () {
  it.effect('should record non-zero index for unclosed tags', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      yield* parser.parse('<root>\n  <child>text</child>\n  <open>');
      const err = parser.getParseErrors().find(e => e.tag === 'open')!;
      expect(err).toBeDefined();
      expect(err.index).toBeGreaterThan(0);
    })
  );

  it.effect('should record position for mismatched-close errors', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onMismatch: 'recover', collectErrors: true } });
      yield* parser.parse('<root><a><b>x</a></root>');
      const err = parser.getParseErrors().find(e => e.type === 'mismatched-close')!;
      expect(err).toBeDefined();
      expect(err.index).toBeGreaterThan(0);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Combined onEof + onMismatch
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — combined onEof + onMismatch', function () {
  it.effect('should handle mismatched tag and unclosed EOF in same document', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', onMismatch: 'recover', collectErrors: true } });
      const result = (yield* parser.parse('<root><a><b>x</a><c>y</c>')) as ParsedNode;
      expect(result.root.a.b).toBe('x');
      expect(result.root.c).toBe('y');
      const errors = parser.getParseErrors();
      expect(errors.some(e => e.type === 'mismatched-close')).toBe(true);
      expect(errors.some(e => e.type === 'unclosed-eof')).toBe(true);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Partial tag — source exhausted mid-token
// ─────────────────────────────────────────────────────────────────────────────
describe('autoClose — partial tag (truncated mid-token)', function () {
  it.effect('should throw by default when opening tag is incomplete', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<div><p').pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.effect('should throw a proper Error (not ReferenceError) for incomplete closing tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<div></div').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure).toBeInstanceOf(Error);
      expect(result.failure).not.toBeInstanceOf(ReferenceError);
    })
  );

  it.effect('should throw for </p with no match', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse('<div></p').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/Unexpected/);
    })
  );

  it.effect('should recover from truncated opening tag, keeping prior content', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      const result = (yield* parser.parse('<div><p>text</p><span')) as ParsedNode;
      expect(result.div.p).toBe('text');
      expect(result.div.span).toBeUndefined();
      expect(parser.getParseErrors().some(e => e.type === 'partial-tag')).toBe(true);
      expect(parser.getParseErrors().some(e => e.type === 'unclosed-eof')).toBe(true);
    })
  );

  it.effect('should recover from truncated closing tag </div', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      const result = (yield* parser.parse('<div><p>hello</p></div')) as ParsedNode;
      expect(result.div.p).toBe('hello');
      expect(parser.getParseErrors().some(e => e.type === 'partial-tag')).toBe(true);
    })
  );

  it.effect('should recover from truncated mismatched closing tag </p', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', onMismatch: 'recover', collectErrors: true } });
      const result = (yield* parser.parse('<div></p')) as ParsedNode;
      expect(result.div).toBeDefined();
      expect(parser.getParseErrors().some(e => e.type === 'partial-tag')).toBe(true);
    })
  );

  it.effect('should record the partial name for a truncated closing tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      yield* parser.parse('<root><item>val</item></roo');
      const err = parser.getParseErrors().find(e => e.type === 'partial-tag')!;
      expect(err).toBeDefined();
      expect(err.tag).toBe('roo');
    })
  );

  it.effect('should record null tag name for a truncated opening tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      yield* parser.parse('<root><ite');
      const err = parser.getParseErrors().find(e => e.type === 'partial-tag')!;
      expect(err).toBeDefined();
      expect(err.tag).toBeNull();
    })
  );

  it.effect('html preset should recover from truncated opening tag', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html' });
      const result = (yield* parser.parse('<div><p>text</p><span')) as ParsedNode;
      expect(result.div.p).toBe('text');
      expect(parser.getParseErrors().some(e => e.type === 'partial-tag')).toBe(true);
    })
  );

  it.effect('html preset: <div><p>text — text inside unclosed tags', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: 'html' });
      const result = (yield* parser.parse('<div><p>text')) as ParsedNode;
      expect(result.div.p).toBe('text');
      expect(Array.isArray(parser.getParseErrors())).toBe(true);
    })
  );

  it.effect('should not put __parseErrors on result even for partial-tag errors', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
      const result = (yield* parser.parse('<div><p')) as ParsedNode;
      expect(result.__parseErrors).toBeUndefined();
    })
  );
});
