/**
 * @description Comments through the builder: an ordered-array document rebuilt with every comment preserved, and a plain-object document whose comment-valued keys
 * are emitted as comment nodes.
 */

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import type { XmlBuilderOptions } from '#/index.ts';

import { XMLBuilder } from '#/index.ts';

describe('Comments', function () {
  it.effect('should parse comment and build them back', () =>
    Effect.gen(function* () {
      const XMLdata = `
    <!--Students grades are uploaded by months-->
    <class_list>
       <student>
         <!--Student details-->
         <!--A second comment-->
         <!-- A third comment -->
         <name>Tanmay</name>
         <!-->> ISO DICTIONARY TYPES <<-->
         <grade>A</grade>
       </student>
    </class_list>`;

      const jsonObj = [
        { '#comment': [{ '#text': 'Students grades are uploaded by months' }] },
        {
          class_list: [
            {
              student: [
                { '#comment': [{ '#text': 'Student details' }] },
                { '#comment': [{ '#text': 'A second comment' }] },
                { '#comment': [{ '#text': ' A third comment ' }] },
                { name: [{ '#text': 'Tanmay' }] },
                { '#comment': [{ '#text': '>> ISO DICTIONARY TYPES <<' }] },
                { grade: [{ '#text': 'A' }] },
              ],
            },
          ],
        },
      ];
      const options: XmlBuilderOptions = { ignoreAttributes: false, format: true, commentPropName: '#comment', preserveOrder: true };

      const builder = yield* XMLBuilder.make(options);
      const output = yield* builder.build(jsonObj);
      expect(output.replace(/\s+/g, '')).toEqual(XMLdata.replace(/\s+/g, ''));
    })
  );

  it.effect('should build XML with Comments without parseOrder', () =>
    Effect.gen(function* () {
      const input = {
        any_name: {
          person: {
            phone: [122233344550, 122233344551, ''],
            name: ['<some>Jack</some>Jack', '<some>Mohan</some>'],
            blank: '',
            another: { phone: '1245789' },
          },
        },
      };
      const expected = `
  <any_name>
    <person>
      <!--122233344550-->
      <!--122233344551-->
      <!---->
      <name><some>Jack</some>Jack</name>
      <name><some>Mohan</some></name>
      <blank></blank>
      <another>
        <!--1245789-->
      </another>
    </person>
  </any_name>`;

      const options: XmlBuilderOptions = { processEntities: false, format: true, ignoreAttributes: false, commentPropName: 'phone' };

      const builder = yield* XMLBuilder.make(options);
      const xmlOutput = yield* builder.build(input);
      expect(xmlOutput.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
    })
  );
});
