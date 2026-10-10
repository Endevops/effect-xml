/**
 * @description Specs for the key conventions and the name resolver: which key is an attribute, which is character data, and what happens to a field name that is
 * not a legal XML name.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { ResolveNameOptions } from '#/index.ts';

import { attributeName, isAttributeKey, isQName, isReservedKey, isTextKey, resolveName, ATTRIBUTE_PREFIX, TEXT_KEY } from '#/index.ts';

/**
 * @description Resolves a name the way a caller not already in an `Effect` would: `resolveName` answers with an `Effect` whose failure is an `XmlParseError`, and
 * `Effect.runSync` throws it. The specs assert on the returned name and on the thrown failure, so this keeps each case a one-liner.
 */
const resolve = (name: string, options?: ResolveNameOptions): string => Effect.runSync(resolveName(name, options));

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

describe('resolve()', () => {
  it('leaves a legal name alone', () => {
    expect(resolve('title')).toBe('title');
    expect(resolve('_private')).toBe('_private');
    expect(resolve('a-b.c')).toBe('a-b.c');
  });

  it('leaves a prefixed name alone, prefix included', () => {
    expect(resolve('soap:Envelope')).toBe('soap:Envelope');
    expect(resolve('xml:lang')).toBe('xml:lang');
  });

  it('leaves a non-ASCII legal name alone', () => {
    expect(resolve('café')).toBe('café');
  });

  it('repairs an illegal name by default', () => {
    expect(resolve('not a name')).toBe('not_a_name');
    expect(resolve('1st')).toBe('_1st');
    expect(resolve('-leading')).toBe('_-leading');
  });

  it('keeps a namespace prefix through a repair rather than dropping it', () => {
    // Repairing with the `name` production keeps colons; repairing with `ncName`
    // would turn `soap:Envelope` into `soapEnvelope` and silently lose the
    // prefix, which is a different name rather than a fixed one.
    expect(resolve('soap:Envelope room')).toBe('soap:Envelope_room');
  });

  it('writes an illegal name unchanged in ignore mode', () => {
    expect(resolve('not a name', { mode: 'ignore' })).toBe('not a name');
  });

  it('fails an illegal name in error mode, naming the reason', () => {
    expect(() => resolve('not a name', { mode: 'error' })).toThrow(/Invalid XML name "not a name"/);
    expect(() => resolve('not a name', { mode: 'error' })).toThrow(/not a valid NameChar/);
  });

  it('accepts a legal name in error mode', () => {
    expect(resolve('title', { mode: 'error' })).toBe('title');
  });

  it('rejects a name that is only legal in XML 1.1 when 1.0 was asked for', () => {
    // U+0487 is a combining mark: a legal NameChar in 1.1, not in 1.0.
    const combining = 'a\u0487';
    expect(resolve(combining, { mode: 'error', xmlVersion: '1.1' })).toBe(combining);
    expect(() => resolve(combining, { mode: 'error', xmlVersion: '1.0' })).toThrow(/Invalid XML name/);
  });
});

describe('isQName()', () => {
  it('accepts what the resolver leaves alone', () => {
    for (const name of ['title', 'a-b', 'a.b', 'ns:x', 'café']) {
      expect(isQName(name)).toBe(true);
      expect(resolve(name)).toBe(name);
    }
  });

  it('rejects what the resolver has to rewrite', () => {
    for (const name of ['1bad', 'a b', '', '-lead']) {
      expect(isQName(name)).toBe(false);
      expect(resolve(name)).not.toBe(name);
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
