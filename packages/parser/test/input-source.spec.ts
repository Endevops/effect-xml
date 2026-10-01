import { describe, it, expect } from '@effect/vitest';
import { Effect } from 'effect';

import BufferSource from '#/input-source/buffer-source.ts';
import FeedableSource from '#/input-source/feedable-source.ts';
import { XMLParser } from '#/xml-parser.ts';

describe('Input Sources', function () {
  it.effect('should parse from string', () =>
    Effect.gen(function* () {
      const xmlString = '<root><tag>value</tag></root>';
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse(xmlString);

      expect(result.root.tag).toBe('value');
    })
  );

  it.effect('should parse from Buffer', () =>
    Effect.gen(function* () {
      const xmlString = '<root><tag>123</tag></root>';
      const buffer = Buffer.from(xmlString);
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse(buffer);

      expect(result.root.tag).toBe(123);
    })
  );

  it.effect('should parse from Uint8Array using parseBytesArr', () =>
    Effect.gen(function* () {
      const xmlString = '<root><tag>test</tag></root>';
      const uint8Array = new Uint8Array(Buffer.from(xmlString));
      const parser = yield* XMLParser.make();
      const result = yield* parser.parseBytesArr(uint8Array);

      expect(result.root.tag).toBe('test');
    })
  );

  it.effect('should handle UTF-8 encoded content', () =>
    Effect.gen(function* () {
      const xmlString = '<root><tag>Hello 世界 🌍</tag></root>';
      const parser = yield* XMLParser.make();
      const result = yield* parser.parse(xmlString);

      expect(result.root.tag).toBe('Hello 世界 🌍');
    })
  );

  it.effect('should use feed/end API for streaming', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();

      yield* parser.feed('<root>');
      yield* parser.feed('<tag>value</tag>');
      yield* parser.feed('</root>');
      const result = yield* parser.end();

      expect(result.root.tag).toBe('value');
    })
  );

  it.effect('should handle chunked streaming data', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const chunks = ['<root>', '<items>', '<item>first</item>', '<item>second</item>', '</items>', '</root>'];

      for (const chunk of chunks) {
        yield* parser.feed(chunk);
      }
      const result = yield* parser.end();

      expect(Array.isArray(result.root.items.item)).toBe(true);
      expect(result.root.items.item[0]).toBe('first');
      expect(result.root.items.item[1]).toBe('second');
    })
  );
});

describe('FeedableSource autoFlush', function () {
  it("trims the buffer even with parseXml()'s level-0 mark pattern in play (fixed)", function () {
    // Mirrors real usage: parseXml()'s main loop calls markTokenStart(0) once
    // per iteration and only clears it via rewindToMark() (the error/retry
    // path). On the success path the level-0 mark is simply overwritten by
    // the next markTokenStart(0), never nulled — so _marks[0] is non-null
    // essentially forever.
    //
    // FIXED: updateBufferBoundary() no longer gates flush() behind an
    // "all marks null" check — flush()'s own min(startIndex, marks...) origin
    // computation is sufficient protection on its own, and correctly trims up
    // to (but not past) the still-live level-0 mark on every call.
    const source = new FeedableSource({ flushThreshold: 16, autoFlush: true });

    let fed = '';
    for (let i = 0; i < 50; i++) {
      const chunk = `x${i}`.padEnd(10, '_');
      Effect.runSync(source.feed(chunk));
      fed += chunk;

      // Simulate parseXml()'s loop: mark before "reading a token", then
      // advance the cursor as if a token of the chunk's length was consumed.
      source.markTokenStart(0);
      source.updateBufferBoundary(chunk.length);
    }

    // We've advanced well past flushThreshold (16) many times over.
    expect(source.startIndex).toBeGreaterThan(0);

    // Buffer should have been trimmed repeatedly — it must not equal the
    // full fed document, and remaining content is whatever's left after the
    // last markTokenStart(0)/updateBufferBoundary() pair (mark tracks the
    // most recent chunk start each iteration, so flush trims everything
    // before it on each call).
    expect(source.buffer.length).toBeLessThan(fed.length);
  });

  it('trims correctly if the level-0 mark is explicitly cleared (proves flush() itself is fine)', function () {
    // Sanity check / isolation: flush()'s trimming logic is correct — the
    // bug is specifically that nothing in the codebase ever clears _marks[0]
    // on the success path (clearMark() exists but is never called anywhere
    // in src/, confirmed by grep).
    const source = new FeedableSource({ flushThreshold: 16, autoFlush: true });

    let fed = '';
    for (let i = 0; i < 50; i++) {
      const chunk = `x${i}`.padEnd(10, '_');
      Effect.runSync(source.feed(chunk));
      fed += chunk;

      source.markTokenStart(0);
      source._marks[0] = null; // what a "clearMark()" call would achieve
      source.updateBufferBoundary(chunk.length);
    }

    expect(source.buffer.length).toBeLessThan(fed.length);
  });

  it.effect('end-to-end via XMLParser.feed(): internal buffer stays bounded on a real parse session (fixed)', () =>
    Effect.gen(function* () {
      // Same scenario as before, through the public API, so it can't be
      // dismissed as an artifact of calling FeedableSource methods in an
      // unrealistic order.
      const parser = yield* XMLParser.make({ feedable: { flushThreshold: 64 } });

      const item = '<item><name>value</name></item>';
      const chunkSize = 8; // small chunks to force many feed()/parseXml() cycles
      let totalFed = 0;
      let peakBuffer = 0;

      for (let n = 0; n < 200; n++) {
        for (let i = 0; i < item.length; i += chunkSize) {
          const chunk = item.slice(i, i + chunkSize);
          yield* parser.feed(chunk);
          totalFed += chunk.length;
          peakBuffer = Math.max(peakBuffer, parser.getFeedBufferLength() as number);
        }
      }
      const bufferLenBeforeEnd = parser.getFeedBufferLength() as number;
      yield* parser.end();

      // With autoFlush working, the live buffer should stay well below the
      // total fed across the whole 200-repetition session, not track it 1:1.
      expect(bufferLenBeforeEnd).toBeLessThan(totalFed / 2);
      expect(peakBuffer).toBeLessThan(totalFed / 2);
    })
  );
});

describe('BufferSource.readFromBuffer (item 10b fix)', function () {
  it('peek (shouldUpdate=false) does not mutate startIndex', function () {
    const source = new BufferSource(Buffer.from('ab\ncd'));
    const before = { startIndex: source.startIndex };
    source.readFromBuffer(3, false); // peeks "ab\n" without consuming
    expect(source.startIndex).toBe(before.startIndex);
  });

  it('single-char consume via readFromBuffer matches readCh() index advancement', function () {
    const viaReadFromBuffer = new BufferSource(Buffer.from('a\nb'));
    viaReadFromBuffer.readFromBuffer(1, true); // 'a'
    viaReadFromBuffer.readFromBuffer(1, true); // '\n'

    const viaReadCh = new BufferSource(Buffer.from('a\nb'));
    viaReadCh.readCh(); // 'a'
    viaReadCh.readCh(); // '\n'

    expect(viaReadFromBuffer.startIndex).toBe(viaReadCh.startIndex);
    expect(viaReadFromBuffer.startIndex).toBe(2);
  });

  it('multi-char consume advances startIndex by exactly n', function () {
    const source = new BufferSource(Buffer.from('ab\ncd'));
    source.readFromBuffer(5, true); // consume entire buffer in one call
    expect(source.startIndex).toBe(5);
  });

  it('multi-char consume matches char-by-char readCh() for startIndex, across a newline', function () {
    const viaBulk = new BufferSource(Buffer.from('12\n345'));
    viaBulk.readFromBuffer(6, true);

    const viaChars = new BufferSource(Buffer.from('12\n345'));
    for (let i = 0; i < 6; i++) viaChars.readCh();

    expect(viaBulk.startIndex).toBe(viaChars.startIndex);
  });

  it('returns the correct substring for both single-char and multi-char reads', function () {
    const source = new BufferSource(Buffer.from('hello'));
    expect(source.readFromBuffer(1, false)).toBe('h');
    expect(source.readFromBuffer(5, false)).toBe('hello');
  });
});
