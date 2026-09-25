import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import XMLParser from '#/XMLParser.ts';

describe('XMLParser', () => {
  it('should parse when Buffer is given as input', async () => {
    const fileNamePath = path.join(import.meta.dirname, 'assets/mini-sample.xml');
    const xmlStrData = await fs.readFile(fileNamePath, 'utf-8');

    const parser = new XMLParser();
    // const result = parser.parse(xmlStrData);

    const expected = {
      '?xml': '',
      any_name: {
        person: [
          { phone: [122233344550, 122233344551], name: 'Jack', age: 33, emptyNode: '', booleanNode: [false, true], selfclosing: '' },
          { phone: [122233344553, 122233344554], name: 'Boris' },
        ],
      },
    };

    for (let i = 0; i < xmlStrData.length; i++) {
      parser.feed(xmlStrData[i]!);
    }
    const result = parser.end();
    expect(result).toEqual(expected);
  });
});
