/**
 * @description Specs for the parser: what it reads out of a document, and what it refuses.
 */

import { assert, describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Result } from 'effect';

import type { XmlParseOptions } from '#/parse.ts';

import { XmlParseError } from '#/errors.ts';
import { parseXml, parseXmlDocument } from '#/parse.ts';

/**
 * @description Parse a document expected to fail and hand back the parse error, which is the only way to reach a message this class reports. A helper rather than
 * the `Effect.result` form at each call site because these specs assert on one property of the error and nothing else. A parse that unexpectedly
 * succeeds is a test defect, so it dies rather than widening the channel every caller would then have to carry.
 *
 * @param text - The document to parse.
 * @param options - Parse options for this call.
 *
 * @returns An effect producing the error the parser reported.
 */
const parseError = (text: string, options: XmlParseOptions = {}): Effect.Effect<XmlParseError> =>
  Effect.gen(function* () {
    const result = yield* parseXml(text, options).pipe(Effect.result);
    if (Result.isSuccess(result)) return yield* Effect.die(new Error(`expected ${JSON.stringify(text)} to fail to parse`));
    return result.failure;
  });

describe('parseXml() — elements', () => {
  it('reads a child element as a bare string', () => {
    expect(parseXmlDocument('<r><title>Dune</title></r>').value).toEqual({ title: 'Dune' });
  });

  it('reads nested elements as records', () => {
    expect(parseXmlDocument('<r><author><first>Frank</first></author></r>').value).toEqual({ author: { first: 'Frank' } });
  });

  it('reads a text-only root as a bare string', () => {
    expect(parseXmlDocument('<r>hello</r>').value).toBe('hello');
  });

  it('reads a self-closing element as an empty string', () => {
    expect(parseXmlDocument('<r><a/></r>').value).toEqual({ a: '' });
  });

  it('reads an element with a space before its close as an empty string', () => {
    expect(parseXmlDocument('<r><a></a></r>').value).toEqual({ a: '' });
  });

  it('reads an element with no children as an empty record', () => {
    expect(parseXmlDocument('<r/>').value).toBe('');
    expect(parseXmlDocument('<r></r>').value).toBe('');
  });

  it('keeps the root name out of the value', () => {
    expect(parseXmlDocument('<person><name>Al</name></person>').value).toEqual({ name: 'Al' });
  });

  it('reports the root name separately when asked', () => {
    expect(parseXmlDocument('<person><name>Al</name></person>')).toEqual({ name: 'person', value: { name: 'Al' } });
  });
});

describe('parseXml() — attributes', () => {
  it('reads an attribute into an @-prefixed key', () => {
    expect(parseXmlDocument('<r><a id="1"/></r>').value).toEqual({ a: { '@id': '1' } });
  });

  it('reads a namespace declaration like any other attribute', () => {
    expect(parseXmlDocument('<r xmlns="urn:books"/>').value).toEqual({ '@xmlns': 'urn:books' });
  });

  it('reads several attributes', () => {
    expect(parseXmlDocument('<r a="1" b="2"/>').value).toEqual({ '@a': '1', '@b': '2' });
  });

  it('accepts a single-quoted value', () => {
    expect(parseXmlDocument("<r a='1'/>").value).toEqual({ '@a': '1' });
  });

  it('accepts a value with spaces and no quotes of its own', () => {
    expect(parseXmlDocument('<r a="one two"/>').value).toEqual({ '@a': 'one two' });
  });

  it('reads an empty attribute value as an empty string', () => {
    expect(parseXmlDocument('<r a=""/>').value).toEqual({ '@a': '' });
  });

  it('puts an element with attributes and text into one record', () => {
    expect(parseXmlDocument('<r a="1">hello</r>').value).toEqual({ '@a': '1', '#text': 'hello' });
  });

  it('decodes a character reference in an attribute value', () => {
    expect(parseXmlDocument('<r a="&lt;&amp;&quot;"/>').value).toEqual({ '@a': '<&"' });
  });

  it('reads a newline written as a character reference back as a newline', () => {
    // A literal newline in an attribute is normalized to a space by every XML
    // parser, so this is the only spelling that survives.
    expect(parseXmlDocument('<r a="x&#10;y"/>').value).toEqual({ '@a': 'x\ny' });
  });

  it('repairs an illegal attribute name, the same way the renderer does', () => {
    // A name that starts with a digit is syntactically a name to the scanner —
    // no whitespace, no `=` — so it reaches the resolver, which rewrites it.
    expect(parseXmlDocument('<r 1a="x"/>').value).toEqual({ '@_1a': 'x' });
  });

  it('refuses an illegal attribute name in error mode', () => {
    expect(() => parseXmlDocument('<r 1a="x"/>', { name: 'error' }).value).toThrow(/is not a legal XML name/);
  });
});

describe('parseXml() — character data', () => {
  it('decodes each of the five predefined entities', () => {
    // One assertion per entity rather than one for the whole sequence: a single
    // literal holding all five needs both quote characters, and a string that
    // has to be escaped on both sides is a string that gets rewritten by the
    // formatter and then asserts the wrong thing.
    expect(parseXmlDocument('<r>&lt;</r>').value).toBe('<');
    expect(parseXmlDocument('<r>&gt;</r>').value).toBe('>');
    expect(parseXmlDocument('<r>&amp;</r>').value).toBe('&');
    expect(parseXmlDocument('<r>&quot;</r>').value).toBe('"');
    expect(parseXmlDocument('<r>&apos;</r>').value).toBe("'");
  });

  it('decodes a numeric character reference', () => {
    expect(parseXmlDocument('<r>&#65;&#x42;</r>').value).toBe('AB');
  });

  it('keeps a bare ampersand rather than refusing the document', () => {
    expect(parseXmlDocument('<r>Smith & Jones</r>').value).toBe('Smith & Jones');
  });

  it('joins text that a comment interrupts', () => {
    expect(parseXmlDocument('<r>a<!-- note -->b</r>').value).toBe('ab');
  });

  it('reads CDATA as the character data it is', () => {
    expect(parseXmlDocument('<r><![CDATA[x&y]]></r>').value).toBe('x&y');
  });

  it('joins text and CDATA into one run', () => {
    expect(parseXmlDocument('<r>a<![CDATA[&b]]>c</r>').value).toBe('a&bc');
  });

  it('joins character data that a processing instruction interrupts', () => {
    expect(parseXmlDocument('<r>a<?target data?>b</r>').value).toBe('ab');
  });

  it('drops the whitespace an indented document is full of', () => {
    expect(parseXmlDocument('<r>\n  <a>1</a>\n  <b>2</b>\n</r>').value).toEqual({ a: '1', b: '2' });
  });

  it('drops an element whose only content is whitespace', () => {
    expect(parseXmlDocument('<r>\n  <a>   </a>\n</r>').value).toEqual({ a: '' });
  });

  it('keeps whitespace when asked to', () => {
    // The document has no whitespace around the root, so the only run in it is
    // the leaf's own. With whitespace preserved it survives as the leaf's text.
    expect(parseXmlDocument('<r><a>   </a></r>', { preserveWhitespace: true }).value).toEqual({ a: '   ' });
  });

  it('keeps the whitespace around a document as the element own text when asked to', () => {
    // A consequence of the model rather than a choice: an element's indentation
    // is character data like any other, and with whitespace preserved it is
    // character data that stays.
    expect(parseXmlDocument('<r>\n  <a>1</a>\n</r>', { preserveWhitespace: true }).value).toEqual({ a: '1', '#text': '\n  \n' });
  });

  it('keeps a space that sits between two words', () => {
    expect(parseXmlDocument('<r>one two</r>').value).toBe('one two');
  });

  it('keeps a newline that sits between two words, because it is not only whitespace', () => {
    expect(parseXmlDocument('<r>one\ntwo</r>').value).toBe('one\ntwo');
  });
});

describe('parseXml() — prolog and epilog', () => {
  it('skips an XML declaration', () => {
    expect(parseXmlDocument('<?xml version="1.0" encoding="UTF-8"?><r><a>1</a></r>').value).toEqual({ a: '1' });
  });

  it('skips a DOCTYPE', () => {
    expect(parseXmlDocument('<!DOCTYPE r SYSTEM "r.dtd"><r><a>1</a></r>').value).toEqual({ a: '1' });
  });

  it('skips a DOCTYPE with an internal subset', () => {
    expect(parseXmlDocument('<!DOCTYPE r [<!ELEMENT r (a)>]><r><a>1</a></r>').value).toEqual({ a: '1' });
  });

  it('skips comments before and after the root', () => {
    expect(parseXmlDocument('<!-- before --><r><a>1</a></r><!-- after -->').value).toEqual({ a: '1' });
  });

  it('tolerates whitespace around the document', () => {
    expect(parseXmlDocument('\n\t <r><a>1</a></r> \n ').value).toEqual({ a: '1' });
  });

  it('keeps a trailing newline, which is what a pretty-printed document ends with', () => {
    expect(parseXmlDocument('<r>\n  <a>1</a>\n</r>\n').value).toEqual({ a: '1' });
  });
});

describe('parseXml() — repeated elements', () => {
  it('reads one element as a bare value', () => {
    expect(parseXmlDocument('<r><tag>a</tag></r>').value).toEqual({ tag: 'a' });
  });

  it('reads two elements as an array', () => {
    expect(parseXmlDocument('<r><tag>a</tag><tag>b</tag></r>').value).toEqual({ tag: ['a', 'b'] });
  });

  it('reads three elements as an array', () => {
    expect(parseXmlDocument('<r><tag>a</tag><tag>b</tag><tag>c</tag></r>').value).toEqual({ tag: ['a', 'b', 'c'] });
  });

  it('reads repeated elements with attributes', () => {
    expect(parseXmlDocument('<r><i n="1"/><i n="2"/></r>').value).toEqual({ i: [{ '@n': '1' }, { '@n': '2' }] });
  });

  it('keeps elements of different names apart', () => {
    expect(parseXmlDocument('<r><a>1</a><b>2</b><a>3</a></r>').value).toEqual({ a: ['1', '3'], b: '2' });
  });
});

describe('parseXml() — documents it refuses', () => {
  it.effect('refuses an empty document', () =>
    Effect.gen(function* () {
      expect((yield* parseError('')).message).toBe('Document has no root element');
    })
  );

  it.effect('refuses a document that is only whitespace', () =>
    Effect.gen(function* () {
      expect((yield* parseError('   \n ')).message).toBe('Document has no root element');
    })
  );

  it.effect('refuses a document that is only a prolog', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<?xml version="1.0"?>')).message).toBe('Document has no root element');
    })
  );

  it.effect('refuses an unclosed element', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r><a>1</a>')).message).toBe('Unclosed element <r>');
    })
  );

  it.effect('refuses a closing tag that does not match', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r><a>1</b></r>')).message).toBe('Closing tag </b> does not match <a>');
    })
  );

  it.effect('refuses content after the root element', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r/><s/>')).message).toBe('Unexpected content after the root element');
    })
  );

  it.effect('refuses a second root element', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r/><r/>')).message).toBe('Unexpected content after the root element');
    })
  );

  it.effect('refuses an unterminated comment', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r><!-- oops</r>')).message).toBe('Unterminated comment');
    })
  );

  it.effect('refuses an unterminated CDATA section', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r><![CDATA[oops</r>')).message).toBe('Unterminated CDATA section');
    })
  );

  it.effect('refuses an attribute with no equals sign', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r a b="1"/>')).message).toMatch(/has no "="/);
      expect((yield* parseError('<r a/>')).message).toMatch(/has no "="/);
    })
  );

  it.effect('refuses an attribute whose value is not quoted', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r a=1/>')).message).toMatch(/has no quoted value/);
    })
  );

  it.effect('refuses an unterminated attribute value', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r a="1/>')).message).toMatch(/Unterminated value for attribute/);
    })
  );

  it.effect('refuses an unterminated start tag', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r a="1"')).message).toBe('Unterminated start tag');
    })
  );

  it.effect('refuses a declaration inside an element', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<r><!ENTITY x "y"></r>')).message).toMatch(/not allowed inside an element/);
    })
  );

  it.effect('refuses an unterminated DOCTYPE', () =>
    Effect.gen(function* () {
      expect((yield* parseError('<!DOCTYPE r [<!ENTITY x "y">]')).message).toBe('Unterminated DOCTYPE declaration');
    })
  );

  it.effect('refuses a document nested past the depth limit', () =>
    Effect.gen(function* () {
      // Built rather than written out: a document deep enough to matter is absurd
      // to spell out, and the point is the limit rather than the contents.
      const deep = `${'<a>'.repeat(40)}x${'</a>'.repeat(40)}`;
      expect((yield* parseError(deep, { maxDepth: 10 })).message).toMatch(/maxDepth/);
    })
  );

  it('reads a document nested exactly to the limit', () => {
    const deep = `${'<a>'.repeat(10)}x${'</a>'.repeat(10)}`;
    expect(() => parseXmlDocument(deep, { maxDepth: 10 }).value).not.toThrow();
  });

  it.effect('carries the position and the source, so a caller can point at the problem', () =>
    Effect.gen(function* () {
      const error = yield* parseError('<r><a>1</b></r>');
      expect(error.position).toBe(7);
      expect(error.input).toBe('<r><a>1</b></r>');
      expect(error._tag).toBe('XmlParseError');
    })
  );

  it.effect('reports the failure through the Effect, not by throwing', () =>
    Effect.gen(function* () {
      expect(Result.isFailure(yield* parseXml('<r><a>1</b></r>').pipe(Effect.result))).toBe(true);
      expect(Result.isSuccess(yield* parseXml('<r><a>1</a></r>').pipe(Effect.result))).toBe(true);
    })
  );

  it.effect('reports a malformed document as a typed failure rather than a defect', () =>
    Effect.gen(function* () {
      // A parse failure is an expected outcome of reading untrusted text, so it has to land in the error channel. Were it a defect, `catchTag`, `retry` and a
      // fallback would all miss it and the declared `XmlParseError` type would be a lie.
      const exit = yield* Effect.exit(parseXml('<r><a>1</b></r>'));
      expect(Exit.hasDies(exit)).toBe(false);
      assert(Exit.isFailure(exit));
      expect(Cause.squash(exit.cause)).toBeInstanceOf(XmlParseError);
    })
  );

  it.effect('lets a caller recover from a parse failure by tag', () =>
    Effect.gen(function* () {
      const recovered = yield* parseXml('<r><a>1</b></r>').pipe(Effect.catchTag('XmlParseError', () => Effect.succeed({ recovered: true })));
      expect(recovered).toEqual({ recovered: true });
    })
  );
});

describe('parseXml() — a document that cannot be read as XML but should be', () => {
  it('reads a document whose only fault is an unescaped ampersand', () => {
    expect(parseXmlDocument('<r><a>Smith & Jones</a></r>').value).toEqual({ a: 'Smith & Jones' });
  });

  it('reads a value that is only spaces, as an empty string', () => {
    expect(parseXmlDocument('<r><a>   </a></r>').value).toEqual({ a: '' });
  });

  it('reads a document with no space before a closing tag', () => {
    expect(parseXmlDocument('<r><a>1</a ></r>').value).toEqual({ a: '1' });
  });

  it('reads a self-closing tag with a space before the slash', () => {
    expect(parseXmlDocument('<r><a /></r>').value).toEqual({ a: '' });
  });
});
