/**
 * @description Round-trips a document whose attributes are grouped under a tag literally named `attributes`, to prove a tag name that reads like a reserved option
 * key is still written as an element. The XML is parsed with `preserveOrder` and `unpairedTags`, then rebuilt with formatting and empty-node
 * suppression, and the two must match once whitespace is normalised. The `format` and `suppressEmptyNode` keys are builder-only, so the parser gets
 * its own options literal.
 */

import type { X2jOptions } from 'fast-xml-parser';

/**
 * @description `XMLParser` here is the **upstream** `fast-xml-parser` from npm, not `@endevops/parser`. It is used to produce input documents for the builder — a
 * real parse result rather than a hand-written object — and it is synchronous, so its `parse` returns a value and must not be passed to {@link run},
 * which only accepts an `Effect`. Only this package's own builder calls are effects. (`@endevops/parser` has since been converted to the same typed
 * channel, so the two now differ; that difference is exactly what the wrap here got wrong.)
 */
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vite-plus/test';

import type { XmlBuilderOptions } from '#/index.ts';

import { run, makeBuilder } from '#/test/helpers/effect.ts';

describe('Attributes', function () {
  it("should parse and build with tag name 'attributes'", function () {
    const XMLdata = `
        <test attr="test bug">
          <a name="a">123</a>
          <b name="b"/>
          <attributes>
            <attribute datatype="string" name="DebugRemoteType">dev</attribute>
            <attribute datatype="string" name="DebugWireType">2</attribute>
            <attribute datatype="string" name="TypeIsVarchar">1</attribute>
          </attributes>
        </test>`;

    const parsingOptions: X2jOptions = { ignoreAttributes: false, preserveOrder: true, unpairedTags: ['star'] };
    const parser = new XMLParser(parsingOptions);
    const result: unknown = parser.parse(XMLdata);

    const builderOptions: XmlBuilderOptions = {
      ignoreAttributes: false,
      format: true,
      preserveOrder: true,
      suppressEmptyNode: true,
      unpairedTags: ['star'],
    };
    const builder = makeBuilder(builderOptions);
    const output = run(builder.build(result));
    expect(output.replace(/\s+/g, '')).toEqual(XMLdata.replace(/\s+/g, ''));
  });
});
