# 01 — Getting Started

## Installation

```bash
npm install @endevops/parser @endevops/builder
```

Install additional output builders only as needed:

```bash
npm install @nodable/node-tree-builder
npm install @nodable/sequential-builder
```

## Every entry point is an `Effect`

This package has one shape for "this can fail". A parser is configured rather than merely
allocated, and configuring one validates options, refuses reserved property names and compiles
every stop-node and skip-tag path expression — all of which can fail. So construction is an
effect:

```typescript
import { Effect } from 'effect';
import XMLParser from '@endevops/parser';

const program = Effect.gen(function* () {
  const parser = yield* XMLParser.make();
  return yield* parser.parse(`
    <books>
      <book id="1">
        <title>The Great Gatsby</title>
        <year>1925</year>
        <price>10.99</price>
      </book>
    </books>
  `);
});

Effect.runSync(program);
// { books: { book: { year: 1925, price: 10.99, title: 'The Great Gatsby' } } }
```

`XMLParser.make` is the way in. `parse`, `parseBytesArr`, `parseStream`, `feed` and `end` all
answer with an `Effect` too, and the only thing that can fail is a `ParseError`.

## Your First Parser

```typescript
import { Effect } from 'effect';
import XMLParser from '@endevops/parser';

const parser = Effect.runSync(XMLParser.make());
const result = Effect.runSync(
  parser.parse(`
  <books>
    <book id="1">
      <title>The Great Gatsby</title>
      <year>1925</year>
      <price>10.99</price>
    </book>
  </books>
`)
);
// { books: { book: { year: 1925, price: 10.99, title: 'The Great Gatsby' } } }
```

`Effect.runSync` is the shortest path from an effect to a value. In real code prefer
`Effect.runPromise`, or a runtime, and the examples below are written to show that shape.

Numbers and booleans are automatically coerced. To include attributes, disable the default skip:

```typescript
const parser = Effect.runSync(XMLParser.make({ skip: { attributes: false } }));
Effect.runSync(parser.parse('<book id="1"><title>1984</title></book>'));
// { book: { '@_id': 1, title: '1984' } }
```

## Handling failure

`ParseError` is a union of 33 classes, one per cause, so a failure names itself: `_tag` is the
cause, `code` is an alias for it, and `index` is the position where there is one. Match on `_tag`
rather than on the message — and read the numbers off the error rather than parsing them out of the
text.

```typescript
import { Effect, Result } from 'effect';
import XMLParser, { type ParseError } from '@endevops/parser';

const program = Effect.gen(function* () {
  const parser = yield* XMLParser.make();
  return yield* parser.parse(untrustedXml);
});

const result = Effect.runSync(Effect.result(program));

if (Result.isFailure(result)) {
  const error: ParseError = result.failure;
  console.error(error.code, error.index, error.message);
  // e.g. 'MISMATCHED_CLOSE_TAG' 42 "Unexpected closing tag 'b' expecting 'a'"
}
```

`Effect.result` is the convenient form: it turns the effect into a `Result`, which cannot fail in
its own right, so there is no `Exit` to unpack and no cast to write. `Effect.runSyncExit` with
`Exit.isFailure` works too, but a `Cause` exposes its failures through `reasons` — the error is on
the individual `Fail` reason, not on the cause itself — so reaching for it takes more than
`cause.error`.

Recovering from one specific failure, rather than inspecting every one. Every cause is its own class
tagged with its `ErrorCode` value, so `Effect.catchTag` matches on that tag and hands the handler the
class — with the numbers and names a handler needs.

```typescript
import { Effect } from 'effect';
import XMLParser, { ErrorCode } from '@endevops/parser';

const program = Effect.gen(function* () {
  const parser = yield* XMLParser.make();
  return yield* parser.parse(xml);
});

// Treat a mismatched closing tag as end-of-document rather than a failure
const lenient = Effect.catchTag(program, ErrorCode.MISMATCHED_CLOSE_TAG, error =>
  Effect.succeed({ truncated: true, got: error.tag, wanted: error.expected })
);
```

`Effect.matchEffect` is the alternative when the recovery is itself a multi-step program. Its
`onFailure` branch re-fails anything it does not handle, so an unexpected failure still surfaces
rather than being swallowed:

```typescript
import { Effect } from 'effect';
import { ErrorCode, type ParseError } from '@endevops/parser';

const lenient = Effect.matchEffect(program, {
  onFailure: (e): Effect.Effect<unknown, ParseError> =>
    e._tag === ErrorCode.MISMATCHED_CLOSE_TAG ? Effect.succeed({ truncated: true }) : Effect.fail(e),
  onSuccess: value => Effect.succeed(value),
});
```

## Common Patterns

### Parse a config file

```typescript
const parser = Effect.runSync(XMLParser.make());
const config = Effect.runSync(parser.parse(xmlString));

console.log(config.config.database.host); // 'localhost'
console.log(config.config.database.port); // 5432 (number)
console.log(config.config.cache.enabled); // true (boolean)
```

### Parse an RSS feed

```typescript
const parser = Effect.runSync(XMLParser.make({ skip: { attributes: false } }));
const feed = Effect.runSync(parser.parse(rssFeedXml));

for (const item of feed.rss.channel.item) {
  console.log(item.title, item.link);
}
```

### Keep everything as raw strings

```typescript
import { Effect } from 'effect';
import { CompactBuilderFactory } from '@endevops/builder';
import XMLParser from '@endevops/parser';

const builder = Effect.runSync(CompactBuilderFactory.make({ tags: { valueParsers: [] }, attributes: { valueParsers: [] } }));
const parser = Effect.runSync(XMLParser.make({ OutputBuilder: builder }));
// All values come out as strings — no type coercion
```

### Keep leading zeros (e.g. SKUs, zip codes)

```typescript
import { Effect } from 'effect';
import { CompactBuilderFactory, NumberValueParser } from '@endevops/builder';
import XMLParser from '@endevops/parser';

const builder = Effect.runSync(
  CompactBuilderFactory.make({ tags: { valueParsers: ['entity', new NumberValueParser({ leadingZeros: false }), 'boolean'] } })
);
const parser = Effect.runSync(XMLParser.make({ OutputBuilder: builder }));
Effect.runSync(parser.parse('<item><sku>00123</sku><price>9.99</price></item>'));
// { item: { sku: '00123', price: 9.99 } }
```

### Strip namespace prefixes

```typescript
const parser = Effect.runSync(XMLParser.make({ skip: { nsPrefix: true, attributes: false } }));
Effect.runSync(parser.parse('<soap:Envelope><soap:Body><m:Item>Apple</m:Item></soap:Body></soap:Envelope>'));
// { Envelope: { Body: { Item: 'Apple' } } }
```

### Parse untrusted XML safely

```typescript
import { Effect } from 'effect';
import XMLParser, { type ParseError } from '@endevops/parser';

const program = Effect.gen(function* () {
  const parser = yield* XMLParser.make({ limits: { maxNestedTags: 50, maxAttributesPerTag: 20 }, doctypeOptions: { enabled: false } });
  return yield* parser.parse(untrustedXml);
});

const result = await Effect.runPromise(program).catch(e => {
  const error = e as ParseError;
  console.error(error.code, error.message);
  return null;
});
```

### Handle CDATA

```typescript
// Option 1 (default): CDATA merged into text
const parser1 = Effect.runSync(XMLParser.make());
Effect.runSync(parser1.parse('<html><![CDATA[<div>content</div>]]></html>'));
// { html: '<div>content</div>' }

// Option 2: separate CDATA key
const parser2 = Effect.runSync(XMLParser.make({ nameFor: { cdata: '#cdata' } }));
Effect.runSync(parser2.parse('<html><![CDATA[<div>content</div>]]></html>'));
// { html: { '#cdata': '<div>content</div>' } }
```

## Quick Reference — Most Used Options

```typescript
Effect.runSync(
  XMLParser.make({
    skip: { attributes: false }, // parse attributes
    nameFor: { cdata: '#cdata' }, // separate CDATA key
    attributes: { prefix: '@_' }, // attribute key prefix
    tags: { unpaired: ['br', 'img'] }, // void/self-closing HTML tags
    limits: { maxNestedTags: 100 }, // DoS guard
  })
);
```

---

➡ Next: [02 — Options Reference](./02-options.md)
