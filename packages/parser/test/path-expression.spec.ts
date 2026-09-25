/**
 * @description PathExpression_spec.js. Integration tests for path-expression-matcher (PEM) in flexible-xml-parser. Covers:
 *
 * 1. StopNodes — string, Expression, wildcard, deep-wildcard, attribute condition, position selector, nested same-name tag, attribute-based stop
 * 2. Value parser context — matcher in context, Expression matching, read-only enforcement, isLeafNode, elementType, attribute context
 * 3. Custom OutputBuilder — matcher in addTag / closeTag callbacks
 * 4. ReadOnlyMatcher — guards against mutation
 */

import type { Context, ValueParser } from '@endevops/base-output-builder';
import type { MatcherView } from '@endevops/path-expression-matcher';

import { CompactBuilderFactory, CompactBuilder } from '@endevops/compact-builder';
import { Expression } from '@endevops/path-expression-matcher';
import { describe, it, expect } from 'vite-plus/test';

import type { OutputBuilderFactoryLike, TagDetailLike } from '#/internal/parser-types.ts';

import { asOutputBuilder } from '#/test/helpers/recording-builder.ts';
import { parseDoc } from '#/test/helpers/test-runner.ts';
import XMLParser from '#/xml-parser.ts';

// ─── Helper ──────────────────────────────────────────────────────────────────
type AnyCompactBuilderCtor = new (
  parserOptions: object,
  builderOptions: ConstructorParameters<typeof CompactBuilder>[1],
  readonlyMatcher: MatcherView | null,
  registry: ConstructorParameters<typeof CompactBuilder>[3]
) => CompactBuilder;

function makeFactory(BuilderSubclass: AnyCompactBuilderCtor): OutputBuilderFactoryLike {
  return {
    getInstance(parserOptions, readonlyMatcher) {
      const base = new CompactBuilderFactory();
      return asOutputBuilder(new BuilderSubclass(parserOptions, base.builderOptions, readonlyMatcher, base.registry));
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — stopNodes', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it('should accept plain strings as stopNodes (existing behaviour preserved)', function () {
    const xml = `<root><raw><b>bold</b></raw><parsed>text</parsed></root>`;
    const parser = new XMLParser({ tags: { stopNodes: ['root.raw'] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.raw).toBe('string');
    expect(result.root.raw).toContain('<b>bold</b>');
    expect(result.root.parsed).toBe('text');
  });

  it('should accept pre-compiled Expression objects in stopNodes', function () {
    const xml = `<root><raw><b>bold</b></raw><parsed>text</parsed></root>`;
    const parser = new XMLParser({ tags: { stopNodes: [new Expression('root.raw')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.raw).toBe('string');
    expect(result.root.raw).toContain('<b>bold</b>');
  });

  it('should accept mixed strings and Expression objects in the same array', function () {
    const xml = `<root><a><x/></a><b><x/></b></root>`;
    const parser = new XMLParser({ tags: { stopNodes: ['root.a', new Expression('root.b')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.a).toBe('string');
    expect(typeof result.root.b).toBe('string');
  });

  it('should support deep-wildcard expression (..tag) matching at any depth', function () {
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
    const parser = new XMLParser({ tags: { stopNodes: [new Expression('..script')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.html.body.div.section.script).toBe('string');
    expect(result.html.body.div.section.script).toContain('nested()');
  });

  it('should support single-level wildcard (*.tag) matching exactly one parent', function () {
    const xml = `<root><script>alert(1)</script></root>`;
    // *.script means exactly: [any single parent].script — matches root.script
    const parser = new XMLParser({ tags: { stopNodes: [new Expression('*.script')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.script).toBe('string');
    expect(result.root.script).toContain('alert(1)');
  });

  it('should stop at root-level tag when stopNode has no parent segment', function () {
    const xml = `<script>window.x = 1;</script>`;
    const parser = new XMLParser({ tags: { stopNodes: [new Expression('..script')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.script).toBe('string');
    expect(result.script).toContain('window.x');
  });

  it('should match stop node with attribute condition — only stops when attr matches', function () {
    const xml = `
      <root>
        <div class="raw"><inner>should be raw</inner></div>
        <div class="normal"><inner>should be parsed</inner></div>
      </root>`;
    const parser = new XMLParser({ skip: { attributes: false }, tags: { stopNodes: [new Expression('..div[class=raw]')] } });
    const result = parseDoc(parser, xml);

    // First div: stop node — content is raw string
    expect(typeof result.root.div[0]).toBe('object');
    expect(typeof result.root.div[0]['#text']).toBe('string');
    expect(result.root.div[0]['#text']).toContain('<inner>');

    // Second div: parsed normally
    expect(typeof result.root.div[1].inner).toBe('string');
    expect(result.root.div[1].inner).toBe('should be parsed');
  });

  it('should support position selector — only first occurrence is a stop node', function () {
    const xml = `
      <root>
        <item>raw content</item>
        <item>parsed content</item>
        <item>also parsed</item>
      </root>`;
    const parser = new XMLParser({ tags: { stopNodes: [new Expression('root.item:first')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.item[0]).toBe('string');
    expect(result.root.item[0]).toBe('raw content');
    // Items 1 and 2 are parsed normally (strings from text content, not stop nodes)
    expect(result.root.item[1]).toBe('parsed content');
    expect(result.root.item[2]).toBe('also parsed');
  });

  it('should capture content including nested tags of different names inside a stop node', function () {
    const xml = `<root><stop><a>one</a><b><c>two</c></b></stop><after>ok</after></root>`;
    const parser = new XMLParser({ tags: { stopNodes: [new Expression('root.stop')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.stop).toBe('string');
    expect(result.root.stop).toContain('<a>one</a>');
    expect(result.root.stop).toContain('<b><c>two</c></b>');
    expect(result.root.after).toBe('ok');
  });

  it('should produce empty string for an empty stop node', function () {
    const xml = `<root><stop></stop></root>`;
    const parser = new XMLParser({ tags: { stopNodes: ['root.stop'] } });
    const result = parseDoc(parser, xml);

    expect(result.root.stop).toBe('');
  });

  it('should produce empty string for a self-closing stop node', function () {
    const xml = `<root><stop/></root>`;
    const parser = new XMLParser({ tags: { stopNodes: ['root.stop'] } });
    const result = parseDoc(parser, xml);

    expect(result.root.stop).toBe('');
  });

  it('should preserve attributes on a stop node that has them', function () {
    const xml = `<root><stop lang="en"><b>raw</b></stop></root>`;
    const parser = new XMLParser({ skip: { attributes: false }, tags: { stopNodes: ['root.stop'] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.stop).toBe('object');
    expect(result.root.stop['@_lang']).toBe('en');
    expect(result.root.stop['#text']).toContain('<b>raw</b>');
  });

  it('should match stop nodes at all levels when using ..tag expression', function () {
    const xml = `
      <root>
        <pre>first pre</pre>
        <section>
          <pre>second pre</pre>
        </section>
      </root>`;
    const parser = new XMLParser({ tags: { stopNodes: [new Expression('..pre')] } });
    const result = parseDoc(parser, xml);

    expect(typeof result.root.pre).toBe('string');
    expect(result.root.pre).toBe('first pre');
    expect(typeof result.root.section.pre).toBe('string');
    expect(result.root.section.pre).toBe('second pre');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — matcher in value parser context', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it('should pass a ReadOnlyMatcher in context.matcher for tag values', function () {
    let capturedMatcher: MatcherView | null = null;

    class CaptureMatcher implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context && !context.isAttribute) capturedMatcher = context.matcher;
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new CaptureMatcher()] } }) });
    parser.parse(`<root><item>hello</item></root>`);

    expect(capturedMatcher).not.toBeNull();
    const m = capturedMatcher!;
    expect(typeof m.matches).toBe('function');
    expect(typeof m.getCurrentTag).toBe('function');
    expect(typeof m.getPosition).toBe('function');
  });

  it('should pass a ReadOnlyMatcher in context.matcher for attribute values', function () {
    let capturedMatcher: MatcherView | null = null;

    class CaptureMatcher implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.isAttribute) capturedMatcher = context.matcher;
        return val;
      }
    }

    const parser = new XMLParser({
      skip: { attributes: false },
      OutputBuilder: new CompactBuilderFactory({ attributes: { valueParsers: [new CaptureMatcher()] } }),
    });
    parser.parse(`<root><item id="1">hello</item></root>`);

    expect(capturedMatcher).not.toBeNull();
    expect(typeof capturedMatcher!.matches).toBe('function');
  });

  it('should allow Expression matching in a value parser to transform selectively', function () {
    const adminExpr = new Expression('..user[role=admin]');

    class AdminUpperParser implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.matcher?.matches(adminExpr)) {
          return typeof val === 'string' ? val.toUpperCase() : val;
        }
        return val;
      }
    }

    const parser = new XMLParser({
      skip: { attributes: false },
      OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new AdminUpperParser()] } }),
    });
    const result = parseDoc(
      parser,
      `
      <users>
        <user role="admin">alice</user>
        <user role="viewer">bob</user>
      </users>`
    );

    expect(result.users.user[0]['#text']).toBe('ALICE');
    expect(result.users.user[1]['#text']).toBe('bob');
  });

  it('should provide correct elementType for tags vs attributes', function () {
    const types: string[] = [];

    class TypeCapture implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        types.push(context?.isAttribute ? 'A' : 'E');
        return val;
      }
    }

    const typeCapture = new TypeCapture();
    const parser = new XMLParser({
      skip: { attributes: false },
      OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [typeCapture] }, attributes: { valueParsers: [typeCapture] } }),
    });
    parser.parse(`<root><item id="1">text</item></root>`);

    expect(types).toContain('E');
    expect(types).toContain('A');
  });

  it('should set isLeafNode:true for simple text-only tags', function () {
    const leafFlags: { name: string; isLeaf: boolean | null }[] = [];

    class LeafCapture implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context && !context.isAttribute) {
          leafFlags.push({ name: context.elementName, isLeaf: context.isLeafNode });
        }
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new LeafCapture()] } }) });
    parser.parse(`<root><leaf>text</leaf></root>`);

    const leaf = leafFlags.find(f => f.name === 'leaf')!;
    expect(leaf).toBeDefined();
    expect(leaf.isLeaf).toBe(true);
  });

  it('should set isLeafNode:false for tags that contain child elements alongside text', function () {
    const leafFlags: { name: string; isLeaf: boolean | null }[] = [];

    class LeafCapture implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context && !context.isAttribute) {
          leafFlags.push({ name: context.elementName, isLeaf: context.isLeafNode });
        }
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new LeafCapture()] } }) });
    // "parent" has mixed content: text + child element — parseValue runs on the text portion
    parser.parse(`<root><parent>intro <child>text</child></parent></root>`);

    const parent = leafFlags.find(f => f.name === 'parent')!;
    expect(parent).toBeDefined();
    expect(parent.isLeaf).toBe(false);
  });

  it('should always set isLeafNode:true for attribute values', function () {
    const attrLeafFlags: (boolean | null)[] = [];

    class AttrLeafCapture implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.isAttribute) {
          attrLeafFlags.push(context.isLeafNode);
        }
        return val;
      }
    }

    const parser = new XMLParser({
      skip: { attributes: false },
      OutputBuilder: new CompactBuilderFactory({ attributes: { valueParsers: [new AttrLeafCapture()] } }),
    });
    parser.parse(`<root><item id="1" class="foo">text</item></root>`);

    expect(attrLeafFlags.length).toBeGreaterThan(0);
    attrLeafFlags.forEach(flag => expect(flag).toBe(true));
  });

  it('should provide elementName as the tag name in TAG context', function () {
    const names: string[] = [];

    class NameCapture implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context && !context.isAttribute) names.push(context.elementName);
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new NameCapture()] } }) });
    parser.parse(`<catalog><title>My Catalog</title><count>5</count></catalog>`);

    expect(names).toContain('title');
    expect(names).toContain('count');
  });

  it('should provide elementName as the attribute name in ATTRIBUTE context', function () {
    const attrNames: string[] = [];

    class AttrNameCapture implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.isAttribute) attrNames.push(context.elementName);
        return val;
      }
    }

    const parser = new XMLParser({
      skip: { attributes: false },
      OutputBuilder: new CompactBuilderFactory({ attributes: { valueParsers: [new AttrNameCapture()] } }),
    });
    parser.parse(`<root><item id="1" type="foo"/></root>`);

    expect(attrNames).toContain('id');
    expect(attrNames).toContain('type');
  });

  it('should allow path-based numeric parsing only for specific elements', function () {
    const priceExpr = new Expression('..price');
    const qtyExpr = new Expression('..qty');

    class SelectiveNumber implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (typeof val !== 'string') return val;
        if (context?.matcher?.matches(priceExpr) || context?.matcher?.matches(qtyExpr)) {
          const n = parseFloat(val);
          return isNaN(n) ? val : n;
        }
        return val; // leave as string
      }
    }

    const parser = new XMLParser({
      // Override default chain — no automatic number conversion
      OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new SelectiveNumber()] } }),
    });
    const result = parseDoc(
      parser,
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
  });

  it('should allow attribute value transformation based on parent path', function () {
    const productIdExpr = new Expression('catalog.product');

    class PrefixIdParser implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (!context?.isAttribute) return val;
        if (context?.elementName === 'id' && context?.matcher?.matches(productIdExpr)) {
          return 'PROD-' + val;
        }
        return val;
      }
    }

    const parser = new XMLParser({
      skip: { attributes: false },
      OutputBuilder: new CompactBuilderFactory({ attributes: { valueParsers: [new PrefixIdParser()] } }),
    });
    const result = parseDoc(
      parser,
      `
      <catalog>
        <product id="101">Widget</product>
        <category id="5">Gadgets</category>
      </catalog>`
    );

    expect(result.catalog.product['@_id']).toBe('PROD-101');
    expect(result.catalog.category['@_id']).toBe('5'); // not transformed
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — matcher in custom OutputBuilder', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it('should pass ReadOnlyMatcher to addElement() override', function () {
    const tagPaths: string[] = [];

    class CapturingBuilder extends CompactBuilder {
      override addElement(tag: TagDetailLike, matcher: MatcherView): void {
        tagPaths.push(matcher.toString());
        super.addElement(tag, matcher);
      }
    }

    const parser = new XMLParser({ OutputBuilder: makeFactory(CapturingBuilder) });
    parser.parse(`<root><child>text</child></root>`);

    expect(tagPaths).toContain('root');
    expect(tagPaths).toContain('root.child');
  });

  it('should pass ReadOnlyMatcher to closeElement() override', function () {
    const closedPaths: string[] = [];

    class CapturingBuilder extends CompactBuilder {
      override closeElement(matcher: MatcherView): void {
        closedPaths.push(matcher.toString());
        super.closeElement(matcher);
      }
    }

    const parser = new XMLParser({ OutputBuilder: makeFactory(CapturingBuilder) });
    parser.parse(`<root><a>1</a><b>2</b></root>`);

    expect(closedPaths).toContain('root.a');
    expect(closedPaths).toContain('root.b');
    expect(closedPaths).toContain('root');
  });

  it('should rename a tag based on its path using Expression matching in addTag', function () {
    const legacyExpr = new Expression('root.oldName');

    class RenameBuilder extends CompactBuilder {
      override addElement(tag: TagDetailLike, matcher: MatcherView): void {
        if (matcher.matches(legacyExpr)) {
          tag = { ...tag, name: 'newName' };
        }
        super.addElement(tag, matcher);
      }
    }

    const parser = new XMLParser({ OutputBuilder: makeFactory(RenameBuilder) });
    const result = parseDoc(parser, `<root><oldName>content</oldName></root>`);

    expect(result.root.newName).toBe('content');
    expect(result.root.oldName).toBeUndefined();
  });

  it('should allow skipping a node entirely based on path in addTag / closeTag pair', function () {
    // Skipping a node requires both addTag AND closeTag to be suppressed together;
    // returning early from only one desynchronises the builder's internal stack.
    // The clean pattern is to set a flag in addTag and check it in closeTag.
    const skipExpr = new Expression('root.internal');

    class SkipBuilder extends CompactBuilder {
      private _skipDepth: number;
      constructor(...args: ConstructorParameters<typeof CompactBuilder>) {
        super(...args);
        this._skipDepth = 0;
      }
      override addElement(tag: TagDetailLike, matcher: MatcherView): void {
        if (matcher.matches(skipExpr)) {
          this._skipDepth++;
          return;
        }
        if (this._skipDepth > 0) {
          this._skipDepth++;
          return;
        }
        super.addElement(tag, matcher);
      }
      override closeElement(matcher: MatcherView): void {
        if (this._skipDepth > 0) {
          this._skipDepth--;
          return;
        }
        super.closeElement(matcher);
      }
    }

    const parser = new XMLParser({ OutputBuilder: makeFactory(SkipBuilder) });
    const result = parseDoc(parser, `<root><public>visible</public><internal>hidden</internal></root>`);

    expect(result.root.public).toBe('visible');
    expect(result.root.internal).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('PEM integration — ReadOnlyMatcher guards', function () {
  // ══════════════════════════════════════════════════════════════════════════════

  it('should throw error when push() is called on the read-only matcher', function () {
    let roMatcher: MatcherView | null = null;

    class GrabMatcher implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.matcher) roMatcher = context.matcher;
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new GrabMatcher()] } }) });
    parser.parse(`<root><tag>value</tag></root>`);

    expect(roMatcher).not.toBeNull();
    // `push` is deliberately absent from MatcherView — that absence IS what this test
    // asserts. The cast reaches the missing method so the call can be made, and stays
    // at the call site because the TypeError text embeds the identifier the assertion
    // string depends on.
    expect(() => (roMatcher as unknown as { push(name: string): void }).push('bad')).toThrowError('roMatcher.push is not a function');
  });

  it('should throw error when pop() is called on the read-only matcher', function () {
    let roMatcher: MatcherView | null = null;

    class GrabMatcher implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.matcher) roMatcher = context.matcher;
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new GrabMatcher()] } }) });
    parser.parse(`<root><tag>value</tag></root>`);

    expect(() => (roMatcher as unknown as { pop(): void }).pop()).toThrowError('roMatcher.pop is not a function');
  });

  it('should throw error when reset() is called on the read-only matcher', function () {
    let roMatcher: MatcherView | null = null;

    class GrabMatcher implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.matcher) roMatcher = context.matcher;
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new GrabMatcher()] } }) });
    parser.parse(`<root><tag>value</tag></root>`);

    expect(() => (roMatcher as unknown as { reset(): void }).reset()).toThrowError('roMatcher.reset is not a function');
  });

  it('should throw error when updateCurrent() is called on the read-only matcher', function () {
    let roMatcher: MatcherView | null = null;

    class GrabMatcher implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context?.matcher) roMatcher = context.matcher;
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new GrabMatcher()] } }) });
    parser.parse(`<root><tag>value</tag></root>`);

    expect(() => (roMatcher as unknown as { updateCurrent(v: unknown): void }).updateCurrent({ x: '1' })).toThrowError(
      'roMatcher.updateCurrent is not a function'
    );
  });

  it('should reflect the correct path at the time the value parser runs', function () {
    const capturedPaths: string[] = [];

    class PathCapture implements ValueParser {
      parse(val: unknown, context?: Context): unknown {
        if (context && !context.isAttribute) {
          capturedPaths.push(context.matcher!.toString());
        }
        return val;
      }
    }

    const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ tags: { valueParsers: [new PathCapture()] } }) });
    parser.parse(`<a><b><c>deep</c></b></a>`);

    expect(capturedPaths).toContain('a.b.c');
  });
});
