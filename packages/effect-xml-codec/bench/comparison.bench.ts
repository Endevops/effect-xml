// oxlint-disable effecttsgo/schema-number

import XMLBuilder from '@endevops/builder';
import { XMLParser } from '@endevops/parser';
import { Effect, Schema } from 'effect';
import UpstreamXMLBuilder from 'fast-xml-builder';
import { XMLParser as UpstreamXMLParser } from 'fast-xml-parser';
import { test } from 'vite-plus/test';

import { toCodecXml } from '#/codec.ts';
import { parseXml } from '#/parse.ts';
import { renderXml } from '#/render.ts';

// ---------------------------------------------------------------------------
// The documents under test
// ---------------------------------------------------------------------------

/**
 * @description The shape most callers have: a few scalar fields, two attributes, one nested object and one repeated child. A document like this is what a single
 * API response turns into, so it is the row that matters most.
 */
const Order = Schema.Struct({
  '@id': Schema.String,
  '@currency': Schema.String,
  total: Schema.Number,
  placed: Schema.Boolean,
  note: Schema.String,
  customer: Schema.Struct({ '@id': Schema.String, name: Schema.String, email: Schema.String }),
  line: Schema.Array(Schema.Struct({ '@sku': Schema.String, sku: Schema.String, qty: Schema.Number, price: Schema.Number })),
}).pipe(toCodecXml);

/**
 * @description One order, as a plain object. Built once, so the benchmarks measure serialization rather than the cost of assembling the thing being serialized.
 */
const order = {
  '@id': 'A-1001',
  '@currency': 'EUR',
  total: 1234.56,
  placed: true,
  note: 'deliver after 5pm',
  customer: { '@id': 'C-77', name: 'Ada Lovelace', email: 'ada@example.com' },
  line: [
    { '@sku': 'S1', sku: 'SKU-1', qty: 2, price: 19.99 },
    { '@sku': 'S2', sku: 'SKU-2', qty: 1, price: 834.58 },
  ],
} satisfies Schema.Schema.Type<typeof Order>;

/**
 * @description The element name the small document is written under. The codec takes it as a root name or from the schema's `identifier`; the builder has no such
 * option, so the value is wrapped in a key of this name instead — see the note at the top of this file.
 */
const ROOT = 'order';

/**
 * @description How many rows the large document has. Large enough that per-element and per-character costs stop being noise, small enough to keep the suite quick.
 */
const ROWS = 500;

/**
 * @description The row shape the large document is built from.
 */
const Row = Schema.Struct({ '@id': Schema.String, '@qty': Schema.String, sku: Schema.String, name: Schema.String, price: Schema.Number });

/**
 * @description The whole large document: a repeated row under a single root element.
 */
const Report = Schema.Struct({ row: Schema.Array(Row) }).pipe(toCodecXml);

/**
 * @description The rows, as one value. Typed against the schema with `satisfies` rather than declared separately, so the benchmark cannot drift from the schema it
 * feeds.
 */
const report = {
  row: Array.from({ length: ROWS }, (_, i) => ({
    '@id': `R-${i}`,
    '@qty': String(i % 7),
    sku: `SKU-${i}`,
    name: `Product number ${i}`,
    price: i + 0.5,
  })),
} satisfies Schema.Schema.Type<typeof Report>;

/**
 * @description The element name the large document is written under.
 */
const REPORT_ROOT = 'report';

/**
 * @description A document that is one large text node rather than many elements. Included because it is the shape where the two approaches diverge most: escaping
 * is a per-character cost rather than a per-element one, and it is the only row here where what a library does with character data dominates
 * everything else it does.
 */
const Note = Schema.Struct({ body: Schema.String }).pipe(toCodecXml);

/**
 * @description The text, long enough to be a real document and with a character needing an escape at both ends of its range, so the escaping path is taken rather
 * than skipped.
 */
const NOTE = `${'lorem ipsum dolor sit amet '.repeat(700)}& <tag> "quoted"`;

/**
 * @description The note, as one value.
 */
const note = { body: NOTE } satisfies Schema.Schema.Type<typeof Note>;

/**
 * @description The element name the note is written under.
 */
const NOTE_ROOT = 'note';

/**
 * @description The settings that make a builder produce the same bytes as this codec, applied to both versions of it. `attributeNamePrefix: '@'` is the one that
 * matters: it is the prefix this codec's convention uses, and with it the two produce the same document. `ignoreAttributes: false` is required for a
 * builder to read prefixed keys as attributes at all — its default drops them. `suppressEmptyNode` matches this codec's default, and `format: false`
 * is what both sides do by default anyway.
 */
const BUILDER_OPTIONS = { attributeNamePrefix: '@', ignoreAttributes: false, suppressEmptyNode: true, format: false } as const;

/**
 * @description `@endevops/builder`, the fork maintained in this workspace.
 */
const builder = XMLBuilder.make({ ...BUILDER_OPTIONS }).pipe(Effect.runSync);

/**
 * @description Upstream `fast-xml-builder` from npm, at the same version as the fork.
 */
const upstreamBuilder = new UpstreamXMLBuilder({ ...BUILDER_OPTIONS });

/**
 * @description `@endevops/parser`. Attributes are skipped by default, and the `@` prefix has to be set separately, so both are given.
 */
const parser = XMLParser.make({ skip: { attributes: false }, attributes: { prefix: '@' } }).pipe(Effect.runSync);

/**
 * @description Upstream `fast-xml-parser`. `parseAttributeValue: false` keeps attribute values as the strings they are in the document, which is what this codec's
 * `@` fields hold; tag values are left to coerce as they normally would.
 */
const upstream = new UpstreamXMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false });

const encodeOrder = Schema.encodeEffect(Order);
const encodeReport = Schema.encodeEffect(Report);
const encodeNote = Schema.encodeEffect(Note);
const decodeOrder = Schema.decodeEffect(Order);
const decodeReport = Schema.decodeEffect(Report);
const decodeNote = Schema.decodeEffect(Note);

/**
 * @description The documents, rendered by this codec so that all three decode from the same bytes.
 */
const orderDocument = Effect.gen(function* () {
  const xml = yield* encodeOrder(order);
  return yield* renderXml(xml, { rootName: ROOT });
}).pipe(Effect.runSync);
const reportDocument = Effect.gen(function* () {
  const xml = yield* encodeReport(report);
  return yield* renderXml(xml, { rootName: REPORT_ROOT });
}).pipe(Effect.runSync);
const noteDocument = Effect.gen(function* () {
  const xml = yield* encodeNote(note);
  return yield* renderXml(xml, { rootName: NOTE_ROOT });
}).pipe(Effect.runSync);

/**
 * @description How long to sample each benchmark in a group, and how long to warm it up first. A small document takes single-digit microseconds, so a shorter
 * sample than Tinybench's default still collects tens of thousands of samples without a suite that takes a minute.
 */
const BUDGET = { time: 1000, warmupTime: 50 } as const;

test('encoding — a small document', async ({ bench }) => {
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const xml = yield* encodeOrder(order);
        yield* renderXml(xml, { rootName: ROOT });
      }).pipe(Effect.runSync);
    }),
    bench('@endevops/builder', () => {
      builder.build({ [ROOT]: order }).pipe(Effect.runSync);
    }),
    bench('fast-xml-builder', () => {
      upstreamBuilder.build({ [ROOT]: order });
    }),
    BUDGET
  );
});

test('encoding — a 500-row document', async ({ bench }) => {
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const xml = yield* encodeReport(report);
        yield* renderXml(xml, { rootName: REPORT_ROOT });
      }).pipe(Effect.runSync);
    }),
    bench('@endevops/builder', () => {
      builder.build({ [REPORT_ROOT]: report }).pipe(Effect.runSync);
    }),
    bench('fast-xml-builder', () => {
      upstreamBuilder.build({ [REPORT_ROOT]: report });
    }),
    BUDGET
  );
});

test('encoding — one large text node', async ({ bench }) => {
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const xml = yield* encodeNote(note);
        yield* renderXml(xml, { rootName: NOTE_ROOT });
      }).pipe(Effect.runSync);
    }),
    bench('@endevops/builder', () => {
      builder.build({ [NOTE_ROOT]: note }).pipe(Effect.runSync);
    }),
    bench('fast-xml-builder', () => {
      upstreamBuilder.build({ [NOTE_ROOT]: note });
    }),
    BUDGET
  );
});

test('decoding — a small document', async ({ bench }) => {
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const xml = yield* parseXml(orderDocument);
        yield* decodeOrder(xml);
      }).pipe(Effect.runSync);
    }),
    bench('@endevops/parser', () => {
      parser.parse(orderDocument).pipe(Effect.runSync);
    }),
    bench('fast-xml-parser', () => {
      upstream.parse(orderDocument);
    }),
    BUDGET
  );
});

test('decoding — a 500-row document', async ({ bench }) => {
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const xml = yield* parseXml(reportDocument);
        yield* decodeReport(xml);
      }).pipe(Effect.runSync);
    }),
    bench('@endevops/parser', () => {
      parser.parse(reportDocument).pipe(Effect.runSync);
    }),
    bench('fast-xml-parser', () => {
      upstream.parse(reportDocument);
    }),
    BUDGET
  );
});

test('decoding — one large text node', async ({ bench }) => {
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const xml = yield* parseXml(noteDocument);
        yield* decodeNote(xml);
      }).pipe(Effect.runSync);
    }),
    bench('@endevops/parser', () => {
      parser.parse(noteDocument).pipe(Effect.runSync);
    }),
    bench('fast-xml-parser', () => {
      upstream.parse(noteDocument);
    }),
    BUDGET
  );
});

test('a full round trip, both halves measured', async ({ bench }) => {
  // The number an application actually cares about: the cost of writing a document and reading it back. Neither builder nor either parser can do both
  // halves, so the last two rows are each ecosystem doing the same work with two libraries and hand-joining them, which is what using them together
  // costs. The two ecosystems are measured separately because a caller picks one, and the difference between them is the difference between the fork
  // and what is on npm.
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const xml = yield* encodeOrder(order);
        const document = yield* renderXml(xml, { rootName: ROOT });
        const xmlValue = yield* parseXml(document);
        yield* decodeOrder(xmlValue);
      }).pipe(Effect.runSync);
    }),
    bench('then parser, both @endevops', () => {
      Effect.gen(function* () {
        const document = yield* builder.build({ [ROOT]: order });
        yield* parser.parse(document);
      }).pipe(Effect.runSync);
    }),
    bench('then parser, both from npm', () => {
      const document = upstreamBuilder.build({ [ROOT]: order });
      upstream.parse(document);
    }),
    BUDGET
  );
});
