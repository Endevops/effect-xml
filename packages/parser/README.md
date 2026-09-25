# @endevops/flexible-xml-parser-effect

A fork of [`@nodable/flexible-xml-parser`](https://github.com/nodable/flexible-xml-parser), a high-performance XML parser in pure JavaScript with pluggable output builders, composable value parsers, and string, buffer, stream, and incremental feed input modes.

## This is a fork

This project is not the original parser. It started as a copy of `@nodable/flexible-xml-parser` at commit [`f51ecad5`](https://github.com/nodable/flexible-xml-parser/commit/f51ecad55027aebae1b89740479e9ec4cbdd6e0f) and is maintained separately by Endevops. The package name changed and the code is edited, so this repository is the place to file issues against the fork, not the upstream one.

Upstream released `@nodable/flexible-xml-parser` as the scoped successor to the unscoped `fast-xml-parser`, so the credit chain runs `fast-xml-parser` (Amit Gupta) to `@nodable/flexible-xml-parser` to this fork. The `flexible-xml-parser` name in this package name is inherited from upstream, not chosen here.

## What this fork changes

The parser behaviour is the same. The changes are in how the code is written and built.

| Change                                               | Why                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Every file and directory renamed to dash-case        | The upstream names were PascalCase and SCREAMING_CASE in the same tree |
| Static types across all of `src/`                    | Upstream shipped types only on the public entry points                 |
| Test suite and benchmark fully typed                 | The specs are now checked by the compiler, which surfaced real bugs    |
| Built with Vite+ (`vp pack`, `vp test`, `vp check`)  | Replaces the previous ad-hoc build setup                               |
| Latent bugs fixed in specs and entity handling       | Found while typing, listed in the commit history                       |
| Path matching and name validation are workspace pkgs | The `path-expression-matcher` type augmentations are gone; see below   |

Two known differences worth calling out: `test/compact-builder-force.spec.ts` and the `@nodable/entities` augmentation in `src/nodable-entities.d.ts` are fork-local, and the benchmark has no runner script yet.

### The `path-expression-matcher` augmentations are gone

The parser used to carry `src/path-expression-matcher.d.ts`, a module augmentation patching three things the published `index.d.ts` got wrong: the third `data` constructor argument it never declared, `findMatch()`'s non-nullable return, and the stale doc comments. It also exported a `ConfigurableExpressionCtor` alias, because the two-argument declaration made the parser's three-argument construction a `TS2554` at every call site.

All four are now real. `@endevops/path-expression-matcher` is generic over the expression payload, so `ExpressionSet<TagExpressionConfig>` carries the config type from construction through to `findMatch().data` with no cast and no augmentation — which is what let the file be deleted rather than trimmed.

`@nodable/base-output-builder` and `@nodable/compact-builder` still ship declarations that name the _upstream_ `path-expression-matcher` from npm. A pnpm `overrides` entry points that transitive dependency at the workspace package, so the tree holds one copy of the types rather than two structurally-identical-but-distinct ones; without it, every builder factory fails to satisfy the parser's structural contract. The remaining `src/nodable-builders.d.ts` augmentations are unrelated to this and still needed.

## Installation

The package is not published to npm. Clone the repository and link it into a consuming project, or point a pnpm `catalog:` entry at the local path.

```bash
pnpm install
pnpm build
```

Its runtime dependencies are `@nodable/base-output-builder` and `@nodable/compact-builder` from npm, plus the two workspace packages `@endevops/path-expression-matcher` and `@endevops/xml-naming`.

## Quick start

```javascript
import XMLParser from '@endevops/flexible-xml-parser-effect';

const parser = new XMLParser();
parser.parse('<root><count>3</count><active>true</active></root>');
// { root: { count: 3, active: true } }
```

Attributes are skipped by default. Turn them on to see them:

```javascript
const parser = new XMLParser({ skip: { attributes: false } });
parser.parse('<item id="1">hello</item>');
// { item: { '@_id': 1, '#text': 'hello' } }
```

## Input modes

```javascript
parser.parse('<root/>'); // string
parser.parse(Buffer.from('<root/>')); // buffer
parser.parseBytesArr(new Uint8Array([...])); // typed array
await parser.parseStream(fs.createReadStream('big.xml')); // Node.js readable

// Incremental feed
parser.feed('<root>');
parser.feed('<item>1</item>');
const result = parser.end();
```

## Options

Everything is optional.

```javascript
new XMLParser({
  skip: {
    // What to leave out of the output
    attributes: true, // Skip all attributes
    declaration: false, // Skip <?xml ...?>
    pi: false, // Skip processing instructions
    cdata: false, // Leave CDATA out of the output
    comment: false, // Leave comments out of the output
    nsPrefix: false, // Strip namespace prefixes
    tags: [], // Tag paths to drop from the output
  },
  nameFor: {
    // Property names for special nodes
    text: '#text', // Mixed-content text property
    cdata: '', // '' merges into text, '#cdata' gets its own key
    comment: '', // '' omits, '#comment' captures
  },
  attributes: {
    // Attribute representation
    prefix: '@_',
    suffix: '',
    groupBy: '', // Group attributes under one key, '' keeps them inline
    booleanType: false, // Allow valueless attributes, read as true
  },
  tags: {
    unpaired: [], // Self-closing tags written without a slash
    stopNodes: [], // Paths whose content is captured raw
  },
  limits: { maxNestedTags: null, maxAttributesPerTag: null },
  doctypeOptions: { enabled: false, maxEntityCount: 100, maxEntitySize: 10000 },
  strictReservedNames: false,
  exitIf: null,
  feedable: { maxBufferSize: 10 * 1024 * 1024, autoFlush: true, flushThreshold: 1024 },
  autoClose: null, // null is strict, 'html' recovers and collects errors
  OutputBuilder: null, // Defaults to CompactBuilder
});
```

## Value parsers

Value parsing belongs to the output builder, so tag text and attribute values get independent chains.

```javascript
import { CompactBuilderFactory } from '@nodable/compact-builder';

const builder = new CompactBuilderFactory({
  tags: { valueParsers: ['entity', 'boolean', 'number'] },
  attributes: { valueParsers: ['entity', 'number', 'boolean'] },
});

const parser = new XMLParser({ OutputBuilder: builder });
```

## Documentation

The docs are inherited from upstream. Their install and import snippets name this package; the option reference and the internals notes still describe upstream behaviour in upstream's terms, so check a snippet against [10 — TypeScript](./docs/10-typescript.md) if it disagrees with your editor.

| File                                                           | Topic                                            |
| -------------------------------------------------------------- | ------------------------------------------------ |
| [`docs/01-getting-started.md`](./docs/01-getting-started.md)   | Installation, first parse, common patterns       |
| [`docs/02-options.md`](./docs/02-options.md)                   | Full options reference                           |
| [`docs/03-value-parsers.md`](./docs/03-value-parsers.md)       | Value parser pipeline, built-ins, custom parsers |
| [`docs/04-stop-nodes.md`](./docs/04-stop-nodes.md)             | Stop nodes and skip tags                         |
| [`docs/05-output-builders.md`](./docs/05-output-builders.md)   | Built-in and custom output builders              |
| [`docs/06-streaming.md`](./docs/06-streaming.md)               | Stream, feed and end, memory behaviour           |
| [`docs/07-auto-close.md`](./docs/07-auto-close.md)             | Lenient HTML parsing and error collection        |
| [`docs/08-security.md`](./docs/08-security.md)                 | DoS limits and prototype pollution               |
| [`docs/09-path-expressions.md`](./docs/09-path-expressions.md) | Path expression syntax                           |
| [`docs/10-typescript.md`](./docs/10-typescript.md)             | TypeScript usage and type definitions            |
| [`docs/16-encoding.md`](./docs/16-encoding.md)                 | Encoding detection and decoding                  |

## Thanks

This parser exists because [Amit Gupta](https://solothought.com) wrote [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) and then [`@nodable/flexible-xml-parser`](https://github.com/nodable/flexible-xml-parser). The tag scanning, attribute handling, value coercion, stop nodes, streaming design, and the output builder split that makes this parser configurable are all his work. The MIT license he chose for both packages is what makes this fork possible.

Thanks also to everyone who has reported a bug, sent a pull request, or answered an issue on either repository. A fork only stays useful when the original keeps moving, and that is mostly thanks to the people who keep sending it fixes.

This fork exists because of that work, and the same MIT terms apply to it.

## License

MIT, the same as upstream. See [`LICENSE`](./LICENSE) for the full text. The copyright notices for Amit Gupta (2026, `@nodable/flexible-xml-parser`) and Amit Kumar Gupta (2017, `fast-xml-parser`) are retained there alongside the fork's own, as the MIT terms require.
