/**
 * @description PathExpression_spec.js. Integration tests for path-expression-matcher (PEM) in flexible-xml-parser. Covers:
 *
 * 1. StopNodes — string, Expression, wildcard, deep-wildcard, attribute condition, position selector, nested same-name tag, attribute-based stop
 * 2. Value parser context — matcher in context, Expression matching, read-only enforcement, isLeafNode, elementType, attribute context
 * 3. Custom OutputBuilder — matcher in addTag / closeTag callbacks
 * 4. ReadOnlyMatcher — guards against mutation
 */

import type { BuilderError, Context, ValueParser } from '@endevops/builder';
import type { CompactBuilder } from '@endevops/builder';
import type { MatcherView } from '@endevops/common-xml';

import { describe, it, expect } from '@effect/vitest';
import { CompactBuilderFactory, makeCompactBuilder } from '@endevops/builder';
import { Expression } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { OutputBuilderFactoryLike } from '#/internal/parser-types.ts';

import { asOutputBuilder } from '#/test/helpers/recording-builder.ts';
import { XMLParser } from '#/xml-parser.ts';

// ─── Helper ──────────────────────────────────────────────────────────────────
/**
 * @description A per-document override of the compact builder. The callback runs once per document, so any closure state it keeps is per-document.
 */
type BuilderOverride = (base: CompactBuilder) => Partial<CompactBuilder>;

/**
 * @description Build a factory that produces a compact builder with a per-document override applied over it. The override's methods can delegate to `base`.
 *
 * @param override - Produces the members to override, given the fresh base builder.
 *
 * @returns An effect producing the parser-facing factory.
 */
function makeFactory(override: BuilderOverride = () => ({}) as Partial<CompactBuilder>): Effect.Effect<OutputBuilderFactoryLike> {
  return Effect.gen(function* () {
    const f = yield* CompactBuilderFactory.make().pipe(Effect.orDie);
    return {
      getInstance(parserOptions, readonlyMatcher) {
        const base = makeCompactBuilder(parserOptions, f.builderOptions, readonlyMatcher, f.registry);
        // Overrides are assigned onto the same object rather than spread into a
        // new one: the builder is mutable per-document state, and a spread would
        // copy `tagName`/`value`/`textValue` by value and leave the base and the
        // override operating on two divergent copies.
        Object.assign(base, override(base));
        return Effect.succeed(asOutputBuilder(base));
      },
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — stopNodes', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it.effect('should accept plain strings as stopNodes (existing behaviour preserved)', () =>
    Effect.gen(function* () {
      const xml = `<root><raw><b>bold</b></raw><parsed>text</parsed></root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: ['root.raw'] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.raw).toBe('string');
      expect(result.root.raw).toContain('<b>bold</b>');
      expect(result.root.parsed).toBe('text');
    })
  );

  it.effect('should accept pre-compiled Expression objects in stopNodes', () =>
    Effect.gen(function* () {
      const xml = `<root><raw><b>bold</b></raw><parsed>text</parsed></root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: [yield* Expression.make('root.raw')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.raw).toBe('string');
      expect(result.root.raw).toContain('<b>bold</b>');
    })
  );

  it.effect('should accept mixed strings and Expression objects in the same array', () =>
    Effect.gen(function* () {
      const xml = `<root><a><x/></a><b><x/></b></root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: ['root.a', yield* Expression.make('root.b')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.a).toBe('string');
      expect(typeof result.root.b).toBe('string');
    })
  );

  it.effect('should support deep-wildcard expression (..tag) matching at any depth', () =>
    Effect.gen(function* () {
      const xml = `
      <html>
        <body>
          <div>
            <section>
              <script>nested(); script();</script>
            </section>
          </div>
        </body>
      </html>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: [yield* Expression.make('..script')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.html.body.div.section.script).toBe('string');
      expect(result.html.body.div.section.script).toContain('nested()');
    })
  );

  it.effect('should support single-level wildcard (*.tag) matching exactly one parent', () =>
    Effect.gen(function* () {
      const xml = `<root><script>alert(1)</script></root>`;
      // *.script means exactly: [any single parent].script — matches root.script
      const parser = yield* XMLParser.make({ tags: { stopNodes: [yield* Expression.make('*.script')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.script).toBe('string');
      expect(result.root.script).toContain('alert(1)');
    })
  );

  it.effect('should stop at root-level tag when stopNode has no parent segment', () =>
    Effect.gen(function* () {
      const xml = `<script>window.x = 1;</script>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: [yield* Expression.make('..script')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.script).toBe('string');
      expect(result.script).toContain('window.x');
    })
  );

  it.effect('should match stop node with attribute condition — only stops when attr matches', () =>
    Effect.gen(function* () {
      const xml = `
      <root>
        <div class="raw"><inner>should be raw</inner></div>
        <div class="normal"><inner>should be parsed</inner></div>
      </root>`;
      const parser = yield* XMLParser.make({ skip: { attributes: false }, tags: { stopNodes: [yield* Expression.make('..div[class=raw]')] } });
      const result = yield* parser.parse(xml);

      // First div: stop node — content is raw string
      expect(typeof result.root.div[0]).toBe('object');
      expect(typeof result.root.div[0]['#text']).toBe('string');
      expect(result.root.div[0]['#text']).toContain('<inner>');

      // Second div: parsed normally
      expect(typeof result.root.div[1].inner).toBe('string');
      expect(result.root.div[1].inner).toBe('should be parsed');
    })
  );

  it.effect('should support position selector — only first occurrence is a stop node', () =>
    Effect.gen(function* () {
      const xml = `
      <root>
        <item>raw content</item>
        <item>parsed content</item>
        <item>also parsed</item>
      </root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: [yield* Expression.make('root.item:first')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.item[0]).toBe('string');
      expect(result.root.item[0]).toBe('raw content');
      // Items 1 and 2 are parsed normally (strings from text content, not stop nodes)
      expect(result.root.item[1]).toBe('parsed content');
      expect(result.root.item[2]).toBe('also parsed');
    })
  );

  it.effect('should capture content including nested tags of different names inside a stop node', () =>
    Effect.gen(function* () {
      const xml = `<root><stop><a>one</a><b><c>two</c></b></stop><after>ok</after></root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: [yield* Expression.make('root.stop')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.stop).toBe('string');
      expect(result.root.stop).toContain('<a>one</a>');
      expect(result.root.stop).toContain('<b><c>two</c></b>');
      expect(result.root.after).toBe('ok');
    })
  );

  it.effect('should produce empty string for an empty stop node', () =>
    Effect.gen(function* () {
      const xml = `<root><stop></stop></root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: ['root.stop'] } });
      const result = yield* parser.parse(xml);

      expect(result.root.stop).toBe('');
    })
  );

  it.effect('should produce empty string for a self-closing stop node', () =>
    Effect.gen(function* () {
      const xml = `<root><stop/></root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: ['root.stop'] } });
      const result = yield* parser.parse(xml);

      expect(result.root.stop).toBe('');
    })
  );

  it.effect('should preserve attributes on a stop node that has them', () =>
    Effect.gen(function* () {
      const xml = `<root><stop lang="en"><b>raw</b></stop></root>`;
      const parser = yield* XMLParser.make({ skip: { attributes: false }, tags: { stopNodes: ['root.stop'] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.stop).toBe('object');
      expect(result.root.stop['@_lang']).toBe('en');
      expect(result.root.stop['#text']).toContain('<b>raw</b>');
    })
  );

  it.effect('should match stop nodes at all levels when using ..tag expression', () =>
    Effect.gen(function* () {
      const xml = `
      <root>
        <pre>first pre</pre>
        <section>
          <pre>second pre</pre>
        </section>
      </root>`;
      const parser = yield* XMLParser.make({ tags: { stopNodes: [yield* Expression.make('..pre')] } });
      const result = yield* parser.parse(xml);

      expect(typeof result.root.pre).toBe('string');
      expect(result.root.pre).toBe('first pre');
      expect(typeof result.root.section.pre).toBe('string');
      expect(result.root.section.pre).toBe('second pre');
    })
  );
});

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — matcher in value parser context', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it.effect('should pass a ReadOnlyMatcher in context.matcher for tag values', () =>
    Effect.gen(function* () {
      let capturedMatcher: MatcherView | null = null;

      class CaptureMatcher implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context && !context.isAttribute) capturedMatcher = context.matcher;
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new CaptureMatcher()] } }) });
      yield* parser.parse(`<root><item>hello</item></root>`);

      expect(capturedMatcher).not.toBeNull();
      const m = capturedMatcher!;
      expect(typeof m.matches).toBe('function');
      expect(typeof m.getCurrentTag).toBe('function');
      expect(typeof m.getPosition).toBe('function');
    })
  );

  it.effect('should pass a ReadOnlyMatcher in context.matcher for attribute values', () =>
    Effect.gen(function* () {
      let capturedMatcher: MatcherView | null = null;

      class CaptureMatcher implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context?.isAttribute) capturedMatcher = context.matcher;
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({
        skip: { attributes: false },
        OutputBuilder: CompactBuilderFactory.make({ attributes: { valueParsers: [new CaptureMatcher()] } }),
      });
      yield* parser.parse(`<root><item id="1">hello</item></root>`);

      expect(capturedMatcher).not.toBeNull();
      expect(typeof capturedMatcher!.matches).toBe('function');
    })
  );

  it.effect('should allow Expression matching in a value parser to transform selectively', () =>
    Effect.gen(function* () {
      const adminExpr = yield* Expression.make('..user[role=admin]');

      class AdminUpperParser implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          // `matches` is a plain predicate now, so the answer is used directly
          // rather than run out of an effect.
          if (context?.matcher && context.matcher.matches(adminExpr)) {
            return Effect.succeed(typeof val === 'string' ? val.toUpperCase() : val);
          }
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({
        skip: { attributes: false },
        OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new AdminUpperParser()] } }),
      });
      const result = yield* parser.parse(
        `
      <users>
        <user role="admin">alice</user>
        <user role="viewer">bob</user>
      </users>`
      );

      expect(result.users.user[0]['#text']).toBe('ALICE');
      expect(result.users.user[1]['#text']).toBe('bob');
    })
  );

  it.effect('should provide correct elementType for tags vs attributes', () =>
    Effect.gen(function* () {
      const types: Array<string> = [];

      class TypeCapture implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          types.push(context?.isAttribute ? 'A' : 'E');
          return Effect.succeed(val);
        }
      }

      const typeCapture = new TypeCapture();
      const parser = yield* XMLParser.make({
        skip: { attributes: false },
        OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [typeCapture] }, attributes: { valueParsers: [typeCapture] } }),
      });
      yield* parser.parse(`<root><item id="1">text</item></root>`);

      expect(types).toContain('E');
      expect(types).toContain('A');
    })
  );

  it.effect('should set isLeafNode:true for simple text-only tags', () =>
    Effect.gen(function* () {
      const leafFlags: Array<{ name: string; isLeaf: boolean | null }> = [];

      class LeafCapture implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context && !context.isAttribute) {
            leafFlags.push({ name: context.elementName, isLeaf: context.isLeafNode });
          }
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new LeafCapture()] } }) });
      yield* parser.parse(`<root><leaf>text</leaf></root>`);

      const leaf = leafFlags.find(f => f.name === 'leaf')!;
      expect(leaf).toBeDefined();
      expect(leaf.isLeaf).toBe(true);
    })
  );

  it.effect('should set isLeafNode:false for tags that contain child elements alongside text', () =>
    Effect.gen(function* () {
      const leafFlags: Array<{ name: string; isLeaf: boolean | null }> = [];

      class LeafCapture implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context && !context.isAttribute) {
            leafFlags.push({ name: context.elementName, isLeaf: context.isLeafNode });
          }
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new LeafCapture()] } }) });
      // "parent" has mixed content: text + child element — parseValue runs on the text portion
      yield* parser.parse(`<root><parent>intro <child>text</child></parent></root>`);

      const parent = leafFlags.find(f => f.name === 'parent')!;
      expect(parent).toBeDefined();
      expect(parent.isLeaf).toBe(false);
    })
  );

  it.effect('should always set isLeafNode:true for attribute values', () =>
    Effect.gen(function* () {
      const attrLeafFlags: Array<boolean | null> = [];

      class AttrLeafCapture implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context?.isAttribute) {
            attrLeafFlags.push(context.isLeafNode);
          }
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({
        skip: { attributes: false },
        OutputBuilder: CompactBuilderFactory.make({ attributes: { valueParsers: [new AttrLeafCapture()] } }),
      });
      yield* parser.parse(`<root><item id="1" class="foo">text</item></root>`);

      expect(attrLeafFlags.length).toBeGreaterThan(0);
      attrLeafFlags.forEach(flag => expect(flag).toBe(true));
    })
  );

  it.effect('should provide elementName as the tag name in TAG context', () =>
    Effect.gen(function* () {
      const names: Array<string> = [];

      class NameCapture implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context && !context.isAttribute) names.push(context.elementName);
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new NameCapture()] } }) });
      yield* parser.parse(`<catalog><title>My Catalog</title><count>5</count></catalog>`);

      expect(names).toContain('title');
      expect(names).toContain('count');
    })
  );

  it.effect('should provide elementName as the attribute name in ATTRIBUTE context', () =>
    Effect.gen(function* () {
      const attrNames: Array<string> = [];

      class AttrNameCapture implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context?.isAttribute) attrNames.push(context.elementName);
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({
        skip: { attributes: false },
        OutputBuilder: CompactBuilderFactory.make({ attributes: { valueParsers: [new AttrNameCapture()] } }),
      });
      yield* parser.parse(`<root><item id="1" type="foo"/></root>`);

      expect(attrNames).toContain('id');
      expect(attrNames).toContain('type');
    })
  );

  it.effect('should allow path-based numeric parsing only for specific elements', () =>
    Effect.gen(function* () {
      const priceExpr = yield* Expression.make('..price');
      const qtyExpr = yield* Expression.make('..qty');

      class SelectiveNumber implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (typeof val !== 'string') return Effect.succeed(val);
          const matcher = context?.matcher;
          if (matcher && (matcher.matches(priceExpr) || matcher.matches(qtyExpr))) {
            const n = parseFloat(val);
            return Effect.succeed(isNaN(n) ? val : n);
          }
          return Effect.succeed(val); // leave as string
        }
      }

      const parser = yield* XMLParser.make({
        // Override default chain — no automatic number conversion
        OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new SelectiveNumber()] } }),
      });
      const result = yield* parser.parse(
        `
      <order>
        <ref>ORD-001</ref>
        <price>19.99</price>
        <qty>3</qty>
        <note>fragile</note>
      </order>`
      );

      expect(result.order.ref).toBe('ORD-001'); // string — not a price/qty
      expect(result.order.price).toBe(19.99); // number
      expect(result.order.qty).toBe(3); // number
      expect(result.order.note).toBe('fragile'); // string
    })
  );

  it.effect('should allow attribute value transformation based on parent path', () =>
    Effect.gen(function* () {
      const productIdExpr = yield* Expression.make('catalog.product');

      class PrefixIdParser implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (!context?.isAttribute) return Effect.succeed(val);
          if (context.elementName === 'id' && context.matcher && context.matcher.matches(productIdExpr)) {
            return Effect.succeed('PROD-' + val);
          }
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({
        skip: { attributes: false },
        OutputBuilder: CompactBuilderFactory.make({ attributes: { valueParsers: [new PrefixIdParser()] } }),
      });
      const result = yield* parser.parse(
        `
      <catalog>
        <product id="101">Widget</product>
        <category id="5">Gadgets</category>
      </catalog>`
      );

      expect(result.catalog.product['@_id']).toBe('PROD-101');
      expect(result.catalog.category['@_id']).toBe('5'); // not transformed
    })
  );
});

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — matcher in custom OutputBuilder', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it.effect('should pass ReadOnlyMatcher to addElement() override', () =>
    Effect.gen(function* () {
      const tagPaths: Array<string> = [];

      const parser = yield* XMLParser.make({
        OutputBuilder: makeFactory(base => {
          const addElement = base.addElement.bind(base);
          return {
            addElement(tag, matcher) {
              tagPaths.push(matcher.toString());
              addElement(tag, matcher);
            },
          };
        }),
      });
      yield* parser.parse(`<root><child>text</child></root>`);

      expect(tagPaths).toContain('root');
      expect(tagPaths).toContain('root.child');
    })
  );

  it.effect('should pass ReadOnlyMatcher to closeElement() override', () =>
    Effect.gen(function* () {
      const closedPaths: Array<string> = [];

      const parser = yield* XMLParser.make({
        OutputBuilder: makeFactory(base => {
          const closeElement = base.closeElement.bind(base);
          return {
            closeElement(matcher, closeMeta) {
              closedPaths.push(matcher.toString());
              return closeElement(matcher, closeMeta);
            },
          };
        }),
      });
      yield* parser.parse(`<root><a>1</a><b>2</b></root>`);

      expect(closedPaths).toContain('root.a');
      expect(closedPaths).toContain('root.b');
      expect(closedPaths).toContain('root');
    })
  );

  it.effect('should rename a tag based on its path using Expression matching in addTag', () =>
    Effect.gen(function* () {
      const legacyExpr = yield* Expression.make('root.oldName');

      const parser = yield* XMLParser.make({
        OutputBuilder: makeFactory(base => {
          const addElement = base.addElement.bind(base);
          return {
            addElement(tag, matcher) {
              const resolved = matcher.matches(legacyExpr) ? { ...tag, name: 'newName' } : tag;
              addElement(resolved, matcher);
            },
          };
        }),
      });
      const result = yield* parser.parse(`<root><oldName>content</oldName></root>`);

      expect(result.root.newName).toBe('content');
      expect(result.root.oldName).toBeUndefined();
    })
  );

  it.effect('should allow skipping a node entirely based on path in addTag / closeTag pair', () =>
    Effect.gen(function* () {
      // Skipping a node requires both addTag AND closeTag to be suppressed together;
      // returning early from only one desynchronises the builder's internal stack.
      // The clean pattern is to set a flag in addTag and check it in closeTag.
      const skipExpr = yield* Expression.make('root.internal');

      const parser = yield* XMLParser.make({
        OutputBuilder: makeFactory(base => {
          const addElement = base.addElement.bind(base);
          const closeElement = base.closeElement.bind(base);
          let skipDepth = 0;
          return {
            addElement(tag, matcher) {
              if (matcher.matches(skipExpr)) {
                skipDepth++;
                return;
              }
              if (skipDepth > 0) {
                skipDepth++;
                return;
              }
              addElement(tag, matcher);
            },
            closeElement(matcher, closeMeta) {
              if (skipDepth > 0) {
                skipDepth--;
                return Effect.void;
              }
              return closeElement(matcher, closeMeta);
            },
          };
        }),
      });
      const result = yield* parser.parse(`<root><public>visible</public><internal>hidden</internal></root>`);

      expect(result.root.public).toBe('visible');
      expect(result.root.internal).toBeUndefined();
    })
  );
});

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — ReadOnlyMatcher guards', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it.effect('should throw error when push() is called on the read-only matcher', () =>
    Effect.gen(function* () {
      let roMatcher: MatcherView | null = null;

      class GrabMatcher implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context?.matcher) roMatcher = context.matcher;
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new GrabMatcher()] } }) });
      yield* parser.parse(`<root><tag>value</tag></root>`);

      expect(roMatcher).not.toBeNull();
      // `push` is deliberately absent from MatcherView — that absence IS what this test
      // asserts. The cast reaches the missing method so the call can be made, and stays
      // at the call site because the TypeError text embeds the identifier the assertion
      // string depends on.
      expect(() => (roMatcher as unknown as { push(name: string): void }).push('bad')).toThrowError('roMatcher.push is not a function');
    })
  );

  it.effect('should throw error when pop() is called on the read-only matcher', () =>
    Effect.gen(function* () {
      let roMatcher: MatcherView | null = null;

      class GrabMatcher implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context?.matcher) roMatcher = context.matcher;
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new GrabMatcher()] } }) });
      yield* parser.parse(`<root><tag>value</tag></root>`);

      expect(() => (roMatcher as unknown as { pop(): void }).pop()).toThrowError('roMatcher.pop is not a function');
    })
  );

  it.effect('should throw error when reset() is called on the read-only matcher', () =>
    Effect.gen(function* () {
      let roMatcher: MatcherView | null = null;

      class GrabMatcher implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context?.matcher) roMatcher = context.matcher;
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new GrabMatcher()] } }) });
      yield* parser.parse(`<root><tag>value</tag></root>`);

      expect(() => (roMatcher as unknown as { reset(): void }).reset()).toThrowError('roMatcher.reset is not a function');
    })
  );

  it.effect('should throw error when updateCurrent() is called on the read-only matcher', () =>
    Effect.gen(function* () {
      let roMatcher: MatcherView | null = null;

      class GrabMatcher implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context?.matcher) roMatcher = context.matcher;
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new GrabMatcher()] } }) });
      yield* parser.parse(`<root><tag>value</tag></root>`);

      expect(() => (roMatcher as unknown as { updateCurrent(v: unknown): void }).updateCurrent({ x: '1' })).toThrowError(
        'roMatcher.updateCurrent is not a function'
      );
    })
  );

  it.effect('should reflect the correct path at the time the value parser runs', () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];

      class PathCapture implements ValueParser {
        parse(val: unknown, context?: Context): Effect.Effect<unknown, BuilderError> {
          if (context && !context.isAttribute) {
            capturedPaths.push(context.matcher!.toString());
          }
          return Effect.succeed(val);
        }
      }

      const parser = yield* XMLParser.make({ OutputBuilder: CompactBuilderFactory.make({ tags: { valueParsers: [new PathCapture()] } }) });
      yield* parser.parse(`<a><b><c>deep</c></b></a>`);

      expect(capturedPaths).toContain('a.b.c');
    })
  );
});
