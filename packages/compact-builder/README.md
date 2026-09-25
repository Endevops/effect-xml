# @endevops/compact-builder

Builds a compact or minimal JavaScript object from XML.

## This is a fork

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

## Installation

```bash
npm install @endevops/compact-builder
```

## Usage

```javascript
import XMLParser from '@endevops/flexible-xml-parser-effect';
import { CompactBuilderFactory } from '@endevops/compact-builder';

const cobOpts = {};

const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory(cobOpts) });

const result = parser.parse('<root><item>value</item></root>');
```

## Properties

### 1. `forceArray` Option

**Type:** `function(matcher, isLeafNode) => boolean`

Forces specific XML tags to always be represented as arrays, even when only a single occurrence exists. This ensures consistent data structures in your parsed output.

**Key Benefits:**

- Prevents code breaking when XML structure changes (single → multiple elements)
- Simplifies array processing logic in consuming code
- Supports path-based, attribute-based, and leaf-node-based decisions

```js
import XMLParser from '@endevops/flexible-xml-parser-effect';
import { CompactBuilderFactory } from '@endevops/compact-builder';

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

### 2. `alwaysArray` Option

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

### 3. `forceTextNode` Option

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

### 4. `textJoint` Option

**Type:** `string` (default: `''`)

String inserted between text chunks when a tag accumulates multiple text segments (e.g. text interspersed with comments or CDATA).

```js
const parser = new XMLParser({ OutputBuilder: new CompactBuilderFactory({ textJoint: ' ' }) });
```

---

### Other Options

`skip`, `nameFor`, and `attributes` are parser-level options documented in `@endevops/flexible-xml-parser-effect`. They are passed through to the parser unchanged.
