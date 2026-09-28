# 09 — Path Expressions

`@endevops/parser` uses the path matcher from [`@endevops/common-xml`](../common-xml) for all path-based features: `stopNodes`, `skip.tags`, `exitIf`, and value parser context.

---

## Pattern Syntax

| Pattern               | Matches                                       |
| --------------------- | --------------------------------------------- |
| `'root.script'`       | `<script>` as a direct child of `<root>`      |
| `'*.script'`          | `<script>` with exactly one parent (any name) |
| `'..script'`          | `<script>` anywhere in the tree               |
| `'root..script'`      | `<script>` anywhere inside `<root>`           |
| `'..div[class=code]'` | `<div class="code">` anywhere                 |
| `'root.item:first'`   | First `<item>` under `<root>`                 |
| `'root.item:nth(2)'`  | Third `<item>` under `<root>` (0-indexed)     |
| `'soap::Envelope'`    | `<Envelope>` with namespace `soap`            |

---

## String vs Pre-compiled Expressions

Plain strings are automatically converted to `Expression` objects at parser construction time. For reusable parsers, pre-compile expressions to avoid re-parsing on every `parse()` call:

```javascript
import { Expression } from 'path-expression-matcher';

const scriptExpr = new Expression('..script'); // compiled once

const parser = new XMLParser({ tags: { stopNodes: [scriptExpr] } });

// Reuse the same parser and expression for many documents
const r1 = parser.parse(html1);
const r2 = parser.parse(html2);
```

You can mix strings and `Expression` objects in the same array.

---

## The ReadOnlyMatcher

A `ReadOnlyMatcher` is passed to every user-facing callback (value parsers, `onStopNode`, `exitIf`, output builder methods). It reflects the current parser position and lets you inspect the path safely without risk of mutating parser state.

It is the `MatcherView` class from `path-expression-matcher`, exported there under the alias `ReadOnlyMatcher` for compatibility. Import it from that package:

```typescript
import type { ReadOnlyMatcher } from 'path-expression-matcher';
```

### Available methods

| Method                   | Returns                                               |
| ------------------------ | ----------------------------------------------------- |
| `matches(expression)`    | `boolean` — does current path match?                  |
| `matchesAny(exprSet)`    | `boolean` — does current path match any of a set?     |
| `getCurrentTag()`        | Current tag name                                      |
| `getCurrentNamespace()`  | Namespace prefix or `undefined`                       |
| `getAttrValue(name)`     | Attribute value on current node                       |
| `hasAttr(name)`          | `boolean`                                             |
| `getAnyParentAttr(name)` | Attribute value from the nearest ancestor that has it |
| `hasAnyParentAttr(name)` | `boolean`                                             |
| `getPosition()`          | Child index of current node                           |
| `getCounter()`           | Occurrence count of this tag name at this level       |
| `getIndex()`             | Character offset of the current tag                   |
| `getDepth()`             | Nesting depth                                         |
| `toString()`             | Dot-separated path string, e.g. `"root.users.user"`   |
| `toArray()`              | Array of tag names                                    |

Read-only by construction, not by guard. `MatcherView` is a facade holding a private reference to the parent `Matcher`, and the mutating methods are simply not on it: `push`, `pop`, `reset`, `updateCurrent` and `restore` do not exist there. Calling one throws an ordinary `TypeError` because the property is `undefined`, not because the view checks anything. Nothing stops a caller that kept its own reference to the `Matcher`, so treat the view as read-only by convention.

---

## Matcher in Value Parser Context

Every value parser's `parse(val, context)` call includes a `matcher` on the context:

```javascript
import { Expression } from 'path-expression-matcher';

const priceExpr = new Expression('..price');

class CurrencyParser {
  parse(val, context) {
    if (typeof val !== 'string') return val;
    if (!context?.matcher?.matches(priceExpr)) return val;
    return parseFloat(val.replace(/[$€£¥₹,]/g, ''));
  }
}

const parser = new XMLParser({ tags: { valueParsers: [new CurrencyParser()] } });
```

---

## Matcher in OutputBuilder Methods

The `matcher` passed to `addElement`, `closeElement`, and `addValue` reflects the current position:

```javascript
import { CompactBuilder } from '@endevops/builder';
import { Expression } from 'path-expression-matcher';

const internalExpr = new Expression('..internal');

class FilteredBuilder extends CompactBuilder {
  constructor(...args) {
    super(...args);
    this._skipDepth = 0;
  }
  addElement(tag, matcher) {
    if (this._skipDepth > 0 || matcher.matches(internalExpr)) {
      this._skipDepth++;
      return;
    }
    super.addElement(tag, matcher);
  }
  closeElement(matcher) {
    if (this._skipDepth > 0) {
      this._skipDepth--;
      return;
    }
    super.closeElement(matcher);
  }
}
```

---

## Attribute Conditions

Attribute conditions in path expressions work because the parser calls `matcher.updateCurrent(rawAttrs)` **before** the stop-node or skip-tag check runs. So `'..div[class=code]'` correctly matches `<div class="code">`:

```javascript
const parser = new XMLParser({ skip: { attributes: false }, tags: { stopNodes: [new Expression('..div[class=code]')] } });

parser.parse('<root><div class="code"><pre>raw</pre></div><div class="text"><p>parsed</p></div></root>');
```

---

➡ Next: [10 — TypeScript](./10-typescript.md)
