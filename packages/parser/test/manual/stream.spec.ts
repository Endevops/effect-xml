import { Effect } from 'effect';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

import { makeParser } from '#/test/helpers/test-runner.ts';

describe('XMLParser', () => {
  it('should parse when a readable stream is given as input', async () => {
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
    const parser = makeParser();
    const result = await Effect.runPromise(parser.parseStream(fs.createReadStream(fileNamePath)));
    expect(result).toEqual(expected);
  });
});
