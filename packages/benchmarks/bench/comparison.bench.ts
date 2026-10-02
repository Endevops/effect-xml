// oxlint-disable effecttsgo/schema-number

import { toCodecXml } from '@endevops/effect-xml-codec';
import { XMLParser as NodableXMLParser } from '@nodable/flexible-xml-parser';
import { Effect, Schema } from 'effect';
import UpstreamXMLBuilder from 'fast-xml-builder';
import { XMLParser as UpstreamXMLParser } from 'fast-xml-parser';
import { describe, expect, test } from 'vite-plus/test';

const Order = toCodecXml(
  Schema.Struct({
    '@id': Schema.String,
    '@currency': Schema.String,
    total: Schema.Number,
    placed: Schema.Boolean,
    note: Schema.String,
    customer: Schema.Struct({ '@id': Schema.String, name: Schema.String, email: Schema.String }),
    line: Schema.Array(Schema.Struct({ '@sku': Schema.String, sku: Schema.String, qty: Schema.Number, price: Schema.Number })),
  }),
  { rootName: 'order' }
);

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
const Report = toCodecXml(Schema.Struct({ row: Schema.Array(Row) }), { rootName: 'report' });
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
const Note = toCodecXml(Schema.Struct({ body: Schema.String }), { rootName: 'note' });
const NOTE = `${'lorem ipsum dolor sit amet '.repeat(700)}& <tag> "quoted"`;
const note = { body: NOTE } satisfies Schema.Schema.Type<typeof Note>;
const NOTE_ROOT = 'note';
const ATOM = 'http://www.w3.org/2005/Atom';
const META = 'urn:meta';
const Feed = toCodecXml(
  Schema.Struct({
    '@version': Schema.String.annotate({ xmlNamespace: META, xmlPrefix: 'meta' }),
    title: Schema.String,
    updated: Schema.String,
    entry: Schema.Array(Schema.Struct({ title: Schema.String, link: Schema.Struct({ '@href': Schema.String }) })),
  }).annotate({ xmlNamespace: ATOM }),
  { rootName: 'feed' }
);
const feed = {
  '@version': '1',
  title: 'Example Feed',
  updated: '2026-10-02T00:00:00Z',
  entry: [
    { title: 'First entry', link: { '@href': 'https://example.com/1' } },
    { title: 'Second entry', link: { '@href': 'https://example.com/2' } },
  ],
} satisfies Schema.Schema.Type<typeof Feed>;
const FEED_ROOT = 'feed';

/**
 * @description The same feed for the plain builders. They have no annotations to read, so the namespace declarations are spelled out by hand and the prefixed
 * names are written where the codec writes them.
 */
const feedWire = {
  '@xmlns': ATOM,
  '@xmlns:meta': META,
  '@meta:version': feed['@version'],
  title: feed.title,
  updated: feed.updated,
  entry: feed.entry,
};

const BUILDER_OPTIONS = { attributeNamePrefix: '@', ignoreAttributes: false, suppressEmptyNode: true, format: false } as const;

const upstreamBuilder = new UpstreamXMLBuilder({ ...BUILDER_OPTIONS });
const upstreamParser = new UpstreamXMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false });
const nodableParser = new NodableXMLParser({ skip: { attributes: false } });

const encodeOrder = Schema.encodeEffect(Order);
const encodeReport = Schema.encodeEffect(Report);
const encodeNote = Schema.encodeEffect(Note);
const encodeFeed = Schema.encodeEffect(Feed);
const decodeOrder = Schema.decodeEffect(Order);
const decodeReport = Schema.decodeEffect(Report);
const decodeNote = Schema.decodeEffect(Note);
const decodeFeed = Schema.decodeEffect(Feed);

/**
 * @description Encoding one value to a document is a single effect now: the codec's encode writes the text. The encoding benchmarks run that effect per iteration,
 * which is the whole object-to-XML job. The decoding benchmarks read the document it produces, encoded once here so their bytes are identical on
 * every iteration.
 */
const encodeOrderDocument = encodeOrder(order);
const encodeReportDocument = encodeReport(report);
const encodeNoteDocument = encodeNote(note);
const encodeFeedDocument = encodeFeed(feed);

const orderDocument = Effect.runSync(encodeOrderDocument);
const reportDocument = Effect.runSync(encodeReportDocument);
const noteDocument = Effect.runSync(encodeNoteDocument);
const feedDocument = Effect.runSync(encodeFeedDocument);

/**
 * @description How long to sample each benchmark in a group, and how long to warm it up first. A small document takes single-digit microseconds, so a shorter
 * sample than Tinybench's default still collects tens of thousands of samples without a suite that takes a minute.
 */
const BUDGET = { time: 1000, warmupTime: 50 } as const;

describe('encoding', () => {
  test('a small document', async ({ bench }) => {
    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        encodeOrderDocument.pipe(Effect.runSync);
      }),
      bench('fast-xml-builder', () => {
        upstreamBuilder.build({ [ROOT]: order });
      }),
      BUDGET
    );
  });

  test('a 500-row document', async ({ bench }) => {
    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        encodeReportDocument.pipe(Effect.runSync);
      }),
      bench('fast-xml-builder', () => {
        upstreamBuilder.build({ [REPORT_ROOT]: report });
      }),
      BUDGET
    );
  });

  test('one large text node', async ({ bench }) => {
    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        encodeNoteDocument.pipe(Effect.runSync);
      }),
      bench('fast-xml-builder', () => {
        upstreamBuilder.build({ [NOTE_ROOT]: note });
      }),
      BUDGET
    );
  });
  test('a namespaced document', async ({ bench }) => {
    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        encodeFeedDocument.pipe(Effect.runSync);
      }),
      bench('fast-xml-builder', () => {
        upstreamBuilder.build({ [FEED_ROOT]: feedWire });
      }),
      BUDGET
    );
  });
});

describe('decoding', () => {
  test('a small document', async ({ bench }) => {
    const decode = decodeOrder(orderDocument);
    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        decode.pipe(Effect.runSync);
      }),
      bench('fast-xml-parser', () => {
        upstreamParser.parse(orderDocument);
      }),
      bench('@nodable/flexible-xml-parser', () => {
        nodableParser.parse(orderDocument);
      }),
      BUDGET
    );
  });

  test('a 500-row document', async ({ bench }) => {
    const decode = decodeReport(reportDocument);
    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        decode.pipe(Effect.runSync);
      }),
      bench('fast-xml-parser', () => {
        upstreamParser.parse(reportDocument);
      }),

      bench('@nodable/flexible-xml-parser', () => {
        nodableParser.parse(orderDocument);
      }),
      BUDGET
    );
  });

  test('one large text node', async ({ bench }) => {
    const decode = decodeNote(noteDocument);

    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        decode.pipe(Effect.runSync);
      }),
      bench('fast-xml-parser', () => {
        upstreamParser.parse(noteDocument);
      }),
      bench('@nodable/flexible-xml-parser', () => {
        nodableParser.parse(orderDocument);
      }),
      BUDGET
    );
  });

  test('a namespaced document', async ({ bench }) => {
    const decode = decodeFeed(feedDocument);
    expect(Effect.runSync(decode)).toEqual(feed);
    await bench.compare(
      bench('@endevops/effect-xml-codec', () => {
        decodeFeed(feedDocument).pipe(Effect.runSync);
      }),
      bench('fast-xml-parser', () => {
        upstreamParser.parse(feedDocument);
      }),
      bench('@nodable/flexible-xml-parser', () => {
        nodableParser.parse(orderDocument);
      }),
      BUDGET
    );
  });
});

test('a full round trip, both halves measured', async ({ bench }) => {
  const decode = encodeOrderDocument.pipe(Effect.flatMap(decodeOrder));
  await bench.compare(
    bench('@endevops/effect-xml-codec', () => {
      decode.pipe(Effect.runSync);
    }),
    bench('then parser, both from npm', () => {
      const document = upstreamBuilder.build({ [ROOT]: order });
      upstreamParser.parse(document);
    }),
    bench('then @nodable/parser, both from npm', () => {
      const document = upstreamBuilder.build({ [ROOT]: order });
      nodableParser.parse(document);
    }),
    BUDGET
  );
});
