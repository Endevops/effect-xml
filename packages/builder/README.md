# @endevops/builder

[![license](https://img.shields.io/npm/l/@endevops/builder.svg)](./LICENSE)

Everything that turns one JavaScript value into another XML-shaped one.

| Section                                     | Direction           | Exports                                                                                       |
| ------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| [XML builder](#xml-builder)                 | object → XML string | `XMLBuilder` (the default export) and the option types                                        |
| [Output builder base](#output-builder-base) | parser → your shape | `BaseOutputBuilder`, `BaseOutputBuilderFactory`, the value-parser pipeline and its primitives |
| [Compact builder](#compact-builder)         | XML → object        | `CompactBuilder`, `CompactBuilderFactory` and the shape options that decide string vs array   |

```bash
npm install @endevops/builder
```

```typescript
import XMLBuilder, { CompactBuilderFactory } from '@endevops/builder';
import XMLParser from '@endevops/parser';

// object -> XML string
new XMLBuilder({ ignoreAttributes: false }).build({ a: { '@_id': '1', '#text': 'hello' } }); // '<a id="1">hello</a>'

// XML -> minimal object, through the parser that drives the builder
new XMLParser({ OutputBuilder: new CompactBuilderFactory() }).parse('<root><item>a</item></root>');
// { root: { item: 'a' } }
```

## Why these three are one package

They were published separately as `@endevops/xml-builder`,
`@endevops/base-output-builder` and `@endevops/compact-builder`. The second and
third are the base and the default implementation of the same parser output API,
so writing one output builder meant installing two packages to do it, and
depending on the parser meant depending on both. The first runs the opposite
direction, but shares the path-matching and name-validation options the other two
are configured with, so it travelled with them.

`XMLBuilder` is the default export, because that is what this package is named
for. `BaseOutputBuilder` and `CompactBuilderFactory` were the default exports of
the packages they came from; they are named exports here, because one module can
only have one default.

The source is split into `src/xml-builder/`, `src/output-builder/` and
`src/compact-builder/`, each with its own barrel, and the specs sit under the
matching `test/` subdirectory. All three are re-exported flat from the package
root; nothing is exposed per-area at the package boundary.

---

## XML builder

Build XML from JSON

XML Builder was part of [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) for years. But considering that any bug in the parser may false-alarm users who are only using the builder, we have decided to split it into a separate package.

### This is a fork

This project is not the original package. It started as a copy of [`fast-xml-builder`](https://github.com/NaturalIntelligence/fast-xml-builder) and is maintained separately by Endevops. The name changed to `@endevops/xml-builder` — dropping the `fast-` claim, which measured something this package does not assert — and the code was rewritten in TypeScript, so this repository is the place to file issues against the fork, not the upstream one.

Output is unchanged. What changed is how the code is written, typed and tested:

| Change                                                                                             | Why                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plain JavaScript with a hand-written `fxb.d.ts`                                                    | Types now come from the implementations that enforce them                                                                                                                      |
| The `MatcherView` class in the old `.d.ts` is gone                                                 | It was a hand-copied duplicate of the one `path-expression-matcher` exports, so it could drift from the real thing. `SanitizeNameContext.matcher` now references the real type |
| The old `.d.ts` declared `stopNodes` as `Expression[]` where `Expression` was aliased to `unknown` | It accepted anything. It is now `(string \| Expression)[]`, the two forms the builder actually reads                                                                           |
| The old `.d.ts` declared `ignoreAttributes`' callback as returning `boolean`                       | The array form's implementation returns `undefined` for a non-match, which is falsy but not a boolean. It is now typed to match                                                |
| The old `.d.ts` declared the constructor callable without `new`                                    | The runtime threw `TypeError: Cannot set properties of undefined`. It is a class now, so the call form still throws — with a clearer message                                   |
| Source files renamed to dash-case                                                                  | Matches the rest of the workspace                                                                                                                                              |
| Test suite moved from jasmine to vitest                                                            | Same tests, same expectations, 136 of them                                                                                                                                     |
| ESM only                                                                                           | Matches the rest of the workspace; the CJS/webpack build is gone                                                                                                               |

Behaviour is verified independently of the suite: 37 option sets against 45 object inputs, 18 ordered-form inputs, top-level arrays, degenerate roots, the `maxNestedTags` boundary at five depths, and the `sanitizeName` and `ignoreAttributes` callback contracts — 1,783 comparisons against the original build, all identical.

One regression the port introduced and the suite caught: on the `preserveOrder` path, `replaceEntitiesValue` was returning a stringified value, so a boolean `true` attribute no longer satisfied the `=== true` check and `suppressBooleanAttributes` stopped firing. The original returned the boolean untouched. Restored, and the two `pi` specs that cover it pass again.

License keeps the upstream MIT copyright notice; package metadata moves to Endevops.

### Installation

```bash
npm install @endevops/builder
```

### Usage

```javascript
import { XMLBuilder } from '@endevops/builder';

const builder = new XMLBuilder();
const xml = builder.build({ name: 'value' });
```

It fully supports the response generated by fast-xml-parser, and by [`@endevops/parser`](../parser) with `preserveOrder`. You can use options like `preserveOrder`, `ignoreAttributes`, `attributeNamePrefix`, `textNodeName`, `cdataPropName`, `commentPropName`, `format`, `indentBy`, `suppressEmptyNode`, `suppressUnpairedNode`, `stopNodes`, `oneListGroup`, `maxNestedTags`, and many more.

### Default Options

```js
{
  attributeNamePrefix: '@_',
  attributesGroupName: false,
  textNodeName: '#text',
  ignoreAttributes: true,
  cdataPropName: false,
  commentPropName: false,
  format: false,
  indentBy: '  ',
  suppressEmptyNode: false,
  suppressUnpairedNode: true,
  suppressBooleanAttributes: true,
  preserveOrder: false,
  processEntities: true,
  unpairedTags: [],
  stopNodes: [],
  oneListGroup: false,
  maxNestedTags: 100,
  jPath: true,
  tagValueProcessor: (key, val) => val,
  attributeValueProcessor: (attrName, val) => val,
}
```

### Options Reference

Check [Options reference](docs/Builder_v1.md) for more detail and examples.

- **arrayNodeName**: When building XML from an array, set `arrayNodeName` to wrap each element in a tag name.
- **attributeNamePrefix**: Prefix used to identify attribute properties in the JS object. Default: `'@_'`.
- **attributesGroupName**: Group name for attributes in the JS object. When set, all attributes are expected to be nested under this key. Not supported with `preserveOrder: true`.
- **attributeValueProcessor**: Customize how attribute values are serialized. Receives the attribute name and value.
- **cdataPropName**: Property name that identifies CDATA content. Values under this key are wrapped in `<![CDATA[...]]>`.
- **commentPropName**: Property name that identifies comment content. Values under this key are rendered as `<!-- ... -->`.
- **format**: By default, output is a single-line XML string. Set `format: true` for human-readable, indented output.
- **ignoreAttributes**: By default (`true`), attributes are skipped. Set to `false` to include them. Also supports selective ignoring via an array of strings, array of regular expressions, or a callback function.
- **indentBy**: String used for each level of indentation. Default: `'  '` (two spaces). Only applies when `format: true`.
- **maxNestedTags**: Limits the maximum depth of nested tags. An error is thrown if this depth is exceeded. Default: `100`.
- **oneListGroup**: Groups all repeated child tags under a single parent tag.
- **preserveOrder**: When a JS object was produced by XMLParser with `preserveOrder: true`, pass the same option to XMLBuilder to reconstruct the original XML correctly.
- **processEntities**: When `true` (default), special characters in text and attribute values are replaced with XML entities (`&amp;`, `&lt;`, etc.). Set to `false` for a performance boost when you know your content has no entities. Note: quotes in attribute values are always escaped regardless of this setting.
- **stopNodes**: Tags listed here are treated as raw content containers — their text content is written as-is without entity encoding. Accepts an array of tag name strings or `Expression` instances from `path-expression-matcher`. The old `*.tagName` wildcard syntax is still accepted and automatically converted to the equivalent `..tagName` deep-wildcard syntax.
- **suppressBooleanAttributes**: When `true` (default), attributes with the value `true` are rendered without the value (e.g. `<tag attr>` instead of `<tag attr="true">`).
- **suppressEmptyNode**: When `true`, tags with no text value are rendered as self-closing (`<tag/>`).
- **suppressUnpairedNode**: When `true` (default), unpaired tags are rendered without a closing slash (`<br>`). When `false`, they are rendered as `<br/>`.
- **tagValueProcessor**: Customize how tag text values are serialized. Receives the tag name and value.
- **textNodeName**: Property name representing the text content of a tag in the JS object. Default: `'#text'`.
- **unpairedTags**: List of tag names that have no matching closing tag (e.g. `<br>` in HTML).

---

## Output builder base

Base classes and value-parsing primitives for XML parser output builders.

Every output builder — `CompactBuilder` in this package, and the unported
`@nodable/sequential-builder` and friends — extends `BaseOutputBuilder` and
`BaseOutputBuilderFactory` from here.

### This is a fork

This project is not the original package. It started as a copy of [`@nodable/base-output-builder`](https://github.com/nodable/flexible-output-builders) and is maintained separately by Endevops. The name changed and the code was rewritten in TypeScript, so this repository is the place to file issues against the fork, not the upstream one.

Behaviour is unchanged. What changed is how the code is written and tested:

| Change                                                | Why                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain JavaScript with a hand-written `index.d.ts`     | Types now come from the implementation that enforces them. Upstream's declared `getOutput()` did not exist on the runtime class, so calling it on a bare `BaseOutputBuilder` threw `TypeError`; it exists now |
| `NumberValueParser` options are typed                 | `strnum` shipped no types, so the old declaration said `options?: any`. The options are now a real interface                                                                                                  |
| `EntityDecoder` is declared as a named export         | `@nodable/entities@2.x` declares it as the _default_ export while the runtime exports it by name — the declaration is the inverse of reality (see `src/nodable-entities.d.ts`)                                |
| Internal class names match their export names         | Upstream's `boolParser`, `trimmer`, `numParser` and `EntityParser` were exported as `BooleanParser`, `Trim`, `NumberValueParser` and `EntitiesValueParser`                                                    |
| `ValueParserRegistryLike` added                       | The pipeline depended on the whole registry class; it now depends on the two methods it actually calls, so a test or embedder can supply its own                                                              |
| `is-unsafe` replaced by `src/security/xml-unsafe.ts`  | One dependency fewer, and the XML rules are now this repository's to read and to test. See the note below                                                                                                     |
| `strnum` replaced by `src/value-parsers/to-number.ts` | One dependency fewer, and `toNumber` is now typed rather than `options?: any`. See the note below                                                                                                             |
| `decimalPoint` option dropped                         | It was declared and documented but never read — by `strnum` too. A documented no-op is worse than an absent option                                                                                            |
| Test suite written from scratch, 293 cases            | Every upstream `test` script was `echo "Error: no test specified" && exit 1` — none of these packages had ever had a working test command                                                                     |
| Source files renamed to dash-case                     | Matches the rest of the workspace                                                                                                                                                                             |
| ESM only                                              | Matches the rest of the workspace                                                                                                                                                                             |

Two upstream behaviours are preserved deliberately, because both are reachable and changing them would be a breaking change rather than a fix:

- `ValueParserPipeline.run()` has an `if (parser)` guard that reads as though an unresolvable parser name is skipped. It is not: the constructor's `_initAll` resolves every name through `registry.get()`, which throws. So a typo in a chain fails loudly when the pipeline is built.
- `NumberValueParser`'s guard is `typeof converted !== val`, which compares a type name against a value and is therefore always true. With `IS_FINAL` set, the parser ends the chain even for input it did not convert. Both behaviours are asserted in the specs so they read as decisions.

### The XML unsafe-value rules

`EntitiesValueParser` refuses to expand a DOCTYPE-declared entity when the entity's value looks like it would subvert an XML parser. That check
used to be `isUnsafe(value, [VALID_CONTEXTS.XML])` from `is-unsafe`, and it is now `isUnsafeXml(value)` from `src/security/xml-unsafe.ts`.

The port is verbatim for the XML context: all twelve rules, same ids, same regexes, same order, same first-match-wins behaviour. Verified against the
dependency over 112 assertions covering every rule id, near-misses that must not trip, realistic entity bodies and statelessness, asserting the same
verdict, the same rule id and the same matched span every time. The dependency's MIT licence is kept at `LICENSE-is-unsafe`.

Only the XML context came across. `is-unsafe` ships nine; the other eight are patterns for strings heading into HTML, SQL, a shell or a log, and no
code path in this repository can reach them. Nine untested rules inside a security control would be worse than not carrying them, so if one is ever
needed it should be added with its own tests.

Two things changed on the way in, both deliberate:

- **`whyUnsafeXml` and `allUnsafeXml` are new, and exported.** The old call site threw the reason away, which left a refused entity impossible to
  diagnose without reimplementing the rules. A caller writing a custom `onInputEntity` can now ask which rule fired and on what span.
- **A non-string throws rather than being coerced.** `String(null)` is `'null'`, which no rule flags, so a silent coercion would let an unexpected
  value skip the check entirely.

Verified independently of the suite: 1,846 assertions comparing this build against the original JavaScript over every parser, option set, chain order, registry guard, throw site and comment/CDATA policy combination — identical apart from five documented differences (the class renames, and `getOutput`).

License keeps the upstream MIT copyright notice; package metadata moves to Endevops.

### Installation

```bash
npm install @endevops/builder
```

---

### Value Parser Pipeline

Value parsers transform text extracted from XML — tag content, CDATA, and attribute values.
They run left-to-right; each parser receives the output of the previous one.

#### Default chains

| Chain      | Parsers                                 |
| ---------- | --------------------------------------- |
| Tags       | `['ws', 'entity', 'boolean', 'number']` |
| Attributes | `['entity', 'number', 'boolean']`       |

#### Configuring the pipeline

Chains are configured on the **builder factory**, not on `XMLParser` directly:

```javascript
import { CompactBuilderFactory } from '@endevops/builder';

// Custom chain
const builder = new CompactBuilderFactory({
  tags: { valueParsers: ['ws', 'entity', 'boolean', 'number'] },
  attributes: { valueParsers: ['entity', 'number'] },
});

// Disable all transformation — raw strings only
const rawBuilder = new CompactBuilderFactory({ tags: { valueParsers: [] }, attributes: { valueParsers: [] } });
```

Each entry is either a **registered name** (string) or a **parser instance** with a
`parse(val, context?)` method.

---

### Built-in Value Parsers

#### `'entity'` — `EntitiesValueParser`

Expands XML entity references (`&lt;`, `&amp;`, etc.), optional HTML entities, and
DOCTYPE-declared entities.

```javascript
import { EntitiesValueParser } from '@endevops/builder';

const evp = new EntitiesValueParser({
  default: true, // built-in XML entities (default: true)
  html: false, // HTML named entities like &nbsp; (default: false)
  external: true, // entities added via addEntity() (default: true)
});
factory.registerValueParser('entity', evp);
```

#### `'ws'` — `WSNormalizer`

Collapses runs of whitespace (spaces, tabs, newlines) to a single space and trims both ends.
**Replaces `'trim'`** in the default chain.

Normalization is automatically skipped when:

- The value is not a string
- The element is an attribute
- Any ancestor element has `xml:space="preserve"`
- The tag path matches a user-supplied exclusion list

```javascript
import { WSNormalizer } from '@endevops/builder';

const ws = new WSNormalizer({
  exclude: ['..pre', '..code', '..script'], // leave whitespace untouched in these
});
factory.registerValueParser('ws', ws);
```

> **Note:** `'trim'` remains registered as an alias for `WSNormalizer` for backward
> compatibility. If you only need edge trimming without collapsing internal whitespace,
> supply a custom parser instead.

#### `'boolean'`

Converts `"true"` and `"false"` (case-insensitive) to JavaScript `true`/`false`. All other values pass through unchanged. You can pass list of true and false values.

```javascript
import { BooleanParser } from '@endevops/builder';

const builder = new CompactBuilderFactory();
builder.registerValueParser('boolean', new BooleanParser({ trueList: ['yes', 'y'], falseList: ['no', 'n'] }));
// "yes" becomes true, "no" becomes false, "true" and "false" stay as strings
```

This final the value on successful match and doesn't process further value parsers. However, you can override this setting.

#### `'number'` — `NumberValueParser`

Converts numeric strings to JS numbers. A value that converts comes back as a `number`; one that does not comes back as the original string, so a
caller tells "this was a number" from "this was text" by the type without checking whether this parser was the one that converted anything.

| Option         | Default      | Description                                                                             |
| -------------- | ------------ | --------------------------------------------------------------------------------------- |
| `hex`          | `true`       | Parse `0x…` hex literals. Lower-case prefix only, so `0X1F` is not hex                  |
| `leadingZeros` | `true`       | Parse `007` as `7`. A zero before a decimal point is not a leading zero                 |
| `eNotation`    | `true`       | Parse `1.5e3` as `1500`                                                                 |
| `binary`       | `false`      | Parse `0b…`. Off by default, since a leading zero in a document is likelier a padded ID |
| `octal`        | `false`      | Parse `0o…`. Off by default, same reasoning                                             |
| `infinity`     | `"original"` | What to do with a value that is not a finite number. Read the note below                |
| `skipLike`     | none         | Return the input unchanged when this pattern matches it                                 |
| `unicode`      | `false`      | Normalize Unicode digits and minus variants to ASCII before matching                    |

`infinity` is reached by **any** value that is not a finite number, not only one that overflows. `'1e1000'` overflows, and so does `'abc'`, because
`Number('abc')` is `NaN`. So `toNumber('abc', { infinity: 'null' })` returns `null` rather than `'abc'`. Leave this at its default unless an
overflowing value genuinely needs a different representation.

`toNumber` is exported directly, so you can use it outside a value-parser chain:

```javascript
import { toNumber } from '@endevops/builder';

toNumber('42'); // 42
toNumber('1,000'); // '1,000'
toNumber('007'); // 7
toNumber('007', { leadingZeros: false }); // '007'
```

Or configure the parser with options and register it:

```javascript
import { NumberValueParser } from '@endevops/builder';

const builder = new CompactBuilderFactory();
builder.registerValueParser('number', new NumberValueParser({ leadingZeros: false }));
// "007" stays as "007"; 9.99 converts normally
```

This final the value on successful match and doesn't process further value parsers. However, you can override this setting.

### Stopping the Chain Early — `FinalValue`

A parser can return `new FinalValue(value)` to short-circuit the pipeline. No subsequent
parsers run, and `value` is returned directly.

```javascript
import { FinalValue } from '@endevops/builder';

class NullParser {
  parse(val) {
    if (val === 'null') return new FinalValue(null); // stop here
    return val;
  }
}

factory.registerValueParser('null', new NullParser());
```

---

### Custom Value Parsers

Any object with a `parse(val, context?)` and `reset()` method works as a value parser:

```javascript
class UpperCaseParser extends BaseValueParser {
  constructor(options, isfinal) {
    super(isfinal);
  }
  parse(val) {
    return typeof val === 'string' ? val.toUpperCase() : val;
  }
}

const builder = new CompactBuilderFactory({ tags: { valueParsers: ['entity', new UpperCaseParser(), 'boolean', 'number'] } });
```

Register by name to reference in multiple chains:

```javascript
factory.registerValueParser('upper', new UpperCaseParser());
// now usable by name in any valueParsers array
```

#### The context object

Each parser receives a typed `Context` as its second argument:

```javascript
import { Context } from '@endevops/builder';

class TagOnlyParser {
  parse(val, context) {
    // skip attributes
    if (context?.isAttribute) return val;
    return doSomething(val);
  }
}
```

| Field         | Type                  | Description                                       |
| ------------- | --------------------- | ------------------------------------------------- |
| `elementName` | `string`              | Tag or attribute name                             |
| `isAttribute` | `boolean \| null`     | `true` for attribute values, `false` for tag text |
| `matcher`     | `MatcherView \| null` | Read-only path inspector                          |
| `isLeafNode`  | `boolean \| null`     | True when element has no child elements           |

---

### ValueParserPipeline

Builder instances expose two pipelines for use in subclass implementations:

```javascript
// In a custom closeElement() — preferred over this.parseValue()
const result = this.tagsPipeline.run(textValue, context);

// In a custom addAttribute() — preferred over this.parseValue()
const result = this.attrsPipeline.run(attrValue, context);
```

---

### Custom Output Builders

Extend `BaseOutputBuilder` and `BaseOutputBuilderFactory`:

`BaseOutputBuilder` needs following optional arguments to build the pipelines, and common work for your custom output builder. However, if you're overriding all methods and preparing value parser pipeline your own then you can skip passing these arguments.

parser options

```
attributes{ prefix: string, suffix: string},
skip: { comment: boolean, cdata: boolean}
nameFor: { comment: string, cdata: string}
```

builder options

```
tags: {valueParsers: []}
attributes{ valueParsers: []},
```

```javascript
import { BaseOutputBuilder, BaseOutputBuilderFactory } from '@endevops/builder';

class TagListBuilder extends BaseOutputBuilder {
  constructor(...args) {
    super(...args);
    this.tags = [];
  }
  addElement(tag) {
    this.tags.push(tag.name);
  }
  getOutput() {
    return this.tags;
  }
}

class TagListBuilderFactory extends BaseOutputBuilderFactory {
  constructor(builderOptions) {
    super();
    this.builderOptions = builderOptions ?? {};
  }

  getInstance(parserOptions, readonlyMatcher) {
    return new TagListBuilder(parserOptions, builderOptions, readonlyMatcher, this.registry);
  }
}
```

#### Methods to override

| Method                               | Called when    | Notes                                     |
| ------------------------------------ | -------------- | ----------------------------------------- |
| `addElement(tag)`                    | Opening tag    |                                           |
| `closeElement()`                     | Closing tag    | Use `this.tagsPipeline.run()` for values  |
| `addAttribute(name, value, matcher)` | Each attribute | Use `this.attrsPipeline.run()` for values |
| `addValue(text)`                     | Text content   |                                           |
| `getOutput()`                        | Parse complete | Return the result                         |

---

### Parser Order

- Put `'ws'` first — trim and collapse whitespace before any interpretation
- Put `'entity'` before `'boolean'` and `'number'` — downstream parsers receive clean characters, not `&amp;` etc.
- Put `'number'` after `'boolean'` — once a value is `true`, number sees a non-string and passes through

Recommended: `['ws', 'entity', 'boolean', 'number']`

---

### Migrating to v2

This is a **major version** with breaking changes to `BaseOutputBuilder`, `BaseOutputBuilderFactory`,
and every output builder built on them (`CompactBuilder` here, and
`@nodable/sequential-builder`, `@nodable/node-tree-builder`,
`@nodable/sequential-stream-builder`, etc.).

All affected packages bump to their own new major version at the same time.

#### 1 — `BaseOutputBuilder` constructor signature changed

The base class now accepts `(parserOptions, builderOptions, matcherView, registry, resetPipelines?)` and builds both `ValueParserPipeline` instances and a fresh `SharedContext` internally. Subclasses no longer receive or manage pipelines directly.

**After**

```javascript
class MyBuilder extends BaseOutputBuilder {
  constructor(parserOptions, builderOptions, readonlyMatcher, registry) {
    super(parserOptions, builderOptions, readonlyMatcher, registry); // pipelines + SharedContext built here
    // this.tagsPipeline, this.attrsPipeline, this.sharedContext are now available
    // ...
  }
}
```

#### 2 — `getInstance()` passes resolved options; pipelines are built automatically

`BaseOutputBuilder`'s constructor now builds both `ValueParserPipeline` instances and a
fresh `SharedContext` from `options.tags.valueParsers` / `options.attributes.valueParsers`.
`getInstance()` only needs to resolve and merge options, then hand the registry.

**After**

```javascript
getInstance(parserOptions, readonlyMatcher) {
  return new MyBuilder(parserOptions, this.builderOptions, readonlyMatcher, this.registry);
}
```

#### 3 — `Context` is now a class, not a plain object

**Before**

```javascript
const context = {
  elementName: tagName,
  elementValue: text,
  elementType: ElementType.ELEMENT,
  matcher: this.matcher,
  isLeafNode: !hasElementChildren,
};
```

**After**

```javascript
const context = new Context(
  tagName, // elementName
  this.matcher, // matcher
  !hasElementChildren, // isLeafNode
  false // isAttribute (false = tag text, true = attribute value)
);
```

#### 4 — Replace `parseValue()` with `tagsPipeline.run()` / `attrsPipeline.run()`

**Before**

```javascript
const parsed = this.parseValue(text, this.options.tags.valueParsers, context);
```

**After**

```javascript
const parsed = this.tagsPipeline.run(text, context);
```

You can decide your own way of parsing though.

#### 5 — Default tag chain now includes `'ws'` instead of `'trim'`

|                          | Before                                    | After                                   |
| ------------------------ | ----------------------------------------- | --------------------------------------- |
| Tags default chain       | `['entity', 'trim', 'boolean', 'number']` | `['ws', 'entity', 'boolean', 'number']` |
| Attributes default chain | `['entity', 'number', 'boolean']`         | unchanged                               |

`'trim'` remains registered as an alias for `WSNormalizer` so existing custom chains that
name it explicitly continue to work. The behavioural difference is that `WSNormalizer` also
**collapses internal whitespace runs** to a single space, not just edge-trims. If you relied
on interior whitespace being preserved, either:

- add the tag path to `WSNormalizer`'s exclusion list, or
- register a custom parser that only trims edges.

#### 6 — `SharedContext` is created automatically per document parse

A `SharedContext` is created inside `BaseOutputBuilder`'s constructor for every new
builder instance (and `getInstance()` returns a fresh builder per document). It flows
automatically to both `ValueParserPipeline` instances and is available on
`this.sharedContext`. No manual wiring is needed.

It carries well-known keys that parsers need at runtime:

| Key               | Set by                                                                     | Used by                                               |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| `'xmlVersion'`    | `BaseOutputBuilder.addAttribute()` when `version` is read from `<?xml …?>` | `EntityParser` — adjusts entity rules per XML version |
| `'inputEntities'` | `BaseOutputBuilder.addInputEntities()` when a DOCTYPE is parsed            | `EntityParser` — expands document-declared entities   |

> **Why a fresh context per parse?** A single `SharedContext` instance that lived on the
> factory would let values from one document (`xmlVersion`, `inputEntities`) bleed into the
> next. Because `BaseOutputBuilder` creates one in its constructor and `getInstance()` returns
> a new builder per parse, each document gets a clean slate automatically.

#### 7 — Custom value parsers should extend `BaseValueParser`

A new `BaseValueParser` base class is now the recommended foundation for all value parsers.
It handles `IS_FINAL` and the `init(ctx)` / `reset()` lifecycle that the pipeline calls.

**Before** — ad-hoc class, no lifecycle hooks:

```javascript
class MyParser {
  constructor(options) {
    this.options = options || {};
  }
  parse(val) {
    // …
    return val;
  }
}
```

**After** — extend `BaseValueParser`:

```javascript
import { BaseValueParser, FinalValue } from '@endevops/builder';

class MyParser extends BaseValueParser {
  constructor(options, isFinal = false) {
    super(isFinal); // sets this.IS_FINAL
    this.options = options || {};
  }

  // Called once per parse with the SharedContext — read from ctx inside parse() lazily.
  // init(ctx) is inherited; override only if you need to pre-read something at init time.

  // Override if your parser caches state between values (e.g. a lazy-built decoder).
  reset() {
    // clear your cached state here
  }

  parse(val, runTimeContext) {
    // …
    const result = transform(val);
    return this.IS_FINAL ? new FinalValue(result) : result;
  }
}
```

Key members provided by `BaseValueParser`:

| Member          | Description                                                                           |
| --------------- | ------------------------------------------------------------------------------------- |
| `this.IS_FINAL` | When `true`, wrap the return value in `new FinalValue(…)` to stop the pipeline        |
| `this.ctx`      | The `SharedContext` injected by `init(ctx)` — read XML version and entities from here |
| `init(ctx)`     | Called by the pipeline after construction; stores `ctx` on `this.ctx`                 |
| `reset()`       | Called by `ValueParserPipeline.resetAll()` before each parse; no-op by default        |

Using `SharedContext` data inside a parser — read lazily inside `parse()` to guarantee the
context is fully populated (the XML declaration and DOCTYPE are parsed before any values):

```javascript
parse(val) {
  const version  = this.ctx?.get('xmlVersion');    // e.g. 1.1
  const entities = this.ctx?.get('inputEntities'); // e.g. { copy: '©', … }
  // …
}
```

---

#### Summary checklist for custom builder authors

- [ ] Change constructor signature to `(parserOptions, builderOptions, readonlyMatcher, registry)`
- [ ] Replace plain context objects with `new Context(name, matcher, isLeafNode, isAttribute)`
- [ ] Replace `this.parseValue(text, ..., context)` with `this.tagsPipeline.run(text, context)`
- [ ] Add `?.` optional chaining to all `parserOptions.*` spreads in options merges
- [ ] Extend `BaseValueParser` in custom value parsers (implement `reset()` for stateful parsers)
- [ ] Bump your package to a new **major** version

---

## Compact builder

Builds a compact or minimal JavaScript object from XML.

### This is a fork

This project is not the original package. It started as a copy of [`@nodable/compact-builder`](https://github.com/nodable/flexible-output-builders) and is maintained separately by Endevops. The name changed and the code was rewritten in TypeScript, so this repository is the place to file issues against the fork, not the upstream one.

Output is unchanged. What changed is how the code is written and tested:

| Change                                                     | Why                                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain JavaScript with a hand-written `index.d.ts`          | Types now come from the implementation that enforces them                                                                                                                                         |
| The `alwaysArray` entry check is typed                     | Upstream duck-typed it, so the option accepted anything at compile time                                                                                                                           |
| `FactoryOptions` and `ResolvedFactoryOptions` are separate | Upstream had one shape doing both jobs, so a caller could not tell which fields were guaranteed                                                                                                   |
| The dead `parent` field removed                            | Upstream set it once in the constructor and never read it — a reader would reasonably assume it tracked the current parent                                                                        |
| Source files renamed to dash-case                          | Matches the rest of the workspace                                                                                                                                                                 |
| Test suite written from scratch, 63 cases                  | Every upstream `test` script was `echo "Error: no test specified" && exit 1`, and the one spec file present was a 32-line scratch script that used jasmine's focused `fit()` and asserted nothing |
| ESM only                                                   | Matches the rest of the workspace                                                                                                                                                                 |

Verified independently of the suite: 6,331 assertions comparing this build against the original JavaScript across 40 documents × 22 builder option sets × 7 parser option sets, plus the option-resolution paths, the `alwaysArray` error cases and the prototype-pollution guard — zero differences.

The port caught one real bug in itself, and the harness is what found it: the tag stack was capturing `this.parent` — which upstream sets once and never updates — instead of `this.value`, the enclosing tag's accumulated value. Every nested document came out self-referential. There is now a regression spec for it.

Two upstream behaviours are preserved rather than fixed, since both are reachable and changing them would break output:

- `_resolveForceArray` dereferences `this.matcher` unguarded, so a builder constructed without a path throws on the first close. Both `alwaysArray` and `forceArray` are path-based, so a builder with no path cannot honour either, and failing loudly beats quietly not forcing an array the caller asked for.
- The default attribute chain is `['entity', 'number', 'boolean']` while the base package's own default is `['entity', 'boolean', 'number']`. The two cannot in practice be told apart — the boolean lists are `['true']` and `['false']`, which `number` never matches — so each package keeps its own.

License keeps the upstream MIT copyright notice; package metadata moves to Endevops.

### Installation

```bash
npm install @endevops/builder
```

### Usage

```javascript
import XMLParser from '@endevops/parser';
import { CompactBuilderFactory } from '@endevops/builder';

const cobOpts = {};

const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory(cobOpts) });

const result = parser.parse('<root><item>value</item></root>');
```

### Properties

#### 1. `forceArray` Option

**Type:** `function(matcher, isLeafNode) => boolean`

Forces specific XML tags to always be represented as arrays, even when only a single occurrence exists. This ensures consistent data structures in your parsed output.

**Key Benefits:**

- Prevents code breaking when XML structure changes (single → multiple elements)
- Simplifies array processing logic in consuming code
- Supports path-based, attribute-based, and leaf-node-based decisions

```js
import XMLParser from '@endevops/parser';
import { CompactBuilderFactory } from '@endevops/builder';

const inputXml = `<catalog><book>Title</book></catalog>`;

const parser = new XMLParser({
  OutputBuilder: new CompactBuilderFactory({
    forceArray: (matcher, isLeafNode) => {
      return matcher.toString().endsWith('catalog.book');
    },
  }),
});

const result = parser.parse(inputXml);
```

Output

```json
{ "catalog": { "book": ["Title"] } }
```

#### 2. `alwaysArray` Option

**Type:** `string[] | Expression[]`

Forces specific XML tags to always be represented as arrays, even when only a single occurrence exists. This ensures consistent data structures in your parsed output.

**Key Benefits:**

- Prevents code breaking when XML structure changes (single → multiple elements)
- Simplifies array processing logic in consuming code
- Supports path-based, attribute-based, and leaf-node-based decisions

```js
import { Expression } from 'path-expression-matcher';

const inputXml = `<catalog><book>Title</book></catalog>`;

const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ alwaysArray: ['..item', new Expression('root.product')] }) });

const result = parser.parse(inputXml);
```

Output

```json
{ "catalog": { "book": "Title" } }
```

Please note that if `alwaysArray` or `forceArray` returns true for a tag then it'll be array. Similarly if any one of then returns false for a tag then it'll not be array.

#### 3. `forceTextNode` Option

**Type:** `boolean`

Forces creation of a text node object for every tag, ensuring consistent object structure instead of mixing strings and objects.

**Key Benefits:**

- Uniform property access patterns (`item["#text"]` always works)
- Easier to serialize/deserialize
- Consistent structure across all tags

```js
const inputXml = `<item>Value</item>`;

const parser = new XMLParser({
  OutputBuilder: new CompactBuilderFactory({
    forceTextNode: true, //false by default
  }),
});

const result = parser.parse(inputXml);

// Without option: { item: "Value" }
// With option: { item: { "#text": "Value" } }
```

Output

```js
{
  "item": {
    "#text": "Value"
  }
}
```

#### 4. `textJoint` Option

**Type:** `string` (default: `''`)

String inserted between text chunks when a tag accumulates multiple text segments (e.g. text interspersed with comments or CDATA).

```js
const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ textJoint: ' ' }) });
```

---

#### Other Options

`skip`, `nameFor`, and `attributes` are parser-level options documented in `@endevops/parser`. They are passed through to the parser unchanged.

---

## License

MIT. The upstream copyright notices for all three merged packages are preserved
as `LICENSE-is-xml-builder`, `LICENSE-is-base-output-builder` and
`LICENSE-is-compact-builder`.
