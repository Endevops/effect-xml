# 08 — Security

`@endevops/parser` includes multiple layers of defence against malicious or pathological input.

---

## ParseError

`ParseError` is the one type in the error channel of every effect this package returns, so you can
distinguish parser errors from unexpected runtime bugs with a single `instanceof` check. It is a plain
`Schema.TaggedError`, so `Effect.catchTag` and `Effect.catchReason` both apply — match on
`code`.

Inspect a failure without catching a throw, using `Effect.runSyncExit` (which hands the failure back,
where `Effect.runSync` would throw it):

```typescript
import { Effect, Result } from 'effect';
import XMLParser from '@endevops/parser';

const result = Effect.runSync(Effect.result(parser.parse(xmlInput)));

if (Result.isFailure(result)) {
  // `ParseError` is the only type in the channel, so there is no `instanceof`
  // to write and nothing to rethrow.
  const error = result.failure;
  console.error(`[${error.code}] index ${error.index}: ${error.message}`);
}
```

Or handle it as a recoverable branch of the program, with `Effect.catchIf`:

```typescript
import { Effect } from 'effect';
import { ErrorCode, ParseError } from '@endevops/parser';

const rejected = Effect.catchIf(
  parser.parse(xmlInput),
  (e): e is ParseError => e.reason._tag === ErrorCode.SECURITY_PROTOTYPE_POLLUTION,
  () => Effect.succeed(null) // anything not matched is re-failed
);
```

### ParseError properties

| Property  | Type                  | Description                                       |
| --------- | --------------------- | ------------------------------------------------- |
| `message` | `string`              | Human-readable description                        |
| `code`    | `ErrorCodeValue`      | Machine-readable code; an alias for `reason._tag` |
| `index`   | `number \| undefined` | 0-based character offset from the document start  |

There is no `line` and no `col`. This parser does no line or column tracking, so a position is an
offset into the source document or nothing at all. See [05-output-builders.md](./05-output-builders.md#position-meta-data).

---

## Structural Limits (DoS Prevention)

```javascript
import { Effect } from 'effect';

Effect.runSync(
  XMLParser.make({
    limits: {
      maxNestedTags: 100, // max tag nesting depth
      maxAttributesPerTag: 50, // max attributes on any single tag
    },
  })
);
```

Both default to `null` (no limit). **For untrusted input, always set both.**

`maxNestedTags` guards against deeply nested documents that exhaust the call stack or heap. `maxAttributesPerTag` guards against attribute-flood attacks. The attributes limit only applies when `skip.attributes: false`.

---

## Entity Expansion Limits (Billion Laughs / XML Bomb)

The Billion Laughs attack uses recursive entity references to produce exponentially large output from a small document. The parser's defence is split into two layers:

**Layer 1 — `doctypeOptions` on `XMLParser`** (enforced at read time):

| Option           | Default | Description                               |
| ---------------- | ------- | ----------------------------------------- |
| `maxEntityCount` | `100`   | Max entities declared in a single DOCTYPE |
| `maxEntitySize`  | `10000` | Max bytes per entity definition value     |

**Layer 2 — `EntitiesValueParser`** from `@endevops/builder` (enforced at replacement time):

| Option               | Default         | Description                                       |
| -------------------- | --------------- | ------------------------------------------------- |
| `maxTotalExpansions` | `0` (unlimited) | Max total entity references expanded per document |
| `maxExpandedLength`  | `0` (unlimited) | Max total characters added by expansion           |

DOCTYPE entity expansion is **disabled by default** (`doctypeOptions.enabled: false`). If you need it, enable it only for trusted input and tighten both layers:

```javascript
import { Effect } from 'effect';
import { EntitiesValueParser } from '@endevops/builder';
import { CompactBuilderFactory } from '@endevops/builder';

const evp = new EntitiesValueParser({ default: true, maxTotalExpansions: 200, maxExpandedLength: 10000 });
const builder = Effect.runSync(CompactBuilderFactory.make());
Effect.runSync(builder.registerValueParser('entity', evp));

Effect.runSync(XMLParser.make({ doctypeOptions: { enabled: true, maxEntityCount: 20, maxEntitySize: 1000 }, OutputBuilder: builder }));
```

---

## Prototype Pollution Prevention

Property names that could corrupt the JavaScript prototype (`__proto__`, `constructor`, `prototype`) are **always rejected** — the effect fails with a `ParseError` whose code is `SECURITY_PROTOTYPE_POLLUTION`, regardless of options.

Dangerous but non-critical names (`hasOwnProperty`, `toString`, `valueOf`, etc.) are sanitised by default: the name is prefixed with `__` in the output. Use `onDangerousProperty` to customise this behaviour.

Option values that would place reserved names into output keys are rejected when the options are resolved, which means `XMLParser.make` fails with code `SECURITY_RESERVED_OPTION` — before a document is read.

When `strictReservedNames: true`, tag or attribute names that collide with any configured `nameFor.*` or `attributes.groupBy` value fail with a `ParseError` whose code is `SECURITY_RESTRICTED_NAME`.

---

## Recommended Configuration for Untrusted Input

```typescript
import { Effect } from 'effect';
import XMLParser, { ParseError } from '@endevops/parser';
import { EntitiesValueParser } from '@endevops/builder';
import { CompactBuilderFactory } from '@endevops/builder';

const evp = new EntitiesValueParser({ default: true, maxTotalExpansions: 500, maxExpandedLength: 50000 });
const builder = Effect.runSync(CompactBuilderFactory.make());
Effect.runSync(builder.registerValueParser('entity', evp));

const parser = Effect.runSync(
  XMLParser.make({
    limits: { maxNestedTags: 100, maxAttributesPerTag: 50 },
    doctypeOptions: { enabled: false }, // never expand DOCTYPE from untrusted input
    strictReservedNames: true,
    OutputBuilder: builder,
  })
);

// Reject the document, log it, and carry on — an async caller catches the promise
const result = await Effect.runPromise(parser.parse(untrustedXml)).catch((e: unknown) => {
  const error = e as ParseError;
  console.warn('XML rejected', { code: error.code, index: error.index });
  return null;
});
```

### ErrorCode Quick Reference

| `ErrorCode`                    | Likely cause                               |
| ------------------------------ | ------------------------------------------ |
| `LIMIT_MAX_NESTED_TAGS`        | Deeply nested or recursive XML             |
| `LIMIT_MAX_ATTRIBUTES`         | Attribute-flood attack                     |
| `ENTITY_MAX_COUNT`             | DOCTYPE with excessive entity declarations |
| `ENTITY_MAX_EXPANSIONS`        | Billion Laughs / XML bomb                  |
| `ENTITY_MAX_EXPANDED_LENGTH`   | Large entity expansion output              |
| `SECURITY_PROTOTYPE_POLLUTION` | Tag/attribute named `__proto__` etc.       |
| `MISMATCHED_CLOSE_TAG`         | Malformed XML (may be intentional fuzzing) |
| `UNEXPECTED_TRAILING_DATA`     | Junk after the root close tag              |

---

➡ Next: [09 — Path Expressions](./09-path-expressions.md)
