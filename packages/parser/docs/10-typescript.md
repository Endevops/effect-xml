# 10 — TypeScript

`@endevops/parser` ships its own TypeScript definitions, emitted as `dist/index.d.mts` alongside the ESM build. No `@types` package is needed. The package is ESM only: there is no CommonJS build and no `.d.cts`.

---

## Basic Usage

```typescript
import { Effect } from 'effect';
import XMLParser, { type X2jOptions } from '@endevops/parser';

const options: X2jOptions = { skip: { attributes: false, nsPrefix: true }, nameFor: { cdata: '#cdata' }, limits: { maxNestedTags: 100 } };

const parser = Effect.runSync(XMLParser.make(options));
const result = Effect.runSync(parser.parse('<root><tag>42</tag></root>'));
// { root: { tag: 42 } }
```

`result` is `unknown`: the shape of a parsed document is only known at runtime, so the parser does
not pretend otherwise. Every entry point is an `Effect`, so `Effect.runSync` is only the shortest
way to see a value here — `Effect.runPromise`, or a runtime, is what real code should use.

There is no public `new XMLParser(...)`. A parser is configured rather than merely allocated, and
configuring one can fail, so `XMLParser.make` is the way in. The declared signatures:

| Member                                         | Type                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `XMLParser.make(options?)`                     | `Effect<XMLParser, ParseError>`                               |
| `parse(string \| Buffer \| ArrayBufferView)`   | `Effect<unknown, ParseError>`                                 |
| `parseBytesArr(Uint8Array \| ArrayBufferView)` | `Effect<unknown, ParseError>`                                 |
| `parseStream(readable)`                        | `Effect<unknown, ParseError>`                                 |
| `feed(string \| Buffer)`                       | `Effect<XMLParser, ParseError>` — yields the parser back      |
| `end()`                                        | `Effect<unknown, ParseError>`                                 |
| `getParseErrors()`                             | `Effect<ParseErrorEntry[], never>` — diagnostics, cannot fail |
| `getFeedBufferLength()`                        | `Effect<number \| null, never>`                               |
| `getFeedBatchThreshold()`                      | `Effect<number, never>`                                       |
| `wasExited`                                    | A field, not a method — still `parser.wasExited`              |

Only `ParseError` ever appears in the `E` channel, and the three diagnostics carry `never` because
they cannot fail. `feed` yields the parser rather than `void` so a chain of feeds composes.

---

## Key Exported Types

| Export               | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `XMLParser`          | The parser class (also the default export); build one with `XMLParser.make` |
| `X2jOptions`         | Full options interface for `XMLParser.make(options)`                        |
| `ParseError`         | The error in the `E` channel of every effect this package returns           |
| `ErrorCode`          | Const object with all error code strings                                    |
| `ErrorCodeValue`     | Union type of all error code values                                         |
| `SkipOptions`        | Type for the `skip` option group                                            |
| `NameForOptions`     | Type for the `nameFor` option group                                         |
| `AttributeOptions`   | Type for the `attributes` option group                                      |
| `TagOptions`         | Type for the `tags` option group                                            |
| `DoctypeOptions`     | Type for the `doctypeOptions` option group                                  |
| `LimitsOptions`      | Type for the `limits` option group                                          |
| `FeedableOptions`    | Type for the `feedable` option group                                        |
| `AutoCloseInput`     | What `autoClose` accepts (see 07-auto-close.md)                             |
| `AutoCloseOptions`   | Fully-resolved autoClose behaviour                                          |
| `DecodingOptions`    | Type for the `decoding` option group                                        |
| `EncodingDecoder`    | Shape a custom decoder must satisfy                                         |
| `EncodingDescriptor` | Descriptor for a custom encoding                                            |
| `ExitIfPredicate`    | Type of the `exitIf` callback                                               |
| `SkipTagEntry`       | Object form of a `skip.tags` entry                                          |
| `StopNodeEntry`      | Object form of a `stopNodes` entry                                          |
| `ParseErrorEntry`    | One recovery from `getParseErrors()`                                        |
| `Enclosure`          | `{ open: string; close: string }` pair                                      |
| `xmlEnclosures`      | Built-in XML enclosure array (comments + CDATA)                             |
| `quoteEnclosures`    | Built-in quote enclosure array                                              |

---

## Error Handling

Every effect this package returns already has `ParseError` in its error channel, so there is no
`instanceof` check to write and no `try` to catch: recovery is a combinator on the effect. The
`catchIf` below recovers the one code it can handle and re-fails everything else unchanged, which
is why there is no fallthrough branch and no `throw e`.

```typescript
import { Effect } from 'effect';
import XMLParser, { ErrorCode } from '@endevops/parser';

const parser = Effect.runSync(XMLParser.make({ limits: { maxNestedTags: 100 } }));

const result = parser.parse(xml).pipe(
  Effect.catchReason('ParseError', ErrorCode.LIMIT_MAX_NESTED_TAGS, reason => {
    console.error('Document too deeply nested');
    // The payload is the point: these are the two numbers, not a sentence to parse.
    console.error(`depth ${reason.depth} exceeds the ceiling of ${reason.limit}`);
    // reason.index is a 0-based character offset, or undefined when the
    // parser had no position to report for this error
    return Effect.succeed(null);
  })
);
```

`ParseError` reports positions as a single `index`, not `line` and `col`.

---

## The `ParseError` Channel

`ParseError` is the one type in the `E` channel of every effect this package returns — `parse`,
`parseBytesArr`, `parseStream`, `feed`, `end`, and `make` itself. Configuring a parser validates
options, refuses reserved property names and compiles every stop-node and skip-tag path expression,
so construction can fail on the same channel as parsing. There is no second error type to branch
on: failures from `@endevops/common-xml` and `@endevops/builder` are mapped in rather than unioned
with it.

| Field     | Type                  | Meaning                                                                                    |
| --------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `reason`  | `ParseErrorReason`    | The cause, as a tagged union. Its `_tag` is one of the `ErrorCode` values.                 |
| `index`   | `number \| undefined` | 0-based offset from document start. `undefined` when the parser had no position to report. |
| `message` | `string`              | Human-readable text. Kept, and kept verbatim — it is part of the contract.                 |
| `code`    | `ErrorCodeValue`      | An alias for `reason._tag`. The two cannot disagree; the alias is for existing call sites. |

### The reason carries the payload

`reason` is not just a label. It carries the numbers and names a handler needs, which used to exist
only inside the English sentence in `message` — so reading a ceiling or a mismatched tag name meant
parsing prose.

```typescript
const error = ...; // a ParseError

switch (error.reason._tag) {
  case 'LIMIT_MAX_NESTED_TAGS':
    return { depth: error.reason.depth, ceiling: error.reason.limit }; // both numbers, no parsing
  case 'MISMATCHED_CLOSE_TAG':
    return { got: error.reason.tag, wanted: error.reason.expected };
  case 'ILLEGAL_CHARACTER':
    return { code: error.reason.code, where: error.reason.in }; // 'content' | 'attribute'
  default:
    return { message: error.message };
}
```

Causes that have nothing to carry — a truncated document, a stream that is not a stream — have an
empty payload, which is itself information: there is nothing there to branch on.

The tag is one of the `ErrorCode` values, one for one. Coarsening them into "malformed document" and
"hostile document" would have been fewer cases, but each of these is a condition a caller may treat
differently, and `code` has been the public discriminant for this package's whole life.

### Inspecting a failure

`Effect.result` turns the effect into a `Result<unknown, ParseError>`, which cannot fail, so there
is no `Exit` to unpack and no cast to write.

```typescript
import { Effect, Result } from 'effect';

const result = Effect.runSync(Effect.result(parser.parse('<a><b></a></b>')));

if (Result.isFailure(result)) {
  const error = result.failure; // ParseError
  console.error(error.reason._tag, error.index, error.message);
  // MISMATCHED_CLOSE_TAG 10 Unexpected closing tag 'a' expecting 'b'
}
```

Note the asymmetry: `Effect.runSync` _throws_ a failed effect's error, while
`Effect.runSyncExit` hands the whole `Exit` back. For a parse that is expected to fail, use one of
those two rather than wrapping `runSync` in a `try` — or `Effect.runPromise(...).catch(...)` in
async code.

### Recovering from one reason

`Effect.catchReason` is the direct form: it names the cause, and the handler receives the payload
already narrowed. A non-matching reason re-fails with its original cause, so a catch is a genuine
partial recovery rather than a catch-all.

```typescript
import { Effect } from 'effect';
import { ErrorCode } from '@endevops/parser';

// Refuse an over-deep document without discarding the rest of the program's work
const rejected = Effect.catchReason(parser.parse(xml), 'ParseError', ErrorCode.LIMIT_MAX_NESTED_TAGS, reason =>
  Effect.succeed({ rejected: true, atDepth: reason.depth, ceiling: reason.limit })
);
```

`Effect.catchIf` takes a refinement instead, which is the form to reach for when the test is a
predicate rather than an equality — "recover from any security failure", say, rather than from one
named reason. `ParseError` carries a real `_tag` (`"ParseError"`), so `Effect.catchTag` works here
too; the `catchReason` above is preferred because it hands the handler the payload.

```typescript
import { Effect } from 'effect';
import { ErrorCode, type ParseError } from '@endevops/parser';

// Treat a mismatched closing tag as end-of-document rather than a failure
const lenient = Effect.catchIf(
  parser.parse(xml),
  (e): e is ParseError => e.reason._tag === ErrorCode.MISMATCHED_CLOSE_TAG,
  () => Effect.succeed({ truncated: true })
);
```

When the recovery is itself a multi-step program, `Effect.matchEffect` is the readable form. It
takes `{ onFailure, onSuccess }`, and the `onFailure` branch re-fails anything it does not handle:

```typescript
const lenient = Effect.matchEffect(parser.parse(xml), {
  onFailure: (e): Effect.Effect<unknown, ParseError> =>
    e.reason._tag === ErrorCode.MISMATCHED_CLOSE_TAG ? Effect.succeed({ truncated: true }) : Effect.fail(e),
  onSuccess: value => Effect.succeed(value),
});
```

### Adding context without losing the code

`Effect.mapError` keeps `reason` and `index` while rewriting the message, which is what makes a
failure report readable once it has crossed a service boundary. A `ParseError` is constructed from
its fields, and `reason` rides along unchanged — which is the point: the context is added for the
reader, and the cause is not lost.

```typescript
import { Effect } from 'effect';
import { ParseError } from '@endevops/parser';

const withContext = Effect.mapError(
  parser.parse(xml),
  e => new ParseError({ reason: e.reason, message: `config.xml: ${e.message}`, ...(e.index === undefined ? {} : { index: e.index }) })
);
```

`ParseError` is a value, not a type — importing it with `import type` and then constructing one is
a `TS1361`.

---

## Custom Output Builder

The `OutputBuilder` option is typed structurally, not as `BaseOutputBuilderFactory`. A builder is anything with a `getInstance()` returning an object carrying the ten methods below. Do not extend the published `BaseOutputBuilder`: it fails to compile with `TS2416` (its `addElement` is declared with one parameter while the parser calls it with two), and it fails at runtime too, because the shipped class implements none of `addElement`, `closeElement`, `addValue` or `getOutput`. Subclass `CompactBuilder` when you want the bundled object output, or implement the interface structurally when you do not.

```typescript
import { Effect } from 'effect';
import XMLParser from '@endevops/parser';

class TagListBuilder {
  private tags: string[] = [];

  addElement(tag: { name: string }): void {
    this.tags.push(tag.name);
  }

  // The parser calls all ten. This builder only needs names, so the rest are empty —
  // but the two that run the value-parser chain return an Effect, not a void.
  closeElement(): Effect.Effect<void> {
    return Effect.void;
  }
  addValue(): void {}
  addLiteral(): void {}
  addComment(): void {}
  addDeclaration(): void {}
  addInstruction(): void {}
  addInputEntities(): void {}
  addAttribute(): Effect.Effect<void> {
    return Effect.void;
  }

  getOutput(): string[] {
    return this.tags;
  }
}

class TagListFactory {
  getInstance(): Effect.Effect<TagListBuilder, never> {
    return Effect.succeed(new TagListBuilder());
  }
}

const parser = Effect.runSync(XMLParser.make({ OutputBuilder: new TagListFactory() }));
const result = Effect.runSync(parser.parse('<r><a><b/></a></r>'));
// ['r', 'a', 'b']
```

`getInstance()` returns an `Effect` because a builder can be refused at construction — a value-parser registration that is wrong, or a pattern that will not compile. It is called once per parse run, so each run gets a fresh builder; its `parserOptions` and `readonlyMatcher` arguments are optional in your signature, because a function that takes fewer parameters is assignable to one that takes more.

`closeElement` and `addAttribute` return effects because closing a tag is where the value-parser chain runs over everything underneath it, and that can fail. The parser runs both, and a failure surfaces as a `ParseError` on the `parse` call rather than as a second error type.

To reuse the bundled value-parser pipeline, extend `BaseValueParser` for your parsers and register them on the factory with `registerValueParser(name, parser)`. See [03 — Value Parsers](./03-value-parsers.md).

---

## Custom Value Parser

`BaseValueParser` and the `Context` class come from `@endevops/builder`. There is no `ElementType` enum and no `ValueParserContext` type: whether a value came from an attribute is a boolean on the context. `parse` returns an `Effect`, because a chain is a sequence of fallible transforms and one parser should be able to reject one value without failing the whole document.

```typescript
import { Effect } from 'effect';
import { BaseValueParser, type Context } from '@endevops/builder';

class UpperCaseParser extends BaseValueParser {
  override parse(val: unknown, context?: Context): Effect.Effect<unknown, never> {
    if (context?.isAttribute) return Effect.succeed(val);
    return Effect.succeed(typeof val === 'string' ? val.toUpperCase() : val);
  }
}
```

A parser that cannot fail declares `never` in the error position; returning `Effect.fail` puts a `BuilderError` in the chain, and the parser surfaces it as a `ParseError` with code `DEPENDENCY_ERROR`.

---

## Module Format

The package is ESM only. `"type": "module"`, one build output, no CJS bundle:

- ESM (`import`): `exports` resolves to `dist/index.mjs`, types to `dist/index.d.mts`

There is no CommonJS entry point, so `require()` does not work. `main` and `types` are also declared, at the same paths, for resolvers that ignore `exports`.

No extra `tsconfig` configuration is needed for standard setups.

---

_This is the end of the documentation series._

← Back to [README](../README.md)
