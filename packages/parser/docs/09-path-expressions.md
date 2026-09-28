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

Plain strings are automatically converted to `Expression` objects while `XMLParser.make` resolves the
options — which is why compiling an expression yourself can fail, and why `Expression`'s constructor is
private. `Expression.make` is the way in. For reusable parsers, pre-compile to avoid re-parsing on
every `parse()` call:

```javascript
import { Effect } from 'effect';
import { Expression } from '@endevops/common-xml';

const scriptExpr = Effect.runSync(Expression.make('..script')); // compiled once

const parser = Effect.runSync(XMLParser.make({ tags: { stopNodes: [scriptExpr] } }));

// Reuse the same parser and expression for many documents
const r1 = Effect.runSync(parser.parse(html1));
const r2 = Effect.runSync(parser.parse(html2));
```

You can mix strings and `Expression` objects in the same array.

---

## The ReadOnlyMatcher

A `ReadOnlyMatcher` is passed to every user-facing callback (value parsers, `onStopNode`, `exitIf`, output builder methods). It reflects the current parser position and lets you inspect the path safely without risk of mutating parser state.

It is the `MatcherView` class from `@endevops/common-xml`, which also exports it under the deprecated alias `ReadOnlyMatcher` for compatibility. Import it from there:

```typescript
import type { MatcherView } from '@endevops/common-xml';
```

### Available methods

**Every one of them answers with an `Effect`.** Asking a path matcher anything — a tag name, an
attribute value, a position counter — is a lookup that can fail on malformed state, and a synchronous
return would have nowhere to put that failure. Compose them in an `Effect.gen`, or run one at a time
where a value is wanted immediately.

| Method                   | Answers                                                  |
| ------------------------ | -------------------------------------------------------- |
| `matches(expression)`    | `Effect<boolean>` — does current path match?             |
| `matchesAny(exprSet)`    | `Effect<boolean>` — match any of a set?                  |
| `getCurrentTag()`        | `Effect<string \| undefined>` — current tag name         |
| `getCurrentNamespace()`  | `Effect<string \| undefined>` — namespace prefix         |
| `getAttrValue(name)`     | `Effect<unknown>` — attribute value on current node      |
| `hasAttr(name)`          | `Effect<boolean>`                                        |
| `getAnyParentAttr(name)` | `Effect<unknown>` — nearest ancestor that has it         |
| `hasAnyParentAttr(name)` | `Effect<boolean>`                                        |
| `getPosition()`          | `Effect<number>` — child index of current node           |
| `getCounter()`           | `Effect<number>` — occurrence count at this level        |
| `getIndex()`             | `Effect<number>` — offset of the current tag             |
| `getDepth()`             | `Effect<number>` — nesting depth                         |
| `toString()`             | `Effect<string>` — path string, e.g. `"root.users.user"` |
| `toArray()`              | `Effect<string[]>` — array of tag names                  |

Read-only by construction, not by guard. `MatcherView` is a facade holding a private reference to the parent `Matcher`, and the mutating methods are simply not on it: `push`, `pop`, `reset`, `updateCurrent` and `restore` do not exist there. Calling one throws an ordinary `TypeError` because the property is `undefined`, not because the view checks anything. Nothing stops a caller that kept its own reference to the `Matcher`, so treat the view as read-only by convention.

The same rule turned `ExpressionSet.size` and `ExpressionSet.isSealed` into methods rather than getters.

---

## Matcher in Value Parser Context

Every value parser's `parse(val, context)` call includes a `matcher` on the context — and `parse`
itself returns an `Effect`, so the matcher question belongs inside it:

```typescript
import { Effect } from 'effect';
import { CompactBuilderFactory } from '@endevops/builder';
import { Expression } from '@endevops/common-xml';

const priceExpr = Effect.runSync(Expression.make('..price'));

class CurrencyParser {
  parse(val, context) {
    return Effect.gen(function* () {
      if (typeof val !== 'string') return val;
      const matcher = context?.matcher;
      if (!matcher || !(yield* matcher.matches(priceExpr))) return val;
      return parseFloat(val.replace(/[$€£¥₹,]/g, ''));
    });
  }
}

const builder = Effect.runSync(CompactBuilderFactory.make({ tags: { valueParsers: [new CurrencyParser()] } }));
```

---

## Matcher in OutputBuilder Methods

The `matcher` passed to `addElement`, `closeElement`, and `addValue` reflects the current position.
`addElement` and `addValue` are plain, so a synchronous builder can still ask the matcher by running
its effect; `closeElement` is an effect already, so the question composes:

```javascript
import { Effect } from 'effect';
import { CompactBuilder } from '@endevops/builder';
import { Expression } from '@endevops/common-xml';

const internalExpr = Effect.runSync(Expression.make('..internal'));

class FilteredBuilder extends CompactBuilder {
  constructor(...args) {
    super(...args);
    this._skipDepth = 0;
  }
  addElement(tag, matcher) {
    if (this._skipDepth > 0 || Effect.runSync(matcher.matches(internalExpr))) {
      this._skipDepth++;
      return;
    }
    super.addElement(tag, matcher);
  }
  closeElement(matcher, closeMeta) {
    return Effect.gen(function* () {
      if (this._skipDepth > 0) {
        this._skipDepth--;
        return; // suppressed — no effect to hand back
      }
      return yield* super.closeElement(matcher, closeMeta);
    });
  }
}
```

Note the two shapes: `addElement` has to make a decision and return nothing, so it runs the matcher's
effect where the boolean is needed. `closeElement` is already an effect, so it composes instead.

---

## Attribute Conditions

Attribute conditions in path expressions work because the parser calls `matcher.updateCurrent(rawAttrs)` **before** the stop-node or skip-tag check runs. So `'..div[class=code]'` correctly matches `<div class="code">`:

```javascript
import { Effect } from 'effect';
import { Expression } from '@endevops/common-xml';

const codeExpr = Effect.runSync(Expression.make('..div[class=code]'));

const parser = Effect.runSync(XMLParser.make({ skip: { attributes: false }, tags: { stopNodes: [codeExpr] } }));

Effect.runSync(parser.parse('<root><div class="code"><pre>raw</pre></div><div class="text"><p>parsed</p></div></root>'));
```

---

➡ Next: [10 — TypeScript](./10-typescript.md)
