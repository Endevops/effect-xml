# 05 — Output Builders

Output builders control the shape of the parsed result. The parser tokenises XML and calls the builder's methods — the builder decides what data structure to build.

Builders live in separate packages so you only install what you need.

---

## Available Builders

| Package                              | Builder                          | Output shape                                      |
| ------------------------------------ | -------------------------------- | ------------------------------------------------- |
| `@nodable/compact-builder`           | `CompactBuilderFactory`          | JS object (default, like fast-xml-parser)         |
| `@nodable/sequential-builder`        | `SequentialBuilderFactory`       | Ordered key-value array, preserves document order |
| `@nodable/sequential-stream-builder` | `SequentialStreamBuilderFactory` | Same as sequential but streams output             |
| `@nodable/node-tree-builder`         | `NodeTreeBuilderFactory`         | Uniform AST node tree                             |
| `@nodable/base-output-builder`       | `BaseOutputBuilder`              | Base class for custom builders                    |

---

## CompactBuilder (default)

Produces a compact JS object. When a tag appears once it becomes a value; when it appears multiple times it becomes an array. This is the default when no `OutputBuilder` is specified.

```javascript
import { CompactBuilderFactory } from '@nodable/compact-builder';

const builder = new CompactBuilderFactory({
  alwaysArray: ['..item', '..book'], // always wrap these tags in arrays
  forceArray: (matcher, isLeafNode) => matcher.path().endsWith('.product'),
  forceTextNode: false, // when true, text-only tags always use { '#text': val }
  textJoint: '', // join string for multiple text nodes in one tag
});

new XMLParser({ OutputBuilder: builder });
```

### New Options

- `alwaysArray`: Force specific tag paths to always be arrays
- `forceArray`: Function-based array forcing for more complex conditions:

> If either `alwaysArray` or `forceArray` returns true for a tag, it becomes an array.

- `forceTextNode`: text-only tags always produce `{ '#text': value }`

---

## SequentialBuilder

Preserves full document order. Every element becomes an array entry. Useful for round-trip serialisation where element order matters.

```javascript
import { SequentialBuilderFactory } from '@nodable/sequential-builder';

new XMLParser({ OutputBuilder: new SequentialBuilderFactory() });
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
import { NodeTreeBuilderFactory } from '@nodable/node-tree-builder';

new XMLParser({ OutputBuilder: new NodeTreeBuilderFactory() });
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

Extend `BaseOutputBuilder` from `@nodable/base-output-builder` to build any custom output.

```javascript
import { BaseOutputBuilder, BaseOutputBuilderFactory } from '@nodable/base-output-builder';

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

BaseOutputBuilder's constructor arguments:

```javascript
constructor(parserOptions, builderOptions, readonlyMatcher, registry);
```

BaseOutputBuilder provides some fields and methods to be used directly. Check [docs](https://github.com/nodable/flexible-output-builders).

### Extending Existing Builders

Subclass existing builders (e.g. `CompactBuilder`) to add behaviour while keeping normal object output:

```javascript
import { CompactBuilder } from '@nodable/compact-builder';

class LowerCaseTagBuilder extends CompactBuilder {
  addElement(tag, matcher) {
    super.addElement({ ...tag, name: tag.name.toLowerCase() }, matcher);
  }
}
```

> Always spread `tag` (`{ ...tag, name }`) rather than mutating `tag.name` directly.

### Position Meta data

Parser sends position meta data to the builder since v1.5.0.

`line`, `col`, and `index` always refer to the position of the relevant token's
starting character (e.g. the `<` of an opening tag, the `</` of a closing tag) in the
original source document:

| Field   | Meaning                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `line`  | 1-based line number. Always starts at `1`; increments after every `\n`.                                                                     |
| `col`   | 0-based column on the current line — number of characters consumed since the last `\n` (or document start). Resets to `0` on every newline. |
| `index` | 0-based absolute character/byte offset from the start of the document. Line-independent.                                                    |

These are accurate everywhere in the document, including across CDATA sections,
comments, and DOCTYPE internal subsets containing embedded newlines, and across
chunk boundaries when using `feed()`/`end()` (a token that fails mid-read and gets
replayed on the next chunk does not double-count newlines it had already consumed).

#### addElement

1st argument of `addElement` i.e. `tagDetail` has the following properties:

- `name`: tag name
- `index`, `line`, `col`: position of this tag's opening `<`
- `openEnd`: absolute offset immediately after this opening tag's `>` (or `/>` for self-closing)

#### closeElement

`closeElement` receives `closeMeta` as its 2nd argument:

- `name`: the tag being closed (always provided)
- `index`, `line`, `col`: position of `</` for a real closing tag
- `closeEnd`: absolute offset immediately after this closing tag's `>`

For **unpaired/self-closing tags** (no real closing token), `closeMeta` reuses the
opening tag's own position. For **stop nodes**, only `{ name, closeEnd }` is provided.
For **autoClose/exitIf synthetic closes**, only `{ name }` is provided.

### addAttribute

`addAttribute` receives `attrMeta` as its 4th argument:

- `index`: the attribute's absolute offset (where its name starts)

`attrMeta` is `undefined` (not an object with `undefined` fields) when no position was
available. `line`/`col` are deliberately not included on attributes — computing them
would mean re-scanning every tag's attribute string for newlines, for a field most
builders never read.

### onStopNode

`onStopNode` receives `stopEnd` as its 4th argument — position right after the stop
node's matched closing tag:

- `index`, `line`, `col`

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
closeElement(matcher) {
  if (this._skipDepth > 0) { this._skipDepth--; return; }
  super.closeElement(matcher);
}
```

**Write to database instead of returning an object:**

```javascript
class DbWriter extends BaseOutputBuilder {
  addElement(tag) {
    /* open record */
  }
  closeElement() {
    /* flush to DB */
  }
  addValue(v) {
    /* accumulate field */
  }
  getOutput() {
    return null;
  } // nothing to return
}
const result = await new XMLParser({ OutputBuilder: new DbWriter() }).parseStream(createReadStream('huge.xml'));
// result === null; data is in the database
```

---

➡ Next: [06 — Streaming & Feed API](./06-streaming.md)
