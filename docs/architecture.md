# Architecture

`@endevops/effect-xml` is a pnpm workspace with two packages:

| Package                     | Role                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `packages/effect-xml-codec` | The one publishable package.                                               |
| `packages/benchmarks`       | Private; runs the `*.bench.ts` suites against each package's built output. |

Everything a consumer can reach ships from `@endevops/effect-xml-codec`, and
`src/index.ts` is its only entry point. The package absorbed the former
`@endevops/common-xml`; the former `@endevops/builder` and `@endevops/parser`
packages were dropped, leaving the codec's own text layer as the only one. No
sibling workspace dependency remains.

## Three layers

- **The codec.** `toCodecXml(schema)` returns a `Schema` whose `Type` is the
  source schema's and whose `Encoded` is XML text. Encoding and decoding are
  `Schema.encodeSync` / `Schema.decodeSync` (or the `Effect` forms); there is no
  value tree at the call site.
- **The text layer.** `renderXml(value)` turns an `XmlValue` into text and
  `parseXml(text)` reads one back. Both answer with an `Effect`. The codec is
  those two joined by Effect's `Schema.toCodecStringTree`.
- **The primitives.** The `EntityDecoder` (with its XML predefined-entity
  table) and the XML name validators moved in from the former `common-xml`.
  They are what the text layer reads a document with.

## Why the derivation is Effect's

`toCodecXml` does not walk the schema AST. It derives
`Schema.toCodecStringTree`, the same derivation `Schema.toEncoderXml` uses, and
runs the resulting tree through this package's renderer and parser. That
derivation makes structs, arrays, unions, records, recursion, refinements,
brands and transformations work without being re-implemented here. The
round-trip specs are the broadest in the suite for the same reason. The
derivation itself reaches into `SchemaAST` internals and is not reusable from
outside; see the note in [`AGENTS.md`](../AGENTS.md).

## The value model

`XmlValue` is `string | undefined | ReadonlyArray<XmlValue> | XmlRecord`. The
conventions live in the keys, not in the parser: an `@`-prefixed key is an
attribute, `#text` is character data, and every other key is a child element.
An array repeats its element once per member, and `undefined` writes nothing, so
an absent optional field stays distinguishable from an empty one.
`src/conventions.ts` owns the rules and `src/xml-value.ts` owns the model and its
guard.

## Namespaces

A schema describes a value in local names; a namespace is an annotation on the
node that owns the element, not part of the field name. Five annotations are
read from `Schema.annotations`: `xmlNamespace`, `xmlPrefix`, `xmlName`,
`xmlAttribute` and `xmlValue`. On encode, an element writes its declaration
where the prefix or default is not already in scope. On decode, every name
resolves to its URI against the document's own declarations, so the document's
choice of prefixes does not matter and the declaration attributes are dropped
from the value. `src/namespaces.ts` builds the plan once per codec; a local name
that belongs to two namespaces in one codec is rejected when the codec is built.

## Effect, functions and the one class

The public operations are functions rather than Effect services: `toCodecXml` is
a factory over a schema, and `renderXml` / `parseXml` have no shared authority
to provide. The walks inside them are plain synchronous recursive descent
wrapped in `Effect.suspend`, so there is no effect boundary per element or per
attribute; the failure the walk throws is folded into the typed error channel at
the boundary. `resolveName` is the effectful name resolver, for the `'error'`
mode that rejects a name rather than repairing it.

`EntityDecoder` is the one class. Its constructor is private and
`EntityDecoder.make(options)` is the factory, so a `null` options object is
refused through the error channel instead of thrown from a constructor, and
`decode` returns an `Effect`.

Failures are `Schema.TaggedError`: `XmlParseError` and `XmlRenderError` for the
two text directions, and `XmlError` for the decoder and the validators. A codec
decode folds a text failure into the `SchemaIssue.Issue` a schema is expected to
report, so `catchTag`, `retry` and a fallback all see it.

## Where the tests and benchmarks live

- Specs sit next to their sources as `src/**/*.spec.ts`, the absorbed
  primitives included.
- Benchmarks live in `packages/benchmarks/bench/` and drive the public entry
  point against the built `dist/`. `vp test` skips `*.bench.ts`;
  `pnpm build && vp run bench` runs them.

## Related

- [`README.md`](../README.md): the workspace and its commands.
- [`packages/effect-xml-codec/README.md`](../packages/effect-xml-codec/README.md):
  the package's API, mapping, performance and limitations.
- [`docs/versioning.md`](./versioning.md): the release flow.
