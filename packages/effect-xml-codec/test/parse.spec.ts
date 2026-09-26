/**
 * @description Specs for the parser: what it reads out of a document, and what it refuses.
 */

import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { XmlParseOptions } from '#/index.ts';

import { parseXml, parseXmlDocument, parseXmlSync, XmlParseError } from '#/index.ts';

/**
 * @description Narrows a failure to a parse error so a spec can assert on its message, and throws if the call succeeded — a spec that expected a rejection cannot
 * pass on a success.
 *
 * @param text - The document to parse.
 * @param options - Parse options for this call.
 *
 * @returns The error the parser reported.
 */
const parseError = (text: string, options: XmlParseOptions = {}): XmlParseError => {
  const exit = Effect.runSyncExit(parseXml(text, options));
  if (Exit.isSuccess(exit)) throw new Error(`expected ${JSON.stringify(text)} to fail to parse`);
  const error = Cause.squash(exit.cause);
  if (!(error instanceof XmlParseError)) throw new Error(`expected an XmlParseError, got ${String(error)}`);
  return error;
};

describe('parseXml() — elements', () => {
  it('reads a child element as a bare string', () => {
    expect(parseXmlSync('<r><title>Dune</title></r>')).toEqual({ title: 'Dune' });
  });

  it('reads nested elements as records', () => {
    expect(parseXmlSync('<r><author><first>Frank</first></author></r>')).toEqual({ author: { first: 'Frank' } });
  });

  it('reads a text-only root as a bare string', () => {
    expect(parseXmlSync('<r>hello</r>')).toBe('hello');
  });

  it('reads a self-closing element as an empty string', () => {
    expect(parseXmlSync('<r><a/></r>')).toEqual({ a: '' });
  });

  it('reads an element with a space before its close as an empty string', () => {
    expect(parseXmlSync('<r><a></a></r>')).toEqual({ a: '' });
  });

  it('reads an element with no children as an empty record', () => {
    expect(parseXmlSync('<r/>')).toBe('');
    expect(parseXmlSync('<r></r>')).toBe('');
  });

  it('keeps the root name out of the value', () => {
    expect(parseXmlSync('<person><name>Al</name></person>')).toEqual({ name: 'Al' });
  });

  it('reports the root name separately when asked', () => {
    expect(parseXmlDocument('<person><name>Al</name></person>')).toEqual({ name: 'person', value: { name: 'Al' } });
  });
});

describe('parseXml() — attributes', () => {
  it('reads an attribute into an @-prefixed key', () => {
    expect(parseXmlSync('<r><a id="1"/></r>')).toEqual({ a: { '@id': '1' } });
  });

  it('reads a namespace declaration like any other attribute', () => {
    expect(parseXmlSync('<r xmlns="urn:books"/>')).toEqual({ '@xmlns': 'urn:books' });
  });

  it('reads several attributes', () => {
    expect(parseXmlSync('<r a="1" b="2"/>')).toEqual({ '@a': '1', '@b': '2' });
  });

  it('accepts a single-quoted value', () => {
    expect(parseXmlSync("<r a='1'/>")).toEqual({ '@a': '1' });
  });

  it('accepts a value with spaces and no quotes of its own', () => {
    expect(parseXmlSync('<r a="one two"/>')).toEqual({ '@a': 'one two' });
  });

  it('reads an empty attribute value as an empty string', () => {
    expect(parseXmlSync('<r a=""/>')).toEqual({ '@a': '' });
  });

  it('puts an element with attributes and text into one record', () => {
    expect(parseXmlSync('<r a="1">hello</r>')).toEqual({ '@a': '1', '#text': 'hello' });
  });

  it('decodes a character reference in an attribute value', () => {
    expect(parseXmlSync('<r a="&lt;&amp;&quot;"/>')).toEqual({ '@a': '<&"' });
  });

  it('reads a newline written as a character reference back as a newline', () => {
    // A literal newline in an attribute is normalized to a space by every XML
    // parser, so this is the only spelling that survives.
    expect(parseXmlSync('<r a="x&#10;y"/>')).toEqual({ '@a': 'x\ny' });
  });

  it('repairs an illegal attribute name, the same way the renderer does', () => {
    // A name that starts with a digit is syntactically a name to the scanner —
    // no whitespace, no `=` — so it reaches the resolver, which rewrites it.
    expect(parseXmlSync('<r 1a="x"/>')).toEqual({ '@_1a': 'x' });
  });

  it('refuses an illegal attribute name in error mode', () => {
    expect(() => parseXmlSync('<r 1a="x"/>', { name: 'error' })).toThrow(/is not a legal XML name/);
  });
});

describe('parseXml() — character data', () => {
  it('decodes each of the five predefined entities', () => {
    // One assertion per entity rather than one for the whole sequence: a single
    // literal holding all five needs both quote characters, and a string that
    // has to be escaped on both sides is a string that gets rewritten by the
    // formatter and then asserts the wrong thing.
    expect(parseXmlSync('<r>&lt;</r>')).toBe('<');
    expect(parseXmlSync('<r>&gt;</r>')).toBe('>');
    expect(parseXmlSync('<r>&amp;</r>')).toBe('&');
    expect(parseXmlSync('<r>&quot;</r>')).toBe('"');
    expect(parseXmlSync('<r>&apos;</r>')).toBe("'");
  });

  it('decodes a numeric character reference', () => {
    expect(parseXmlSync('<r>&#65;&#x42;</r>')).toBe('AB');
  });

  it('keeps a bare ampersand rather than refusing the document', () => {
    expect(parseXmlSync('<r>Smith & Jones</r>')).toBe('Smith & Jones');
  });

  it('joins text that a comment interrupts', () => {
    expect(parseXmlSync('<r>a<!-- note -->b</r>')).toBe('ab');
  });

  it('reads CDATA as the character data it is', () => {
    expect(parseXmlSync('<r><![CDATA[x&y]]></r>')).toBe('x&y');
  });

  it('joins text and CDATA into one run', () => {
    expect(parseXmlSync('<r>a<![CDATA[&b]]>c</r>')).toBe('a&bc');
  });

  it('joins character data that a processing instruction interrupts', () => {
    expect(parseXmlSync('<r>a<?target data?>b</r>')).toBe('ab');
  });

  it('drops the whitespace an indented document is full of', () => {
    expect(parseXmlSync('<r>\n  <a>1</a>\n  <b>2</b>\n</r>')).toEqual({ a: '1', b: '2' });
  });

  it('drops an element whose only content is whitespace', () => {
    expect(parseXmlSync('<r>\n  <a>   </a>\n</r>')).toEqual({ a: '' });
  });

  it('keeps whitespace when asked to', () => {
    // The document has no whitespace around the root, so the only run in it is
    // the leaf's own. With whitespace preserved it survives as the leaf's text.
    expect(parseXmlSync('<r><a>   </a></r>', { preserveWhitespace: true })).toEqual({ a: '   ' });
  });

  it('keeps the whitespace around a document as the element own text when asked to', () => {
    // A consequence of the model rather than a choice: an element's indentation
    // is character data like any other, and with whitespace preserved it is
    // character data that stays.
    expect(parseXmlSync('<r>\n  <a>1</a>\n</r>', { preserveWhitespace: true })).toEqual({ a: '1', '#text': '\n  \n' });
  });

  it('keeps a space that sits between two words', () => {
    expect(parseXmlSync('<r>one two</r>')).toBe('one two');
  });

  it('keeps a newline that sits between two words, because it is not only whitespace', () => {
    expect(parseXmlSync('<r>one\ntwo</r>')).toBe('one\ntwo');
  });
});

describe('parseXml() — prolog and epilog', () => {
  it('skips an XML declaration', () => {
    expect(parseXmlSync('<?xml version="1.0" encoding="UTF-8"?><r><a>1</a></r>')).toEqual({ a: '1' });
  });

  it('skips a DOCTYPE', () => {
    expect(parseXmlSync('<!DOCTYPE r SYSTEM "r.dtd"><r><a>1</a></r>')).toEqual({ a: '1' });
  });

  it('skips a DOCTYPE with an internal subset', () => {
    expect(parseXmlSync('<!DOCTYPE r [<!ELEMENT r (a)>]><r><a>1</a></r>')).toEqual({ a: '1' });
  });

  it('skips comments before and after the root', () => {
    expect(parseXmlSync('<!-- before --><r><a>1</a></r><!-- after -->')).toEqual({ a: '1' });
  });

  it('tolerates whitespace around the document', () => {
    expect(parseXmlSync('\n\t <r><a>1</a></r> \n ')).toEqual({ a: '1' });
  });

  it('keeps a trailing newline, which is what a pretty-printed document ends with', () => {
    expect(parseXmlSync('<r>\n  <a>1</a>\n</r>\n')).toEqual({ a: '1' });
  });
});

describe('parseXml() — repeated elements', () => {
  it('reads one element as a bare value', () => {
    expect(parseXmlSync('<r><tag>a</tag></r>')).toEqual({ tag: 'a' });
  });

  it('reads two elements as an array', () => {
    expect(parseXmlSync('<r><tag>a</tag><tag>b</tag></r>')).toEqual({ tag: ['a', 'b'] });
  });

  it('reads three elements as an array', () => {
    expect(parseXmlSync('<r><tag>a</tag><tag>b</tag><tag>c</tag></r>')).toEqual({ tag: ['a', 'b', 'c'] });
  });

  it('reads repeated elements with attributes', () => {
    expect(parseXmlSync('<r><i n="1"/><i n="2"/></r>')).toEqual({ i: [{ '@n': '1' }, { '@n': '2' }] });
  });

  it('keeps elements of different names apart', () => {
    expect(parseXmlSync('<r><a>1</a><b>2</b><a>3</a></r>')).toEqual({ a: ['1', '3'], b: '2' });
  });
});

describe('parseXml() — documents it refuses', () => {
  it('refuses an empty document', () => {
    expect(parseError('').message).toBe('Document has no root element');
  });

  it('refuses a document that is only whitespace', () => {
    expect(parseError('   \n ').message).toBe('Document has no root element');
  });

  it('refuses a document that is only a prolog', () => {
    expect(parseError('<?xml version="1.0"?>').message).toBe('Document has no root element');
  });

  it('refuses an unclosed element', () => {
    expect(parseError('<r><a>1</a>').message).toBe('Unclosed element <r>');
  });

  it('refuses a closing tag that does not match', () => {
    expect(parseError('<r><a>1</b></r>').message).toBe('Closing tag </b> does not match <a>');
  });

  it('refuses content after the root element', () => {
    expect(parseError('<r/><s/>').message).toBe('Unexpected content after the root element');
  });

  it('refuses a second root element', () => {
    expect(parseError('<r/><r/>').message).toBe('Unexpected content after the root element');
  });

  it('refuses an unterminated comment', () => {
    expect(parseError('<r><!-- oops</r>').message).toBe('Unterminated comment');
  });

  it('refuses an unterminated CDATA section', () => {
    expect(parseError('<r><![CDATA[oops</r>').message).toBe('Unterminated CDATA section');
  });

  it('refuses an attribute with no equals sign', () => {
    expect(parseError('<r a b="1"/>').message).toMatch(/has no "="/);
    expect(parseError('<r a/>').message).toMatch(/has no "="/);
  });

  it('refuses an attribute whose value is not quoted', () => {
    expect(parseError('<r a=1/>').message).toMatch(/has no quoted value/);
  });

  it('refuses an unterminated attribute value', () => {
    expect(parseError('<r a="1/>').message).toMatch(/Unterminated value for attribute/);
  });

  it('refuses an unterminated start tag', () => {
    expect(parseError('<r a="1"').message).toBe('Unterminated start tag');
  });

  it('refuses a declaration inside an element', () => {
    expect(parseError('<r><!ENTITY x "y"></r>').message).toMatch(/not allowed inside an element/);
  });

  it('refuses an unterminated DOCTYPE', () => {
    expect(parseError('<!DOCTYPE r [<!ENTITY x "y">]').message).toBe('Unterminated DOCTYPE declaration');
  });

  it('refuses a document nested past the depth limit', () => {
    // Built rather than written out: a document deep enough to matter is absurd
    // to spell out, and the point is the limit rather than the contents.
    const deep = `${'<a>'.repeat(40)}x${'</a>'.repeat(40)}`;
    expect(parseError(deep, { maxDepth: 10 }).message).toMatch(/maxDepth/);
  });

  it('reads a document nested exactly to the limit', () => {
    const deep = `${'<a>'.repeat(10)}x${'</a>'.repeat(10)}`;
    expect(() => parseXmlSync(deep, { maxDepth: 10 })).not.toThrow();
  });

  it('carries the position and the source, so a caller can point at the problem', () => {
    const error = parseError('<r><a>1</b></r>');
    expect(error.position).toBe(7);
    expect(error.input).toBe('<r><a>1</b></r>');
    expect(error._tag).toBe('XmlParseError');
  });

  it('reports the failure through the Effect, not by throwing', () => {
    expect(Exit.isSuccess(Effect.runSyncExit(parseXml('<r><a>1</b></r>')))).toBe(false);
    expect(Exit.isSuccess(Effect.runSyncExit(parseXml('<r><a>1</a></r>')))).toBe(true);
  });
});

describe('parseXml() — a document that cannot be read as XML but should be', () => {
  it('reads a document whose only fault is an unescaped ampersand', () => {
    expect(parseXmlSync('<r><a>Smith & Jones</a></r>')).toEqual({ a: 'Smith & Jones' });
  });

  it('reads a value that is only spaces, as an empty string', () => {
    expect(parseXmlSync('<r><a>   </a></r>')).toEqual({ a: '' });
  });

  it('reads a document with no space before a closing tag', () => {
    expect(parseXmlSync('<r><a>1</a ></r>')).toEqual({ a: '1' });
  });

  it('reads a self-closing tag with a space before the slash', () => {
    expect(parseXmlSync('<r><a /></r>')).toEqual({ a: '' });
  });
});
