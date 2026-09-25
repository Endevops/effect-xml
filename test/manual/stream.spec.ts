import fs from 'node:fs';
import path from 'node:path';

import XMLParser from '#/XMLParser.ts';

describe('XMLParser', () => {
  it('should parse when Buffer is given as input', () => {
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
    const parser = new XMLParser();
    const result = parser.parseStream(fs.createReadStream(fileNamePath));
    expect(result).toEqual(expected);
  });
});
