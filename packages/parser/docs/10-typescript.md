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

| Export                                        | Description                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `XMLParser`                                   | The parser class (also the default export); build one with `XMLParser.make`      |
| `X2jOptions`                                  | Full options interface for `XMLParser.make(options)`                             |
| `ParseError`                                  | Union of the 33 reason classes, and the error in the `E` channel of every effect |
| `LimitMaxNestedTags`, `MismatchedCloseTag`, … | One named class per cause, each tagged with its `ErrorCode` value                |
| `isParseError`                                | `value is ParseError`. A union has no `instanceof`, so this is the substitute    |
| `ErrorCode`                                   | Const object with all error code strings                                         |
| `ErrorCodeValue`                              | Union type of all error code values                                              |
| `SkipOptions`                                 | Type for the `skip` option group                                                 |
| `NameForOptions`                              | Type for the `nameFor` option group                                              |
| `AttributeOptions`                            | Type for the `attributes` option group                                           |
| `TagOptions`                                  | Type for the `tags` option group                                                 |
| `DoctypeOptions`                              | Type for the `doctypeOptions` option group                                       |
| `LimitsOptions`                               | Type for the `limits` option group                                               |
| `FeedableOptions`                             | Type for the `feedable` option group                                             |
| `AutoCloseInput`                              | What `autoClose` accepts (see 07-auto-close.md)                                  |
| `AutoCloseOptions`                            | Fully-resolved autoClose behaviour                                               |
| `DecodingOptions`                             | Type for the `decoding` option group                                             |
| `EncodingDecoder`                             | Shape a custom decoder must satisfy                                              |
| `EncodingDescriptor`                          | Descriptor for a custom encoding                                                 |
| `ExitIfPredicate`                             | Type of the `exitIf` callback                                                    |
| `SkipTagEntry`                                | Object form of a `skip.tags` entry                                               |
| `StopNodeEntry`                               | Object form of a `stopNodes` entry                                               |
| `ParseErrorEntry`                             | One recovery from `getParseErrors()`                                             |
| `Enclosure`                                   | `{ open: string; close: string }` pair                                           |
| `xmlEnclosures`                               | Built-in XML enclosure array (comments + CDATA)                                  |
| `quoteEnclosures`                             | Built-in quote enclosure array                                                   |

---

## Error Handling

Every effect this package returns already has `ParseError` in its error channel, so there is no
`try` to catch: recovery is a combinator on the effect. Each of the 33 causes is its own class, so
`Effect.catchTag` names the one it can handle and re-fails everything else unchanged — which is why
the handler below needs no fallthrough branch and no `throw e`.

```typescript
import { Effect } from 'effect';
import XMLParser, { ErrorCode } from '@endevops/parser';

const parser = Effect.runSync(XMLParser.make({ limits: { maxNestedTags: 100 } }));

const result = parser.parse(xml).pipe(
  Effect.catchTag(ErrorCode.LIMIT_MAX_NESTED_TAGS, error => {
    console.error('Document too deeply nested');
    // The payload is the point: these are the two numbers, not a sentence to parse.
    console.error(`depth ${error.depth} exceeds the ceiling of ${error.limit}`);
    // error.index is a 0-based character offset, or undefined when the
    // parser had no position to report for this error
    return Effect.succeed(null);
  })
);
```

The handler gets the whole error, not a payload in a wrapper, so `error.message` and `error.index`
are in reach next to `error.depth` and `error.limit`. `ErrorCode.LIMIT_MAX_NESTED_TAGS` and the bare
string `'LIMIT_MAX_NESTED_TAGS'` are the same tag — a class is tagged with its code rather than with
its own name — so either compiles, and the `ErrorCode` member turns a typo into a compile error
instead of a handler that never fires.

`ParseError` reports positions as a single `index`, not `line` and `col`.

---

## The `ParseError` Channel

`ParseError` is the one type in the `E` channel of every effect this package returns — `parse`,
`parseBytesArr`, `parseStream`, `feed`, `end`, and `make` itself. Configuring a parser validates
options, refuses reserved property names and compiles every stop-node and skip-tag path expression,
so construction can fail on the same channel as parsing. There is no second error type to branch
on: a failure from `@endevops/common-xml` or `@endevops/builder` arrives as a `DependencyError`,
mapped in rather than unioned with the parser's own.

It is a **union of 33 classes**, one per cause, and it is exported as a type. A union has no value,
so `new ParseError(...)` and `instanceof ParseError` do not exist. Each class is a named export, so
a handler can name the failure it recovers from, and a test can build one.

### Why one class per cause

`@endevops/common-xml` and `@endevops/builder` keep one error class with a `reason` union, and that
is the right shape when the causes are facets of a single decision — a bad _configuration_ versus a
bad _document_. The parser's causes are not facets of one decision. A tripped limit is a rejection
the caller may honour and keep serving; a mismatched close tag is a document to hand back with an
error; a reserved option name is a bug in the caller's own configuration, and a program that
recovers from the first two while quietly renaming the third has shipped something wrong. Each of
those is a decision, and each decision wants a name of its own.

A class per cause buys three things a `reason` field cannot:

- **A class in a type position.** `error instanceof MismatchedCloseTag` is a real check, with no
  predicate and no string comparison.
- **`Effect.catchTag`, with the payload already narrowed.** The handler's parameter is a
  `LimitMaxNestedTags`, so `error.limit` and `error.depth` are typed fields. A refinement predicate
  over the union hands the handler the union instead, with the payload one `e is` away.
- **The payload on the class that owns it, where the compiler checks it.** The ceiling and the depth
  used to exist only inside the English sentence in `message`, so reading a number meant parsing
  prose. `LimitMaxNestedTags` now declares `limit: number` and `depth: number`, and a misspelled
  field is a compile error rather than a silent `undefined`.

It costs one thing, worth stating plainly: there is no class to construct for an arbitrary
`ParseError`, so there is no generic way to rebuild one with a new `message`. Adding context means
naming the cause — see [Adding context without losing the cause](#adding-context-without-losing-the-cause).

### The fields every class carries

| Field     | Type                  | Meaning                                                                                                                                                      |
| --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_tag`    | `ErrorCodeValue`      | Which of the 33 causes this is. This is what `Effect.catchTag` matches on.                                                                                   |
| `code`    | `ErrorCodeValue`      | An alias for `_tag`, kept for the `err.code === ErrorCode.X` comparisons that predate the classes.                                                           |
| `index`   | `number \| undefined` | 0-based offset from document start. `undefined` when the parser had no position — a rejected configuration, or a limit checked before the document was read. |
| `message` | `string`              | Human-readable text. Kept, and kept verbatim — it is part of the contract.                                                                                   |

`code` and `_tag` are two names for one value, which is usually a smell. Here the alias is the point:
it is the field most call sites already read, and it is a getter rather than a stored value, so the
two cannot drift apart.

`toString()` is the tag, the position, and the message, with no class name in front — the tag _is_
the identity now:

```
LIMIT_MAX_NESTED_TAGS at index 9: Nesting depth 4 exceeds limit of 3 (tag: 'd')
INVALID_INPUT: 'limits.maxNestedTags' must be a positive integer, got 0
```

### The class carries the payload

A cause is not just a label. It carries the numbers and names a handler needs, and it carries them
itself, so reading a ceiling or a mismatched tag name is a property access rather than prose
parsing.

| Class                        | Payload                 | Notes                                                                                                       |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LimitMaxNestedTags`         | `limit`, `depth`        | `depth` is the level that tripped it, so one level too deep is told apart from orders of magnitude too deep |
| `MismatchedCloseTag`         | `tag`, `expected?`      | `expected` is absent when the stack was empty, which is a different situation from a mismatch               |
| `IllegalCharacter`           | `charCode`, `in`        | `in` is `'content'` or `'attribute'`. The field is `charCode` because `code` is this class's own tag        |
| `LimitMaxAttributes`         | `limit`, `count`, `tag` | Which tag was refused, not just how many attributes                                                         |
| `InvalidInput`               | `option?`, `received?`  | `option` as a caller writes it: `'limits.maxNestedTags'`                                                    |
| `UnexpectedEnd`              | `reading?`              | What the reader was waiting for — a `'>'`, a `'</div>'`                                                     |
| `SecurityPrototypePollution` | `name`                  | The name that would have polluted `Object.prototype`                                                        |
| `SecurityRestrictedName`     | `name`, `kind`          | `kind` is `'tag'` or `'attribute'`, which are checked against different sets                                |
| `SecurityReservedOption`     | `option`, `value`       | No `index`: an option is refused before a document is read                                                  |
| `DependencyError`            | `package`, `cause`      | `cause` is the upstream message, verbatim                                                                   |

The rest group the same way: `actual` and `limit` for the four entity ceilings, `name` for every
check that refused a name, and `declared` / `actual` for an encoding that contradicts its own
declaration. Every class is a named export, so `new EntityMaxCount({ ... })` types itself in a test.

Causes with nothing to carry — a truncated document, a stream that is not a stream, an
`ALREADY_STREAMING` — carry only the four fields above, which is itself information: there is
nothing there to branch on.

```typescript
const error = ...; // a ParseError

switch (error._tag) {
  case 'LIMIT_MAX_NESTED_TAGS':
    return { depth: error.depth, ceiling: error.limit }; // both numbers, no parsing
  case 'MISMATCHED_CLOSE_TAG':
    return { got: error.tag, wanted: error.expected };
  case 'ILLEGAL_CHARACTER':
    return { code: error.charCode, where: error.in }; // 'content' | 'attribute'
  default:
    return { message: error.message };
}
```

A `switch` on `_tag` narrows the union, so each arm reads the payload of the class it matched. Write
all 33 cases and the `default` arm can be `const unhandled: never = error`, which then fails to
compile the moment a 34th cause is added — the completeness check the union gives for free.

The tag vocabulary is unchanged, one `ErrorCode` value per class. Coarsening them into "malformed
document" and "hostile document" would have been fewer cases, but each of these is a condition a
caller may treat differently, and `code` has been the public discriminant for this package's whole
life.

### Inspecting a failure

`Effect.result` turns the effect into a `Result<unknown, ParseError>`, which cannot fail, so there
is no `Exit` to unpack and no cast to write.

```typescript
import { Effect, Result } from 'effect';

const result = Effect.runSync(Effect.result(parser.parse('<a><b></a></b>')));

if (Result.isFailure(result)) {
  const error = result.failure; // ParseError
  console.error(error._tag, error.index, error.message);
  // MISMATCHED_CLOSE_TAG 10 Unexpected closing tag 'a' expecting 'b'
}
```

Note the asymmetry: `Effect.runSync` _throws_ a failed effect's error, while
`Effect.runSyncExit` hands the whole `Exit` back. For a parse that is expected to fail, use one of
those two rather than wrapping `runSync` in a `try` — or `Effect.runPromise(...).catch(...)` in
async code, which rejects with the error itself, not a wrapper around it.

### Asking whether a value is one of ours

`ParseError` is a union, so there is no `instanceof` to write for "is this a parser error at all".
`isParseError` is the substitute, and it is exported for exactly that. It checks the one thing every
member has — a `_tag` the union recognises — on a value that is an `Error`, so an object merely
shaped like one is refused:

```typescript
import { isParseError } from '@endevops/parser';

const describeUnknown = (value: unknown): string => {
  if (isParseError(value)) return `${value._tag} at ${value.index ?? 'unknown position'}`; // value is a ParseError
  return 'not a parser failure';
};

if (Result.isFailure(result)) describeUnknown(result.failure); // 'MISMATCHED_CLOSE_TAG at 10'
describeUnknown(new Error('x')); // 'not a parser failure'
describeUnknown({ _tag: 'LIMIT_MAX_NESTED_TAGS' }); // 'not a parser failure'
```

To test one specific cause, ask the class: `value instanceof MismatchedCloseTag`.

### Recovering from one cause

`Effect.catchTag` is the direct form: it names the tag, and the handler receives that class with its
payload already narrowed. A non-matching cause re-fails with itself, so a catch is a genuine partial
recovery rather than a catch-all.

```typescript
import { Effect } from 'effect';
import XMLParser, { ErrorCode } from '@endevops/parser';

const parser = Effect.runSync(XMLParser.make({ limits: { maxNestedTags: 3 } }));

// Refuse an over-deep document without discarding the rest of the program's work
const rejected = Effect.catchTag(parser.parse('<a><b><c><d>x</d></c></b></a>'), ErrorCode.LIMIT_MAX_NESTED_TAGS, error =>
  Effect.succeed({ rejected: true, atDepth: error.depth, ceiling: error.limit })
);
// { rejected: true, atDepth: 4, ceiling: 3 }
```

`Effect.catchTags` is the same thing for several at once, which is how a caller says "these are the
malformed-document family and everything else still fails":

```typescript
const lenient = Effect.catchTags(parser.parse('<a><b></c></b></a>'), {
  MISMATCHED_CLOSE_TAG: error => Effect.succeed({ truncated: true, got: error.tag }),
  UNEXPECTED_TRAILING_DATA: error => Effect.succeed({ truncated: true, after: error.index }),
});
// { truncated: true, got: 'c' }
```

`Effect.catchIf` takes a refinement instead, and it is the form to reach for when the test is a
predicate rather than a tag — "recover from any security failure", say. A guard can name the class
it matched, so the payload is still there:

```typescript
import { Effect } from 'effect';
import { SecurityPrototypePollution } from '@endevops/parser';

// Treat a prototype-polluting name as a rejected document, whatever else fails
const safe = Effect.catchIf(
  parser.parse('<__proto__>x</__proto__>'),
  (e): e is SecurityPrototypePollution => e instanceof SecurityPrototypePollution,
  e => Effect.succeed({ refused: e.name })
);
// { refused: '__proto__' }
```

When the recovery is itself a multi-step program, `Effect.matchEffect` is the readable form. It
takes `{ onFailure, onSuccess }`, and the `onFailure` branch re-fails anything it does not handle:

```typescript
import { Effect } from 'effect';
import { ErrorCode, type ParseError } from '@endevops/parser';

const lenient = Effect.matchEffect(parser.parse('<a><b></c></b></a>'), {
  onFailure: (e): Effect.Effect<unknown, ParseError> =>
    e._tag === ErrorCode.MISMATCHED_CLOSE_TAG ? Effect.succeed({ truncated: true }) : Effect.fail(e),
  onSuccess: value => Effect.succeed(value),
});
```

`Effect.catchReason` has no place in any of this. It recovers from a `reason` field on a single error
class, which is not a shape this package has any more.

### Adding context without losing the cause

Rewriting a `message` so a failure reads properly once it has crossed a service boundary now means
rebuilding the same class, which means naming the cause — that is the price of a union. Spread the
error to keep its payload, replace `message`, and the class comes out the other side unchanged:

```typescript
import { Effect } from 'effect';
import { MismatchedCloseTag } from '@endevops/parser';

const withContext = Effect.catchTag(parser.parse('<a><b></c></b></a>'), 'MISMATCHED_CLOSE_TAG', error =>
  Effect.fail(new MismatchedCloseTag({ ...error, message: `config.xml: ${error.message}` }))
);
// MismatchedCloseTag, message 'config.xml: Unexpected closing tag \'c\' expecting \'b\'',
// still carrying tag: 'c', expected: 'b' and index: 10
```

The context is added for the reader and the cause is not lost: what comes out is a
`MismatchedCloseTag`, with `tag`, `expected` and `index` as they were, and a `_tag` a downstream
`Effect.catchTag` still matches. For a cause a program does not know in advance, leave the message
alone and log `error.message` next to `error.index` — the class name is in `error.constructor.name`,
so nothing is lost by not rewriting it.

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
