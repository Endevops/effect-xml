/**
 * @description Specs for the builder's entity handling: the predefined `&`, `<`, `>`, `'` and `"` table applied to text and attribute values, in both the
 * plain-object and the `preserveOrder` form. Every document here is built out of the characters the table escapes, so an assertion passes only if
 * each one is escaped exactly once.
 */

import { describe, expect, it } from 'vite-plus/test';

import { run, makeBuilder } from '#/test/helpers/effect.ts';

describe('Entities', () => {
  it('should build by decoding default entities', () => {
    const jsObj = { note: { '@heading': 'Reminder > "Alert', body: { '#text': ' 3 < 4', attr: 'Writer: Donald Duck.' } } };

    const expected = `
        <note heading="Reminder &gt; &quot;Alert">
            <body>
             3 &lt; 4
             <attr>Writer: Donald Duck.</attr>
            </body>
        </note>`;

    const options = {
      attributeNamePrefix: '@',
      ignoreAttributes: false,
      // processEntities: true,
    };
    const builder = makeBuilder(options);
    const result = run(builder.build(jsObj));
    expect(result.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
  });

  it('should build by decoding default entities in preserve mode', () => {
    const jsObj = [
      { note: [{ body: [{ '#text': '3 < 4' }, { attr: [{ '#text': 'Writer: Donald Duck.' }] }] }], ':@': { '@heading': 'Reminder > "Alert' } },
    ];

    const expected = `
        <note heading="Reminder &gt; &quot;Alert">
            <body>
             3 &lt; 4
             <attr>Writer: Donald Duck.</attr>
            </body>
        </note>`;

    const options = {
      attributeNamePrefix: '@',
      ignoreAttributes: false,
      preserveOrder: true,
      // processEntities: false,
    };

    const builder = makeBuilder(options);
    const result = run(builder.build(jsObj));
    expect(result.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
  });
});

describe('External Entities', () => {
  it("should build by decoding '&' preserve mode", () => {
    const jsObj = [
      { note: [{ body: [{ '#text': '(3 & 4) < 5' }, { attr: [{ '#text': 'Writer: Donald Duck.' }] }] }], ':@': { '@heading': 'Reminder > "Alert' } },
    ];

    const expected = `
        <note heading="Reminder &gt; &quot;Alert">
            <body>
             (3 &amp; 4) &lt; 5
             <attr>Writer: Donald Duck.</attr>
            </body>
        </note>`;

    const options = {
      attributeNamePrefix: '@',
      ignoreAttributes: false,
      preserveOrder: true,
      // processEntities: false,
    };

    const builder = makeBuilder(options);
    const result = run(builder.build(jsObj));
    expect(result.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
  });

  it("should build by decoding '&'", () => {
    const jsObj = { note: { body: { attr: 'Writer: Donald Duck.', '#text': '(3 & 4) < 5' }, '@heading': 'Reminder > "Alert' } };

    const expected = `
        <note heading="Reminder &gt; &quot;Alert">
            <body>
            <attr>Writer: Donald Duck.</attr>
             (3 &amp; 4) &lt; 5
            </body>
        </note>`;

    const options = { attributeNamePrefix: '@', ignoreAttributes: false };

    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
  });
});
