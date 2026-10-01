import { describe, it, expect } from '@effect/vitest';
import { Effect } from 'effect';
import fs from 'node:fs';
import path from 'node:path';

import { XMLParser } from '#/xml-parser.ts';

describe('XMLParser', () => {
  it.effect('should parse when a readable stream is given as input', () =>
    Effect.gen(function* () {
      const fileNamePath = path.join(import.meta.dirname, 'assets/mini-sample.xml');

      const expected = {
        '?xml': '',
        any_name: {
          person: [
            { phone: [122233344550, 122233344551], name: 'Jack', age: 33, emptyNode: '', booleanNode: [false, true], selfclosing: '' },
            { phone: [122233344553, 122233344554], name: 'Boris' },
          ],
        },
      };
      const parser = yield* XMLParser.make();
      const result = yield* parser.parseStream(fs.createReadStream(fileNamePath));
      expect(result).toEqual(expected);
    })
  );
});
