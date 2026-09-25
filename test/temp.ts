import { describe, it, expect } from 'vite-plus/test';

import XMLParser from '#/XMLParser.ts';

// NOTE: scratch/debug file — not a real spec. The assertions are mostly
// `console.log` probes. Kept out of the Vitest run because the filename is
// `temp.ts`, not `temp.spec.ts`. The `it.only` below is deliberately NOT
// present: this file is not executed by `vp test` (which globs `*.spec.ts`),
// so a focus here could never hide a real test, and the intent is preserved
// for when the probes are turned into assertions.
describe('Temp', function () {
  it('BUG: skip.declaration: true should omit ?xml from output (currently broken)', function () {
    const parser = new XMLParser({ skip: { declaration: true } });
    parser.feed(`<ro`);
    parser.feed(`ot/>`);
    const result = parser.end();
    console.log(result); //{ root: '' }
  });

  it('should stop at multiple stop nodes with feedable input source', function () {
    const xmlData = `<rootNode abc='\t23' />`;

    const parser = new XMLParser({ skip: { attributes: false } });

    const result = parser.parse(xmlData);
    console.log(JSON.stringify(result, null, 2));
  });

  it('stop node: comment inside content stays raw', function () {
    const xmlData = `<a><b>abc<!-- </b> --><b/></a>`;

    const parser = new XMLParser({ tags: { stopNodes: ['a.b'] } });
    for (let i = 0; i < xmlData.length; i++) {
      const ch = xmlData[i];
      if (ch !== undefined) parser.feed(ch);
    }
    const result = parser.end();
    console.log(result); //{ root: 'hello' }
  });

  it('booleanType: false', function () {
    const xmlData = `<a name=amit gupta></a>`;

    const parser = new XMLParser({ attributes: { booleanType: 'allow' }, skip: { attributes: false } });
    const result = parser.parse(xmlData);
    console.log(result); //{ root: 'hello' }
  });

  it('uses a custom OutputBuilder', async () => {
    // Simple builder that just counts tags
    let counts = 0;
    const series: (string | number)[] = [];
    const CustomBuilder = {
      getInstance() {
        return {
          registeredValParsers: {},
          addElement(tag: { name: string }) {
            series.push(tag.name);
          },
          closeElement() {
            series.push('closing');
          },
          addValue(text: string) {
            series.push(text);
          },
          addAttribute() {},
          addComment() {},
          addLiteral() {},
          addDeclaration() {},
          addInstruction() {},
          addDocType() {},
          getOutput() {
            return counts;
          },
        };
      },
      registerValueParser() {},
    };

    const xml = '<root>a<item/>b<item/>c<item/>d</root>';
    // CustomBuilder is a hand-written stub that predates the structural
    // OutputBuilderFactoryLike contract; it is cast here only so this scratch
    // probe type-checks. Not a pattern to copy.
    const result = new XMLParser({ OutputBuilder: CustomBuilder as unknown as import('#/internal/parser-types.ts').OutputBuilderFactoryLike }).parse(
      xml
    );
    expect(result).toBeDefined();
    console.log(series);
  });
});
