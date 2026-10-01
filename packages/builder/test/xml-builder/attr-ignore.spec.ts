/**
 * @description Selective attribute dropping on the build side: the same namespaced-attribute document is built three times, with `ignoreAttributes` given a list
 * of names, a list of regular expressions, and a callback that also sees the jPath. A namespaced name is not a valid QName, so these also cover names
 * being written as given.
 */

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import type { XmlBuilderOptions } from '#/index.ts';

import { XMLBuilder } from '#/index.ts';

const jsonData = {
  tag: {
    '$ns:attr1': 'a1-value',
    '$ns:attr2': 'a2-value',
    '$ns2:attr3': 'a3-value',
    '$ns2:attr4': 'a4-value',
    tag2: { '$ns:attr1': 'a1-value', '$ns:attr2': 'a2-value', '$ns2:attr3': 'a3-value', '$ns2:attr4': 'a4-value' },
  },
};

describe('XMLParser', function () {
  it.effect('must ignore building attributes by array of strings', () =>
    Effect.gen(function* () {
      const options: XmlBuilderOptions = { attributeNamePrefix: '$', ignoreAttributes: ['ns:attr1', 'ns:attr2'] };
      const builder = yield* XMLBuilder.make(options);
      expect(yield* builder.build(jsonData)).toEqual(
        '<tag ns2:attr3="a3-value" ns2:attr4="a4-value"><tag2 ns2:attr3="a3-value" ns2:attr4="a4-value"></tag2></tag>'
      );
    })
  );

  it.effect('must ignore building attributes by array of RegExp', () =>
    Effect.gen(function* () {
      const options: XmlBuilderOptions = { attributeNamePrefix: '$', ignoreAttributes: [/^ns2:/] };
      const builder = yield* XMLBuilder.make(options);
      expect(yield* builder.build(jsonData)).toEqual(
        '<tag ns:attr1="a1-value" ns:attr2="a2-value"><tag2 ns:attr1="a1-value" ns:attr2="a2-value"></tag2></tag>'
      );
    })
  );

  it.effect('must ignore building attributes via callback fn', () =>
    Effect.gen(function* () {
      const options: XmlBuilderOptions = {
        attributeNamePrefix: '$',
        ignoreAttributes: (aName, jPath) => aName.startsWith('ns:') || jPath === 'tag.tag2',
      };
      const builder = yield* XMLBuilder.make(options);
      expect(yield* builder.build(jsonData)).toEqual('<tag ns2:attr3="a3-value" ns2:attr4="a4-value"><tag2></tag2></tag>');
    })
  );
});
