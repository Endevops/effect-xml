/**
 * @description The `cdataPropName` selection, applied twice to the same `person` document: one run promotes the repeated `phone` numbers to CDATA and leaves the
 * `regx` value as text, the other promotes `regx` and leaves the numbers as text. That makes the choice provably per-key rather than per-document,
 * with an empty string and a blank value both still building a node.
 */

import { describe, expect, it } from 'vite-plus/test';

import type { XmlBuilderOptions } from '#/index.ts';

import { XMLBuilder } from '#/index.ts';

describe('Builder', function () {
  it('should build XML with CDATA for repeated values without parseOrder', function () {
    const input = {
      any_name: {
        person: { phone: [122233344550, 122233344551, ''], name: ['<some>Jack</some>Jack', '<some>Mohan</some>'], blank: '', regx: '^[ ].*$' },
      },
    };
    const expected = `
        <any_name>
            <person>
                <![CDATA[122233344550]]>
                <![CDATA[122233344551]]>
                <![CDATA[]]>
                <name><some>Jack</some>Jack</name>
                <name><some>Mohan</some></name>
                <blank></blank>
                <regx>^[ ].*$</regx>
            </person>
        </any_name>`;

    const options: XmlBuilderOptions = { processEntities: false, format: true, ignoreAttributes: false, cdataPropName: 'phone' };

    const builder = new XMLBuilder(options);
    const xmlOutput = builder.build(input);
    expect(xmlOutput.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
  });

  it('should build XML with CDATA for single value without parseOrder', function () {
    const input = {
      any_name: {
        person: { phone: [122233344550, 122233344551, ''], name: ['<some>Jack</some>Jack', '<some>Mohan</some>'], blank: '', regx: '^[ ].*$' },
      },
    };
    const expected = `
        <any_name>
            <person>
                <phone>122233344550</phone>
                <phone>122233344551</phone>
                <phone></phone>
                <name><some>Jack</some>Jack</name>
                <name><some>Mohan</some></name>
                <blank></blank>
                <![CDATA[^[ ].*$]]>
            </person>
        </any_name>`;

    const options: XmlBuilderOptions = { processEntities: false, format: true, ignoreAttributes: false, cdataPropName: 'regx' };

    const builder = new XMLBuilder(options);
    const xmlOutput = builder.build(input);
    expect(xmlOutput.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
  });
});
