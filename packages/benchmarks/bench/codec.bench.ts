import type { XmlValue } from '@endevops/effect-xml-codec';

import { parseXml, renderXml, toCodecXml } from '@endevops/effect-xml-codec';
import { Effect, Schema } from 'effect';
import { describe, test } from 'vite-plus/test';

/**
 * @description The shape most callers have: a handful of scalar fields, one nested struct, one repeated child, and a couple of attributes. A document like this is
 * what a single API response turns into, so it is the row that matters most.
 */
const Order = toCodecXml(
  Schema.Struct({
    '@id': Schema.String,
    '@currency': Schema.String,
    total: Schema.Finite,
    placed: Schema.Boolean,
    note: Schema.String,
    customer: Schema.Struct({ '@id': Schema.String, name: Schema.String, email: Schema.String }),
    line: Schema.Array(Schema.Struct({ sku: Schema.String, qty: Schema.Finite, price: Schema.Finite })),
  }),
  { rootName: 'order' }
);

/**
 * @description One order, as a plain object. Built once: the benchmarks measure serialization, not the cost of assembling the thing being serialized.
 */
const order = {
  '@id': 'A-1001',
  '@currency': 'EUR',
  total: 1234.56,
  placed: true,
  note: 'deliver after 5pm',
  customer: { '@id': 'C-77', name: 'Ada Lovelace', email: 'ada@example.com' },
  line: [
    { sku: 'SKU-1', qty: 2, price: 199.99 },
    { sku: 'SKU-2', qty: 1, price: 834.58 },
  ],
} satisfies Schema.Schema.Type<typeof Order>;

/**
 * @description A document with many rows, which is where per-element and per-character costs stop being noise: anything that scales with the number of elements or
 * the number of characters shows up here and nowhere else.
 */
const Row = Schema.Struct({ '@id': Schema.String, '@qty': Schema.String, sku: Schema.String, name: Schema.String, price: Schema.Finite });

/**
 * @description How many rows the large document has. Large enough that per-row costs dominate the per-call costs, small enough to keep the suite quick.
 */
const ROWS = 500;

/**
 * @description The rows, as one value. Typed against the schema rather than with `satisfies`, so the benchmark cannot drift from the schema it feeds.
 */
const rows: { row: Array<Schema.Schema.Type<typeof Row>> } = {
  row: Array.from({ length: ROWS }, (_, i) => ({
    '@id': `R-${i}`,
    '@qty': String(i % 7),
    sku: `SKU-${i}`,
    name: `Product number ${i}`,
    price: i + 0.5,
  })),
};

const Report = toCodecXml(Schema.Struct({ row: Schema.Array(Row) }), { rootName: 'report' });

/**
 * @description The decode rows' inputs: the documents this codec produces, encoded once here so every decode iteration reads byte-identical bytes and the row
 * measures the decoder rather than the encoder.
 */
const rowsDocument = Schema.encodeSync(Report)(rows);

const orderDocument = Schema.encodeSync(Order)(order);

/**
 * @description A record of plain character data, for isolating the renderer from the escaping it normally does.
 */
const cleanValue = { title: 'Dune', author: 'Frank Herbert', isbn: '9780441013593' };

/**
 * @description The same record with every XML-unsafe character in every field, for the other half of the escaping comparison.
 */
const dirtyValue = { title: 'Dune & <Messiah>', author: 'Frank "Frank" Herbert', isbn: 'a&b<c>d"e' };

/**
 * @description How long to sample each benchmark in a group, and how long to warm it up first. Serialization is measured in the tens of microseconds for the small
 * document, so a shorter sample than Tinybench's default collects plenty of samples without a suite that takes a minute.
 */
const BUDGET = { time: 1000, warmupTime: 50 } as const;

describe('codec', () => {
  test('a small document', async ({ bench }) => {
    const encode = Schema.encodeEffect(Order);
    const decode = Schema.decodeEffect(Order);

    // Each pipeline is built once and run per iteration: one `Effect.runSync` per
    // iteration, over the whole chain. The codec's encode writes the document and
    // its decode reads one, so the round trip is just the two of them joined.
    const encodeDocument = encode(order);
    const decodeDocument = decode(orderDocument);
    const roundTrip = encode(order).pipe(Effect.flatMap(decode));

    await bench.compare(
      bench('encode', () => {
        Effect.runSync(encodeDocument);
      }),
      bench('decode', () => {
        Effect.runSync(decodeDocument);
      }),
      bench('round trip', () => {
        Effect.runSync(roundTrip);
      }),
      BUDGET
    );
  });

  test('a large document', async ({ bench }) => {
    const encode = Schema.encodeEffect(Report);
    const decode = Schema.decodeEffect(Report);

    const encodeDocument = encode(rows);
    const decodeDocument = decode(rowsDocument);

    await bench.compare(
      bench('encode', () => {
        Effect.runSync(encodeDocument);
      }),
      bench('decode', () => {
        Effect.runSync(decodeDocument);
      }),
      BUDGET
    );
  });

  test('the layer underneath', async ({ bench }) => {
    // The same work without the schema, so the difference between these rows and
    // the rows above is what Effect's derivation costs on every call.
    const xml: XmlValue = { '@id': 'A-1001', title: 'Dune', total: '1234.56', placed: 'true', tag: ['a', 'b', 'c'] };

    const render = renderXml(xml, { rootName: 'r' });
    const parse = parseXml('<r id="A-1001"><title>Dune</title><total>1234.56</total><placed>true</placed><tag>a</tag><tag>b</tag><tag>c</tag></r>');
    await bench.compare(
      bench('render, no schema', () => {
        render.pipe(Effect.runSync);
      }),
      bench('parse, no schema', () => {
        parse.pipe(Effect.runSync);
      }),
      BUDGET
    );
  });

  test('what escaping costs', async ({ bench }) => {
    // The two rows either side of these are the same render with and without
    // anything to escape, so the difference is the escaping pass itself.
    const long = 'word '.repeat(4000);

    const renderClean = renderXml(cleanValue, { rootName: 'r' });
    const renderDirty = renderXml(dirtyValue, { rootName: 'r' });
    const renderLong = renderXml({ body: long }, { rootName: 'r' });
    const renderLongDirty = renderXml({ body: `${long}&` }, { rootName: 'r' });

    await bench.compare(
      bench('render clean text', () => {
        renderClean.pipe(Effect.runSync);
      }),
      bench('render text needing escapes', () => {
        renderDirty.pipe(Effect.runSync);
      }),
      bench('render 20k of clean text', () => {
        renderLong.pipe(Effect.runSync);
      }),
      bench('render 20k of text with one unsafe character', () => {
        renderLongDirty.pipe(Effect.runSync);
      }),
      BUDGET
    );
  });

  test('the document shape', async ({ bench }) => {
    const xml: XmlValue = {
      row: Array.from({ length: ROWS }, (_, i) => ({ '@id': `R-${i}`, sku: `SKU-${i}`, name: `Product ${i}`, price: `${i}.5` })),
    };
    const render = renderXml(xml, { rootName: 'report' });
    const renderIndented = renderXml(xml, { rootName: 'report', format: true });
    const parse = parseXml(rowsDocument);
    const parsePreserveWhitespace = parseXml(rowsDocument, { preserveWhitespace: true });

    await bench.compare(
      bench('render, compact', () => {
        render.pipe(Effect.runSync);
      }),
      bench('render, indented', () => {
        renderIndented.pipe(Effect.runSync);
      }),
      bench('parse, 500 rows', () => {
        parse.pipe(Effect.runSync);
      }),
      bench('parse, 500 rows, keeping whitespace', () => {
        parsePreserveWhitespace.pipe(Effect.runSync);
      }),
      BUDGET
    );
  });
});
