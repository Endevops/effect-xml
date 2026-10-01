// oxlint-disable effecttsgo/schema-number

import XMLBuilder from '@endevops/builder';
import { XMLParser } from '@endevops/parser';
import { Effect, Schema } from 'effect';
import UpstreamXMLBuilder from 'fast-xml-builder';
import { XMLParser as UpstreamXMLParser } from 'fast-xml-parser';
import { describe, test } from 'vite-plus/test';

import { toCodecXml } from '#/codec.ts';
import { parseXml } from '#/parse.ts';
import { renderXml } from '#/render.ts';

const Order = Schema.Struct({
  '@id': Schema.String,
  '@currency': Schema.String,
  total: Schema.Number,
  placed: Schema.Boolean,
  note: Schema.String,
  customer: Schema.Struct({ '@id': Schema.String, name: Schema.String, email: Schema.String }),
  line: Schema.Array(Schema.Struct({ '@sku': Schema.String, sku: Schema.String, qty: Schema.Number, price: Schema.Number })),
}).pipe(toCodecXml);

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
const ROOT = 'order';
const ROWS = 500;
const Row = Schema.Struct({ '@id': Schema.String, '@qty': Schema.String, sku: Schema.String, name: Schema.String, price: Schema.Number });
const Report = Schema.Struct({ row: Schema.Array(Row) }).pipe(toCodecXml);
const report = {
  row: Array.from({ length: ROWS }, (_, i) => ({
    '@id': `R-${i}`,
    '@qty': String(i % 7),
    sku: `SKU-${i}`,
    name: `Product number ${i}`,
    price: i + 0.5,
  })),
} satisfies Schema.Schema.Type<typeof Report>;
const REPORT_ROOT = 'report';
const Note = Schema.Struct({ body: Schema.String }).pipe(toCodecXml);
const NOTE = `${'lorem ipsum dolor sit amet '.repeat(700)}& <tag> "quoted"`;
const note = { body: NOTE } satisfies Schema.Schema.Type<typeof Note>;
const NOTE_ROOT = 'note';
const BUILDER_OPTIONS = { attributeNamePrefix: '@', ignoreAttributes: false, suppressEmptyNode: true, format: false } as const;
const builder = XMLBuilder.make({ ...BUILDER_OPTIONS }).pipe(Effect.runSync);
const upstreamBuilder = new UpstreamXMLBuilder({ ...BUILDER_OPTIONS });
const parser = XMLParser.make({ skip: { attributes: false }, attributes: { prefix: '@' } }).pipe(Effect.runSync);
const upstreamParser = new UpstreamXMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false });

const encodeOrder = Schema.encodeEffect(Order);
const encodeReport = Schema.encodeEffect(Report);
const encodeNote = Schema.encodeEffect(Note);
const decodeOrder = Schema.decodeEffect(Order);
const decodeReport = Schema.decodeEffect(Report);
const decodeNote = Schema.decodeEffect(Note);

/**
 * @description Encoding one value to a document, as one pipeline: the schema encodes it to the XML value tree, then the renderer writes that tree as text. The
 * encoding benchmarks run the whole effect per iteration — the encode is half of what the row measures, and leaving it out of the timed region would
 * compare this codec's renderer alone against a builder that does the whole object-to-XML job. The decoding benchmarks read the document it produces,
 * run once here so their bytes are identical on every iteration.
 */
const encodeOrderDocument = Effect.gen(function* () {
  const xml = yield* encodeOrder(order);
  return yield* renderXml(xml, { rootName: ROOT });
});
const encodeReportDocument = Effect.gen(function* () {
  const xml = yield* encodeReport(report);
  return yield* renderXml(xml, { rootName: REPORT_ROOT });
});
const encodeNoteDocument = Effect.gen(function* () {
  const xml = yield* encodeNote(note);
  return yield* renderXml(xml, { rootName: NOTE_ROOT });
});

const orderDocument = Effect.runSync(encodeOrderDocument);
const reportDocument = Effect.runSync(encodeReportDocument);
const noteDocument = Effect.runSync(encodeNoteDocument);

/**
 * @description How long to sample each benchmark in a group, and how long to warm it up first. A small document takes single-digit microseconds, so a shorter
 * sample than Tinybench's default still collects tens of thousands of samples without a suite that takes a minute.
 */
const BUDGET = { time: 1000, warmupTime: 50 } as const;

describe('encoding', () => {
  test('a small document', async ({ bench }) => {
    await bench.compare(
      bench('this codec', () => {
        Effect.runSync(encodeOrderDocument);
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

  test('a 500-row document', async ({ bench }) => {
    await bench.compare(
      bench('this codec', () => {
        Effect.runSync(encodeReportDocument);
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

  test('one large text node', async ({ bench }) => {
    await bench.compare(
      bench('this codec', () => {
        Effect.runSync(encodeNoteDocument);
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
});

describe('decoding', () => {
  test('a small document', async ({ bench }) => {
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
        upstreamParser.parse(orderDocument);
      }),
      BUDGET
    );
  });

  test('a 500-row document', async ({ bench }) => {
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
        upstreamParser.parse(reportDocument);
      }),
      BUDGET
    );
  });

  test('one large text node', async ({ bench }) => {
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
        upstreamParser.parse(noteDocument);
      }),
      BUDGET
    );
  });
});

test('a full round trip, both halves measured', async ({ bench }) => {
  await bench.compare(
    bench('this codec', () => {
      Effect.gen(function* () {
        const document = yield* encodeOrderDocument;
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
      upstreamParser.parse(document);
    }),
    BUDGET
  );
});
