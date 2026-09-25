# 10 — TypeScript

`@endevops/flexible-xml-parser-effect` ships its own TypeScript definitions, emitted as `dist/index.d.mts` alongside the ESM build. No `@types` package is needed. The package is ESM only: there is no CommonJS build and no `.d.cts`.

---

## Basic Usage

```typescript
import XMLParser, { X2jOptions } from '@endevops/flexible-xml-parser-effect';

const options: X2jOptions = { skip: { attributes: false, nsPrefix: true }, nameFor: { cdata: '#cdata' }, limits: { maxNestedTags: 100 } };

const parser = new XMLParser(options);
const result = parser.parse('<root><tag>42</tag></root>');
```

---

## Key Exported Types

| Export               | Description                                         |
| -------------------- | --------------------------------------------------- |
| `XMLParser`          | The parser class (also the default export)          |
| `X2jOptions`         | Full options interface for `new XMLParser(options)` |
| `ParseError`         | Error class thrown on parse failures                |
| `ErrorCode`          | Const object with all error code strings            |
| `ErrorCodeValue`     | Union type of all error code values                 |
| `SkipOptions`        | Type for the `skip` option group                    |
| `NameForOptions`     | Type for the `nameFor` option group                 |
| `AttributeOptions`   | Type for the `attributes` option group              |
| `TagOptions`         | Type for the `tags` option group                    |
| `DoctypeOptions`     | Type for the `doctypeOptions` option group          |
| `LimitsOptions`      | Type for the `limits` option group                  |
| `FeedableOptions`    | Type for the `feedable` option group                |
| `AutoCloseInput`     | What `autoClose` accepts (see 07-auto-close.md)     |
| `AutoCloseOptions`   | Fully-resolved autoClose behaviour                  |
| `DecodingOptions`    | Type for the `decoding` option group                |
| `EncodingDecoder`    | Shape a custom decoder must satisfy                 |
| `EncodingDescriptor` | Descriptor for a custom encoding                    |
| `ExitIfPredicate`    | Type of the `exitIf` callback                       |
| `SkipTagEntry`       | Object form of a `skip.tags` entry                  |
| `StopNodeEntry`      | Object form of a `stopNodes` entry                  |
| `ParseErrorEntry`    | One recovery from `getParseErrors()`                |
| `Enclosure`          | `{ open: string; close: string }` pair              |
| `xmlEnclosures`      | Built-in XML enclosure array (comments + CDATA)     |
| `quoteEnclosures`    | Built-in quote enclosure array                      |

---

## Error Handling

```typescript
import XMLParser, { ParseError, ErrorCode } from '@endevops/flexible-xml-parser-effect';

const parser = new XMLParser({ limits: { maxNestedTags: 100 } });

try {
  parser.parse(xml);
} catch (e) {
  if (e instanceof ParseError) {
    // e.code is typed as ErrorCodeValue
    if (e.code === ErrorCode.LIMIT_MAX_NESTED_TAGS) {
      console.error('Document too deeply nested');
    } else {
      // e.index is a 0-based character offset, or undefined when the
      // parser had no position to report for this error
      console.error(e.code, e.message, `at index ${e.index ?? 'unknown'}`);
    }
  } else {
    throw e;
  }
}
```

`ParseError` reports positions as a single `index`, not `line` and `col`.

---

## Custom Output Builder

The `OutputBuilder` option is typed structurally, not as `BaseOutputBuilderFactory`. A builder is anything with a `getInstance()` returning an object carrying the ten methods below. Do not extend the published `BaseOutputBuilder`: it fails to compile with `TS2416` (its `addElement` is declared with one parameter while the parser calls it with two), and it fails at runtime too, because the shipped class implements none of `addElement`, `closeElement`, `addValue` or `getOutput`. Subclass `CompactBuilder` when you want the bundled object output, or implement the interface structurally when you do not.

```typescript
import XMLParser from '@endevops/flexible-xml-parser-effect';

class TagListBuilder {
  private tags: string[] = [];

  addElement(tag: { name: string }): void {
    this.tags.push(tag.name);
  }

  // The parser calls all ten. This builder only needs names, so the rest are empty.
  closeElement(): void {}
  addValue(): void {}
  addLiteral(): void {}
  addComment(): void {}
  addDeclaration(): void {}
  addInstruction(): void {}
  addInputEntities(): void {}
  addAttribute(): void {}

  getOutput(): string[] {
    return this.tags;
  }
}

class TagListFactory {
  getInstance(): TagListBuilder {
    return new TagListBuilder();
  }
}

const result = new XMLParser({ OutputBuilder: new TagListFactory() }).parse('<r><a><b/></a></r>');
// ['r', 'a', 'b']
```

`getInstance()` is called once per parse run, so each run gets a fresh builder. Its `parserOptions` and `readonlyMatcher` arguments are optional in your signature: a function that takes fewer parameters is assignable to one that takes more.

To reuse the bundled value-parser pipeline, extend `BaseValueParser` for your parsers and register them on the factory with `registerValueParser(name, parser)`. See [03 — Value Parsers](./03-value-parsers.md).

---

## Custom Value Parser

`BaseValueParser` and the `Context` class come from `@nodable/base-output-builder`. There is no `ElementType` enum and no `ValueParserContext` type: whether a value came from an attribute is a boolean on the context.

```typescript
import { BaseValueParser, type Context } from '@nodable/base-output-builder';

class UpperCaseParser extends BaseValueParser {
  override parse(val: unknown, context?: Context): unknown {
    if (context?.isAttribute) return val;
    return typeof val === 'string' ? val.toUpperCase() : val;
  }
}
```

---

## Module Format

The package is ESM only. `"type": "module"`, one build output, no CJS bundle:

- ESM (`import`): `exports` resolves to `dist/index.mjs`, types to `dist/index.d.mts`

There is no CommonJS entry point, so `require()` does not work. `main` and `types` are also declared, at the same paths, for resolvers that ignore `exports`.

No extra `tsconfig` configuration is needed for standard setups.

---

_This is the end of the documentation series._

← Back to [README](../README.md)
