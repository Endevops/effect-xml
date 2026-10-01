/**
 * @description Formatting with an empty `indentBy`: each element lands on its own line at column zero, in both the ordered and the plain-object input forms. The
 * plain-object case is a known open issue, so it is skipped rather than deleted.
 */

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import type { XmlBuilderOptions } from '#/index.ts';

import { XMLBuilder } from '#/index.ts';

describe('Format without indentation', function () {
  const expectedXml = `
<root>
<child1>hello</child1>
<child2>world</child2>
</root>`;

  it.effect('when order is preserved', () =>
    Effect.gen(function* () {
      const jObj = [{ root: [{ child1: [{ '#text': 'hello' }] }, { child2: [{ '#text': 'world' }] }] }];

      const builderOptions: XmlBuilderOptions = { format: true, preserveOrder: true, indentBy: '' };

      const builder = yield* XMLBuilder.make(builderOptions);
      const output = yield* builder.build(jObj);
      expect(output).toEqual(expectedXml);
    })
  );

  // oxlint-disable-next-line vitest/no-disabled-tests
  it.effect.skip('when order is not preserved', () =>
    Effect.gen(function* () {
      // TODO: This test is failing due an extra line in the starting of the document
      // But not changing the behavior for backward compatibility.
      // Will be fixed in major release
      const jObj = { root: { child1: 'hello', child2: 'world' } };

      const builderOptions: XmlBuilderOptions = { format: true, indentBy: '' };

      const builder = yield* XMLBuilder.make(builderOptions);
      const output = yield* builder.build(jObj);
      expect(output).toEqual(expectedXml);
    })
  );
});
