/**
 * @description Specs for the interaction between `unpairedTags`, `suppressUnpairedNode` and `suppressEmptyNode` — which of the two decides a tag's closing bracket
 * when a tag is declared unpaired _and_ holds no content. Covered in both the plain-object and the `preserveOrder` form, plus repeated unpaired tags,
 * an unpaired tag with attributes, and a `stopNodes` subtree re-emitted between unpaired siblings.
 */

import { describe, expect, it } from 'vite-plus/test';

import { XMLBuilder } from '#/index.ts';

describe('unpaired and empty tags', () => {
  it('should be parsed with paired tag when suppressEmptyNode:false', () => {
    /*
     * Source document `jsObj` is parsed from. Documentation only — the builder never sees it, so it is kept as a reference rather than a live
     * binding:
     * <rootNode>
     *           <tag>value</tag>
     *           <empty />
     *           <unpaired attr="1">
     *       </rootNode>
     */
    const expectedXmlData = `<rootNode>
            <tag>value</tag>
            <empty></empty>
            <unpaired attr="1">
        </rootNode>`;

    const jsObj = { rootNode: { tag: 'value', empty: '', unpaired: { '@_attr': '1' } } };
    const options = {
      // format: true,
      // preserveOrder: true,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(expectedXmlData.replace(/\s+/g, ''));
  });

  it('should be parsed without paired tag when suppressEmptyNode:true', () => {
    const xmlData = `<rootNode>
            <tag>value</tag>
            <empty />
            <unpaired attr="1">
        </rootNode>`;
    const jsObj = { rootNode: { tag: 'value', empty: '', unpaired: { '@_attr': '1' } } };
    const options = {
      // format: true,
      // preserveOrder: true,
      suppressEmptyNode: true,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should be parsed without paired tag when suppressEmptyNode:true and tags order is preserved', () => {
    const xmlData = `<rootNode>
            <tag>value</tag>
            <empty />
            <unpaired attr="1">
        </rootNode>`;
    const jsObj = { rootNode: { tag: 'value', empty: '', unpaired: { '@_attr': '1' } } };
    const options = {
      // format: true,
      // preserveOrder: true,
      suppressEmptyNode: true,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(xmlData.replace(/\s+/g, ''));
  });

  it('should be parsed when unpaired tag is self-closing or paired closing tag', () => {
    /*
     * Source document `jsObj` is parsed from. Documentation only — the builder never sees it, so it is kept as a reference rather than a live
     * binding:
     * <rootNode>
     *           <unpaired attr="1">
     *           <self />
     *           <unpaired>
     *           <unpaired />
     *           <unpaired>
     *           <unpaired />
     *           <unpaired>
     *       </rootNode>
     */

    const expectedXml = `<rootNode>
        <unpaired attr="1">
        <self/>
        <unpaired>
        <unpaired>
        <unpaired>
        <unpaired>
        <unpaired>
      </rootNode>`;
    const jsObj = [
      {
        rootNode: [
          { unpaired: [], ':@': { '@_attr': '1' } },
          { self: [] },
          { unpaired: [] },
          { unpaired: [] },
          { unpaired: [] },
          { unpaired: [] },
          { unpaired: [] },
        ],
      },
    ];
    const options = {
      // format: true,
      preserveOrder: true,
      suppressEmptyNode: true,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(expectedXml.replace(/\s+/g, ''));
  });

  it('should parsed unpaired tag before stop nodes', () => {
    /*
     * Source document `jsObj` is parsed from. Documentation only — the builder never sees it, so it is kept as a reference rather than a live
     * binding:
     * <rootNode>
     *           <unpaired attr="1">
     *           <stop>here</stop>
     *           <unpaired>
     *       </rootNode>
     */

    const expectedXml = `<rootNode>
        <unpaired attr="1">
        <stop>here</stop>
        <unpaired>
      </rootNode>`;

    const jsObj = [{ rootNode: [{ unpaired: [], ':@': { '@_attr': '1' } }, { stop: [{ '#text': 'here' }] }, { unpaired: [] }] }];
    const options = {
      // format: true,
      preserveOrder: true,
      suppressEmptyNode: true,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
      stopNodes: ['*.stop'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(expectedXml.replace(/\s+/g, ''));
  });

  it('should suppress paired tag but not unpaired tag when suppressUnpairedNode:false', () => {
    /*
     * Source document `jsObj` is parsed from. Documentation only — the builder never sees it, so it is kept as a reference rather than a live
     * binding:
     * <rootNode>
     *           <tag>value</tag>
     *           <empty />
     *           <unpaired attr="1">
     *           <unpaired>
     *       </rootNode>
     */
    const expectedXmlData = `<rootNode>
          <tag>value</tag>
          <empty/>
          <unpaired attr="1"/>
          <unpaired/>
      </rootNode>`;
    const jsObj = { rootNode: { tag: 'value', empty: '', unpaired: [{ '@_attr': '1' }, ''] } };
    const options = {
      // format: true,
      // preserveOrder: true,
      suppressEmptyNode: true,
      suppressUnpairedNode: false,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(expectedXmlData.replace(/\s+/g, ''));
  });

  it('should not suppress paired tag but unpaired tag when suppressUnpairedNode:true', () => {
    /*
     * Source document `jsObj` is parsed from. Documentation only — the builder never sees it, so it is kept as a reference rather than a live
     * binding:
     * <rootNode>
     *           <tag>value</tag>
     *           <empty />
     *           <unpaired attr="1">
     *           <unpaired>
     *       </rootNode>
     */
    const expectedXmlData = `<rootNode>
          <tag>value</tag>
          <empty></empty>
          <unpaired attr="1">
          <unpaired>
      </rootNode>`;
    const jsObj = { rootNode: { tag: 'value', empty: '', unpaired: [{ '@_attr': '1' }, ''] } };
    const options = {
      // format: true,
      // preserveOrder: true,
      // suppressEmptyNode: true,
      suppressUnpairedNode: true,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(expectedXmlData.replace(/\s+/g, ''));
  });

  it('should suppress paired tag but not unpaired tag when suppressUnpairedNode:false (ordered)', () => {
    /*
     * Source document `jsObj` is parsed from. Documentation only — the builder never sees it, so it is kept as a reference rather than a live
     * binding:
     * <rootNode>
     *           <tag>value</tag>
     *           <empty />
     *           <unpaired attr="1">
     *           <unpaired>
     *       </rootNode>
     */
    const expectedXmlData = `<rootNode>
          <tag>value</tag>
          <empty/>
          <unpaired attr="1"/>
          <unpaired/>
      </rootNode>`;
    const jsObj = [{ rootNode: [{ tag: [{ '#text': 'value' }] }, { empty: [] }, { unpaired: [], ':@': { '@_attr': '1' } }, { unpaired: [] }] }];
    const options = {
      // format: true,
      preserveOrder: true,
      suppressEmptyNode: true,
      suppressUnpairedNode: false,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(expectedXmlData.replace(/\s+/g, ''));
  });

  it('should not suppress paired tag but unpaired tag when suppressUnpairedNode:true  (ordered)', () => {
    /*
     * Source document `jsObj` is parsed from. Documentation only — the builder never sees it, so it is kept as a reference rather than a live
     * binding:
     * <rootNode>
     *           <tag>value</tag>
     *           <empty />
     *           <unpaired attr="1">
     *           <unpaired>
     *       </rootNode>
     */
    const expectedXmlData = `<rootNode>
          <tag>value</tag>
          <empty></empty>
          <unpaired attr="1">
          <unpaired>
      </rootNode>`;
    const jsObj = [{ rootNode: [{ tag: [{ '#text': 'value' }] }, { empty: [] }, { unpaired: [], ':@': { '@_attr': '1' } }, { unpaired: [] }] }];
    const options = {
      // format: true,
      preserveOrder: true,
      // suppressEmptyNode: true,
      suppressUnpairedNode: true,
      ignoreAttributes: false,
      unpairedTags: ['unpaired'],
    };

    const builder = new XMLBuilder(options);
    const output = builder.build(jsObj);
    expect(output.replace(/\s+/g, '')).toEqual(expectedXmlData.replace(/\s+/g, ''));
  });
});
