# Encoding support

FXP intelligently handles many different character encodings, not just UTF‑8.

## Quick usage

```js
import { Effect } from 'effect';
import XMLParser from '@endevops/parser';

// Everything returns an Effect, so reading a buffer is a two-step program:
// resolve the parser, then read the document.
const parseBytes = (options, buffer) =>
  Effect.gen(function* () {
    const parser = yield* XMLParser.make(options);
    return yield* parser.parseBytesArr(buffer);
  });

// Auto-detect (default) — sniffs a BOM or an <?xml ... encoding="..."?>
// declaration; falls back to UTF-8 if neither is present.
Effect.runSync(parseBytes(undefined, buffer));

// Explicit — skips detection entirely.
Effect.runSync(parseBytes({ decoding: { encoding: 'utf16le' } }, buffer));

// Custom encoding FXP doesn't ship natively (e.g. Shift_JIS via iconv-lite).
Effect.runSync(
  parseBytes(
    {
      decoding: {
        encoding: 'shift_jis',
        customDecoders: {
          shift_jis: {
            name: 'shift_jis',
            createDecoder: () => iconv.getDecoder('shift_jis'),
            selfSynchronizing: false, // see "Adding an encoding" below
          },
        },
      },
    },
    buffer
  )
);
```

Constructing a parser and parsing are separate effects — `make` resolves and validates the options,
`parseBytesArr` reads the document — which is why they compose rather than nest. The failures come
back as a `ParseError` on the same channel as any other parse; see
[01 — Getting Started](./01-getting-started.md).

## 1. Default Behaviour: Auto‑Detection

If you don’t specify anything, the parser figures out the encoding for you:

- It first looks for a **Byte Order Mark (BOM)** at the very beginning of the file/stream (e.g. `EF BB BF` for UTF‑8, `FF FE` for UTF‑16LE).
- If no BOM is found, it peeks at the first 200 bytes and tries to find an **XML declaration** like `<?xml version="1.0" encoding="UTF‑8"?>` and reads the `encoding` attribute.
- If neither exists, it falls back to **UTF‑8** (the XML spec default).

All of this happens automatically – you just call `.parse()` or `.parseBytesArr()` as usual.

```js
const parser = Effect.runSync(XMLParser.make());
const result = Effect.runSync(parser.parseBytesArr(buffer)); // auto‑detects
```

## 2. Explicitly Setting an Encoding

You can skip auto‑detection and tell the parser which encoding to use. This is useful when you already know the encoding or want to force a specific one.

```js
const parser = Effect.runSync(
  XMLParser.make({
    decoding: { encoding: 'utf16le' }, //'auto' (default)
  })
);
const result = Effect.runSync(parser.parseBytesArr(buffer));
```

The parser then uses that encoding directly – no BOM/declaration sniffing.

Supported built‑in encodings:  
`'utf8'`, `'ascii'`, `'latin1'` (also `'iso‑8859‑1'`), `'utf16le'`, `'utf16be'` (Node.js doesn’t have a native UTF‑16BE decoder, so FXP implements one by byte‑swapping).

## 3. Custom Encodings (e.g. Shift_JIS, GBK)

If you need an encoding not built in (like Japanese Shift_JIS), you can register a custom decoder. The decoder must follow Node’s `StringDecoder` interface – it has `write(buffer)` and `end()` methods.

You supply it via the `customDecoders` option, scoped to a single parser instance:

```js
import iconv from 'iconv-lite';

const parser = Effect.runSync(
  XMLParser.make({
    decoding: {
      encoding: 'shift_jis',
      customDecoders: {
        shift_jis: {
          name: 'shift_jis',
          createDecoder: () => iconv.getDecoder('shift_jis'),
          selfSynchronizing: false, // important – read below
        },
      },
    },
  })
);
```

The `selfSynchronizing` flag describes whether an ASCII delimiter byte can appear inside a multi‑byte character in this encoding. It is **descriptive metadata only** — every encoding is decoded before scanning regardless, so setting it wrong can no longer corrupt tag boundaries. It is kept on `EncodingDescriptor` because callers legitimately want to ask the question; the parser no longer branches on it.

## 4. How It Works Internally (Decode Once, Then Scan)

Byte input is decoded to a JavaScript string **once**, at the start of the parse, and all scanning runs over that string. This is the same algorithm the string input path uses, so there is one scanner, not two.

There was previously a byte‑scanning path for self‑synchronizing encodings (UTF‑8, ASCII, Latin‑1) that walked the raw bytes and decoded each token on demand. It was removed after measuring that it was **slower**, not faster: on a 4.5 MiB / 20k‑item catalog it took 889 ms against 751 ms for decode‑first, because avoiding one whole‑document decode required 2,537,787 individual `Buffer#toString(enc, i, j)` calls averaging 2.6 bytes each. Swapping those for a reused `TextDecoder` did not rescue it either — measured ~1.4x the cost of `Buffer#toString` on a 20‑byte read — so "keep the bytes and decode per token" has no fast version. `parseBytesArr` is now ~15% faster than it was.

For streaming input (`feed()`/`end()` or `parseStream()`), the parser buffers a small amount of raw bytes until it can determine the encoding, then decodes and continues. This ensures auto‑detection works even when the declaration is split across chunks.

## 5. Important Limitations & Caveats

- **BOM vs declared encoding mismatch** – If the BOM says UTF‑8 but the XML declaration says `encoding="UTF‑16"`, the parse fails with a `ParseError` carrying `ENCODING_MISMATCH`. It does not silently pick one – that would be ambiguous and error‑prone.
- **Streaming auto‑detection** – The parser may hold back up to ~200 bytes of the stream until it has enough to detect the encoding. This is usually fine, but for very small documents (shorter than that) it resolves at `end()`.
- **Custom encoders must be correctly implemented** – If your `createDecoder()` doesn’t return an object with `write` and `end`, `XMLParser.make` fails immediately with `INVALID_DECODER`, not later during parsing.
- **Input types** – The encoding features apply to `Uint8Array` / `Buffer` / any `ArrayBufferView` input. If you pass a JavaScript string already, no decoding is needed. `Buffer` is a `Uint8Array` subclass, so a `Buffer` is accepted everywhere a `Uint8Array` is, but the package itself never references the type — nothing here needs Node.
- **Custom decoders are your Node dependency** – The built‑in encodings are built on the global `TextDecoder`, which exists natively in Node _and_ in every modern browser, so the package runs unchanged in a browser. A `customDecoders` entry that reaches for e.g. `iconv-lite` or `node:string_decoder` reintroduces a Node dependency _of your own making_; that is a choice, and it is not the package's default.

---

## 6. Summary

| Aspect                       | What FXP does                                                           |
| ---------------------------- | ----------------------------------------------------------------------- |
| **Auto‑detect**              | BOM → XML declaration → UTF‑8                                           |
| **Explicit**                 | Set `decoding.encoding` to any supported/custom name                    |
| **Custom**                   | Register via `customDecoders` with a `StringDecoder`‑compatible factory |
| **Scanning**                 | Decode once, then character‑scan — one strategy for every encoding      |
| **Runtime deps**             | `Uint8Array` + global `TextDecoder`; no Node builtin is imported        |
| **Error/position reporting** | Index-only, a **character** offset for every input — no line/column     |
| **Conflict handling**        | BOM vs declared encoding mismatch → fails the parse                     |

You can use the parser with any encoding you need, and the complexity is hidden behind a clean API. The default “just works” behaviour for UTF‑8 remains unchanged, while power users can plug in any encoding.

---

Typed-array input to `parse()` is routed through the same encoding-aware
path as `parseBytesArr()` — it no longer does an unconditional UTF-8
decode before FXP ever sees it.

## Why this needed more than "pick a decoder"

FXP has three input sources, and they don't all work the same way underneath:

- **`StringSource`** — input is already a JS string. Nothing to decode.
- **`FeedableSource` / `StreamSource`** — bytes are decoded to a JS string
  incrementally (via the global `TextDecoder`) _before_ any scanning happens.
  All tag/attribute/text scanning already runs on decoded characters.
- **`BufferSource`** — decodes the whole document once in its constructor and
  then scans the resulting string, exactly like `StringSource`.

So this isn't just a decoder swap: getting it right is what lets the package
carry no Node dependency. The decoders are built on the global `TextDecoder`
rather than `node:string_decoder` (Node‑only, and bundling it for a browser
target fails outright because no browser polyfill is registered by default),
and the byte type is `Uint8Array` rather than `Buffer` — which works because
Node's `Buffer` _is_ a `Uint8Array` subclass, so `Uint8Array` is the strict
universal subset of what both runtimes accept.

`test/browser-compat.spec.ts` enforces this: it scans `src/` for any `node:`
import or `Buffer` reference and fails the build if one reappears.

## Architecture (`src/encoding/`)

```
encoding-registry.js       — descriptors (utf8/ascii/latin1/utf16le/utf16be by
                             default) + register()/resolve(), fail-fast validated
encoding-detector.js       — pure function: sniff(bytes, registry) -> {encoding, bomLength}
encoding-profile.js        — the one place that turns "which encoding" into a
                             resolved descriptor + scan strategy, for BufferSource
scan-strategy/
  char-scan-strategy.js      — the only strategy: character-indexed scanning on
                             the decoded string, used for every encoding
```

`BufferSource` never branches on an encoding name. At construction it's handed
a resolved `profile` (from `EncodingProfile.buildProfileForBuffer`) and does
`Object.assign(this, profile.scanStrategy)` once — every `readCh`/`readStr`/
`scanTagExpEnd`/etc. call afterward just runs whichever strategy was assigned,
with zero per-call overhead or branching.

`FeedableSource`/`StreamSource` don't use a scan strategy at all (they're
always decode-first) — they just need the right decoder, resolved the same way
via the registry, or via the auto-detect state machine described below.

## Auto-detection

Follows XML 1.0 Appendix F: check for a known BOM first; if none, ASCII-sniff
far enough to read `encoding="..."` out of a leading `<?xml ... ?>`
declaration; if neither, default to UTF-8. A BOM and a declared encoding that
disagree is a hard error (`ErrorCode.ENCODING_MISMATCH`), not silently
resolved one way.

- **`BufferSource`**: trivial — the whole buffer is available, so detection
  peeks the first ~200 bytes once.
- **`FeedableSource`/`StreamSource`**: can't decode immediately if `'auto'` is
  set — there may not be enough bytes yet to know the encoding. Raw
  (undecoded) bytes are buffered in `_sniffBuffer` until a BOM+enough bytes, a
  complete `<?xml ... ?>` declaration, or a 200-byte cap is reached, then
  detection resolves once, the real decoder is built, and the held bytes are
  decoded and handed off normally. A short document that never crosses the
  threshold resolves at `end()` instead.

## Position reporting (index-only)

FXP does not track line/column anywhere. Every source exposes a single
`startIndex`, and for every source it is a **character** offset. `errorPositionOf()`
in `util.js` just reads that field; there is no per-encoding correction step.

`BufferSource` used to report a _byte_ offset, because it scanned the raw
buffer and advanced by bytes. It now decodes first, so it reports a character
offset like everything else. That is a deliberate fix rather than a cosmetic
one: a byte offset into a UTF-8 document cannot be used to slice that document,
so a caller who pointed at the reported position landed mid-character. Byte
input now reports exactly what string input reports for the same document.

This used to be a two-counter system (`cols` counted in bytes, a second
`_charCol` counter maintained incrementally to correct it for multi-byte
UTF-8) with its own `PositionCorrector` module. It was removed because
nothing in the parser actually needs line/column — dropping the bookkeeping
that produced it, on every character and every bulk-read span, is a
straightforward speed win with no functional loss: a caller that wants
line/column can still derive it from `index` plus the original document
text.

## Adding a new encoding

```js
import EncodingRegistry, { defaultEncodingRegistry } from './src/encoding/encoding-registry.js';

defaultEncodingRegistry.register({
  name: 'shift_jis',
  selfSynchronizing: false, // see below — default and safe unless proven otherwise
  variableWidth: true,
  createDecoder: () => iconv.getDecoder('shift_jis'), // { write(buf)->str, end()->str }
});
```

or scoped to one `XMLParser` instance via `decoding.customDecoders` (shown
above) — this builds a private registry for that instance so it doesn't leak
into other `XMLParser`s in the same process.

`createDecoder()` must return an object shaped like Node's own
`StringDecoder`: `{ write(buf): string, end(): string }`. Validated at
registration time — a broken shape fails immediately
(`ErrorCode.INVALID_DECODER`), not on first use three parses later. On the
`decoding.customDecoders` path that failure arrives on `XMLParser.make`'s
error channel; on the registry path above it is thrown directly.

**`selfSynchronizing`**: descriptive metadata, retained because callers may want
to ask the question, but it no longer selects a read strategy. Every encoding
is decoded before scanning, so a wrong value here can no longer cause
`BufferSource` to misidentify tag/attribute boundaries.

## What this does _not_ cover yet

- `readPiExp()` (processing instructions) and `doc-type-reader.js` were
  investigated as a possible gap and found to already be encoding-safe: both
  only ever call `source.readCh()/.readChAt()/.canRead()`, never index the
  raw buffer directly. No changes were needed there. (A separate,
  encoding-_independent_ inconsistency in `canRead(n)`'s offset formula on
  `BufferSource`/`StringSource` — unrelated to this feature — has since been
  fixed; see the main project map's architecture notes.)
