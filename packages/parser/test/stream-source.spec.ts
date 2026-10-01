import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Result } from 'effect';
import { Readable } from 'stream';

import type { OutputBuilderFactoryLike } from '#/internal/parser-types.ts';
import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import { XMLParser } from '#/xml-parser.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @description Build a Node.js Readable stream from an array of string chunks. Each chunk is pushed in a separate tick so the parser receives them one at a time —
 * identical to how fs.createReadStream delivers data.
 */
function makeStream(chunks: Array<string | Buffer>): Readable {
  return new Readable({
    read() {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        this.push(null); // EOF
      } else {
        this.push(chunk);
      }
    },
  });
}

/**
 * @description Split a string into chunks of exactly `size` characters.
 */
function chunkString(str: string, size: number): Array<string> {
  const out: Array<string> = [];
  for (let i = 0; i < str.length; i += size) {
    out.push(str.slice(i, i + size));
  }
  return out;
}

// ─── Basic parseStream behaviour ─────────────────────────────────────────────

describe('parseStream — basic', () => {
  it.effect('resolves with a parsed JS object from a well-formed stream', () =>
    Effect.gen(function* () {
      const xml = '<root><tag>value</tag></root>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream([xml]))) as ParsedNode;
      expect(result.root.tag).toBe('value');
    })
  );

  it.effect('handles multiple chunks that align on tag boundaries', () =>
    Effect.gen(function* () {
      const chunks = ['<root>', '<item>one</item>', '<item>two</item>', '</root>'];
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream(chunks))) as ParsedNode;
      expect(Array.isArray(result.root.item)).toBe(true);
      expect(result.root.item[0]).toBe('one');
      expect(result.root.item[1]).toBe('two');
    })
  );

  it.effect('handles a single-character-per-chunk stream', () =>
    Effect.gen(function* () {
      const xml = '<root><tag>hello</tag></root>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 1)))) as ParsedNode;
      expect(result.root.tag).toBe('hello');
    })
  );

  it.effect('handles Buffer chunks', () =>
    Effect.gen(function* () {
      const xml = '<root><val>42</val></root>';
      const stream = Readable.from([Buffer.from(xml)]);
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(stream)) as ParsedNode;
      expect(result.root.val).toBe(42);
    })
  );

  it.effect('returns a Promise when run through the promise bridge', () =>
    Effect.gen(function* () {
      // `parseStream` is an `Effect`; `Effect.runPromise` is the bridge a
      // Promise-shaped caller goes through, so what is under test here is that
      // bridge, not the parse itself.
      const xml = '<root/>';
      const parser = yield* XMLParser.make();
      const result = Effect.runPromise(parser.parseStream(makeStream([xml])));
      expect(result instanceof Promise).toBe(true);
      yield* Effect.promise(() => result);
    })
  );

  it.effect('throws synchronously for non-stream input', () =>
    Effect.gen(function* () {
      // Deliberately not a Readable: parseStream is specified to reject these
      // synchronously with INVALID_STREAM, so the inputs are cast past the type
      // to prove the runtime check rather than the compiler does the rejecting.
      const notAStream = 'not a stream' as unknown as NodeJS.ReadableStream;
      const r1 = yield* (yield* XMLParser.make()).parseStream(notAStream).pipe(Effect.result);
      assert(Result.isFailure(r1));
      const r2 = yield* (yield* XMLParser.make()).parseStream(null as unknown as NodeJS.ReadableStream).pipe(Effect.result);
      assert(Result.isFailure(r2));
      const r3 = yield* (yield* XMLParser.make()).parseStream({} as unknown as NodeJS.ReadableStream).pipe(Effect.result);
      assert(Result.isFailure(r3));
    })
  );
});

// ─── Chunk-boundary stress tests ─────────────────────────────────────────────

describe('parseStream — chunk boundaries', () => {
  it.effect('handles a chunk boundary mid tag-name', () =>
    Effect.gen(function* () {
      // '<ro' ... 'ot><child>x</child></root>'
      const xml = '<root><child>x</child></root>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 3)))) as ParsedNode;
      expect(result.root.child).toBe('x');
    })
  );

  it.effect('handles a chunk boundary inside an attribute value', () =>
    Effect.gen(function* () {
      const xml = '<root id="hello world"><tag>v</tag></root>';
      const parser = yield* XMLParser.make({ skip: { attributes: false } });
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 7)))) as ParsedNode;
      expect(result.root.tag).toBe('v');
    })
  );

  it.effect('handles a chunk boundary inside a text node', () =>
    Effect.gen(function* () {
      // text 'hello world' split across chunks
      const xml = '<root>hello world</root>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 4)))) as ParsedNode;
      expect(result.root).toBe('hello world');
    })
  );

  it.effect('handles a chunk boundary inside CDATA', () =>
    Effect.gen(function* () {
      const xml = '<root><![CDATA[hel]]><![CDATA[lo]]></root>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 5)))) as ParsedNode;
      expect(result.root).toBe('hello');
    })
  );

  it.effect('handles a chunk boundary inside a comment', () =>
    Effect.gen(function* () {
      const xml = '<root><!--this is a comment-->val</root>';
      const parser = yield* XMLParser.make({ nameFor: { comment: '#comment' } });
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 6)))) as ParsedNode;
      expect(result.root['#text']).toBe('val');
    })
  );

  it.effect('handles a chunk boundary inside a closing tag', () =>
    Effect.gen(function* () {
      const xml = '<root><item>1</item></root>';
      // chunks chosen so '</roo' and 't>' fall in separate chunks
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 13)))) as ParsedNode;
      expect(result.root.item).toBe(1);
    })
  );

  it.effect('handles 2-byte chunks across a deeply nested document', () =>
    Effect.gen(function* () {
      const xml = '<a><b><c><d>deep</d></c></b></a>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream(chunkString(xml, 2)))) as ParsedNode;
      expect(result.a.b.c.d).toBe('deep');
    })
  );
});

// ─── Parser options forwarded correctly ──────────────────────────────────────

describe('parseStream — parser options', () => {
  it.effect('applies number parsing', () =>
    Effect.gen(function* () {
      const xml = '<root><n>42</n><f>3.14</f></root>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream([xml]))) as ParsedNode;
      expect(result.root.n).toBe(42);
      expect(result.root.f).toBeCloseTo(3.14);
    })
  );

  it.effect('applies boolean parsing', () =>
    Effect.gen(function* () {
      const xml = '<root><a>true</a><b>false</b></root>';
      const parser = yield* XMLParser.make();
      const result = (yield* parser.parseStream(makeStream([xml]))) as ParsedNode;
      expect(result.root.a).toBe(true);
      expect(result.root.b).toBe(false);
    })
  );

  it.effect('respects skip.declaration', () =>
    Effect.gen(function* () {
      const xml = '<?xml version="1.0"?><root><v>1</v></root>';
      const r1 = yield* (yield* XMLParser.make({ skip: { declaration: false } })).parseStream(makeStream([xml]));
      const r2 = yield* (yield* XMLParser.make({ skip: { declaration: true } })).parseStream(makeStream([xml]));
      expect(r1['?xml']).toBeDefined();
      expect(r2['?xml']).toBeUndefined();
    })
  );

  it.effect('respects skip.attributes = false', () =>
    Effect.gen(function* () {
      const xml = '<root id="123"><tag>v</tag></root>';
      const parser = yield* XMLParser.make({ skip: { attributes: false } });
      const result = (yield* parser.parseStream(makeStream([xml]))) as ParsedNode;
      expect(result.root['@_id']).toBe(123);
    })
  );

  it.effect('respects stopNodes', () =>
    Effect.gen(function* () {
      const xml = '<root><raw><b>bold</b></raw></root>';
      const parser = yield* XMLParser.make({ tags: { stopNodes: ['*.raw'] } });
      const result = (yield* parser.parseStream(makeStream([xml]))) as ParsedNode;
      expect(result.root.raw).toBe('<b>bold</b>');
    })
  );

  it.effect('uses a custom OutputBuilder', () =>
    Effect.gen(function* () {
      // Simple builder that just counts tags
      const counts: Record<string, number> = {};
      const CustomBuilder = {
        getInstance() {
          return Effect.succeed({
            registeredValParsers: {},
            addElement(tag: { name: string }) {
              counts[tag.name] = (counts[tag.name] || 0) + 1;
            },
            closeElement() {
              return Effect.void;
            },
            addValue() {},
            addAttribute() {
              return Effect.void;
            },
            addComment() {},
            addLiteral() {},
            addDeclaration() {},
            addInstruction() {},
            addDocType() {},
            getOutput() {
              return counts;
            },
          });
        },
        registerValueParser() {
          return Effect.void;
        },
      };

      const xml = '<root><item/><item/><item/></root>';
      const parser = yield* XMLParser.make({ OutputBuilder: CustomBuilder as unknown as OutputBuilderFactoryLike });
      const result = (yield* parser.parseStream(makeStream([xml]))) as ParsedNode;
      expect(result.item).toBe(3);
    })
  );
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('parseStream — error handling', () => {
  it.effect('rejects on malformed XML', () =>
    Effect.gen(function* () {
      const xml = '<root><unclosed>';
      const parser = yield* XMLParser.make();
      const result = yield* parser.parseStream(makeStream([xml])).pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.live('rejects when the stream emits an error event', () =>
    Effect.gen(function* () {
      const stream = new Readable({ read() {} });
      const parser = yield* XMLParser.make();
      const fiber = yield* parser.parseStream(stream).pipe(Effect.result, Effect.forkChild);
      // Let the forked fiber run until it subscribes to the stream, so the
      // error is delivered to a live reader rather than after it has finished.
      yield* Effect.yieldNow;
      stream.emit('error', new Error('disk read failure'));
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result));
      expect(result.failure.message).toContain('disk read failure');
    })
  );

  it.effect('rejects when feedable.maxBufferSize is exceeded', () =>
    Effect.gen(function* () {
      const xml = '<root>' + 'x'.repeat(200) + '</root>';
      const stream = makeStream([xml]);
      const parser = yield* XMLParser.make({ feedable: { maxBufferSize: 100 } });
      const result = yield* parser.parseStream(stream).pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.live('does not reject valid XML just because chunks arrive slowly', () =>
    Effect.gen(function* () {
      // Simulate slow stream with setTimeout between pushes. `it.live` because
      // this is about real timer-driven chunk delivery, which the test clock
      // would hold still.
      const xml = '<root><tag>ok</tag></root>';
      const stream = new Readable({ read() {} });
      const parser = yield* XMLParser.make();
      const fiber = yield* parser.parseStream(stream).pipe(Effect.forkChild);
      // Let the forked fiber run until it subscribes to the stream.
      yield* Effect.yieldNow;

      yield* Effect.sleep('10 millis');
      stream.push(xml.slice(0, 10));
      yield* Effect.sleep('10 millis');
      stream.push(xml.slice(10));
      yield* Effect.sleep('5 millis');
      stream.push(null);

      const result = (yield* Fiber.join(fiber)) as ParsedNode;
      expect(result.root.tag).toBe('ok');
    })
  );
});

// ─── feed()/end() regression — unchanged behaviour ───────────────────────────

describe('feed()/end() — regression', () => {
  it.effect('works with whole-document feed', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      yield* parser.feed('<root><tag>value</tag></root>');
      expect((yield* parser.end()).root.tag).toBe('value');
    })
  );

  it.effect('accumulates multiple chunks before parsing', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      yield* parser.feed('<root>');
      yield* parser.feed('<item>a</item>');
      yield* parser.feed('<item>b</item>');
      yield* parser.feed('</root>');
      const result = (yield* parser.end()) as ParsedNode;
      expect(result.root.item).toEqual(['a', 'b']);
    })
  );

  it.effect('handles chunk boundary mid tag-name', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { declaration: true } });
      yield* parser.feed('<ro');
      yield* parser.feed('ot/>');
      expect((yield* parser.end()).root).toBe('');
    })
  );

  it.effect('handles chunk boundary in CDATA', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ skip: { declaration: true } });
      yield* parser.feed('<root><![CDATA[hel');
      yield* parser.feed('lo]]></root>');
      expect((yield* parser.end()).root).toBe('hello');
    })
  );

  it.effect('is chainable', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      // `feed` yields the parser, so the next feed composes onto the previous
      // one — the same chaining the return-the-parser shape always supported,
      // now spelled as flatMap because the yield is an effect.
      const result = (yield* Effect.flatMap(parser.feed('<r>'), p => Effect.flatMap(p.feed('<v>1</v>'), q => q.feed('</r>'))).pipe(
        Effect.flatMap(p => p.end())
      )) as ParsedNode;
      expect(result.r.v).toBe(1);
    })
  );

  it.effect('throws NOT_STREAMING when end() called without feed()', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      const result = yield* parser.end().pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.effect('reads feedable options from parser config', () =>
    Effect.gen(function* () {
      // maxBufferSize of 20 chars — a single large feed should throw
      const parser = yield* XMLParser.make({ feedable: { maxBufferSize: 20 } });
      const result = yield* parser.feed('<root>' + 'x'.repeat(50) + '</root>').pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.effect('allows a fresh feed/end session after end()', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      yield* parser.feed('<a>1</a>');
      expect((yield* parser.end()).a).toBe(1);
      // Second session on the same parser instance
      yield* parser.feed('<b>2</b>');
      expect((yield* parser.end()).b).toBe(2);
    })
  );
});

// ─── feedable option group ────────────────────────────────────────────────────

describe('feedable options', () => {
  it.effect('defaults apply when feedable is not specified', () =>
    Effect.gen(function* () {
      // Should not throw — default maxBufferSize is 10 MB
      const parser = yield* XMLParser.make();
      const xml = '<root>' + 'x'.repeat(1000) + '</root>';
      yield* parser.feed(xml);
      const result = (yield* parser.end()) as ParsedNode;
      expect(typeof result.root).toBe('string');
    })
  );

  it.effect('feedable.maxBufferSize limits buffer growth', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({ feedable: { maxBufferSize: 50 } });
      const result = yield* parser.feed('x'.repeat(100)).pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );

  it.effect('feedable.autoFlush: false keeps processed data in buffer (no error)', () =>
    Effect.gen(function* () {
      // With autoFlush off, processed data stays but no error should be thrown
      // for a normal-sized document
      const parser = yield* XMLParser.make({ feedable: { autoFlush: false } });
      const xml = '<root><v>ok</v></root>';
      yield* parser.feed(xml);
      expect((yield* parser.end()).root.v).toBe('ok');
    })
  );

  it.effect('feedable options are forwarded to parseStream', () =>
    Effect.gen(function* () {
      const xml = '<root>' + 'a'.repeat(200) + '</root>';
      const parser = yield* XMLParser.make({ feedable: { maxBufferSize: 50 } });
      const result = yield* parser.parseStream(makeStream([xml])).pipe(Effect.result);
      assert(Result.isFailure(result));
    })
  );
});

// ─── parseStream vs feed/end equivalence ─────────────────────────────────────

describe('parseStream / feed / parse equivalence', () => {
  const XML = `
    <catalog>
      <book id="1"><title>XML Primer</title><price>29.99</price></book>
      <book id="2"><title>Node Streams</title><price>34.50</price></book>
    </catalog>`.trim();

  it.effect('parseStream and parse produce identical output', () =>
    Effect.gen(function* () {
      const opts = { skip: { attributes: false } };
      const expected = yield* (yield* XMLParser.make(opts)).parse(XML);
      const actual = yield* (yield* XMLParser.make(opts)).parseStream(makeStream([XML]));
      expect(actual).toEqual(expected);
    })
  );

  it.effect('parseStream and feed/end produce identical output', () =>
    Effect.gen(function* () {
      const opts = { skip: { attributes: false } };

      const feedParser = yield* XMLParser.make(opts);
      for (const c of chunkString(XML, 11)) {
        yield* feedParser.feed(c);
      }
      const feedResult = yield* feedParser.end();

      const streamResult = yield* (yield* XMLParser.make(opts)).parseStream(makeStream(chunkString(XML, 11)));

      expect(streamResult).toEqual(feedResult);
    })
  );
});
