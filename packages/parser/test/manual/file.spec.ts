import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

import { makeParser, runParser } from '#/test/helpers/test-runner.ts';

describe('XMLParser', () => {
  it('should parse when Buffer is given as input', () => {
    const fileNamePath = path.join(import.meta.dirname, 'assets/mini-sample.xml');
    const xmlStrData = fs.readFileSync(fileNamePath, 'utf-8');

    const parser = makeParser();
    const result = runParser(parser.parse(xmlStrData));

    const expected = {
      '?xml': '',
      any_name: {
        person: [
          { phone: [122233344550, 122233344551], name: 'Jack', age: 33, emptyNode: '', booleanNode: [false, true], selfclosing: '' },
          { phone: [122233344553, 122233344554], name: 'Boris' },
        ],
      },
    };
    expect(result).toEqual(expected);
  });
});
