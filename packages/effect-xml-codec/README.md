# @endevops/effect-xml-codec

A round-trip Effect Schema codec for XML. `toCodecXml(schema)` returns a
`Schema` whose `Encoded` is XML text, so `Schema.encodeSync` writes a document
and `Schema.decodeSync` reads one back, the way `Schema.toCodecJson` works for
JSON. There is no second call to a renderer or a parser at the call site.
`renderXml` and `parseXml` are the text layer underneath, and remain available
on their own.

```typescript
import { Schema } from 'effect';
import { toCodecXml } from '@endevops/effect-xml-codec';

const Book = Schema.Struct({ '@id': Schema.String, title: Schema.String, pages: Schema.Number, tag: Schema.Array(Schema.String) });

const codec = toCodecXml(Book, { rootName: 'book' });
const value = { '@id': '1', title: 'Dune', pages: 412, tag: ['sci-fi', 'classic'] };

Schema.encodeSync(codec)(value);
// => '<book id="1"><title>Dune</title><pages>412</pages><tag>sci-fi</tag><tag>classic</tag></book>'

Schema.decodeSync(codec)('<book id="1"><title>Dune</title><pages>412</pages><tag>sci-fi</tag><tag>classic</tag></book>');
// => { '@id': '1', title: 'Dune', pages: 412, tag: ['sci-fi', 'classic'] }
```

## Why this exists

Effect 4 ships `Schema.toEncoderXml`, and it is one-way: a value goes in, an XML
string comes out, and there is no way back. It also has no notion of an
attribute — a field named `@id` becomes an element called `<@id>` with its name
rewritten.

This package pairs Effect's own XML-value derivation, `Schema.toCodecStringTree`,
with a renderer and a parser, then wraps both in a codec whose encoded side is
the document text. The derivation is Effect's and stays Effect's; the codec adds
the text layer and the `@`/`#text` conventions.

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

## Namespaces

A schema describes a value in local names, so a namespace is an annotation on
the schema node that owns the element rather than part of the field name. Four
annotations, all accepted by `Schema.annotate`:

| Annotation     | Meaning                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| `xmlNamespace` | The element's namespace URI.                                                                  |
| `xmlPrefix`    | The wire prefix to write for it. Omit it to write the namespace as the default (`xmlns="…"`). |
| `xmlName`      | The wire local name, when it differs from the schema key.                                     |
| `xmlAttribute` | The field is an attribute, without the schema key carrying the `@` prefix.                    |

`xmlName` renames one node, element or attribute, without touching the schema's
own name. The prefix still comes from `xmlPrefix`, so the name is a local name
and must not contain a colon. On the root schema it also names the root element,
unless the `rootName` option is given.

`xmlAttribute` is for a schema whose keys stay plain names: the field is written
as an attribute instead of a child element, and read back to the same key. It
composes with `xmlName` and with a namespace, but a namespaced attribute still
needs a prefix, because a default namespace does not apply to attributes.

The annotation is attached with `Schema.annotate`:

```typescript
import { Schema } from 'effect';
import { toCodecXml } from '@endevops/effect-xml-codec';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const AUTH = 'urn:auth';

const Envelope = Schema.Struct({
  Header: Schema.Struct({ Token: Schema.String.annotate({ xmlNamespace: AUTH, xmlPrefix: 'auth' }) }).annotate({
    xmlNamespace: SOAP,
    xmlPrefix: 'soap',
  }),
  Body: Schema.Struct({ GetPrice: Schema.Struct({ item: Schema.String }).annotate({ xmlNamespace: 'urn:shop' }) }).annotate({
    xmlNamespace: SOAP,
    xmlPrefix: 'soap',
  }),
}).annotate({ xmlNamespace: SOAP, xmlPrefix: 'soap' });

const codec = toCodecXml(Envelope, { rootName: 'Envelope' });
const value = { Header: { Token: 'abc' }, Body: { GetPrice: { item: 'widget' } } };

Schema.encodeSync(codec)(value);
// => '<soap:Envelope xmlns:soap="…"><soap:Header><auth:Token xmlns:auth="urn:auth">abc</auth:Token></soap:Header><soap:Body><GetPrice xmlns="urn:shop"><item>widget</item></GetPrice></soap:Body></soap:Envelope>'

// A document that binds the same URI to another prefix decodes to the same value.
Schema.decodeSync(codec)(text.replaceAll('soap:', 's:').replace('xmlns:soap=', 'xmlns:s=')); // => value
```

The namespace of an element is inherited by its descendant elements, and an
attribute is in a namespace only when it is annotated itself, because a default
namespace does not apply to attributes. On encode, an element writes its
declaration where the prefix or default is not already in scope. On decode,
every name is resolved to its URI against the declarations the document
carries, so the document's choice of prefixes does not matter, and the
declaration attributes are dropped from the value.

Two limits:

- One local name can belong to only one namespace in one codec. Two fields with
  the same local name in different namespaces are rejected when the codec is
  built. Give them distinct local names.
- A root array cannot carry the root element's declaration, because `renderXml`
  wraps it in an element the codec does not build. Give the root a struct.

## API

| Export                           | What it does                                                    |
| -------------------------------- | --------------------------------------------------------------- |
| `toCodecXml(schema, options?)`   | The codec. A `Schema` whose `Encoded` is XML text.              |
| `renderXml(value, options?)`     | An XML value tree to XML text. Returns an `Effect`.             |
| `parseXml(text, options?)`       | XML text to an XML value tree. Returns an `Effect`.             |
| `escapeText` / `escapeAttribute` | The escaping the renderer applies.                              |
| `resolveName`                    | Name repair for a render or parse, from `@endevops/common-xml`. |
| `isXmlValue`                     | A runtime guard for the value model.                            |
| `XmlValueSchema`                 | A `Schema` for an `XmlValue`, for a value from outside.         |
| `XmlParseError`                  | The failure a malformed document reports.                       |
| `XmlRenderError`                 | The failure a value that cannot be written reports.             |

`toCodecXml` returns a `Schema`, so encoding and decoding are `Schema.encodeSync`
and `Schema.decodeSync` (or the `Effect` forms), and every other Schema operation
— `Schema.toFormatter`, `Schema.toJsonSchemaDocument`, the guards — applies to it
unchanged. A failure in either direction arrives as a `SchemaIssue.Issue`: a
document that will not parse or a value that will not write is reported with its
underlying XML message, alongside the schema mismatches Effect already reports.
The root element is named from the `rootName` option, then the schema's
`identifier` or `title` annotation, then `'root'`.

## Design notes

**The derivation is Effect's.** `toCodecXml` derives
`Schema.toCodecStringTree`, the same derivation `Schema.toEncoderXml` uses, and
runs it through this package's `renderXml` and `parseXml` on the two text
directions. That is what makes every schema feature Effect supports — structs,
arrays, unions, records, recursion, refinements, branded types, transformations —
work here without this package re-implementing the walk over a schema AST, and it
is what the round-trip specs are exercising.

**The shape is `toCodecJson`'s.** The value `toCodecXml` returns is a `Schema`:
`Type` is the source schema's `Type`, `Encoded` is XML text, the service
requirements are preserved, and it composes with the rest of Schema. There is no
wrapper object and no separate render or parse call at the call site. The two
text steps are still there underneath, and are exported on their own so a caller
that wants the value tree can take it: `renderXml` and `parseXml`. Both answer
with an `Effect`, so a value that will not write and a document that will not
read are typed failures, which the codec folds into the `SchemaIssue.Issue` a
schema is expected to report.

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
| a 300-byte document, encode | ~183k/sec  |
| a 300-byte document, decode | ~194k/sec  |
| a 500-row document, encode  | ~1,800/sec |
| a 500-row document, decode  | ~2,100/sec |
| 20,000 characters of text   | ~627k/sec  |

Three findings shaped the code, and all are measured rather than assumed:

- **Escaping was the whole cost of a large document.**
  `EntityEncoder` escapes by applying five sequential global replacements,
  one per character, so a document with a single `&` in twenty thousand
  characters was scanned five times over to change one byte — 58µs for that one
  document. Escaping is now a single pattern scan to find the first character
  that needs replacing, then one pass to build the result, which is 7.6x faster
  for clean text and 28x faster for text with a character in it.
  `src/render.spec.ts` compares the two implementations across every ASCII
  character so the fast path is checked against the library rather than trusted.
- **Resolving a name is a regex test, not an `Effect`.** The naming package's
  validators and the path matcher used to return `Effect`s for pure questions,
  which left the renderer and the parser running an effect per distinct element
  and attribute name in every document. Running a runtime to read a boolean cost
  roughly 1µs per name, and a small document has about a dozen names, so name
  resolution was most of what a serialize and a parse did. `@endevops/common-xml`
  now exposes plain synchronous predicates (`isQName` and the rest, `sanitize`)
  with no `Effect` wrapper, and the renderer's namer and the parser's name cache
  call them directly. `resolveName` is the one exception: it is effectful because
  `'error'` mode rejects an illegal name, and a rejection is a failure rather than
  a value, so it reports through the error channel like every other fallible step
  of a parse or a render. That is the bulk of the gain on a small
  document; the 500-row document improves by a few percent because it asks the
  same handful of names, and the per-row work is what dominates there.
- **The codec adds no layer of its own.** `toCodecXml` derives
  `Schema.toCodecStringTree` and runs the tree through `renderXml`, so a value is
  encoded by Effect's parser and then rendered, with nothing wrapped around
  either. Dropping the extra `Schema.toCodecArrayFromSingle` layer the codec used
  to carry is part of why the table above is higher than the numbers this README
  quoted before: the single-element-array leniency is the caller's to compose now,
  and the plain codec does not pay for it on every array.
- **A small document is dominated by something this package does not own.** Of
  the ~9µs it takes to serialize one, roughly 2.5µs is Effect's
  `toCodecStringTree` derivation, which walks the schema on every call, and the
  rest is this package's renderer. The renderer and parser underneath run at
  roughly 2.5µs and 2.5µs on a flat document. A caller serializing the same
  shape on every request should build the codec once and reuse it, which is what
  the API is shaped for.

The other things the benchmarks changed: one pass over a record's keys instead of
one per role a key can play, name resolution memoized per document rather than
per element, one object per parsed element instead of two, and the indent for
each depth built once per render rather than once per line.

### Tracing

`parseXml` opens a span named `XmlCodec.parseXml`, carrying the document length
as an attribute, so a slow parse in a trace can be attributed to the input that
caused it. It is the package's traced entry point; `renderXml` is an `Effect`
too but opens no span, and `toCodecXml` is a `Schema`, so tracing a schema
encode or decode is Effect's concern. Provide a `Tracer` to a program to collect
the span, as `src/tracing.spec.ts` does. The codec calls `parseXml` on the way
in, so the span is opened for a schema decode too. A failed parse is a typed
`XmlParseError` in the error channel, not a defect, so `catchTag`, `retry` and a
fallback all see it.

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
| a small order       | 166,919/s  | 15,170/s (0.09x)    | 216,148/s (1.29x)  |
| 500 rows            | 1,698/s    | 114/s (0.07x)       | 1,269/s (0.75x)    |
| one large text node | 584,358/s  | 72,922/s (0.12x)    | 254,355/s (0.44x)  |

**Decoding** — one document to the same value:

| Document            | This codec | `@endevops/flexible-xml-parser` | `fast-xml-parser` |
| ------------------- | ---------- | ------------------------------- | ----------------- |
| a small order       | 177,143/s  | 8,874/s (0.05x)                 | 64,492/s (0.36x)  |
| 500 rows            | 1,975/s    | 70/s (0.04x)                    | 486/s (0.25x)     |
| one large text node | 20,715/s   | 5,694/s (0.27x)                 | 8,209/s (0.40x)   |

**A full round trip**, which is the number an application actually pays. Neither
a builder nor a parser can do both halves, so the last two rows are each
ecosystem doing the same work with two libraries and hand-joining them:

| Path                                               | Throughput       |
| -------------------------------------------------- | ---------------- |
| this codec                                         | 81,335/s         |
| `@endevops` builder, then its parser               | 5,514/s (0.07x)  |
| npm `fast-xml-builder`, then npm `fast-xml-parser` | 47,562/s (0.58x) |

**The two forks are slower for one reason: they run an `Effect` per call.**
`@endevops/builder` and `@endevops/flexible-xml-parser` were refactored into
Effect services, so every `build` and `parse` allocates and runs a runtime
before it reaches the XML work. That is the whole gap — the fork trails upstream
by 14x to 29x on encoding and 7x to 28x on decoding, which is far more than the
module-runner overhead the benchmark's own notes allow for. It is a property of
those packages' architecture, not of maintaining the fork, and it is why this
codec, which reaches Effect's parser directly through `Schema.encodeSync` and
`Schema.decodeSync`, is the fastest row on both sides.

Four things to be straight about when reading those tables:

- **These are one machine's numbers, from one run.** The relative error is under
  2% on every row, but the machine's load moved between runs, so treat the
  ratios as the durable part and the absolute figures as a range.
- **This codec's decode does strictly more work.** It parses _and_ validates the
  result against the schema, coercing `"30"` to `30` and failing on a mismatch.
  The parsers only parse. On the 500-row document, parsing alone runs at
  2,984/s and the schema pass brings it to 1,975/s, so roughly a third of the
  decode time is validation the comparison rows do not pay.
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
`src/round-trip.spec.ts` that pins the behaviour, so none of them can change
quietly.

- **An empty element is ambiguous.** `<a/>` is empty character data, and there is
  no XML that says "an array with nothing in it" as against "a struct with no
  fields". An empty array of structs, an empty record, or a struct whose fields
  are all absent is written faithfully and cannot be read back. Reading it
  reports a schema failure rather than inventing a value. Settling it needs the
  schema at the field, which a plain `Schema` does not provide; a caller that
  knows the shape can map `''` to `{}` before decoding.
- **A one-member array is ambiguous.** `<a>x</a>` is one element, and it is
  equally a one-member array of that element; `<a id="1"><b>x</b></a>` is the
  same. Two or more members are unambiguous and do round-trip. A caller that
  wants the leniency composes Effect's `Schema.toCodecArrayFromSingle` on top of
  the codec, which reads a bare value back as an array of one.
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

## Commands

```bash
vp -C packages/effect-xml-codec check           # format, lint, type-check
vp -C packages/effect-xml-codec test            # the suite
vp -C packages/effect-xml-codec test bench      # the benchmarks
vp -C packages/effect-xml-codec pack            # build
```

## License

MIT. See [LICENSE](./LICENSE).
