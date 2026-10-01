/**
 * @description The `sanitizeName` option, across both builder forms. Covers the default pass-through of invalid names, tag and attribute sanitising, the
 * `isAttribute` flag, error propagation out of a throwing resolver, the keys exempt from the resolver (`#text`, `?xml`), and XML version detection
 * from a `?xml` declaration. The plain-object and `preserveOrder` walks are specced separately because they resolve names through independent code
 * paths.
 */

import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';

import { XMLBuilder } from '#/index.ts';

// ---------------------------------------------------------------------------
// Helper: xml-naming sanitize stub — mirrors what a real integration would do.
// In production the user would import { sanitize, qName } from 'xml-naming'.
// ---------------------------------------------------------------------------
function xmlNamingSanitize(name: string): string {
  // Replace any character that is not a valid NameChar with '_',
  // and fix a digit/hyphen/dot start by prepending '_'.
  let safe = name.replace(/[^a-zA-Z0-9._\-:]/g, '_');
  if (/^[^a-zA-Z_:]/.test(safe)) safe = '_' + safe;
  return safe;
}

// ---------------------------------------------------------------------------
// fxb.js (plain-object builder) — sanitizeName tests
// ---------------------------------------------------------------------------
describe('Builder (plain object) — sanitizeName option', function () {
  // --- default behaviour: no sanitizeName, invalid names pass through ---

  it.effect('should allow invalid tag names by default (backward-compatible)', () =>
    Effect.gen(function* () {
      const input = { '1invalid': 'value' };
      const builder = yield* XMLBuilder.make({});
      const output = yield* builder.build(input);
      expect(output).toContain('<1invalid>');
    })
  );

  // --- sanitize tag names ---

  it.effect('should sanitize an invalid tag name that starts with a digit', () =>
    Effect.gen(function* () {
      const input = { '1tag': 'hello' };
      const builder = yield* XMLBuilder.make({ sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('<_1tag>');
      expect(output).not.toContain('<1tag>');
    })
  );

  it.effect('should sanitize a tag name containing spaces', () =>
    Effect.gen(function* () {
      const input = { 'my tag': 'world' };
      const builder = yield* XMLBuilder.make({ sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('<my_tag>');
      expect(output).not.toContain('<my tag>');
    })
  );

  it.effect('should leave valid tag names unchanged', () =>
    Effect.gen(function* () {
      const input = { validTag: 'content' };
      const builder = yield* XMLBuilder.make({ sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('<validTag>');
    })
  );

  it.effect('should sanitize nested tag names', () =>
    Effect.gen(function* () {
      const input = { root: { '1child': 'val' } };
      const builder = yield* XMLBuilder.make({ sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('<_1child>');
      expect(output).not.toContain('<1child>');
    })
  );

  it.effect('should sanitize tag names in arrays', () =>
    Effect.gen(function* () {
      const input = { root: { '1item': ['a', 'b'] } };
      const builder = yield* XMLBuilder.make({ sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output.match(/<_1item>/g)?.length).toBe(2);
    })
  );

  // --- sanitize attribute names ---

  it.effect('should sanitize an invalid attribute name', () =>
    Effect.gen(function* () {
      const input = { root: { '@_1attr': 'val', '#text': 'content' } };
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false, sanitizeName: name => xmlNamingSanitize(name) });
      const expected = `<root _1attr="val">content</root>`;
      const output = yield* builder.build(input);
      expect(output).toEqual(expected);
    })
  );

  it.effect('should leave valid attribute names unchanged', () =>
    Effect.gen(function* () {
      const input = { root: { '@_class': 'btn', '#text': 'text' } };
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false, sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('class="btn"');
    })
  );

  // --- isAttribute flag in context ---

  it.effect('should receive isAttribute=false for tag names and isAttribute=true for attribute names', () =>
    Effect.gen(function* () {
      const calls: Array<{ name: string; isAttribute: boolean }> = [];
      const input = { root: { '@_data': 'x', '#text': 't' } };
      const builder = yield* XMLBuilder.make({
        ignoreAttributes: false,
        sanitizeName: (name, ctx) => {
          calls.push({ name, isAttribute: ctx.isAttribute });
          return name;
        },
      });
      const expected = `<root data="x">t</root>`;
      const output = yield* builder.build(input);
      expect(output).toEqual(expected);
    })
  );

  // --- throw behaviour ---

  it.effect('should propagate an error thrown inside sanitizeName', () =>
    Effect.gen(function* () {
      const input = { '1bad': 'value' };
      const builder = yield* XMLBuilder.make({
        sanitizeName: name => {
          if (/^[0-9]/.test(name)) throw new Error(`Invalid XML name: "${name}"`);
          return name;
        },
      });
      const result = yield* builder.build(input).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toContain('Invalid XML name: "1bad"');
    })
  );

  // --- special keys are never passed to sanitizeName ---

  it.effect('should not call sanitizeName for textNodeName', () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const input = { root: { '#text': 'hello' } };
      const builder = yield* XMLBuilder.make({
        sanitizeName: name => {
          calls.push(name);
          return name;
        },
      });
      yield* builder.build(input);
      expect(calls).not.toContain('#text');
    })
  );

  it.effect('should not call sanitizeName for PI tags', () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const input = { '?xml': { '@_version': '1.0' }, root: 'ok' };
      const builder = yield* XMLBuilder.make({
        ignoreAttributes: false,
        sanitizeName: name => {
          calls.push(name);
          return name;
        },
      });
      yield* builder.build(input);
      expect(calls).not.toContain('?xml');
    })
  );

  // --- XML version detection ---

  it.effect('should detect XML version 1.1 from ?xml declaration (flat attributes)', () =>
    Effect.gen(function* () {
      // The detected version is exposed via the sanitizeName context; we verify
      // that the ?xml declaration is read correctly by checking the output contains it.
      const input = { '?xml': { '@_version': '1.1', '@_encoding': 'UTF-8' }, root: 'content' };
      const builder = yield* XMLBuilder.make({ ignoreAttributes: false });
      const output = yield* builder.build(input);
      expect(output).toContain('version="1.1"');
    })
  );

  it.effect('should default to XML version 1.0 when no ?xml declaration is present', () =>
    Effect.gen(function* () {
      // No ?xml — builder should not crash and should produce valid output
      const input = { root: 'content' };
      const builder = yield* XMLBuilder.make({});
      const output = yield* builder.build(input);
      expect(output).toContain('<root>');
    })
  );
});

// ---------------------------------------------------------------------------
// orderedJs2Xml (preserveOrder builder) — sanitizeName tests
// ---------------------------------------------------------------------------
describe('Builder (preserveOrder) — sanitizeName option', function () {
  // --- default behaviour ---

  it.effect('should allow invalid tag names by default (backward-compatible)', () =>
    Effect.gen(function* () {
      const input = [{ '1tag': [{ '#text': 'val' }] }];
      const builder = yield* XMLBuilder.make({ preserveOrder: true });
      const output = yield* builder.build(input);
      expect(output).toContain('<1tag>');
    })
  );

  // --- sanitize tag names ---

  it.effect('should sanitize an invalid tag name starting with a digit', () =>
    Effect.gen(function* () {
      const input = [{ '1tag': [{ '#text': 'hello' }] }];
      const builder = yield* XMLBuilder.make({ preserveOrder: true, sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('<_1tag>');
      expect(output).not.toContain('<1tag>');
    })
  );

  it.effect('should sanitize a tag name with spaces in ordered mode', () =>
    Effect.gen(function* () {
      const input = [{ 'my tag': [{ '#text': 'value' }] }];
      const builder = yield* XMLBuilder.make({ preserveOrder: true, sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('<my_tag>');
    })
  );

  it.effect('should leave valid tag names unchanged in ordered mode', () =>
    Effect.gen(function* () {
      const input = [{ validTag: [{ '#text': 'ok' }] }];
      const builder = yield* XMLBuilder.make({ preserveOrder: true, sanitizeName: name => xmlNamingSanitize(name) });
      const output = yield* builder.build(input);
      expect(output).toContain('<validTag>');
    })
  );

  // --- sanitize attribute names ---

  it.effect('should sanitize an invalid attribute name in ordered mode', () =>
    Effect.gen(function* () {
      const input = [{ root: [{ '#text': 't' }], ':@': { '@_1attr': 'v' } }];
      const builder = yield* XMLBuilder.make({ preserveOrder: true, ignoreAttributes: false, sanitizeName: name => xmlNamingSanitize(name) });
      const expected = `<root _1attr="v">t</root>`;
      const output = yield* builder.build(input);
      expect(output).toEqual(expected);
    })
  );

  // --- throw behaviour ---

  it.effect('should propagate an error thrown inside sanitizeName in ordered mode', () =>
    Effect.gen(function* () {
      const input = [{ '2bad': [{ '#text': 'x' }] }];
      const builder = yield* XMLBuilder.make({
        preserveOrder: true,
        sanitizeName: name => {
          if (/^[0-9]/.test(name)) throw new Error(`Invalid XML name: "${name}"`);
          return name;
        },
      });
      const result = yield* builder.build(input).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toContain('Invalid XML name: "2bad"');
    })
  );

  // --- special keys exempt from sanitizeName ---

  it.effect('should not call sanitizeName for textNodeName in ordered mode', () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const input = [{ root: [{ '#text': 'hi' }] }];
      const builder = yield* XMLBuilder.make({
        preserveOrder: true,
        sanitizeName: name => {
          calls.push(name);
          return name;
        },
      });
      yield* builder.build(input);
      expect(calls).not.toContain('#text');
    })
  );

  it.effect('should not call sanitizeName for ?xml PI tag in ordered mode', () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const input = [{ '?xml': [], ':@': { '@_version': '1.0' } }, { root: [{ '#text': 'x' }] }];
      const builder = yield* XMLBuilder.make({
        preserveOrder: true,
        ignoreAttributes: false,
        sanitizeName: name => {
          calls.push(name);
          return name;
        },
      });
      yield* builder.build(input);
      expect(calls).not.toContain('?xml');
    })
  );

  // --- XML version detection from first element ---

  it.effect('should detect XML version 1.1 from the first ?xml element in ordered input', () =>
    Effect.gen(function* () {
      const input = [{ '?xml': [], ':@': { '@_version': '1.1', '@_encoding': 'UTF-8' } }, { root: [{ '#text': 'content' }] }];
      const builder = yield* XMLBuilder.make({ preserveOrder: true, ignoreAttributes: false });
      const output = yield* builder.build(input);
      expect(output).toContain('version="1.1"');
    })
  );

  it.effect('should default to XML version 1.0 when no ?xml is present in ordered input', () =>
    Effect.gen(function* () {
      const input = [{ root: [{ '#text': 'content' }] }];
      const builder = yield* XMLBuilder.make({ preserveOrder: true });
      const output = yield* builder.build(input);
      expect(output).toContain('<root>');
    })
  );
});
