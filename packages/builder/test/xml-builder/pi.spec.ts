/**
 * @description Pi_spec.js. Processing-instruction and XML-declaration coverage for the XML builder. Covers PI tags with and without attributes, boolean and
 * tag-like attributes, the same with and without preserveOrder, and the rule that text inside a PI tag is ignored.
 */

import { describe, expect, it } from 'vite-plus/test';

import { run, makeBuilder } from '#/test/helpers/effect.ts';

describe('Processing Instruction Tag', function () {
  it('should process PI tag without attributes', function () {
    const xmlData = `
        <?xml version="1.0"?>
        <?mso-contentType?>
        <h1></h1>
        `;
    const jsObj = [{ '?xml': [{ '#text': '' }], ':@': { '@_version': '1.0' } }, { '?mso-contentType': [{ '#text': '' }] }, { h1: [] }];
    const options = { ignoreAttributes: false, format: true, preserveOrder: true };

    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should process PI tag with attributes', function () {
    const xmlData = `
        <?xml version="1.0"?>
        <?xml-stylesheet href="mystyle.xslt" type="text/xsl"?>
        <?TeamAlpha member="Jesper" date="2008-04-15" comment="I strongly feel that the attributes in the product element below are really not needed and should be dropped." ?>
        <h1></h1>
        `;
    const jsObj = [
      { '?xml': [{ '#text': '' }], ':@': { '@_version': '1.0' } },
      { '?xml-stylesheet': [{ '#text': '' }], ':@': { '@_href': 'mystyle.xslt', '@_type': 'text/xsl' } },
      {
        '?TeamAlpha': [{ '#text': '' }],
        ':@': {
          '@_member': 'Jesper',
          '@_date': '2008-04-15',
          '@_comment': 'I strongly feel that the attributes in the product element below are really not needed and should be dropped.',
        },
      },
      { h1: [] },
    ];
    const options = { ignoreAttributes: false, format: true, preserveOrder: true };
    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should process PI tag with boolean attributes', function () {
    const xmlData = `
        <?xml version="1.0"?>
        <?textinfo whitespace is allowed ?>

        <h1></h1>
        `;

    const jsObj = [
      { '?xml': [{ '#text': '' }], ':@': { '@_version': '1.0' } },
      { '?textinfo': [{ '#text': '' }], ':@': { '@_whitespace': true, '@_is': true, '@_allowed': true } },
      { h1: [] },
    ];

    const options = { ignoreAttributes: false, format: true, preserveOrder: true, suppressBooleanAttributes: true };

    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should process PI tag with tag attributes', function () {
    const xmlData = `<?xml version="1.0"?>
        <?elementnames <fred>, <bert>, <harry> ?>
        <h1></h1>
        `;
    const jsObj = [
      { '?xml': [{ '#text': '' }], ':@': { '@_version': '1.0' } },
      { '?elementnames': [{ '#text': '' }], ':@': { '@_<fred>,': true, '@_<bert>,': true, '@_<harry>': true } },
      { h1: [] },
    ];
    const options = { ignoreAttributes: false, format: true, preserveOrder: true, suppressBooleanAttributes: true };

    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should process PI tag with tag attributes when order is not preserved', function () {
    const xmlData = `<?xml version="1.0"?>
        <?elementnames <fred>, <bert>, <harry> ?>
        <h1></h1>
        `;

    const jsObj = {
      '?xml': { attr: { version: '1.0' } },
      '?elementnames': { attr: { '<fred>,': true, '<bert>,': true, '<harry>': true } },
      h1: { text: '' },
    };
    const builderOptions = {
      attributeNamePrefix: '',
      attributesGroupName: 'attr',
      textNodeName: 'text',
      ignoreAttributes: false,
      format: true,
      // suppressEmptyNode: true,
      suppressBooleanAttributes: true,
    };

    const builder = makeBuilder(builderOptions);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should not add any empty line in the start', function () {
    const xmlData = `
      <?xml version="1.0"?>
      <?mso-contentType?>
      <h1></h1>
      `;
    const jsObj = [{ '?xml': [{ '#text': '' }], ':@': { '@_version': '1.0' } }, { '?mso-contentType': [{ '#text': '' }] }, { h1: [] }];
    const options = { ignoreAttributes: false, format: true, preserveOrder: true };

    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should ignore text when preserve order', function () {
    const xmlData = `
      <?xml version="1.0"?>
      <?mso-contentType?>
      <h1></h1>
      `;
    const jsObj = [
      { '?xml': [{ '#text': 'anything' }], ':@': { '@_version': '1.0' } },
      { '?mso-contentType': [{ '#text': 'something' }] },
      { h1: [] },
    ];
    const options = { ignoreAttributes: false, format: true, preserveOrder: true };

    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should ignore text', function () {
    const xmlData = `
      <?xml version="1.0"?>
      <?mso-contentType version="1.0"?>
      <h1></h1>
      `;
    const jsObj = {
      '?xml': { '#text': 'anything', '@_version': '1.0' },
      '?mso-contentType': { '#text': 'something', '@_version': '1.0' },
      h1: { '#text': '' },
    };
    const options = { ignoreAttributes: false, format: true, preserveOrder: false };

    const builder = makeBuilder(options);
    const output = run(builder.build(jsObj));
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });
});
