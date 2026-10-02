/**
 * @description Specs for the namespace layer: annotating a schema node with `xmlNamespace` places its element in that namespace, and a document written with any
 * prefix for the same URI decodes back to the same value.
 */

import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { toCodecXml } from '#/codec.ts';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const AUTH = 'urn:auth';
const SHOP = 'urn:shop';

describe('namespaces — encode', () => {
  const Envelope = Schema.Struct({
    Header: Schema.optional(
      Schema.Struct({ Token: Schema.String.annotate({ xmlNamespace: AUTH, xmlPrefix: 'auth' }) }).annotate({ xmlNamespace: SOAP, xmlPrefix: 'soap' })
    ),
    Body: Schema.Struct({ GetPrice: Schema.Struct({ item: Schema.String }).annotate({ xmlNamespace: SHOP }) }).annotate({
      xmlNamespace: SOAP,
      xmlPrefix: 'soap',
    }),
  }).annotate({ xmlNamespace: SOAP, xmlPrefix: 'soap' });

  const value = { Header: { Token: 'abc' }, Body: { GetPrice: { item: 'widget' } } };
  const codec = toCodecXml(Envelope, { rootName: 'Envelope' });

  it('writes the annotated prefixes and the declarations they need', () => {
    expect(Schema.encodeSync(codec)(value)).toBe(
      `<soap:Envelope xmlns:soap="${SOAP}">` +
        '<soap:Header><auth:Token xmlns:auth="urn:auth">abc</auth:Token></soap:Header>' +
        `<soap:Body><GetPrice xmlns="${SHOP}"><item>widget</item></GetPrice></soap:Body>` +
        '</soap:Envelope>'
    );
  });

  it('round-trips the value', () => {
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(value))).toEqual(value);
  });

  it('reads a document that binds the same URI to a different prefix', () => {
    const text = Schema.encodeSync(codec)(value).replaceAll('soap:', 's:').replace('xmlns:soap=', 'xmlns:s=');
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });
});

describe('namespaces — default namespace and attributes', () => {
  it('writes an omitted prefix as the default namespace', () => {
    const Note = Schema.Struct({ title: Schema.String, body: Schema.String }).annotate({ xmlNamespace: 'urn:notes' });
    const codec = toCodecXml(Note, { rootName: 'note' });
    expect(Schema.encodeSync(codec)({ title: 'Hi', body: 'there' })).toBe('<note xmlns="urn:notes"><title>Hi</title><body>there</body></note>');
    expect(Schema.decodeSync(codec)('<note xmlns="urn:notes"><title>Hi</title><body>there</body></note>')).toEqual({ title: 'Hi', body: 'there' });
  });

  it('puts only an explicitly annotated attribute in a namespace', () => {
    const Element = Schema.Struct({
      '@mustUnderstand': Schema.String.annotate({ xmlNamespace: SOAP, xmlPrefix: 'soap' }),
      '@id': Schema.String,
      value: Schema.String,
    }).annotate({ xmlNamespace: SOAP, xmlPrefix: 'soap' });
    const codec = toCodecXml(Element, { rootName: 'element' });
    const value = { '@mustUnderstand': '1', '@id': 'x', value: 'v' };
    expect(Schema.encodeSync(codec)(value)).toBe(
      `<soap:element xmlns:soap="${SOAP}" soap:mustUnderstand="1" id="x"><soap:value>v</soap:value></soap:element>`
    );
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(value))).toEqual(value);
  });

  it('declares an attribute prefix on the element that carries it', () => {
    const META = 'urn:meta';
    const Note = Schema.Struct({ '@version': Schema.String.annotate({ xmlNamespace: META, xmlPrefix: 'meta' }), title: Schema.String }).annotate({
      xmlNamespace: 'urn:notes',
    });
    const codec = toCodecXml(Note, { rootName: 'note' });
    const value = { '@version': '1', title: 'Hi' };
    expect(Schema.encodeSync(codec)(value)).toBe('<note xmlns="urn:notes" xmlns:meta="urn:meta" meta:version="1"><title>Hi</title></note>');
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(value))).toEqual(value);
  });

  it('inherits the element namespace through an unannotated child but not to an attribute', () => {
    const Element = Schema.Struct({ child: Schema.Struct({ grand: Schema.String }), '@id': Schema.String }).annotate({
      xmlNamespace: SOAP,
      xmlPrefix: 'soap',
    });
    const codec = toCodecXml(Element, { rootName: 'element' });
    expect(Schema.encodeSync(codec)({ child: { grand: 'x' }, '@id': '7' })).toBe(
      `<soap:element xmlns:soap="${SOAP}" id="7"><soap:child><soap:grand>x</soap:grand></soap:child></soap:element>`
    );
  });
});

describe('namespaces — failures', () => {
  it('refuses a key that already carries a prefix and an annotation', () => {
    expect(() => toCodecXml(Schema.Struct({ 'a:b': Schema.String.annotate({ xmlNamespace: SOAP, xmlPrefix: 'soap' }) }))).toThrow(
      /already carries a prefix/
    );
  });

  it('keeps the same local name in two namespaces when it is nested differently', () => {
    const clash = Schema.Struct({
      a: Schema.Struct({ title: Schema.String.annotate({ xmlNamespace: AUTH, xmlPrefix: 'auth' }) }),
      b: Schema.Struct({ title: Schema.String.annotate({ xmlNamespace: SHOP, xmlPrefix: 'shop' }) }),
    });
    const codec = toCodecXml(clash, { rootName: 'root' });
    const value = { a: { title: 'x' }, b: { title: 'y' } };
    const text = Schema.encodeSync(codec)(value);
    expect(text).toBe(`<root><a><auth:title xmlns:auth="${AUTH}">x</auth:title></a><b><shop:title xmlns:shop="${SHOP}">y</shop:title></b></root>`);
    expect(Schema.decodeSync(codec)(text)).toEqual(value);
  });

  it('refuses an attribute namespace without a prefix', () => {
    expect(() => toCodecXml(Schema.Struct({ '@id': Schema.String.annotate({ xmlNamespace: AUTH }) }))).toThrow(/needs xmlPrefix/);
  });

  it('leaves an unannotated schema byte-for-byte as before', () => {
    const codec = toCodecXml(Schema.Struct({ 'soap:Envelope': Schema.String }), { rootName: 'root' });
    expect(Schema.encodeSync(codec)({ 'soap:Envelope': 'x' })).toBe('<root><soap:Envelope>x</soap:Envelope></root>');
  });
});

describe('namespaces — a repeated element', () => {
  const ITEMS = 'urn:items';

  const codec = toCodecXml(
    Schema.Struct({
      lineItems: Schema.Array(Schema.Struct({ value: Schema.String })).annotate({ xmlNamespace: ITEMS, xmlPrefix: 'i', xmlName: 'Item' }),
    }),
    { rootName: 'root' }
  );

  it('resolves a prefix each repeated element declares on itself', () => {
    const text =
      `<root>` +
      `<i:Item xmlns:i="${ITEMS}"><i:value xmlns:i="${ITEMS}">a</i:value></i:Item>` +
      `<i:Item xmlns:i="${ITEMS}"><i:value xmlns:i="${ITEMS}">b</i:value></i:Item>` +
      `</root>`;
    expect(Schema.decodeSync(codec)(text)).toEqual({ lineItems: [{ value: 'a' }, { value: 'b' }] });
  });

  it('reads a single occurrence as the one-member array', () => {
    expect(Schema.decodeSync(codec)(`<root><i:Item xmlns:i="${ITEMS}"><i:value xmlns:i="${ITEMS}">a</i:value></i:Item></root>`)).toEqual({
      lineItems: [{ value: 'a' }],
    });
  });
});
