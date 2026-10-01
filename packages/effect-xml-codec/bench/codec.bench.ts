import { Effect, Schema } from 'effect';
import { afterAll, describe, expect, test } from 'vite-plus/test';

import type { XmlValue } from '#/xml-value.ts';

import { toCodecXml } from '#/codec.ts';
import { parseXml } from '#/parse.ts';
import { renderXml } from '#/render.ts';
import { isXmlArray, isXmlRecord } from '#/xml-value.ts';

/**
 * @description The shape most callers have: a handful of scalar fields, one nested struct, one repeated child, and a couple of attributes. A document like this is
 * what a single API response turns into, so it is the row that matters most.
 */
const Order = Schema.Struct({
  '@id': Schema.String,
  '@currency': Schema.String,
  total: Schema.Finite,
  placed: Schema.Boolean,
  note: Schema.String,
  customer: Schema.Struct({ '@id': Schema.String, name: Schema.String, email: Schema.String }),
  line: Schema.Array(Schema.Struct({ sku: Schema.String, qty: Schema.Finite, price: Schema.Finite })),
}).pipe(toCodecXml);

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

const Report = Schema.Struct({ row: Schema.Array(Row) }).pipe(toCodecXml);

/**
 * @description The decode rows' inputs: the documents this codec produces, rendered once here so every decode iteration reads byte-identical bytes and the row
 * measures the decoder rather than the renderer. Each is one piped effect run once, not a schema call and a render call joined by two separate runs.
 */
const rowsDocument = Schema.encodeEffect(Report)(rows).pipe(
  Effect.flatMap(value => renderXml(value, { rootName: 'report' })),
  Effect.runSync
);

const orderDocument = Schema.encodeEffect(Order)(order).pipe(
  Effect.flatMap(value => renderXml(value, { rootName: 'order' })),
  Effect.runSync
);

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

/**
 * @description Accumulates a property of every result the benchmarks below produce. A benchmark whose result is dropped is one the JIT is free to optimise into a
 * no-op, which reports a meaningless number rather than an obviously wrong one. `afterAll` reads it back, so the work is observable and the counter
 * cannot itself be optimised away.
 */
let observed = 0;

/**
 * @description A number derived from any XML value, so a parse benchmark can fold its result into {@link observed}. An `XmlValue` has no `length` of its own — it
 * is a string, an array, or a record — and counting what it holds is enough to keep the work from being optimised away.
 *
 * @param value - The value to size.
 *
 * @returns A number that depends on the whole value.
 */
const sizeOf = (value: XmlValue): number => {
  if (typeof value === 'string') return value.length;
  if (isXmlArray(value)) return value.length;
  if (isXmlRecord(value)) return Object.keys(value).length;
  return 0;
};

afterAll(() => {
  // An empty sink means the benchmark bodies never reached the line that folds a result in, so the tables describe a run that did no work.
  expect(observed).toBeGreaterThan(0);
});

describe('codec', () => {
  test('a small document', async ({ bench }) => {
    const rootName = 'order';
    const encode = Schema.encodeEffect(Order);
    const decode = Schema.decodeEffect(Order);

    // Each pipeline is built once and run per iteration: one `Effect.runSync` per
    // iteration, over the whole chain. The decode parses first — `decode` reads the
    // XML value tree, not the document text — and the round trip runs both halves.
    const encodeDocument = encode(order).pipe(Effect.flatMap(value => renderXml(value, { rootName })));
    const decodeDocument = parseXml(orderDocument).pipe(Effect.flatMap(xml => decode(xml)));
    const roundTrip = encode(order).pipe(
      Effect.flatMap(value => renderXml(value, { rootName })),
      Effect.flatMap(document => parseXml(document)),
      Effect.flatMap(xml => decode(xml))
    );

    await bench.compare(
      bench('encode', () => {
        observed += Effect.runSync(encodeDocument).length;
      }),
      bench('decode', () => {
        observed += Effect.runSync(decodeDocument) === null ? 0 : 1;
      }),
      bench('round trip', () => {
        observed += Effect.runSync(roundTrip) === null ? 0 : 1;
      }),
      BUDGET
    );
  });

  test('a large document', async ({ bench }) => {
    const schema = Schema.Struct({ row: Schema.Array(Row) }).pipe(toCodecXml);
    const rootName = 'report';
    const encode = Schema.encodeEffect(schema);
    const decode = Schema.decodeEffect(schema);

    const encodeDocument = encode(rows).pipe(Effect.flatMap(value => renderXml(value, { rootName })));
    const decodeDocument = parseXml(rowsDocument).pipe(Effect.flatMap(xml => decode(xml)));

    await bench.compare(
      bench('encode', () => {
        observed += Effect.runSync(encodeDocument).length;
      }),
      bench('decode', () => {
        observed += Effect.runSync(decodeDocument) === null ? 0 : 1;
      }),
      BUDGET
    );
  });

  test('the layer underneath', async ({ bench }) => {
    // The same work without the schema, so the difference between these rows and
    // the rows above is what Effect's derivation costs on every call.
    const xml: XmlValue = { '@id': 'A-1001', title: 'Dune', total: '1234.56', placed: 'true', tag: ['a', 'b', 'c'] };

    await bench.compare(
      bench('render, no schema', () => {
        observed += Effect.runSync(renderXml(xml, { rootName: 'r' })).length;
      }),
      bench('parse, no schema', () => {
        observed += sizeOf(
          Effect.runSync(
            parseXml('<r id="A-1001"><title>Dune</title><total>1234.56</total><placed>true</placed><tag>a</tag><tag>b</tag><tag>c</tag></r>')
          )
        );
      }),
      BUDGET
    );
  });

  test('what escaping costs', async ({ bench }) => {
    // The two rows either side of these are the same render with and without
    // anything to escape, so the difference is the escaping pass itself.
    const long = 'word '.repeat(4000);

    await bench.compare(
      bench('render clean text', () => {
        observed += Effect.runSync(renderXml(cleanValue, { rootName: 'r' })).length;
      }),
      bench('render text needing escapes', () => {
        observed += Effect.runSync(renderXml(dirtyValue, { rootName: 'r' })).length;
      }),
      bench('render 20k of clean text', () => {
        observed += Effect.runSync(renderXml({ body: long }, { rootName: 'r' })).length;
      }),
      bench('render 20k of text with one unsafe character', () => {
        observed += Effect.runSync(renderXml({ body: `${long}&` }, { rootName: 'r' })).length;
      }),
      BUDGET
    );
  });

  test('the document shape', async ({ bench }) => {
    const xml: XmlValue = {
      row: Array.from({ length: ROWS }, (_, i) => ({ '@id': `R-${i}`, sku: `SKU-${i}`, name: `Product ${i}`, price: `${i}.5` })),
    };

    await bench.compare(
      bench('render, compact', () => {
        observed += Effect.runSync(renderXml(xml, { rootName: 'report' })).length;
      }),
      bench('render, indented', () => {
        observed += Effect.runSync(renderXml(xml, { rootName: 'report', format: true })).length;
      }),
      bench('parse, 500 rows', () => {
        observed += sizeOf(Effect.runSync(parseXml(rowsDocument)));
      }),
      bench('parse, 500 rows, keeping whitespace', () => {
        observed += sizeOf(Effect.runSync(parseXml(rowsDocument, { preserveWhitespace: true })));
      }),
      BUDGET
    );
  });
});
