/**
 * @description Throughput benchmarks for the two hot paths an application that serializes XML spends its time in: turning a typed value into a document, and
 * turning a document back into one. Split by layer as well as by direction, because the question "is the codec slow" has two very different answers
 * depending on whether the cost is in Effect's schema derivation, in this package's renderer, or in the parser. `renderXml` and `parseXmlSync` are
 * measured on their own for exactly that reason: the gap between a codec row and its bare counterpart is what Effect's derivation costs, and that is
 * not something this package can optimise. Every benchmark folds its result into a module-scope counter that `afterAll` reads back. A discarded
 * result is a result the JIT is free to delete, which would make a benchmark that measured nothing look like a very fast codec. The `escape` suite is
 * the one to read first. Escaping is the only place the renderer touches every character of the document, so it is the only part whose cost scales
 * with content rather than with structure, and the two rows between them say how much of a document's serialization is escaping.
 */

import { Schema } from 'effect';
import { afterAll, bench, describe, expect } from 'vite-plus/test';

import type { XmlValue } from '#/index.ts';

import { isXmlArray, isXmlRecord, parseXmlSync, renderXml, toCodecXml } from '#/index.ts';

/**
 * @description The shape most callers have: a handful of scalar fields, one nested struct, one repeated child, and a couple of attributes. A document like this is
 * what a single API response turns into, so it is the row that matters most.
 */
const Order = Schema.Struct({
  '@id': Schema.String,
  '@currency': Schema.String,
  total: Schema.Number,
  placed: Schema.Boolean,
  note: Schema.String,
  customer: Schema.Struct({ '@id': Schema.String, name: Schema.String, email: Schema.String }),
  line: Schema.Array(Schema.Struct({ sku: Schema.String, qty: Schema.Number, price: Schema.Number })),
});

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
const Row = Schema.Struct({ '@id': Schema.String, '@qty': Schema.String, sku: Schema.String, name: Schema.String, price: Schema.Number });

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

/**
 * @description The same rows as a document, for the parsing benchmarks. Rendering them once here rather than inside a benchmark keeps the parse rows measuring the
 * parser.
 */
const rowsDocument = toCodecXml(Schema.Struct({ row: Schema.Array(Row) }), { rootName: 'report' }).encodeTextSync(rows);

/**
 * @description The small document as text, for the parsing benchmarks.
 */
const orderDocument = toCodecXml(Order, { rootName: 'order' }).encodeTextSync(order);

/**
 * @description A record of plain character data, for isolating the renderer from the escaping it normally does.
 */
const cleanValue: XmlValue = { title: 'Dune', author: 'Frank Herbert', isbn: '9780441013593' };

/**
 * @description The same record with every XML-unsafe character in every field, for the other half of the escaping comparison.
 */
const dirtyValue: XmlValue = { title: 'Dune & <Messiah>', author: 'Frank "Frank" Herbert', isbn: 'a&b<c>d"e' };

/**
 * @description Accumulates the outcome of every operation the benchmarks perform, so the work is observable rather than discardable.
 */
let observed = 0;

/**
 * @description A number derived from any parsed value, so a parse benchmark can fold its result into the counter. An `XmlValue` has no `length` of its own — it is
 * a string, an array, or a record — and counting what it holds is enough to keep the work from being optimised away.
 *
 * @param value - The value the parser produced.
 *
 * @returns A number that depends on the whole value.
 */
const sizeOf = (value: XmlValue): number => {
  if (typeof value === 'string') return value.length;
  if (isXmlArray(value)) return value.length;
  if (isXmlRecord(value)) return Object.keys(value).length;
  return 0;
};

/**
 * @description How long to sample each benchmark, and how long to warm it up first. Serialization is measured in the tens of microseconds for the small document,
 * so a shorter sample than Tinybench's default collects plenty of samples without a suite that takes a minute.
 */
const BUDGET = { time: 300, warmupTime: 50 } as const;

/**
 * @description A codec bound to a local, so the benchmark body does not pay for a property read on the codec object on every iteration.
 *
 * @param schema - The schema to build a codec for.
 * @param rootName - The root element's name.
 *
 * @returns The codec's `encodeTextSync`.
 */
const encoderFor = (schema: Schema.Constraint, rootName: string): ((value: never) => string) =>
  toCodecXml(schema as never, { rootName }).encodeTextSync as (value: never) => string;

/**
 * @description A codec's `decodeTextSync` bound to a local.
 *
 * @param schema - The schema to build a codec for.
 * @param rootName - The root element's name.
 *
 * @returns The codec's `decodeTextSync`.
 */
const decoderFor = (schema: Schema.Constraint, rootName: string): ((text: string) => unknown) =>
  toCodecXml(schema as never, { rootName }).decodeTextSync;

afterAll(() => {
  // An empty sink means the benchmark bodies never reached the line that folds a
  // result in, so the tables describe a run that did no work.
  expect(observed).toBeGreaterThan(0);
});

describe('codec — a small document', () => {
  const encode = encoderFor(Order, 'order');
  const decode = decoderFor(Order, 'order');

  bench(
    'encode',
    () => {
      observed += encode(order as never).length;
    },
    BUDGET
  );

  bench(
    'decode',
    () => {
      observed += decode(orderDocument) === null ? 0 : 1;
    },
    BUDGET
  );

  bench(
    'round trip',
    () => {
      observed += decode(encode(order as never)) === null ? 0 : 1;
    },
    BUDGET
  );
});

describe('codec — a large document', () => {
  const schema = Schema.Struct({ row: Schema.Array(Row) });
  const encode = encoderFor(schema, 'report');
  const decode = decoderFor(schema, 'report');

  bench(
    'encode',
    () => {
      observed += encode(rows as never).length;
    },
    BUDGET
  );

  bench(
    'decode',
    () => {
      observed += decode(rowsDocument) === null ? 0 : 1;
    },
    BUDGET
  );
});

describe('codec — the layer underneath', () => {
  // The same work without the schema, so the difference between these rows and
  // the rows above is what Effect's derivation costs on every call.
  const xml: XmlValue = { '@id': 'A-1001', title: 'Dune', total: '1234.56', placed: 'true', tag: ['a', 'b', 'c'] };

  bench(
    'render, no schema',
    () => {
      observed += renderXml(xml, { rootName: 'r' }).length;
    },
    BUDGET
  );

  bench(
    'parse, no schema',
    () => {
      observed += sizeOf(
        parseXmlSync('<r id="A-1001"><title>Dune</title><total>1234.56</total><placed>true</placed><tag>a</tag><tag>b</tag><tag>c</tag></r>')
      );
    },
    BUDGET
  );
});

describe('codec — what escaping costs', () => {
  // The two rows either side of these are the same render with and without
  // anything to escape, so the difference is the escaping pass itself.
  bench(
    'render clean text',
    () => {
      observed += renderXml(cleanValue, { rootName: 'r' }).length;
    },
    BUDGET
  );

  bench(
    'render text needing escapes',
    () => {
      observed += renderXml(dirtyValue, { rootName: 'r' }).length;
    },
    BUDGET
  );

  const long = 'word '.repeat(4000);
  bench(
    'render 20k of clean text',
    () => {
      observed += renderXml({ body: long }, { rootName: 'r' }).length;
    },
    BUDGET
  );

  bench(
    'render 20k of text with one unsafe character',
    () => {
      observed += renderXml({ body: `${long}&` }, { rootName: 'r' }).length;
    },
    BUDGET
  );
});

describe('codec — the document shape', () => {
  const xml: XmlValue = {
    row: Array.from({ length: ROWS }, (_, i) => ({ '@id': `R-${i}`, sku: `SKU-${i}`, name: `Product ${i}`, price: `${i}.5` })),
  };

  bench(
    'render, compact',
    () => {
      observed += renderXml(xml, { rootName: 'report' }).length;
    },
    BUDGET
  );

  bench(
    'render, indented',
    () => {
      observed += renderXml(xml, { rootName: 'report', format: true }).length;
    },
    BUDGET
  );

  bench(
    'parse, 500 rows',
    () => {
      observed += sizeOf(parseXmlSync(rowsDocument));
    },
    BUDGET
  );

  bench(
    'parse, 500 rows, keeping whitespace',
    () => {
      observed += sizeOf(parseXmlSync(rowsDocument, { preserveWhitespace: true }));
    },
    BUDGET
  );
});
