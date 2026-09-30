# @endevops/effect-xml-codec

A round-trip Effect Schema codec for XML. Derives an XML representation from any
Effect schema, writes it, and reads it back.

```typescript
import { Schema } from 'effect';
import { toCodecXml } from '@endevops/effect-xml-codec';

const Book = Schema.Struct({ '@id': Schema.String, title: Schema.String, pages: Schema.Number, tag: Schema.Array(Schema.String) });

const book = toCodecXml(Book, { rootName: 'book' });

const value = { '@id': '1', title: 'Dune', pages: 412, tag: ['sci-fi', 'classic'] };

book.encodeTextSync(value);
// => '<book id="1"><title>Dune</title><pages>412</pages><tag>sci-fi</tag><tag>classic</tag></book>'

book.decodeTextSync(book.encodeTextSync(value));
// => { '@id': '1', title: 'Dune', pages: 412, tag: ['sci-fi', 'classic'] }
```

## Why this exists

Effect 4 ships `Schema.toEncoderXml`, and it is one-way: a value goes in, an XML
string comes out, and there is no way back. It also has no notion of an
attribute — a field named `@id` becomes an element called `<@id>` with its name
rewritten — and it renders through `Schema.toCodecStringTree`, which erases the
types it passes over, so a `number` field and a `string` field holding `"5"` are
indistinguishable in its output.

This package is the other half. It derives through the same
`Schema.toCodecStringTree` foundation, adds the attributes, and adds a parser, so
a document can be read back into the value that produced it.

## The mapping

An `XmlValue` is the plainest value that can hold a document — strings, arrays
and records. What gives it XML meaning is two key conventions:

| In the value            | In the document                       |
| ----------------------- | ------------------------------------- |
| a key starting with `@` | an attribute: `@xmlns` is `xmlns="…"` |
| the key `#text`         | the element's character data          |
| any other key           | a child element, named by the key     |
| an array                | the element repeated once per member  |
| a string                | character data                        |
| `undefined`             | nothing written at all                |

`@` is a good discriminator because it is not a legal XML name character, so an
`@`-prefixed key can never collide with an element name, and a field that _is_ a
legal element name is never mistaken for an attribute.

Two shapes are read from a document, and which one a field wants is the schema's
decision rather than the parser's:

- a text-only element reads as a bare string, so
  `Schema.Struct({ title: Schema.String })` matches `<title>Dune</title>`;
- an element that also carries attributes or children reads as a record, so
  `Schema.Struct({ '@id': Schema.String, '#text': Schema.String })` matches
  `<a id="1">hello</a>`.

## API

| Export                                    | What it does                                             |
| ----------------------------------------- | -------------------------------------------------------- |
| `toCodecXml(schema, options?)`            | Builds the codec. The entry point.                       |
| `renderXml(value, options?)`              | An `XmlValue` to XML text, with no schema.               |
| `parseXml(text, options?)`                | XML text to an `XmlValue`. Returns an `Effect`.          |
| `parseXmlSync(text, options?)`            | The same, throwing instead.                              |
| `parseXmlDocument(text, options?)`        | The same, keeping the root element's name.               |
| `escapeText` / `escapeAttribute`          | The escaping the renderer applies.                       |
| `resolveName`, `isValidName`              | Name validation and repair, from `@endevops/common-xml`. |
| `isXmlValue`, `isXmlRecord`, `isXmlArray` | Runtime guards for the value model.                      |
| `XmlValueSchema`                          | A `Schema` for an `XmlValue`, for a value from outside.  |
| `XmlParseError`, `XmlNameError`           | The two failures that are not schema mismatches.         |

A codec has eight methods — `encodeValue`, `decodeValue`, `encodeText`,
`decodeText` and a `…Sync` form of each. The text methods speak documents; the
value methods speak `XmlValue`, for when the document is stored elsewhere and a
parse or a render would be wasted. Every method also takes per-call option
overrides.

## Design notes

**The derivation is Effect's.** `toCodecXml` derives through
`Schema.toCodecStringTree`, the same foundation `Schema.toEncoderXml` uses. That
is what makes every schema feature Effect supports — structs, arrays, unions,
records, recursion, refinements, branded types, transformations — work here
without this package re-implementing the walk over a schema AST, and it is what
the round-trip specs are exercising.

**Why there is no `Schema.Codec` returned.** A derivation that produces a new
encoded representation needs `SchemaAST.replaceEncoding` and the per-node
`recur` walker, both of which are `/** @internal */` and stripped from Effect's
published type declarations; `./internal/*` is not on the package's export map.
The one public composition primitive, `Schema.decodeTo`, declares its
transformation getters as `To.Encoded → From.Type` and `From.Type →
To.Encoded` while its implementation runs them the other way round, so
composing two real codecs through it needs casts to use correctly. Both make a
schema object pinned to one release candidate in a way a serializer an
application depends on should not be. `XmlCodec` is a plain interface instead,
built entirely on public API, and every operation Effect itself exposes —
`Schema.encodeSync`, `decodeUnknownEffect` and the rest — is available on it.

**Escaping is XML's, not HTML's.** `EntityEncoder` from `@endevops/common-xml`
is used with `encodeAllNamed: false`. Its named tables are HTML's, and an HTML
name such as `&eacute;` is well-formed XML that no parser will resolve, so the
only names this package writes are the five XML predefines. A character reference
in an attribute value is still spelled as one where XML's whitespace
normalization would otherwise eat it: a literal newline in an attribute comes
back as a space unless it is written `&#10;`.

**Comments and processing instructions are markup, not data.** The parser skips
them, which is what `XMLBuilder` does by default. CDATA becomes character data,
since that is what it is.

## Performance

`bench/codec.bench.ts` measures this package alone, split by layer so the cost
of Effect's derivation and the cost of this package's renderer are told apart.
`bench/comparison.bench.ts` measures it against `@endevops/builder` and the
two parsers. Run both with `vp test bench packages/effect-xml-codec`.

| Benchmark                   | Throughput |
| --------------------------- | ---------- |
| a 300-byte document, encode | ~160k/sec  |
| a 300-byte document, decode | ~160k/sec  |
| a 500-row document, encode  | ~1,500/sec |
| a 500-row document, decode  | ~1,500/sec |
| 20,000 characters of text   | ~500k/sec  |

Two findings shaped the code, and both are measured rather than assumed:

- **Escaping was the whole cost of a large document.**
  `EntityEncoder` escapes by applying five sequential global replacements,
  one per character, so a document with a single `&` in twenty thousand
  characters was scanned five times over to change one byte — 58µs for that one
  document. Escaping is now a single pattern scan to find the first character
  that needs replacing, then one pass to build the result, which is 7.6x faster
  for clean text and 28x faster for text with a character in it.
  `test/render.spec.ts` compares the two implementations across every ASCII
  character so the fast path is checked against the library rather than trusted.
- **A small document is dominated by something this package does not own.** Of
  the ~6µs it takes to serialize one, the great majority is Effect's
  `toCodecStringTree` and `toCodecArrayFromSingle` derivation, which are
  memoized per schema but still walk the schema on every call. The renderer and
  parser underneath it run at roughly 1.5µs and 1.7µs. A caller serializing the
  same shape on every request should build the codec once and reuse it, which is
  what the API is shaped for.

The other things the benchmarks changed: one pass over a record's keys instead of
one per role a key can play, name resolution memoized per document rather than
per element, one object per parsed element instead of two, and the indent for
each depth built once per render rather than once per line.

### Tracing

Every `Effect` method opens a span named `XmlCodec.<method>`, carrying the
document length or the root name as an attribute, so a slow serialize in a trace
can be attributed to the input that caused it. `decodeText` nests the parser's
own `XmlCodec.parseXml` span, which is what lets a profile separate parsing from
schema validation — the split the benchmark notes above are worth reading
together with. Provide a `Tracer` to a program to collect them, as
`test/tracing.spec.ts` does. The `…Sync` forms are untraced on purpose: they
exist to skip the `Effect` machinery the spans live in. A failed parse is a
typed `XmlParseError` in the error channel, not a defect, so `catchTag`, `retry`
and a fallback all see it.

### Against the libraries in this workspace and on npm

`bench/comparison.bench.ts` measures the same object through this codec and
through four libraries — the two builders and the two parsers, fork and upstream
alike. The equivalence is established rather than assumed: with
`attributeNamePrefix: '@'`, **both builders produce byte-identical output to this
codec**, and the benchmark asserts it in `beforeAll`, so a change that breaks it
fails the suite instead of quietly comparing different work.

**Encoding** — one object to the same bytes:

| Document            | This codec | `@endevops/builder` | `fast-xml-builder` |
| ------------------- | ---------- | ------------------- | ------------------ |
| a small order       | 152,234/s  | 135,661/s (0.89x)   | 139,345/s (0.92x)  |
| 500 rows            | 1,402/s    | 922/s (0.66x)       | 841/s (0.60x)      |
| one large text node | 415,192/s  | 158,970/s (0.38x)   | 153,710/s (0.37x)  |

**Decoding** — one document to the same value:

| Document            | This codec | `@endevops/flexible-xml-parser` | `fast-xml-parser` |
| ------------------- | ---------- | ------------------------------- | ----------------- |
| a small order       | 142,934/s  | 57,065/s (0.40x)                | 39,836/s (0.28x)  |
| 500 rows            | 1,405/s    | 437/s (0.31x)                   | 309/s (0.22x)     |
| one large text node | 21,980/s   | 4,255/s (0.19x)                 | 5,178/s (0.24x)   |

**A full round trip**, which is the number an application actually pays. Neither
a builder nor a parser can do both halves, so the last two rows are each
ecosystem doing the same work with two libraries and hand-joining them:

| Path                                               | Throughput       |
| -------------------------------------------------- | ---------------- |
| this codec                                         | 70,729/s         |
| `@endevops` builder, then its parser               | 38,779/s (0.55x) |
| npm `fast-xml-builder`, then npm `fast-xml-parser` | 31,166/s (0.44x) |

**The fork has not cost anything in speed.** `@endevops/builder` and npm
`fast-xml-builder` are the same version of the same code, and every encode row is
within noise of the other — the fork measures 0.97x, 1.10x and 1.03x of upstream
across the three documents, which is the spread you get from measurement error
rather than a difference. On decoding the fork's parser is the faster of the two
on element-shaped documents (1.43x on the small order, 1.41x on 500 rows) and the
slower on the text-heavy one (0.82x), which is what its pluggable value-parser
pipeline costs and buys.

Four things to be straight about when reading those tables:

- **These are one machine's numbers, from one run.** The relative error is under
  2% on most rows, but the 500-row decode row for the fork reported 13% in the
  run these came from, so treat that one as a range rather than a figure.
- **This codec's decode does strictly more work.** It parses _and_ validates the
  result against the schema, coercing `"30"` to `30` and failing on a mismatch.
  The parsers only parse. On the 500-row document, parsing alone runs at
  2,205/s and the schema pass brings it to 1,372/s, so roughly 40% of the decode
  time is validation the comparison rows do not pay.
- **The parsers do work this codec does not.** They coerce tag values through a
  value-parser pipeline — entity decoding, whitespace normalizing, boolean and
  number parsing — where a schema already decided the type. Both sides have work
  the other lacks, and neither is idle.
- **Neither ecosystem is doing the whole job on its own.** A builder has no
  reader and a parser has no writer, so the round-trip table is the honest
  comparison and the single-direction tables are the diagnostic ones.

## Limitations

Each of these is a property of the format or of the underlying derivation rather
than something the codec can decide. Each has a spec in
`test/round-trip.spec.ts` that pins the behaviour, so none of them can change
quietly.

- **An empty element is ambiguous.** `<a/>` is empty character data, and there is
  no XML that says "an array with nothing in it" as against "a struct with no
  fields". A root-level struct is settled, because the schema is in hand there,
  but a nested one is not: an empty array of structs, or an empty record, is
  written faithfully and cannot be read back. Reading it reports a schema
  failure rather than inventing a value.
- **A one-member array of structs is ambiguous.** `<a id="1"><b>x</b></a>` is one
  element, and it is equally a one-member array of that element. Two or more
  members are unambiguous and do round-trip. A one-member array of _strings_ is
  fine, because `arrayFromSingle` — on by default, off with
  `arrayFromSingle: false` — reads a bare value back as an array of one.
- **A repaired name is a different name.** XML cannot spell `not a name`, so the
  renderer rewrites it and the document is well-formed. A schema that asks for
  the illegal name then has nothing to match, and reading it fails. A schema that
  uses the repaired name round-trips normally. Set `name: 'error'` to fail the
  render instead of rewriting.
- **Mixed content loses its order.** An element's `#text` is written before its
  children and read back as a single run, so `<p>a<b/>c</p>` reads as
  `{ b: '', '#text': 'ac' }`. Reading and re-rendering is stable from there on.
- **Whitespace at the edges of text is trimmed** unless `preserveWhitespace` is
  set. That is what makes a pretty-printed document read as the same value as an
  unindented one. Whitespace _inside_ a run is never touched.
- **`Schema.BigInt` is write-only.** Effect's `StringTree` derivation lowers one
  to its decimal text and has no way to raise it again.
- **The schema must need no services.** `toCodecXml` requires a service-free
  schema, because a synchronous serializer is meaningless if it may need a
  service to finish. A schema that needs one is rejected at the call.

## Commands

```bash
vp -C packages/effect-xml-codec check           # format, lint, type-check
vp -C packages/effect-xml-codec test            # the suite
vp -C packages/effect-xml-codec test bench      # the benchmarks
vp -C packages/effect-xml-codec pack            # build
```

## License

MIT. See [LICENSE](./LICENSE).
