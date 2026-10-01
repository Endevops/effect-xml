/**
 * @description Specs for the key conventions and the name resolver: which key is an attribute, which is character data, and what happens to a field name that is
 * not a legal XML name.
 */

import { isQName } from '@endevops/common-xml';
import { describe, expect, it } from 'vite-plus/test';

import { attributeName, isAttributeKey, isReservedKey, isTextKey, resolveName, ATTRIBUTE_PREFIX, TEXT_KEY } from '#/index.ts';

describe('the attribute prefix', () => {
  it('is the single character the convention documents', () => {
    expect(ATTRIBUTE_PREFIX).toBe('@');
  });

  it('recognises a prefixed key', () => {
    expect(isAttributeKey('@id')).toBe(true);
    expect(isAttributeKey('@xmlns')).toBe(true);
    expect(isAttributeKey('@a-b.c')).toBe(true);
  });

  it('does not recognise a bare prefix, because it names nothing', () => {
    // `@` on its own has no name after it, so treating it as an attribute would
    // produce an attribute with an empty name — a document nothing can read.
    expect(isAttributeKey('@')).toBe(false);
  });

  it('does not recognise an unprefixed key', () => {
    expect(isAttributeKey('id')).toBe(false);
    expect(isAttributeKey('title')).toBe(false);
    expect(isAttributeKey('')).toBe(false);
  });

  it('does not mistake a character data key for an attribute', () => {
    expect(isAttributeKey(TEXT_KEY)).toBe(false);
  });

  it('recovers the attribute name from the key', () => {
    expect(attributeName('@id')).toBe('id');
    expect(attributeName('@xmlns')).toBe('xmlns');
  });
});

describe('the text key', () => {
  it('is the reserved key the convention documents', () => {
    expect(TEXT_KEY).toBe('#text');
  });

  it('recognises only itself', () => {
    expect(isTextKey(TEXT_KEY)).toBe(true);
    expect(isTextKey('#text2')).toBe(false);
    expect(isTextKey('text')).toBe(false);
  });

  it('is reserved', () => {
    expect(isReservedKey(TEXT_KEY)).toBe(true);
    expect(isReservedKey('@id')).toBe(false);
    expect(isReservedKey('title')).toBe(false);
  });
});

describe('resolveName()', () => {
  it('leaves a legal name alone', () => {
    expect(resolveName('title')).toBe('title');
    expect(resolveName('_private')).toBe('_private');
    expect(resolveName('a-b.c')).toBe('a-b.c');
  });

  it('leaves a prefixed name alone, prefix included', () => {
    expect(resolveName('soap:Envelope')).toBe('soap:Envelope');
    expect(resolveName('xml:lang')).toBe('xml:lang');
  });

  it('leaves a non-ASCII legal name alone', () => {
    expect(resolveName('café')).toBe('café');
  });

  it('repairs an illegal name by default', () => {
    expect(resolveName('not a name')).toBe('not_a_name');
    expect(resolveName('1st')).toBe('_1st');
    expect(resolveName('-leading')).toBe('_-leading');
  });

  it('keeps a namespace prefix through a repair rather than dropping it', () => {
    // Repairing with the `name` production keeps colons; repairing with `ncName`
    // would turn `soap:Envelope` into `soapEnvelope` and silently lose the
    // prefix, which is a different name rather than a fixed one.
    expect(resolveName('soap:Envelope room')).toBe('soap:Envelope_room');
  });

  it('writes an illegal name unchanged in ignore mode', () => {
    expect(resolveName('not a name', { mode: 'ignore' })).toBe('not a name');
  });

  it('fails an illegal name in error mode, naming the reason', () => {
    expect(() => resolveName('not a name', { mode: 'error' })).toThrow(/Invalid XML name "not a name"/);
    expect(() => resolveName('not a name', { mode: 'error' })).toThrow(/not a valid NameChar/);
  });

  it('accepts a legal name in error mode', () => {
    expect(resolveName('title', { mode: 'error' })).toBe('title');
  });

  it('rejects a name that is only legal in XML 1.1 when 1.0 was asked for', () => {
    // U+0487 is a combining mark: a legal NameChar in 1.1, not in 1.0.
    const combining = 'a\u0487';
    expect(resolveName(combining, { mode: 'error', xmlVersion: '1.1' })).toBe(combining);
    expect(() => resolveName(combining, { mode: 'error', xmlVersion: '1.0' })).toThrow(/Invalid XML name/);
  });
});

describe('isQName()', () => {
  it('accepts what the resolver leaves alone', () => {
    for (const name of ['title', 'a-b', 'a.b', 'ns:x', 'café']) {
      expect(isQName(name)).toBe(true);
      expect(resolveName(name)).toBe(name);
    }
  });

  it('rejects what the resolver has to rewrite', () => {
    for (const name of ['1bad', 'a b', '', '-lead']) {
      expect(isQName(name)).toBe(false);
      expect(resolveName(name)).not.toBe(name);
    }
  });

  it('allows at most one colon, which is what separates a QName from a Name', () => {
    expect(isQName('a:b')).toBe(true);
    expect(isQName('a:b:c')).toBe(false);
  });

  it('agrees with the resolver about XML 1.1 names', () => {
    // U+0487 is a combining mark: legal in 1.1, not in 1.0.
    expect(isQName('a\u0487', { xmlVersion: '1.1' })).toBe(true);
    expect(isQName('a\u0487', { xmlVersion: '1.0' })).toBe(false);
  });
});
