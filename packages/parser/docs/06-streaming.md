# 06 — Streaming & Feed API

Three ways to provide XML input, all using the same parser internals and producing identical output.
All three answer with an `Effect`: `parseStream` is asynchronous, `feed` and `end` are the two halves
of one session, and a stream or a partial document can fail in the same ways a whole document can.

| API                     | Use when                                                  |
| ----------------------- | --------------------------------------------------------- |
| `parse(string\|Buffer)` | Document already in memory                                |
| `feed(chunk)` / `end()` | You control the data loop (WebSocket, `fetch` body, etc.) |
| `parseStream(readable)` | Node.js Readable stream; lowest memory footprint          |

---

## `parseStream` — Node.js streams

```javascript
import { Effect } from 'effect';
import XMLParser from '@endevops/parser';
import { createReadStream } from 'fs';

const parser = Effect.runSync(XMLParser.make(options));
const result = await Effect.runPromise(parser.parseStream(createReadStream('large.xml')));
```

`Effect.runPromise` is the direct substitute for the old `.then` / `.catch` pair.

Each chunk is parsed immediately as it arrives and already-consumed bytes are freed before the next chunk. Memory at steady state is proportional to the **largest single token** (one tag, one CDATA block), not the total document size.

Both failure kinds arrive on the one error channel, so a single `catch` covers them:

```javascript
import { Effect } from 'effect';

const result = await Effect.runPromise(parser.parseStream(readable)).catch(err => {
  // ParseError — malformed XML or limit exceeded
  // native Error — stream 'error' event forwarded as-is
});
```

---

## `feed` / `end` — incremental feeding

Use when you control the data loop. A feed session is a sequence of effects, which is what
`Effect.gen` is for:

```javascript
const program = Effect.gen(function* () {
  const parser = yield* XMLParser.make(options);

  yield* parser.feed('<root>');
  yield* parser.feed('<item>value</item>');
  yield* parser.feed('</root>');

  return yield* parser.end();
});

const result = await Effect.runPromise(program);
```

`feed` yields the parser back, so each `feed` is a `yield*` rather than a chained call — chaining an
`Effect` is not a thing, and the sequence is the part that reads. The parser is the same instance
throughout, which is what makes the feed state accumulate:

```javascript
const result = Effect.runSync(
  Effect.gen(function* () {
    const parser = yield* XMLParser.make(options);
    yield* parser.feed(a);
    yield* parser.feed(b);
    yield* parser.feed(c);
    return yield* parser.end();
  })
);
```

### With `fetch` body

```javascript
const program = Effect.gen(function* () {
  const response = yield* Effect.promise(() => fetch('https://example.com/data.xml'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = yield* XMLParser.make(options);

  while (true) {
    const { done, value } = yield* Effect.promise(() => reader.read());
    if (done) break;
    yield* parser.feed(decoder.decode(value, { stream: true }));
  }

  return yield* parser.end();
});

const result = await Effect.runPromise(program);
```

### Chunk boundaries

Chunks may split anywhere — mid tag-name, mid attribute value, mid CDATA. The parser buffers data internally and handles all split points correctly.

### Reusing a parser instance

`end()` closes the session. The next `feed()` opens a fresh one on the same parser, so a configured
parser can be reused across documents:

```javascript
const parser = Effect.runSync(XMLParser.make(options));

const r1 = Effect.runSync(
  Effect.gen(function* () {
    yield* parser.feed(xml1);
    return yield* parser.end();
  })
);

const r2 = Effect.runSync(
  Effect.gen(function* () {
    yield* parser.feed(xml2);
    return yield* parser.end();
  })
);
```

---

## `feedable` Options

```javascript
Effect.runSync(
  XMLParser.make({
    feedable: {
      maxBufferSize: 10 * 1024 * 1024, // 10 MB (default)
      autoFlush: true, // free processed chars automatically
      flushThreshold: 1024, // processed bytes that trigger a flush
      bufferSize: 256, // size of buffer to be used for parsing
    },
  })
);
```

Increase `maxBufferSize` only if a single XML token exceeds 10 MB.

Two diagnostics report what that configuration is actually doing, and both are effects that cannot
fail — `bufferSize` is only a starting threshold, it grows while the parser is stuck mid-token:

```javascript
const buffered = Effect.runSync(parser.getFeedBufferLength()); // number | null — null when no session is open
const threshold = Effect.runSync(parser.getFeedBatchThreshold()); // number — pending bytes before the next parse pass
```

---

## Memory Characteristics

**`parse(string|Buffer)`** — the whole document is in memory. Peak ≈ 2× document size.

**`feed()`/`end()`** — the full document accumulates in the buffer before `end()` triggers parsing. Equivalent to `parse()` memory-wise; the benefit is that _you_ control when chunks arrive.

**`parseStream()`** — the low-memory path. Each chunk is processed and freed before the next arrives. The output object still holds the complete result — for documents where even the output is too large, use a custom `OutputBuilder` that writes directly to a database and returns `null` from `getOutput()`.

---

## API Reference

### `parser.parseStream(readable): Effect<unknown, ParseError>`

Fails with `ParseError` (malformed XML / limit exceeded), with `INVALID_STREAM` if the argument is
not a Node.js Readable stream, or with the stream's own error.

### `parser.feed(data): Effect<XMLParser, ParseError>`

Yields the parser. Fails with `ParseError` code `DATA_MUST_BE_STRING` for non-string/Buffer input,
with `INVALID_INPUT` if `maxBufferSize` is exceeded, or with any real parse error in the accumulated
input.

### `parser.end(): Effect<unknown, ParseError>`

Fails with `ParseError` code `NOT_STREAMING` if called before any `feed()`.

### `parser.getParseErrors(): Effect<ParseErrorEntry[], never>`

Infallible. See [07-auto-close.md](./07-auto-close.md).

### `parser.getFeedBufferLength(): Effect<number | null, never>`

Infallible.

### `parser.getFeedBatchThreshold(): Effect<number, never>`

Infallible.

---

➡ Next: [07 — Auto-Close (Lenient HTML)](./07-auto-close.md)
