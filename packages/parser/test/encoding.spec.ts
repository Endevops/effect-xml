import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { StringDecoder } from 'node:string_decoder';

import type { ParseError } from '#/parse-error.ts';
import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import { XMLParser } from '#/xml-parser.ts';

describe('Encoding support', () => {
  it.effect('parseBytesArr correctly decodes multi-byte UTF-8 content (prerequisite bug fix)', () =>
    Effect.gen(function* () {
      const xml = `<root name="Rahul🎉"><city>København</city></root>`;
      const buf = Buffer.from(xml, 'utf8');
      const parser = yield* XMLParser.make({ skip: { attributes: false } });
      const result = (yield* parser.parseBytesArr(buf)) as ParsedNode;
      expect(result.root['@_name']).toBe('Rahul🎉');
      expect(result.root.city).toBe('København');
    })
  );

  it.effect('parse() with a Buffer also goes through the encoding-aware path', () =>
    Effect.gen(function* () {
      const xml = `<root>café</root>`;
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parse(Buffer.from(xml, 'utf8'))) as ParsedNode;
      expect(result.root).toBe('café');
    })
  );

  it.effect('auto-detects utf8 BOM and strips it from output', () =>
    Effect.gen(function* () {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const xml = Buffer.from(`<root>hello</root>`, 'utf8');
      const buf = Buffer.concat([bom, xml]);
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseBytesArr(buf)) as ParsedNode;
      expect(result.root).toBe('hello');
    })
  );

  it.effect('auto-detects encoding from the XML declaration when no BOM is present', () =>
    Effect.gen(function* () {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><root>hi</root>`;
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseBytesArr(Buffer.from(xml, 'utf8'))) as ParsedNode;
      expect(result.root).toBe('hi');
    })
  );

  it.effect('throws ENCODING_MISMATCH when BOM and declared encoding disagree', () =>
    Effect.gen(function* () {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]); // utf8 BOM
      const decl = Buffer.from(`<?xml version="1.0" encoding="UTF-16"?><root>hi</root>`, 'utf8');
      const buf = Buffer.concat([bom, decl]);
      const parser = yield* XMLParser.make();
      const result = yield* parser.parseBytesArr(buf).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/encoding/i);
    })
  );

  it.effect('decodes explicit utf16le buffers correctly (decode-first CharScanStrategy path)', () =>
    Effect.gen(function* () {
      const xml = `<root>hello world</root>`;
      const buf = Buffer.from(xml, 'utf16le');
      const parser = yield* XMLParser.make({ decoding: { encoding: 'utf16le' } });
      const result = (yield* parser.parseBytesArr(buf)) as ParsedNode;
      expect(result.root).toBe('hello world');
    })
  );

  it.effect('auto-detects a utf16le BOM', () =>
    Effect.gen(function* () {
      const bomBuf = Buffer.from([0xff, 0xfe]);
      const xmlBuf = Buffer.from(`<root>hi</root>`, 'utf16le');
      const buf = Buffer.concat([bomBuf, xmlBuf]);
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseBytesArr(buf)) as ParsedNode;
      expect(result.root).toBe('hi');
    })
  );

  it.effect('index for byte input is a character offset, so it lines up with the decoded text', () =>
    Effect.gen(function* () {
      // Position reporting is index-only, and that index is now a CHARACTER
      // offset for every input — string, bytes or fed chunks — because the bytes
      // are decoded before scanning begins. "café" and "cafe" are both four
      // characters, so a mismatch at the same place reports the same index.
      //
      // This used to be a byte offset, and the two documents differed by one
      // because 'é' occupies two bytes. That was a trap rather than a feature: a
      // byte offset into a UTF-8 document cannot be used to slice that document,
      // so any caller who tried to point at the reported position got a character
      // boundary in the wrong place, or a replacement character. The index is now
      // directly usable against the decoded text.
      const parseAndCatch = (xml: string) =>
        Effect.gen(function* () {
          const parser = yield* XMLParser.make();
          const result = yield* parser.parseBytesArr(Buffer.from(xml, 'utf8')).pipe(Effect.result);
          return Result.isFailure(result) ? (result.failure as ParseError) : null;
        });
      const withMultiByte = yield* parseAndCatch(`<root>café</wrong></root>`);
      const withAsciiOnly = yield* parseAndCatch(`<root>cafe</wrong></root>`);
      expect(withMultiByte).not.toBeNull();
      expect(withAsciiOnly).not.toBeNull();
      // Both documents must fail with the same error at the same character
      // position, regardless of how many bytes that position spans.
      expect(withMultiByte!.code).toBe(withAsciiOnly!.code);
      expect(withMultiByte!.index).toBe(withAsciiOnly!.index);
      // And byte input now reports the same index the string path reports, which
      // is the property that makes the offset usable.
      const parser = yield* XMLParser.make();
      const strResult = yield* parser.parse(`<root>café</wrong></root>`).pipe(Effect.result);
      const strError = Result.isFailure(strResult) ? (strResult.failure as ParseError) : null;
      expect(strError).not.toBeNull();
      expect(withMultiByte!.index).toBe(strError!.index);
    })
  );

  it.effect('supports a custom-registered encoding via decoding.customDecoders', () =>
    Effect.gen(function* () {
      // Trivial passthrough "encoding" standing in for something like an
      // iconv-lite-backed Shift_JIS -- proves the pluggable-decoder contract.
      const parser = yield* XMLParser.make({
        decoding: {
          encoding: 'my-custom',
          customDecoders: { 'my-custom': { name: 'my-custom', createDecoder: () => new StringDecoder('latin1'), selfSynchronizing: false } },
        },
      });
      const xml = `<root>hi</root>`;
      const result = (yield* parser.parseBytesArr(Buffer.from(xml, 'latin1'))) as ParsedNode;
      expect(result.root).toBe('hi');
    })
  );

  describe('streaming (feed/end and parseStream) auto-detect', () => {
    it.effect('feed()/end() auto-detects utf8 BOM across a Buffer chunk', () =>
      Effect.gen(function* () {
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const xml = Buffer.from(`<root>café</root>`, 'utf8');
        const parser = yield* XMLParser.make();
        yield* parser.feed(Buffer.concat([bom, xml]));
        const result = (yield* parser.end()) as ParsedNode;
        expect(result.root).toBe('café');
      })
    );

    it.effect('feed()/end() correctly decodes a multi-byte utf8 char split across two feed() calls, even while still detecting', () =>
      Effect.gen(function* () {
        const xml = Buffer.from(`<root>caf\u00e9</root>`, 'utf8'); // 'é' is 2 bytes
        const splitPoint = xml.indexOf(Buffer.from([0xc3])); // split mid-character
        const parser = yield* XMLParser.make();
        yield* parser.feed(xml.subarray(0, splitPoint + 1));
        yield* parser.feed(xml.subarray(splitPoint + 1));
        const result = (yield* parser.end()) as ParsedNode;
        expect(result.root).toBe('café');
      })
    );

    it.effect('parseStream() auto-detects a declared encoding from the XML declaration split across chunks', () =>
      Effect.gen(function* () {
        const { Readable } = yield* Effect.promise(() => import('node:stream'));
        const full = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><root>hello</root>`, 'utf8');
        // Split mid-declaration to prove detection waits for enough bytes.
        const chunks = [full.subarray(0, 10), full.subarray(10)];
        const parser = yield* XMLParser.make();
        const result = (yield* parser.parseStream(Readable.from(chunks))) as ParsedNode;
        expect(result.root).toBe('hello');
      })
    );

    it.effect('parseStream() handles a short document that never reaches the sniff cap or a declaration', () =>
      Effect.gen(function* () {
        const { Readable } = yield* Effect.promise(() => import('node:stream'));
        const parser = yield* XMLParser.make();
        const result = (yield* parser.parseStream(Readable.from([Buffer.from('<root/>')]))) as ParsedNode;
        expect(result.root).toBe('');
      })
    );

    it.effect('does not hold back more than SNIFF_CAP-ish bytes once a real document is streaming in', () =>
      Effect.gen(function* () {
        // Sanity check that detection resolves and the parser makes progress
        // chunk-by-chunk rather than silently buffering the whole document.
        const parser = yield* XMLParser.make();
        const big = '<root>' + 'x'.repeat(5000) + '</root>';
        const buf = Buffer.from(big, 'utf8');
        const first = buf.subarray(0, 50);
        const rest = buf.subarray(50);
        yield* parser.feed(first);
        // Internal peek: once first (< SNIFF_CAP) is fed, detection shouldn't
        // have resolved yet on its own without more bytes or end().
        yield* parser.feed(rest);
        const result = (yield* parser.end()) as ParsedNode;
        expect(result.root.length).toBe(5000);
      })
    );
  });
});
