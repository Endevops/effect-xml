import { describe, it, expect } from '@effect/vitest';
import { CompactBuilderFactory, makeCompactBuilder } from '@endevops/builder';
import { Effect } from 'effect';

import type { OutputBuilderFactoryLike, XmlDeclaration } from '#/internal/parser-types.ts';

import { asOutputBuilder } from '#/test/helpers/recording-builder.ts';
import { runAcrossAllInputSources, runAcrossAllInputSourcesWithException } from '#/test/helpers/test-runner.ts';
import { XMLParser } from '#/xml-parser.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 1. XML declaration (<?xml ... ?>)
// ─────────────────────────────────────────────────────────────────────────────
describe('Processing Instructions — XML declaration', function () {
  runAcrossAllInputSources('should include XML declaration in output by default', `<?xml version="1.0"?><root><tag>value</tag></root>`, result => {
    expect(result['?xml']).toBeDefined();
    expect(result.root.tag).toBe('value');
  });

  runAcrossAllInputSources(
    'should capture declaration attributes when skip.attributes is false',
    `<?xml version="1.0" encoding="UTF-8"?><root/>`,
    result => {
      expect(result['?xml']['@_version']).toBe(1.0);
      expect(result['?xml']['@_encoding']).toBe('UTF-8');
    },
    { skip: { attributes: false } }
  );

  runAcrossAllInputSources(
    'should keep declaration version as raw string when valueParsers is empty',
    `<?xml version="1.0"?><root/>`,
    result => {
      expect(result['?xml']['@_version']).toBe('1.0');
    },
    { skip: { attributes: false }, OutputBuilder: CompactBuilderFactory.make({ attributes: { valueParsers: [] } }) }
  );

  // NOTE: skip.declaration is currently not working as expected due to a bug
  // in xml-special-tags-reader.js. The tagName returned by readPiExp is "xml"
  // (without the leading "?"), so the check `tagExp.tagName === "?xml"` always
  // fails — addDeclaration() is never called, addInstruction("?xml") is always used,
  // and skip.declaration: true has no effect. This test documents the BUG:
  it.effect('BUG: skip.declaration: true should omit ?xml from output (currently broken)', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { declaration: true } });
      const result = yield* parser.parse(`<?xml version="1.0"?><root/>`);
      expect(result['?xml']).toBeUndefined();
      expect(result.root).toBe('');
    })
  );

  it.effect('does NOT reach the builder when both attributes and declaration are skipped', () =>
    Effect.gen(function* () {
      // `XmlSpecialTagsReader` guards the call with `if (!skipOptions.declaration)`
      // before `flushAttributes` and `addDeclaration`, so with both skips set the
      // builder is never told about the declaration at all. This case used to
      // assert the opposite from inside the override, where the expectation was
      // never evaluated because the override was never called — it passed
      // vacuously. The captured value is asserted after the parse so a missed
      // call is a real failure.
      const seen: Array<XmlDeclaration> = [];
      const base = yield* CompactBuilderFactory.make();
      const factory: OutputBuilderFactoryLike = {
        getInstance(parserOpts, readonlyMatcher) {
          const inner = makeCompactBuilder(parserOpts, base.builderOptions, readonlyMatcher, base.registry);
          // Captured before the override replaces it, then assigned onto the same
          // object: the builder is mutable state and a spread would leave two
          // divergent copies.
          const addDeclaration = inner.addDeclaration.bind(inner);
          Object.assign(inner, {
            addDeclaration(name: string, xmlDef?: XmlDeclaration) {
              if (xmlDef) seen.push(xmlDef);
              addDeclaration(name, xmlDef);
            },
          });
          return Effect.succeed(asOutputBuilder(inner));
        },
      };

      const xmlData = `<?xml version="1.1"?><root/>`;

      const parser = yield* XMLParser.make({ skip: { declaration: true, attributes: true }, OutputBuilder: factory });

      const result = yield* parser.parse(xmlData);
      expect(seen).toEqual([]);
      // The declaration is absent from the output tree too, which is the point
      // of `skip.declaration`.
      expect(result['?xml']).toBeUndefined();
    })
  );

  it.effect('reaches the builder with the parsed def when only the declaration is skipped from the tree', () =>
    Effect.gen(function* () {
      // Same builder, but with `skip.declaration` off: the def arrives intact,
      // which is what makes the guard above a suppression rather than a loss.
      const seen: Array<XmlDeclaration> = [];
      const base = yield* CompactBuilderFactory.make();
      const factory: OutputBuilderFactoryLike = {
        getInstance(parserOpts, readonlyMatcher) {
          const inner = makeCompactBuilder(parserOpts, base.builderOptions, readonlyMatcher, base.registry);
          // Captured before the override replaces it, then assigned onto the same
          // object: the builder is mutable state and a spread would leave two
          // divergent copies.
          const addDeclaration = inner.addDeclaration.bind(inner);
          Object.assign(inner, {
            addDeclaration(name: string, xmlDef?: XmlDeclaration) {
              if (xmlDef) seen.push(xmlDef);
              addDeclaration(name, xmlDef);
            },
          });
          return Effect.succeed(asOutputBuilder(inner));
        },
      };

      const parser = yield* XMLParser.make({ skip: { attributes: false }, OutputBuilder: factory });
      yield* parser.parse(`<?xml version="1.1"?><root/>`);

      expect(seen.length).toBe(1);
      expect(seen[0]!.version).toBe(1.1);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Other processing instructions
// ─────────────────────────────────────────────────────────────────────────────
describe('Processing Instructions — non-declaration PI tags', function () {
  runAcrossAllInputSources(
    'should include PI tags in output by default',
    `<?xml version="1.0"?><?xml-stylesheet href="style.css"?><root/>`,
    result => {
      expect(result['?xml-stylesheet']).toBeDefined();
    },
    { skip: { attributes: false } }
  );

  runAcrossAllInputSources(
    'should capture PI tag attributes',
    `<?xml-stylesheet href="mystyle.xslt" type="text/xsl"?><root/>`,
    result => {
      expect(result['?xml-stylesheet']['@_href']).toBe('mystyle.xslt');
      expect(result['?xml-stylesheet']['@_type']).toBe('text/xsl');
    },
    { skip: { attributes: false } }
  );

  runAcrossAllInputSources('should handle PI tag with no attributes', `<?xml version="1.0"?><?mso-contentType?><root/>`, result => {
    expect(result['?mso-contentType']).toBeDefined();
    expect(result['?mso-contentType']).toBe('');
  });

  runAcrossAllInputSources(
    'should handle PI tag name containing a hyphen',
    `<?xml-stylesheet href="a.css"?><root/>`,
    result => {
      expect(result['?xml-stylesheet']).toBeDefined();
    },
    { skip: { attributes: false } }
  );

  runAcrossAllInputSources(
    'should handle multiple PI tags before root element',
    `<?xml version="1.0"?><?pi1 a="1"?><?pi2 b="2"?><root/>`,
    result => {
      expect(result['?xml']).toBeDefined();
      expect(result['?pi1']['@_a']).toBe(1);
      expect(result['?pi2']['@_b']).toBe(2);
    },
    { skip: { attributes: false } }
  );

  runAcrossAllInputSources(
    'should handle PI tag appearing inside an element',
    `<root><?proc data="x"?><child>value</child></root>`,
    result => {
      expect(result.root['?proc']).toBeDefined();
      expect(result.root.child).toBe('value');
    },
    { skip: { attributes: false } }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. skip.pi — suppressing non-declaration PI tags
// ─────────────────────────────────────────────────────────────────────────────
describe('Processing Instructions — skip.pi', function () {
  runAcrossAllInputSources(
    'should omit non-declaration PI tags when skip.pi: true',
    `<?xml version="1.0"?><?xml-stylesheet href="a.css"?><root/>`,
    result => {
      expect(result['?xml-stylesheet']).toBeUndefined();
      expect(result.root).toBe('');
    },
    { skip: { pi: true } }
  );

  runAcrossAllInputSources(
    'should keep XML declaration even when skip.pi: true',
    `<?xml version="1.0"?><?ignored data="x"?><root/>`,
    result => {
      // Declaration is always kept when skip.pi: true (only non-xml PIs are skipped)
      expect(result['?xml']).toBeDefined();
      expect(result['?ignored']).toBeUndefined();
    },
    { skip: { pi: true } }
  );

  runAcrossAllInputSources(
    'should omit all non-declaration PI tags when skip.pi: true',
    `<?xml version="1.0"?><?pi1 a="1"?><?pi2 b="2"?><root/>`,
    result => {
      expect(result['?pi1']).toBeUndefined();
      expect(result['?pi2']).toBeUndefined();
      expect(result.root).toBe('');
    },
    { skip: { pi: true } }
  );

  runAcrossAllInputSources(
    'should omit PI tags inside elements when skip.pi: true',
    `<root><?proc data="x"?><child>value</child></root>`,
    result => {
      expect(result.root['?proc']).toBeUndefined();
      expect(result.root.child).toBe('value');
    },
    { skip: { pi: true } }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Boolean (valueless) attributes in PI tags
// ─────────────────────────────────────────────────────────────────────────────
describe('Processing Instructions — boolean attributes', function () {
  runAcrossAllInputSources(
    'should treat valueless PI attributes as true when booleanType is allow',
    `<?textinfo whitespace standalone?><root/>`,
    result => {
      expect(result['?textinfo']['@_whitespace']).toBe(true);
      expect(result['?textinfo']['@_standalone']).toBe(true);
    },
    { skip: { attributes: false }, attributes: { booleanType: 'allow' } }
  );

  runAcrossAllInputSources(
    'should mix valued and valueless PI attributes',
    `<?proc version="2" debug standalone?><root/>`,
    result => {
      expect(result['?proc']['@_version']).toBe(2);
      expect(result['?proc']['@_debug']).toBe(true);
      expect(result['?proc']['@_standalone']).toBe(true);
    },
    { skip: { attributes: false }, attributes: { booleanType: 'allow' } }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Malformed PI tags
// ─────────────────────────────────────────────────────────────────────────────
describe('Processing Instructions — malformed PI', function () {
  runAcrossAllInputSourcesWithException('should throw when PI tag is not closed', `<?xml version="1.0"?><?pi  `, /Unexpected closing of source/);

  // Regression for the "enough left to read?" fix: a large amount of prior
  // content used to make the closing-tag scan keep going well past the real
  // end of the document before giving up. Confirms the same, correct error
  // still comes back once real content precedes the unclosed PI tag.
  runAcrossAllInputSourcesWithException(
    'should throw when PI tag is not closed, deep inside a long document',
    `<root>${'x'.repeat(5000)}</root><?pi  `,
    /Unexpected closing of source/
  );
});
