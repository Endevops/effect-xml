/**
 * @description Specs for the renderer: how a value becomes XML text. Everything here is about output, and the round-trip specs in `round-trip.spec.ts` are about
 * output that can be read back.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { XmlRenderOptions } from '#/render.ts';
import type { XmlValue } from '#/xml-value.ts';

import { escapeAttribute, escapeText, renderXml } from '#/render.ts';

/**
 * @description Renders a value the way a caller not already in an `Effect` would: `renderXml` answers with an `Effect` whose failure is an `XmlRenderError`, and
 * `Effect.runSync` throws it. The specs assert on the string and on the thrown failure, so this keeps each case a one-liner.
 */
const render = (value: XmlValue, options?: XmlRenderOptions): string => Effect.runSync(renderXml(value, options));

describe('renderXml() — elements', () => {
  it('writes a record as an element named by its key', () => {
    expect(render({ title: 'Dune' }, { rootName: 'book' })).toBe('<book><title>Dune</title></book>');
  });

  it('nests records as child elements', () => {
    expect(render({ author: { first: 'Frank' } }, { rootName: 'book' })).toBe('<book><author><first>Frank</first></author></book>');
  });

  it('writes character data on its own', () => {
    expect(render('hello', { rootName: 'book' })).toBe('<book>hello</book>');
  });

  it('writes an element with no content as self-closing by default', () => {
    expect(render({ a: '' }, { rootName: 'r' })).toBe('<r><a/></r>');
  });

  it('writes an element with no content as a pair of tags when asked', () => {
    expect(render({ a: '' }, { rootName: 'r', suppressEmptyNode: false })).toBe('<r><a></a></r>');
  });

  it('writes an element with only attributes as self-closing', () => {
    expect(render({ '@id': '1' }, { rootName: 'r' })).toBe('<r id="1"/>');
  });

  it('writes a record with nothing in it as self-closing', () => {
    expect(render({}, { rootName: 'r' })).toBe('<r/>');
  });

  it('defaults the root name to root', () => {
    expect(render({ a: '1' })).toBe('<root><a>1</a></root>');
  });

  it('repairs an illegal element name rather than emitting a broken document', () => {
    expect(render({ 'not a name': 'x' }, { rootName: 'r' })).toBe('<r><not_a_name>x</not_a_name></r>');
  });

  it('refuses an illegal element name in error mode', () => {
    expect(() => render({ 'not a name': 'x' }, { rootName: 'r', name: 'error' })).toThrow(/Invalid XML name/);
  });

  it('stops at the configured depth instead of exhausting the stack', () => {
    // Built rather than written out, because a document deep enough to matter is absurd to spell out.
    let deep: XmlValue = { end: 'x' };
    for (let i = 0; i < 50; i++) deep = { nest: deep };
    expect(() => render(deep, { rootName: 'r', maxDepth: 10 })).toThrow(/maxDepth/);
  });

  it('writes a document nested exactly to the limit', () => {
    expect(render({ a: { b: { c: 'x' } } }, { rootName: 'r', maxDepth: 3 })).toBe('<r><a><b><c>x</c></b></a></r>');
  });
});

describe('renderXml() — attributes', () => {
  it('writes an @-prefixed key as an attribute', () => {
    expect(render({ '@id': '1', title: 'Dune' }, { rootName: 'book' })).toBe('<book id="1"><title>Dune</title></book>');
  });

  it('writes a namespace declaration, which is what @xmlns is for', () => {
    expect(render({ '@xmlns': 'urn:books' }, { rootName: 'book' })).toBe('<book xmlns="urn:books"/>');
  });

  it('writes every attribute before any child', () => {
    expect(render({ title: 'Dune', '@a': '1', '@b': '2' }, { rootName: 'r' })).toBe('<r a="1" b="2"><title>Dune</title></r>');
  });

  it('omits an attribute with no value rather than writing an empty one', () => {
    expect(render({ '@a': undefined, '@b': '1' }, { rootName: 'r' })).toBe('<r b="1"/>');
  });

  it('omits a child with no value rather than writing an empty one', () => {
    expect(render({ a: undefined, b: '1' }, { rootName: 'r' })).toBe('<r><b>1</b></r>');
  });

  it('repairs an illegal attribute name', () => {
    expect(render({ '@not a name': '1' }, { rootName: 'r' })).toBe('<r not_a_name="1"/>');
  });

  it('refuses an illegal attribute name in error mode', () => {
    expect(() => render({ '@not a name': '1' }, { rootName: 'r', name: 'error' })).toThrow(/Invalid XML name/);
  });

  it('escapes a value so it cannot break out of its attribute', () => {
    expect(render({ '@a': '" onload="alert(1)' }, { rootName: 'r' })).toBe('<r a="&quot; onload=&quot;alert(1)"/>');
  });

  it('escapes the XML-unsafe characters in an attribute value', () => {
    expect(render({ '@a': `<&>"'` }, { rootName: 'r' })).toBe('<r a="&lt;&amp;&gt;&quot;&apos;"/>');
  });

  it('writes a newline in an attribute as a character reference, so it survives a read', () => {
    // XML normalizes a literal newline in an attribute value to a space. The
    // character reference is the only spelling that comes back as a newline.
    expect(render({ '@a': 'x\ny' }, { rootName: 'r' })).toBe('<r a="x&#10;y"/>');
  });

  it('writes a tab and a carriage return in an attribute as character references', () => {
    expect(render({ '@a': 'x\ty\r' }, { rootName: 'r' })).toBe('<r a="x&#9;y&#13;"/>');
  });
});

describe('renderXml() — character data', () => {
  it('reads the reserved text key as the element content', () => {
    expect(render({ '@id': '1', '#text': 'hello' }, { rootName: 'a' })).toBe('<a id="1">hello</a>');
  });

  it('writes text before children', () => {
    expect(render({ '#text': 'hi', b: 'x' }, { rootName: 'a' })).toBe('<a>hi<b>x</b></a>');
  });

  it('escapes the XML-unsafe characters in text', () => {
    expect(render({ a: `<&>"'` }, { rootName: 'r' })).toBe('<r><a>&lt;&amp;&gt;&quot;&apos;</a></r>');
  });

  it('leaves a non-ASCII character alone, because XML carries it natively', () => {
    expect(render({ a: 'café' }, { rootName: 'r' })).toBe('<r><a>café</a></r>');
  });

  it('never writes an HTML named entity, which no XML parser would resolve', () => {
    // `&eacute;` is well-formed XML but only valid against a DTD that declares
    // it. The five predefined names are the only ones every parser knows.
    const out = render({ a: 'café' }, { rootName: 'r' });
    expect(out).not.toContain('&eacute;');
  });

  it('writes an element with an empty text run as self-closing', () => {
    expect(render({ '#text': '' }, { rootName: 'a' })).toBe('<a/>');
  });
});

describe('renderXml() — repeated elements', () => {
  it('repeats the element name once per member', () => {
    expect(render({ tag: ['a', 'b'] }, { rootName: 'r' })).toBe('<r><tag>a</tag><tag>b</tag></r>');
  });

  it('writes a single member without any array marker', () => {
    expect(render({ tag: ['a'] }, { rootName: 'r' })).toBe('<r><tag>a</tag></r>');
  });

  it('keeps an empty array visible as an empty element', () => {
    // Writing nothing would make a field that was present and empty
    // indistinguishable from one that was never there.
    expect(render({ tag: [] }, { rootName: 'r' })).toBe('<r><tag/></r>');
  });

  it('repeats records too', () => {
    expect(render({ item: [{ n: '1' }, { n: '2' }] }, { rootName: 'r' })).toBe('<r><item><n>1</n></item><item><n>2</n></item></r>');
  });

  it('wraps a root array in the root element, since a document has one root', () => {
    expect(render(['a', 'b'], { rootName: 'r' })).toBe('<r><item>a</item><item>b</item></r>');
  });

  it('names the members of a root array with itemName', () => {
    expect(render(['a'], { rootName: 'r', itemName: 'entry' })).toBe('<r><entry>a</entry></r>');
  });

  it('flattens a nested array into the same repeated element', () => {
    expect(render({ tag: [['a', 'b'], ['c']] }, { rootName: 'r' })).toBe('<r><tag>a</tag><tag>b</tag><tag>c</tag></r>');
  });
});

describe('renderXml() — pretty printing', () => {
  it('puts every child on its own line', () => {
    expect(render({ a: '1', b: '2' }, { rootName: 'r', format: true })).toBe('<r>\n  <a>1</a>\n  <b>2</b>\n</r>\n');
  });

  it('indents by depth', () => {
    expect(render({ a: { b: '1' } }, { rootName: 'r', format: true })).toBe('<r>\n  <a>\n    <b>1</b>\n  </a>\n</r>\n');
  });

  it('puts each member of a repeated element on its own line', () => {
    expect(render({ tag: ['a', 'b'] }, { rootName: 'r', format: true })).toBe('<r>\n  <tag>a</tag>\n  <tag>b</tag>\n</r>\n');
  });

  it('honours a custom indent', () => {
    expect(render({ a: '1' }, { rootName: 'r', format: true, indent: '\t' })).toBe('<r>\n\t<a>1</a>\n</r>\n');
  });

  it('gives text its own line when the element also has children', () => {
    expect(render({ '#text': 'hi', b: 'x' }, { rootName: 'a', format: true })).toBe('<a>\n  hi\n  <b>x</b>\n</a>\n');
  });

  it('leaves an element with only text on one line', () => {
    expect(render({ a: '1' }, { rootName: 'r', format: true })).toBe('<r>\n  <a>1</a>\n</r>\n');
  });
});

describe('renderXml() — key order', () => {
  it('keeps declaration order by default', () => {
    expect(render({ z: '1', a: '2' }, { rootName: 'r' })).toBe('<r><z>1</z><a>2</a></r>');
  });

  it('sorts keys when asked, which is what a snapshot test needs', () => {
    expect(render({ z: '1', a: '2' }, { rootName: 'r', sortKeys: true })).toBe('<r><a>2</a><z>1</z></r>');
  });
});

describe('the escaping helpers', () => {
  it('escape the XML-unsafe characters and nothing else', () => {
    expect(escapeText('a<b>&c"d\'e')).toBe('a&lt;b&gt;&amp;c&quot;d&apos;e');
    expect(escapeAttribute('a<b>&c"d\'e')).toBe('a&lt;b&gt;&amp;c&quot;d&apos;e');
  });

  it('leave a string with nothing to escape untouched', () => {
    expect(escapeText('plain text')).toBe('plain text');
  });

  it('escape an ampersand once, never twice', () => {
    expect(escapeText('&amp;')).toBe('&amp;amp;');
    expect(escapeText('&')).toBe('&amp;');
  });

  it('return the very same string when there is nothing to escape, so a caller can skip a copy', () => {
    const clean = 'nothing here needs escaping';
    expect(escapeText(clean)).toBe(clean);
    expect(escapeAttribute(clean)).toBe(clean);
    expect(escapeText('')).toBe('');
  });
});
