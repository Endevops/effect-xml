# 08 — Security

`@endevops/parser` includes multiple layers of defence against malicious or pathological input.

---

## ParseError

`ParseError` is the one type in the error channel of every effect this package returns. It is a union
of 33 classes, one per cause, and a union has no `instanceof` — so telling a parser failure from an
unexpected runtime bug is `isParseError`, and recovering from one is `Effect.catchTag` on its `_tag`,
which is the same value `code` reads.

Inspect a failure without catching a throw. `Effect.result` hands the failure back in a `Result`,
where `Effect.runSync` would throw it:

```typescript
import { Effect, Result } from 'effect';
import XMLParser from '@endevops/parser';

const result = Effect.runSync(Effect.result(parser.parse(xmlInput)));

if (Result.isFailure(result)) {
  // Every failure in the channel is one of the 33 classes, so there is no
  // second error type to rethrow and no `instanceof` to write.
  const error = result.failure;
  console.error(`[${error.code}] index ${error.index}: ${error.message}`);
}
```

Or handle one as a recoverable branch of the program, by its tag:

```typescript
import { Effect } from 'effect';
import { ErrorCode } from '@endevops/parser';

const rejected = Effect.catchTag(
  parser.parse(xmlInput),
  ErrorCode.SECURITY_PROTOTYPE_POLLUTION,
  error => Effect.succeed(null) // anything not matched is re-failed
);
```

`Effect.catchIf` takes a refinement instead, for when the test is a predicate rather than a tag. Name
the class in the guard and the payload stays available in the handler:

```typescript
import { Effect } from 'effect';
import { SecurityPrototypePollution } from '@endevops/parser';

const rejected = Effect.catchIf(
  parser.parse(xmlInput),
  (e): e is SecurityPrototypePollution => e instanceof SecurityPrototypePollution,
  error => Effect.succeed(error.name)
);
```

### What a `ParseError` carries

All 33 classes carry the same four fields:

| Property  | Type                  | Description                                                            |
| --------- | --------------------- | ---------------------------------------------------------------------- |
| `_tag`    | `ErrorCodeValue`      | The cause. This is what `Effect.catchTag` matches on                   |
| `code`    | `ErrorCodeValue`      | An alias for `_tag`, kept for the comparisons that predate the classes |
| `index`   | `number \| undefined` | 0-based character offset from the document start                       |
| `message` | `string`              | Human-readable description                                             |

The security causes carry the name they refused, so a handler can report it without re-reading
`message`: `SecurityPrototypePollution` has `name`, `SecurityReservedOption` has `option` and
`value`, `SecurityRestrictedName` has `name` and a `kind` of `'tag'` or `'attribute'`.

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

Property names that could corrupt the JavaScript prototype (`__proto__`, `constructor`, `prototype`) are **always rejected** — the effect fails with a `SecurityPrototypePollution`, whose `_tag` is `SECURITY_PROTOTYPE_POLLUTION`, regardless of options.

Dangerous but non-critical names (`hasOwnProperty`, `toString`, `valueOf`, etc.) are sanitised by default: the name is prefixed with `__` in the output. Use `onDangerousProperty` to customise this behaviour.

Option values that would place reserved names into output keys are rejected when the options are resolved, which means `XMLParser.make` fails with a `SecurityReservedOption` — before a document is read, so there is no `index` to report.

When `strictReservedNames: true`, tag or attribute names that collide with any configured `nameFor.*` or `attributes.groupBy` value fail with a `SecurityRestrictedName`, carrying `name` and a `kind` of `'tag'` or `'attribute'`.

---

## Recommended Configuration for Untrusted Input

```typescript
import { Effect } from 'effect';
import XMLParser, { type ParseError } from '@endevops/parser';
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

Each code is the `_tag` of the class beside it, so a row names both the thing to compare and the
thing to `instanceof`.

| `ErrorCode`                    | Class                        | Likely cause                               |
| ------------------------------ | ---------------------------- | ------------------------------------------ |
| `LIMIT_MAX_NESTED_TAGS`        | `LimitMaxNestedTags`         | Deeply nested or recursive XML             |
| `LIMIT_MAX_ATTRIBUTES`         | `LimitMaxAttributes`         | Attribute-flood attack                     |
| `ENTITY_MAX_COUNT`             | `EntityMaxCount`             | DOCTYPE with excessive entity declarations |
| `ENTITY_MAX_EXPANSIONS`        | `EntityMaxExpansions`        | Billion Laughs / XML bomb                  |
| `ENTITY_MAX_EXPANDED_LENGTH`   | `EntityMaxExpandedLength`    | Large entity expansion output              |
| `SECURITY_PROTOTYPE_POLLUTION` | `SecurityPrototypePollution` | Tag/attribute named `__proto__` etc.       |
| `MISMATCHED_CLOSE_TAG`         | `MismatchedCloseTag`         | Malformed XML (may be intentional fuzzing) |
| `UNEXPECTED_TRAILING_DATA`     | `UnexpectedTrailingData`     | Junk after the root close tag              |

---

➡ Next: [09 — Path Expressions](./09-path-expressions.md)
