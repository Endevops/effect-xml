# 07 — Auto-Close (Lenient HTML Parsing)

By default the parser fails on any structural problem: the `parse` effect is a `Failure` carrying a
`ParseError`. `autoClose` lets you recover gracefully from malformed or incomplete XML — useful for
parsing real-world HTML fragments.

---

## Two Failure Modes

**1. Unclosed tags at EOF** — document ends with open tags still on the stack:

```xml
<root><a><b>hello</b>
```

**2. Mismatched closing tag** — close tag doesn't match the currently open tag:

```xml
<root><outer><inner>text</outer></root>
```

---

## Options

```javascript
import { Effect } from 'effect';

Effect.runSync(
  XMLParser.make({
    autoClose: {
      onEof: 'throw', // 'throw' | 'closeAll'
      onMismatch: 'throw', // 'throw' | 'recover' | 'discard'
      collectErrors: false,
    },
  })
);
```

All three sub-options are independent and default to the strictest value.

### `onEof`

| Value        | Behaviour                                               |
| ------------ | ------------------------------------------------------- |
| `'throw'`    | Fail with a `ParseError` (default)                      |
| `'closeAll'` | Silently close all remaining open tags, innermost first |

```javascript
const parser = Effect.runSync(XMLParser.make({ autoClose: { onEof: 'closeAll' } }));
Effect.runSync(parser.parse('<root><a><b>hello</b>'));
// → { root: { a: { b: 'hello' } } }
```

### `onMismatch`

| Value       | Behaviour                                                                   |
| ----------- | --------------------------------------------------------------------------- |
| `'throw'`   | Fail with a `ParseError` (default)                                          |
| `'recover'` | Scan up the stack for a matching opener; close intermediate tags implicitly |
| `'discard'` | Silently ignore the bad closing tag                                         |

```javascript
const parser = Effect.runSync(XMLParser.make({ autoClose: { onMismatch: 'recover' } }));
Effect.runSync(parser.parse('<root><outer><inner>text</outer></root>'));
// → { root: { outer: { inner: 'text' } } }
```

A closing tag with no matching opener anywhere in the stack is called a **phantom close**. With `'recover'` or `'discard'` it is dropped and, if `collectErrors: true`, logged as a `phantom-close` error.

### `collectErrors`

When `true`, structural problems are recorded rather than silently dropped. After parsing, retrieve the list with `parser.getParseErrors()` — an effect, and an infallible one, so it never needs a handler:

```javascript
const parser = Effect.runSync(XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } }));
Effect.runSync(parser.parse('<root><a><b>hi</b>'));

Effect.runSync(parser.getParseErrors());
// [{ type: 'unclosed-eof', tag: 'a', expected: null, index: 6 }]
```

#### Error record fields

| Field      | Description                                                                   |
| ---------- | ----------------------------------------------------------------------------- |
| `type`     | `'unclosed-eof'`, `'mismatched-close'`, `'phantom-close'`, or `'partial-tag'` |
| `tag`      | Name of the tag that caused the problem                                       |
| `expected` | What the parser expected (`null` for `unclosed-eof`)                          |
| `index`    | Character offset of the **opening** tag, when available                       |

These are records, not `ParseError`s. They report what recovery did; they do not fail anything.

---

## Recovering at the Effect Level

`autoClose` is one recovery strategy — a policy the parser applies to itself. The other is to let
the parse fail and handle the code at the call site, which is what `Effect.catchIf` is for:

```typescript
import { Effect } from 'effect';
import XMLParser, { ErrorCode, ParseError } from '@endevops/parser';

const program = Effect.gen(function* () {
  const parser = yield* XMLParser.make();
  return yield* parser.parse(html);
});

const lenient = Effect.catchIf(
  program,
  (e): e is ParseError => e.code === ErrorCode.MISMATCHED_CLOSE_TAG,
  () => Effect.succeed({ truncated: true })
);
```

`catchIf` matches one code and re-fails everything else, so the fallback cannot quietly swallow a
security failure. When the recovery is itself more than one step, `Effect.matchEffect` takes the
same shape with an `onFailure` branch that re-fails whatever it does not handle:

```typescript
const lenient = Effect.matchEffect(parser.parse(html), {
  onFailure: (e): Effect.Effect<unknown, ParseError> =>
    e.code === ErrorCode.MISMATCHED_CLOSE_TAG ? Effect.succeed({ truncated: true }) : Effect.fail(e),
  onSuccess: value => Effect.succeed(value),
});
```

`ParseError` is a plain `Error` subclass with no `_tag`, so `Effect.catchTag` does not apply to it —
match on `code`. And note the asymmetry: `Effect.runSync` **throws** a failed effect's error while
`Effect.runSyncExit` hands it back, so a parse expected to fail wants the latter rather than a
`try` around the former:

```typescript
import { Effect, Result } from 'effect';
import { type ParseError } from '@endevops/parser';

const result = Effect.runSync(Effect.result(parser.parse(html)));

if (Result.isFailure(result)) {
  const error: ParseError = result.failure;
  console.error(error.code, error.index, error.message);
}
```

`autoClose` and this are not rivals. `autoClose: { collectErrors: true }` turns a hard failure into a
result plus a list; `catchIf` decides what the caller does about whatever the parser could not fix.

---

## HTML Preset

The `'html'` shorthand enables all three relaxed behaviours and registers standard HTML void elements (`br`, `img`, `input`, `meta`, etc.) in `tags.unpaired`:

```javascript
const parser = Effect.runSync(XMLParser.make({ autoClose: 'html' }));
```

Equivalent to:

```javascript
Effect.runSync(
  XMLParser.make({
    autoClose: { onEof: 'closeAll', onMismatch: 'discard', collectErrors: true },
    tags: { unpaired: ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'] },
  })
);
```

Any `tags.unpaired` values you add yourself are **merged** with the HTML void elements, not replaced.

```javascript
const parser = Effect.runSync(XMLParser.make({ autoClose: 'html', skip: { attributes: false } }));
Effect.runSync(parser.parse('<html><head><meta charset="UTF-8"></head><body><p>Line one<br>Line two</body></html>'));
// Parses successfully
```

---

## Common Combinations

```javascript
// Stream/truncation recovery only
{ autoClose: { onEof: 'closeAll' } }

// Lenient about mismatches, strict at EOF
{ autoClose: { onMismatch: 'recover' } }

// Fully lenient with error log
{ autoClose: { onEof: 'closeAll', onMismatch: 'recover', collectErrors: true } }
```

---

## Works with all input modes

`autoClose` works identically with `parse()`, `parseStream()`, and `feed()`/`end()`. Errors are attached to the result returned by `end()`.

```javascript
const result = Effect.runSync(
  Effect.gen(function* () {
    const parser = yield* XMLParser.make({ autoClose: { onEof: 'closeAll', collectErrors: true } });
    yield* parser.feed('<root><a>');
    yield* parser.feed('<b>hello</b>');
    const result = yield* parser.end();
    console.log(Effect.runSync(parser.getParseErrors()));
    return result;
  })
);
// result.root.a.b === 'hello'
// [{ type: 'unclosed-eof', tag: 'a', expected: null, index: 6 }]
```

---

➡ Next: [08 — Security](./08-security.md)
