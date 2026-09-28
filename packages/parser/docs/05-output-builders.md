# 05 — Output Builders

Output builders control the shape of the parsed result. The parser tokenises XML and calls the builder's methods — the builder decides what data structure to build.

Builders live in separate packages so you only install what you need.

---

## Available Builders

| Package                              | Builder                          | Output shape                                      |
| ------------------------------------ | -------------------------------- | ------------------------------------------------- |
| `@endevops/builder`                  | `CompactBuilderFactory`          | JS object (default, like fast-xml-parser)         |
| `@nodable/sequential-builder`        | `SequentialBuilderFactory`       | Ordered key-value array, preserves document order |
| `@nodable/sequential-stream-builder` | `SequentialStreamBuilderFactory` | Same as sequential but streams output             |
| `@nodable/node-tree-builder`         | `NodeTreeBuilderFactory`         | Uniform AST node tree                             |
| `@endevops/builder`                  | `BaseValueParser`                | Base class for custom value parsers               |

`CompactBuilderFactory` and `BaseValueParser` are two parts of the same package
now: the base class and the concrete compact builder moved into
[`@endevops/builder`](../builder) together, because writing one output builder
needs both.

---

## CompactBuilder (default)

Produces a compact JS object. When a tag appears once it becomes a value; when it appears multiple times it becomes an array. This is the default when no `OutputBuilder` is specified.

```javascript
import { Effect } from 'effect';
import { CompactBuilderFactory } from '@endevops/builder';

const builder = Effect.runSync(
  CompactBuilderFactory.make({
    alwaysArray: ['..item', '..book'], // always wrap these tags in arrays
    forceArray: (matcher, isLeafNode) => Effect.runSync(matcher.toString()).endsWith('.product'),
    forceTextNode: false, // when true, text-only tags always use { '#text': val }
    textJoint: '', // join string for multiple text nodes in one tag
  })
);

Effect.runSync(XMLParser.make({ OutputBuilder: builder }));
```

`forceArray` still answers with a plain boolean — the builder is already mid-document when it votes,
so it runs the matcher's effect and unwraps it inline. `matcher.toString()` is a path question like
any other; a predicate that can be written without one takes no matcher call at all.

### New Options

- `alwaysArray`: Force specific tag paths to always be arrays
- `forceArray`: Function-based array forcing for more complex conditions:

> If either `alwaysArray` or `forceArray` returns true for a tag, it becomes an array.

- `forceTextNode`: text-only tags always produce `{ '#text': value }`

---

## SequentialBuilder

Preserves full document order. Every element becomes an array entry. Useful for round-trip serialisation where element order matters.

```javascript
import { Effect } from 'effect';
import { SequentialBuilderFactory } from '@nodable/sequential-builder';

Effect.runSync(XMLParser.make({ OutputBuilder: new SequentialBuilderFactory() }));
```

Input:

```xml
<root>
  <child>hello</child>
  <child>world</child>
</root>
```

Output:

```json
[{ "root": [{ "child": [{ "#text": "hello" }] }, { "child": [{ "#text": "world" }] }] }]
```

---

## NodeTreeBuilder

Produces a uniform AST-style node tree. Every node has a consistent structure with `tagname` and `child` properties, making tree traversal predictable.

```javascript
import { Effect } from 'effect';
import { NodeTreeBuilderFactory } from '@nodable/node-tree-builder';

Effect.runSync(XMLParser.make({ OutputBuilder: new NodeTreeBuilderFactory() }));
```

Output for `<root><child>hello</child></root>`:

```json
{ "tagname": "root", "child": [{ "tagname": "child", "child": [{ "#text": "hello" }] }] }
```

Attributes are always grouped under `:@` (the `attributes.groupBy` option is ignored):

```json
{ "tagname": "t", "child": [], ":@": { "@_foo": "bar" } }
```

---

## Custom Output Builder

The `OutputBuilder` option takes a **factory**, not a builder. The parser calls `getInstance()` on it before every parse, which is what gives each run a fresh builder. The factory's `parserOptions` and `readonlyMatcher` arguments are optional in your signature: a function that takes fewer parameters is assignable to one that takes more.

`getInstance()` answers with an `Effect` — a builder can be refused at construction, and a
constructor has nowhere to put an error channel. Two of the ten methods answer with effects too:
`closeElement` and `addAttribute`, because closing a tag is where the builder runs the value-parser
chain over everything under it, and an attribute's value goes through that same chain on the way in.
The other eight are plain, and stay that way — an effect nobody can fail is an allocation per tag.

Do not extend `BaseOutputBuilder` from `@endevops/builder` for this. Its shipped declarations and its shipped implementation both fall short: it declares `addElement` with one parameter where the parser passes two, and at runtime the class implements none of the four methods the parser calls (`addElement`, `closeElement`, `addValue`, `getOutput`). A subclass that defines only `addElement` and `getOutput` throws `TypeError: this.outputBuilder.closeElement is not a function` on the first closing tag.

Implement the builder structurally instead. It needs no base class, no import and no cast:

```javascript
import { Effect } from 'effect';

class TagListBuilder {
  constructor() {
    this.tags = [];
  }

  addElement(tag) {
    this.tags.push(tag.name);
  }

  // The parser calls all ten. This builder only wants names, so the rest are empty.
  closeElement() {
    return Effect.void; // an effect — the parser runs it
  }
  addValue() {}
  addLiteral() {}
  addComment() {}
  addDeclaration() {}
  addInstruction() {}
  addInputEntities() {}
  addAttribute() {
    return Effect.void;
  }

  getOutput() {
    return this.tags;
  }
}

class TagListBuilderFactory {
  getInstance() {
    return Effect.succeed(new TagListBuilder());
  }
}

const program = Effect.gen(function* () {
  const parser = yield* XMLParser.make({ OutputBuilder: new TagListBuilderFactory() });
  return yield* parser.parse('<r><a><b/></a></r>');
});

Effect.runSync(program);
// ['r', 'a', 'b']
```

A typed version of the same builder, and the full list of the ten methods, is in [10 — TypeScript](./10-typescript.md#custom-output-builder).

### Extending Existing Builders

Subclass existing builders (e.g. `CompactBuilder`) to add behaviour while keeping normal object output. `CompactBuilder` does implement all four methods, so this path works where extending the base class does not:

```javascript
import { CompactBuilder } from '@endevops/builder';

class LowerCaseTagBuilder extends CompactBuilder {
  addElement(tag, matcher) {
    super.addElement({ ...tag, name: tag.name.toLowerCase() }, matcher);
  }
}
```

> Always spread `tag` (`{ ...tag, name }`) rather than mutating `tag.name` directly.

### Position Meta data

Parser sends position meta data to the builder since v1.5.0.

Positions are `index`-only: the parser does no line or column tracking, anywhere, so a builder
gets an offset into the original source document and nothing else. Every `index` is 0-based and
absolute, and refers to the start of the relevant token (the `<` of an opening tag, the `</` of a
closing tag).

These are accurate everywhere in the document, including across CDATA sections, comments, and
DOCTYPE internal subsets, and across chunk boundaries when using `feed()`/`end()` (a token that
fails mid-read and gets replayed on the next chunk is measured from the same origin, so a
replayed token does not shift the ones after it).

#### addElement

1st argument of `addElement` i.e. `tagDetail` has the following properties:

- `name`: tag name
- `index`: position of this tag's opening `<`
- `openEnd`: absolute offset immediately after this opening tag's `>` (or `/>` for self-closing)

#### closeElement

`closeElement` receives `closeMeta` as its 2nd argument, and answers with an `Effect`:

- `name`: the tag being closed (always provided)
- `index`: position of `</` for a real closing tag
- `closeEnd`: absolute offset immediately after this closing tag's `>`

For **unpaired/self-closing tags** (no real closing token), `closeMeta` reuses the
opening tag's own position. For **stop nodes**, only `{ name, closeEnd }` is provided.
For **autoClose/exitIf synthetic closes**, only `{ name }` is provided.

### addAttribute

`addAttribute` receives `attrMeta` as its 4th argument, and answers with an `Effect`:

- `index`: the attribute's absolute offset (where its name starts)

`attrMeta` is `undefined` (not an object with `undefined` fields) when no position was
available. No line or column is reported on attributes — or anywhere else in this parser's
output.

### onStopNode

`onStopNode` receives `stopEnd` as its 4th argument — position right after the stop
node's matched closing tag:

- `index`

### Common patterns

**Rename tags:**

```javascript
addElement(tag, matcher) {
  const name = tag.name === 'Person' ? 'person' : tag.name;
  super.addElement({ ...tag, name }, matcher);
}
```

**Skip a tag and its subtree:**

```javascript
constructor(...args) {
  super(...args);
  this._skipDepth = 0;
}
addElement(tag, matcher) {
  if (this._skipDepth > 0 || tag.name === 'internal') {
    this._skipDepth++;
    return; // omit super — tag is suppressed
  }
  super.addElement(tag, matcher);
}
closeElement(matcher, closeMeta) {
  // an Effect: the parser runs whatever comes back, so a suppressed tag returns
  // a completed no-op rather than nothing
  if (this._skipDepth > 0) { this._skipDepth--; return Effect.void; }
  return super.closeElement(matcher, closeMeta);
}
```

**Write to database instead of returning an object:**

```javascript
import { Effect } from 'effect';

class DbWriterBuilder {
  addElement(tag) {
    /* open record */
  }
  closeElement() {
    /* flush to DB */
    return Effect.void;
  }
  addValue(v) {
    /* accumulate field */
  }
  addLiteral() {}
  addComment() {}
  addDeclaration() {}
  addInstruction() {}
  addInputEntities() {}
  addAttribute() {
    return Effect.void;
  }

  getOutput() {
    return null;
  } // nothing to return
}

class DbWriterFactory {
  getInstance() {
    return Effect.succeed(new DbWriterBuilder());
  }
}

const parser = Effect.runSync(XMLParser.make({ OutputBuilder: new DbWriterFactory() }));
const result = await Effect.runPromise(parser.parseStream(createReadStream('huge.xml')));
// result === null; data is in the database
```

---

➡ Next: [06 — Streaming & Feed API](./06-streaming.md)
