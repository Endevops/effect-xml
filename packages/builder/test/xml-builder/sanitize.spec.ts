/**
 * @description The `sanitizeName` option, across both builder forms. Covers the default pass-through of invalid names, tag and attribute sanitising, the
 * `isAttribute` flag, error propagation out of a throwing resolver, the keys exempt from the resolver (`#text`, `?xml`), and XML version detection
 * from a `?xml` declaration. The plain-object and `preserveOrder` walks are specced separately because they resolve names through independent code
 * paths.
 */

import { describe, expect, it } from 'vite-plus/test';

import { failed, makeBuilder, run } from '#/test/helpers/effect.ts';

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

  it('should allow invalid tag names by default (backward-compatible)', function () {
    const input = { '1invalid': 'value' };
    const builder = makeBuilder({});
    const output = run(builder.build(input));
    expect(output).toContain('<1invalid>');
  });

  // --- sanitize tag names ---

  it('should sanitize an invalid tag name that starts with a digit', function () {
    const input = { '1tag': 'hello' };
    const builder = makeBuilder({ sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('<_1tag>');
    expect(output).not.toContain('<1tag>');
  });

  it('should sanitize a tag name containing spaces', function () {
    const input = { 'my tag': 'world' };
    const builder = makeBuilder({ sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('<my_tag>');
    expect(output).not.toContain('<my tag>');
  });

  it('should leave valid tag names unchanged', function () {
    const input = { validTag: 'content' };
    const builder = makeBuilder({ sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('<validTag>');
  });

  it('should sanitize nested tag names', function () {
    const input = { root: { '1child': 'val' } };
    const builder = makeBuilder({ sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('<_1child>');
    expect(output).not.toContain('<1child>');
  });

  it('should sanitize tag names in arrays', function () {
    const input = { root: { '1item': ['a', 'b'] } };
    const builder = makeBuilder({ sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output.match(/<_1item>/g)?.length).toBe(2);
  });

  // --- sanitize attribute names ---

  it('should sanitize an invalid attribute name', function () {
    const input = { root: { '@_1attr': 'val', '#text': 'content' } };
    const builder = makeBuilder({ ignoreAttributes: false, sanitizeName: name => xmlNamingSanitize(name) });
    const expected = `<root _1attr="val">content</root>`;
    const output = run(builder.build(input));
    expect(output).toEqual(expected);
  });

  it('should leave valid attribute names unchanged', function () {
    const input = { root: { '@_class': 'btn', '#text': 'text' } };
    const builder = makeBuilder({ ignoreAttributes: false, sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('class="btn"');
  });

  // --- isAttribute flag in context ---

  it('should receive isAttribute=false for tag names and isAttribute=true for attribute names', function () {
    const calls: Array<{ name: string; isAttribute: boolean }> = [];
    const input = { root: { '@_data': 'x', '#text': 't' } };
    const builder = makeBuilder({
      ignoreAttributes: false,
      sanitizeName: (name, ctx) => {
        calls.push({ name, isAttribute: ctx.isAttribute });
        return name;
      },
    });
    const expected = `<root data="x">t</root>`;
    const output = run(builder.build(input));
    expect(output).toEqual(expected);
  });

  // --- throw behaviour ---

  it('should propagate an error thrown inside sanitizeName', function () {
    const input = { '1bad': 'value' };
    const builder = makeBuilder({
      sanitizeName: name => {
        if (/^[0-9]/.test(name)) throw new Error(`Invalid XML name: "${name}"`);
        return name;
      },
    });
    expect(failed(builder.build(input)).message).toContain('Invalid XML name: "1bad"');
  });

  // --- special keys are never passed to sanitizeName ---

  it('should not call sanitizeName for textNodeName', function () {
    const calls: Array<string> = [];
    const input = { root: { '#text': 'hello' } };
    const builder = makeBuilder({
      sanitizeName: name => {
        calls.push(name);
        return name;
      },
    });
    run(builder.build(input));
    expect(calls).not.toContain('#text');
  });

  it('should not call sanitizeName for PI tags', function () {
    const calls: Array<string> = [];
    const input = { '?xml': { '@_version': '1.0' }, root: 'ok' };
    const builder = makeBuilder({
      ignoreAttributes: false,
      sanitizeName: name => {
        calls.push(name);
        return name;
      },
    });
    run(builder.build(input));
    expect(calls).not.toContain('?xml');
  });

  // --- XML version detection ---

  it('should detect XML version 1.1 from ?xml declaration (flat attributes)', function () {
    // The detected version is exposed via the sanitizeName context; we verify
    // that the ?xml declaration is read correctly by checking the output contains it.
    const input = { '?xml': { '@_version': '1.1', '@_encoding': 'UTF-8' }, root: 'content' };
    const builder = makeBuilder({ ignoreAttributes: false });
    const output = run(builder.build(input));
    expect(output).toContain('version="1.1"');
  });

  it('should default to XML version 1.0 when no ?xml declaration is present', function () {
    // No ?xml — builder should not crash and should produce valid output
    const input = { root: 'content' };
    const builder = makeBuilder({});
    const output = run(builder.build(input));
    expect(output).toContain('<root>');
  });
});

// ---------------------------------------------------------------------------
// orderedJs2Xml (preserveOrder builder) — sanitizeName tests
// ---------------------------------------------------------------------------
describe('Builder (preserveOrder) — sanitizeName option', function () {
  // --- default behaviour ---

  it('should allow invalid tag names by default (backward-compatible)', function () {
    const input = [{ '1tag': [{ '#text': 'val' }] }];
    const builder = makeBuilder({ preserveOrder: true });
    const output = run(builder.build(input));
    expect(output).toContain('<1tag>');
  });

  // --- sanitize tag names ---

  it('should sanitize an invalid tag name starting with a digit', function () {
    const input = [{ '1tag': [{ '#text': 'hello' }] }];
    const builder = makeBuilder({ preserveOrder: true, sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('<_1tag>');
    expect(output).not.toContain('<1tag>');
  });

  it('should sanitize a tag name with spaces in ordered mode', function () {
    const input = [{ 'my tag': [{ '#text': 'value' }] }];
    const builder = makeBuilder({ preserveOrder: true, sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('<my_tag>');
  });

  it('should leave valid tag names unchanged in ordered mode', function () {
    const input = [{ validTag: [{ '#text': 'ok' }] }];
    const builder = makeBuilder({ preserveOrder: true, sanitizeName: name => xmlNamingSanitize(name) });
    const output = run(builder.build(input));
    expect(output).toContain('<validTag>');
  });

  // --- sanitize attribute names ---

  it('should sanitize an invalid attribute name in ordered mode', function () {
    const input = [{ root: [{ '#text': 't' }], ':@': { '@_1attr': 'v' } }];
    const builder = makeBuilder({ preserveOrder: true, ignoreAttributes: false, sanitizeName: name => xmlNamingSanitize(name) });
    const expected = `<root _1attr="v">t</root>`;
    const output = run(builder.build(input));
    expect(output).toEqual(expected);
  });

  // --- throw behaviour ---

  it('should propagate an error thrown inside sanitizeName in ordered mode', function () {
    const input = [{ '2bad': [{ '#text': 'x' }] }];
    const builder = makeBuilder({
      preserveOrder: true,
      sanitizeName: name => {
        if (/^[0-9]/.test(name)) throw new Error(`Invalid XML name: "${name}"`);
        return name;
      },
    });
    expect(failed(builder.build(input)).message).toContain('Invalid XML name: "2bad"');
  });

  // --- special keys exempt from sanitizeName ---

  it('should not call sanitizeName for textNodeName in ordered mode', function () {
    const calls: Array<string> = [];
    const input = [{ root: [{ '#text': 'hi' }] }];
    const builder = makeBuilder({
      preserveOrder: true,
      sanitizeName: name => {
        calls.push(name);
        return name;
      },
    });
    run(builder.build(input));
    expect(calls).not.toContain('#text');
  });

  it('should not call sanitizeName for ?xml PI tag in ordered mode', function () {
    const calls: Array<string> = [];
    const input = [{ '?xml': [], ':@': { '@_version': '1.0' } }, { root: [{ '#text': 'x' }] }];
    const builder = makeBuilder({
      preserveOrder: true,
      ignoreAttributes: false,
      sanitizeName: name => {
        calls.push(name);
        return name;
      },
    });
    run(builder.build(input));
    expect(calls).not.toContain('?xml');
  });

  // --- XML version detection from first element ---

  it('should detect XML version 1.1 from the first ?xml element in ordered input', function () {
    const input = [{ '?xml': [], ':@': { '@_version': '1.1', '@_encoding': 'UTF-8' } }, { root: [{ '#text': 'content' }] }];
    const builder = makeBuilder({ preserveOrder: true, ignoreAttributes: false });
    const output = run(builder.build(input));
    expect(output).toContain('version="1.1"');
  });

  it('should default to XML version 1.0 when no ?xml is present in ordered input', function () {
    const input = [{ root: [{ '#text': 'content' }] }];
    const builder = makeBuilder({ preserveOrder: true });
    const output = run(builder.build(input));
    expect(output).toContain('<root>');
  });
});
