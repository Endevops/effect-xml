import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import type { X2jOptions } from '#/options.ts';
import type { ParseError } from '#/parse-error.ts';
import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import { buildOptions } from '#/options-builder.ts';
import { runAcrossAllInputSources, runAcrossAllInputSourcesWithException } from '#/test/helpers/test-runner.ts';
import { criticalProperties, DANGEROUS_PROPERTY_NAMES } from '#/util.ts';
import { XMLParser } from '#/xml-parser.ts';

/**
 * @description Build the parser's resolved options through the same validation path `XMLParser.make` uses, so an option-level rejection surfaces as a typed
 * `ParseError` rather than a thrown value. `buildOptions` is where the security checks, the defaults and the expression compilation live.
 */
const makeOptions = (opts: X2jOptions = {}): Effect.Effect<unknown, ParseError> => buildOptions(opts);

describe('Security - Prototype Pollution Prevention', function () {
  // ─── CRITICAL PROPERTIES ────────────────────────────────────────────────────
  // __proto__, constructor, prototype  →  always throw; no recovery possible

  // Tag names
  for (let prop of criticalProperties) {
    runAcrossAllInputSourcesWithException(
      `should reject '${prop}' as tag name`,
      `<${prop}>malicious</${prop}>`,
      `[SECURITY] Invalid name: "${prop}" is a reserved JavaScript keyword that could cause prototype pollution`
    );
  }

  // Attribute names (attributes must be enabled to trigger the check)
  for (let prop of criticalProperties) {
    runAcrossAllInputSourcesWithException(
      `should reject '${prop}' as attribute name`,
      `<root ${prop}="malicious"></root>`,
      `[SECURITY] Invalid name: "${prop}" is a reserved JavaScript keyword that could cause prototype pollution`,
      { skip: { attributes: false } }
    );
  }

  // ─── DANGEROUS PROPERTIES ───────────────────────────────────────────────────
  // hasOwnProperty, toString, valueOf, __defineGetter__, etc.
  // These are sanitized (prefixed with __) rather than rejected outright.

  // Default sanitisation: __ prefix on tag names
  for (let prop of DANGEROUS_PROPERTY_NAMES) {
    runAcrossAllInputSources(`should sanitize dangerous tag name '${prop}' with default handler`, `<${prop}>value</${prop}>`, result => {
      expect(result[`__${prop}`]).toBe('value');
    });
  }

  // Default sanitisation: __ prefix on attribute names
  for (let prop of DANGEROUS_PROPERTY_NAMES) {
    runAcrossAllInputSources(
      `should sanitize dangerous attribute name '${prop}' with default handler`,
      `<root ${prop}="value"></root>`,
      result => {
        expect(result.root[`__${prop}`]).toBe('value');
      },
      { attributes: { prefix: '' }, skip: { attributes: false } }
    );
  }

  // Custom onDangerousProperty handler: tag names
  for (let prop of DANGEROUS_PROPERTY_NAMES) {
    runAcrossAllInputSources(
      `should sanitize dangerous tag name '${prop}' with custom onDangerousProperty`,
      `<${prop}>value</${prop}>`,
      result => {
        expect(result[`#${prop}`]).toBe('value');
      },
      { onDangerousProperty: name => `#${name}` }
    );
  }

  // Custom onDangerousProperty handler: attribute names
  for (let prop of DANGEROUS_PROPERTY_NAMES) {
    runAcrossAllInputSources(
      `should sanitize dangerous attribute name '${prop}' with custom onDangerousProperty`,
      `<root ${prop} = "value" ></root > `,
      result => {
        expect(result.root[`#${prop}`]).toBe('value');
      },
      { attributes: { prefix: '' }, onDangerousProperty: name => `#${name}`, skip: { attributes: false } }
    );
  }

  // ─── OPTION-LEVEL PROPERTY NAME VALIDATION ──────────────────────────────────
  // Critical names must be rejected when used as nameFor.*, attributes.prefix,
  // or attributes.groupBy values.

  it.effect('should reject a critical name as nameFor.text', () =>
    Effect.gen(function* () {
      const result = yield* makeOptions({ nameFor: { text: '__proto__' } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("SECURITY: '__proto__' is a reserved JavaScript keyword and cannot be used as nameFor.text");
    })
  );

  it.effect('should reject a dangerous name as nameFor.cdata', () =>
    Effect.gen(function* () {
      const result = yield* makeOptions({ nameFor: { cdata: '__defineGetter__' } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("SECURITY: '__defineGetter__' is a reserved JavaScript keyword and cannot be used as nameFor.cdata");
    })
  );

  it.effect('should reject a dangerous name as nameFor.comment', () =>
    Effect.gen(function* () {
      const result = yield* makeOptions({ nameFor: { comment: '__defineSetter__' } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("SECURITY: '__defineSetter__' is a reserved JavaScript keyword and cannot be used as nameFor.comment");
    })
  );

  it.effect('should reject a critical name as attributes.prefix', () =>
    Effect.gen(function* () {
      const result = yield* makeOptions({ attributes: { prefix: 'constructor' } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("SECURITY: 'constructor' is a reserved JavaScript keyword and cannot be used as attributes.prefix");
    })
  );

  it.effect('should reject a critical name as attributes.groupBy', () =>
    Effect.gen(function* () {
      const result = yield* makeOptions({ attributes: { groupBy: 'prototype' } }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("SECURITY: 'prototype' is a reserved JavaScript keyword and cannot be used as attributes.groupBy");
    })
  );

  // ─── STRICT RESERVED NAMES ──────────────────────────────────────────────────
  // When strictReservedNames: true, a tag/attribute name that collides with
  // a nameFor.* value must throw, even when it wouldn't normally be dangerous.

  it.effect('should throw when strictReservedNames is true and a tag name matches nameFor.text', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ strictReservedNames: true, nameFor: { text: 'abc' } });
      const result = yield* parser.parse('<abc>normal</abc>').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/Restricted tag name: abc/);
    })
  );

  it.effect('should throw when strictReservedNames is true and a tag name matches nameFor.cdata', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ strictReservedNames: true, nameFor: { cdata: 'mydata' } });
      const result = yield* parser.parse('<mydata><![CDATA[content]]></mydata>').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/Restricted tag name: mydata/);
    })
  );

  it.effect('should throw when strictReservedNames is true and a tag name matches nameFor.comment', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ strictReservedNames: true, nameFor: { comment: 'note' } });
      const result = yield* parser.parse('<note>text</note>').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/Restricted tag name: note/);
    })
  );

  it.effect('should throw when strictReservedNames is true and an attribute name matches attributes.groupBy', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ strictReservedNames: true, attributes: { groupBy: 'meta', prefix: '' }, skip: { attributes: false } });
      const result = yield* parser.parse(`<root meta="value"></root>`).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/Restricted attribute name: meta/);
    })
  );

  // ─── sanitizeNames: false ────────────────────────────────────────────────
  // Fully disables the dangerous-name/prototype-pollution check for trusted
  // input. Must not touch strictReservedNames, a separate concern.

  it.effect('should let a dangerous tag name through unprefixed when sanitizeNames is false', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ sanitizeNames: false });
      const result = (yield* parser.parse('<hasOwnProperty>value</hasOwnProperty>')) as ParsedNode;
      expect(Object.prototype.hasOwnProperty.call(result, 'hasOwnProperty')).toBe(true);
      expect(result['hasOwnProperty']).toBe('value');
    })
  );

  it.effect('should let a dangerous attribute name through unprefixed when sanitizeNames is false', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ sanitizeNames: false, attributes: { prefix: '' }, skip: { attributes: false } });
      const result = (yield* parser.parse(`<root hasOwnProperty="value"></root>`)) as ParsedNode;
      expect(result.root['hasOwnProperty']).toBe('value');
    })
  );

  it.effect('should still throw on a critical name even when sanitizeNames is false (not skippable)', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ sanitizeNames: false });
      const result = yield* parser.parse('<__proto__>value</__proto__>').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/is a reserved JavaScript keyword that could cause prototype pollution/);
    })
  );

  it.effect('should still enforce strictReservedNames when sanitizeNames is false', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ sanitizeNames: false, strictReservedNames: true, nameFor: { text: 'abc' } });
      const result = yield* parser.parse('<abc>normal</abc>').pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/Restricted tag name: abc/);
    })
  );

  // ─── name cache correctness ──────────────────────────────────────────────
  // A cache must never change *what* is thrown/returned — only skip repeat
  // work. These guard against "only sanitized/validated on first sight".

  it.effect('should sanitize a dangerous tag name identically on every repeated occurrence', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parse('<root><toString>a</toString><toString>b</toString><toString>c</toString></root>')) as ParsedNode;
      expect(result.root.__toString).toEqual(['a', 'b', 'c']);
    })
  );

  it.effect('should keep throwing on a critical tag name across repeated parse() calls, not just the first', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const first = yield* parser.parse('<constructor>x</constructor>').pipe(Effect.result);
      assert(Result.isFailure(first));
      expect(first.failure.message).toMatch(/prototype pollution/);
      const second = yield* parser.parse('<constructor>y</constructor>').pipe(Effect.result);
      assert(Result.isFailure(second));
      expect(second.failure.message).toMatch(/prototype pollution/);
      const third = yield* parser.parse('<constructor>z</constructor>').pipe(Effect.result);
      assert(Result.isFailure(third));
      expect(third.failure.message).toMatch(/prototype pollution/);
    })
  );

  it.effect('should keep throwing on a strictReservedNames collision across repeated parse() calls', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ strictReservedNames: true, nameFor: { text: 'abc' } });
      const first = yield* parser.parse('<abc>1</abc>').pipe(Effect.result);
      assert(Result.isFailure(first));
      expect(first.failure.message).toMatch(/Restricted tag name: abc/);
      const second = yield* parser.parse('<abc>2</abc>').pipe(Effect.result);
      assert(Result.isFailure(second));
      expect(second.failure.message).toMatch(/Restricted tag name: abc/);
    })
  );

  it.effect('should reuse the same name cache across repeated parse() calls on one XMLParser instance', () =>
    Effect.gen(function* () {
      // Not observable behavior per se, but pins down the documented design:
      // options._nameCache is created once and shared by every Xml2JsParser
      // this XMLParser instance spawns.
      const parser = yield* XMLParser.make();
      yield* parser.parse('<root><a>1</a></root>');
      const cacheAfterFirst = parser.options._nameCache;
      expect(cacheAfterFirst).toBeDefined();
      yield* parser.parse('<root><a>2</a></root>');
      expect(parser.options._nameCache).toBe(cacheAfterFirst);
      expect(cacheAfterFirst.tags.has('root')).toBe(true);
      expect(cacheAfterFirst.tags.has('a')).toBe(true);
    })
  );

  it.effect('should give two separate XMLParser instances two separate name caches', () =>
    Effect.gen(function* () {
      const parserA = yield* XMLParser.make();
      const parserB = yield* XMLParser.make();
      expect(parserA.options._nameCache).not.toBe(parserB.options._nameCache);
    })
  );
});

// NOTE: Entity expansion limit tests (maxEntityCount, maxEntitySize, maxTotalExpansions,
// maxExpandedLength, Billion Laughs mitigation, per-parse isolation) are covered
// comprehensively in doctype_spec.js. They are not duplicated here.
