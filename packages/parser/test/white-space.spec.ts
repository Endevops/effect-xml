import { WSNormalizer } from '@endevops/builder';
import { CompactBuilderFactory } from '@endevops/builder';
import { describe, it, expect } from 'vite-plus/test';

import { parseDoc, makeParser, runParser } from '#/test/helpers/test-runner.ts';

describe('White Space', function () {
  it("should preserve whitespace when xml:space='preserve' and strip it when xml:space='default' and skipping NS", function () {
    const xmlData = `
      <root xml:space="preserve">
        <note xml:space="default">
          <and> this    </and>
            this should not be preserved
        </note>
        <integer>42</integer>
        <float>3.14</float><!-- comment     spaces -->
        <![CDATA[Some 
        <raw> 
        data & more]]>
        <stop>
        raw
        </stop>
        <hex>0x1F
        </hex>
      </root>`;

    const options = {
      skip: {
        whitespaceText: false,
        attributes: false,
        nsPrefix: true, //no impact
        comments: false,
      },
      nameFor: { cdata: '#cdata', comment: '#comment' },
      OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['ws', 'boolean', 'number'] } })),
      tags: { stopNodes: ['root.stop'] },
    };
    const parser = makeParser(options);
    const result = parseDoc(parser, xmlData);

    const expected = {
      root: {
        '@_space': 'preserve',
        note: { '@_space': 'default', and: 'this', '#text': 'this should not be preserved' },
        integer: 42,
        float: 3.14,
        '#comment': ' comment     spaces ',
        '#cdata': 'Some \n        <raw> \n        data & more',
        stop: '\n        raw\n        ',
        hex: 31,
        '#text': '\n        \n        \n        \n        \n        \n        \n      ',
      },
    };

    // console.log(JSON.stringify(result, null, 2))
    expect(result).toEqual(expected);
  });
  it("should preserve whitespace when xml:space='preserve' and strip it when xml:space='default' when not skipping NS", function () {
    const xmlData = `
      <root xml:space="preserve">
        <note xml:space="default">
          <and> this    </and>
            this should not be preserved
        </note>
        <integer>42</integer>
        <float>3.14</float><!-- comment     spaces -->
        <![CDATA[Some 
        <raw> 
        data & more]]>
        <stop>
        raw
        </stop>
        <hex>0x1F
        </hex>
      </root>`;

    const options = {
      skip: {
        whitespaceText: false,
        attributes: false,
        nsPrefix: false, //no impact
        comments: false,
      },
      nameFor: { cdata: '#cdata', comment: '#comment' },
      OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['ws', 'boolean', 'number'] } })),
      tags: { stopNodes: ['root.stop'] },
    };
    const parser = makeParser(options);
    const result = parseDoc(parser, xmlData);

    const expected = {
      root: {
        '@_xml:space': 'preserve',
        note: { '@_xml:space': 'default', and: 'this', '#text': 'this should not be preserved' },
        integer: 42,
        float: 3.14,
        '#comment': ' comment     spaces ',
        '#cdata': 'Some \n        <raw> \n        data & more',
        stop: '\n        raw\n        ',
        hex: 31,
        '#text': '\n        \n        \n        \n        \n        \n        \n      ',
      },
    };

    // console.log(JSON.stringify(result, null, 2))
    expect(result).toEqual(expected);
  });

  it('should preserve whitespace for CDATA, Stopnode, comment by default', function () {
    const xmlData = `
      <root>
        <integer>42</integer>
        <float>3.14</float><!-- comment     spaces -->
        <![CDATA[Some 
        <raw> 
        data & more]]>
        <stop>
        raw
        </stop>
        <hex>0x1F</hex>
      </root>`;

    const options = {
      skip: {
        whitespaceText: false,
        attributes: false,
        nsPrefix: false, //no impact
        comments: false,
      },
      nameFor: { cdata: '#cdata', comment: '#comment' },
      OutputBuilder: runParser(CompactBuilderFactory.make({ tags: { valueParsers: ['ws', 'boolean', 'number'] } })),
      tags: { stopNodes: ['root.stop'] },
    };
    const parser = makeParser(options);
    const result = parseDoc(parser, xmlData);

    const expected = {
      root: {
        integer: 42,
        float: 3.14,
        '#comment': ' comment     spaces ',
        '#cdata': 'Some \n        <raw> \n        data & more',
        stop: '\n        raw\n        ',
        hex: 31,
        '#text': '',
      },
    };
    // console.log(JSON.stringify(result, null, 2))
    expect(result).toEqual(expected);
  });
  it('should preserve whitespace for speciic tags', function () {
    const xmlData = `
      <root>
        <integer>42</integer>
        <float>3.14</float><!-- comment     spaces -->
        <![CDATA[Some 
        <raw> 
        data & more]]>
        <stop>
        raw
        </stop>
        <hex>0x1F</hex>
      </root>`;

    const options = {
      skip: {
        whitespaceText: false,
        attributes: false,
        nsPrefix: false, //no impact
        comments: false,
      },
      nameFor: { cdata: '#cdata', comment: '#comment' },
      OutputBuilder: runParser(
        CompactBuilderFactory.make({ tags: { valueParsers: [runParser(WSNormalizer.make({ exclude: ['root.stop'] })), 'boolean', 'number'] } })
      ),
      // tags: { stopNodes: ["root.stop"] }
    };
    const parser = makeParser(options);
    const result = parseDoc(parser, xmlData);

    const expected = {
      root: {
        integer: 42,
        float: 3.14,
        '#comment': ' comment     spaces ',
        '#cdata': 'Some \n        <raw> \n        data & more',
        stop: '\n        raw\n        ',
        hex: 31,
        '#text': '',
      },
    };
    // console.log(JSON.stringify(result, null, 2))
    expect(result).toEqual(expected);
  });
});
