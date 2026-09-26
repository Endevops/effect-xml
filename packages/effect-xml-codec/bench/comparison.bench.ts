/**
 * @description Throughput benchmarks for this package against the libraries it is compared with: `@endevops/xml-builder` (a fork of `fast-xml-builder`) and
 * upstream `fast-xml-builder` for encoding, and `@endevops/flexible-xml-parser-effect` (a fork of `fast-xml-parser`) plus upstream `fast-xml-parser`
 * for decoding. Both halves of the comparison are present in both versions, so there are two ecosystems rather than one. The fork and the upstream
 * package are the same version of the same code -- `@endevops/xml-builder` is 1.3.1 and `fast-xml-builder` is 1.3.1 -- which makes the fork's rows a
 * check that maintaining it in this workspace has cost nothing in speed. That is a question worth answering rather than assuming, and it only shows
 * up if both are measured. The comparison is only worth anything if every implementation is handed the same object and asked for the same thing, so
 * that is established rather than assumed:
 *
 * - All three encode the same value and, with `attributeNamePrefix: '@'`, every builder produces **byte-identical** output to this codec. The
 *   assertions at the bottom of this file check it, so a change that breaks the equivalence fails the benchmark rather than quietly reporting a
 *   speed-up over different work.
 * - All three decode that same document, and both parsers reproduce the original value's content. Upstream `fast-xml-parser` puts the attributes last
 *   in key order rather than first, so it is compared on throughput and not on the equality of its output. Two differences in the APIs are worth
 *   stating rather than hiding. This codec's value excludes the root element's name, because the schema describes the root's content; both parsers
 *   include it, so their benchmarks read one property off the result. And both parsers are given the document this codec produced, so neither is
 *   being measured against a document it found easy to read. Every implementation is constructed once, at module scope, which is how each is meant to
 *   be used: the builders resolve their options in the constructor and the parsers compile theirs there, so constructing one per call would measure
 *   setup rather than the work. Every benchmark folds its result into a module-scope counter that `afterAll` reads back, because a discarded result
 *   is a result the JIT is free to delete.
 */

import { XMLParser } from '@endevops/flexible-xml-parser-effect';
import XMLBuilder from '@endevops/xml-builder';
import { Schema } from 'effect';
import UpstreamXMLBuilder from 'fast-xml-builder';
import { XMLParser as UpstreamXMLParser } from 'fast-xml-parser';
import { afterAll, beforeAll, bench, describe, expect } from 'vite-plus/test';

import { toCodecXml } from '#/index.ts';

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
});

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
const Report = Schema.Struct({ row: Schema.Array(Row) });

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
const Note = Schema.Struct({ body: Schema.String });

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

// ---------------------------------------------------------------------------
// The implementations, each constructed once
// ---------------------------------------------------------------------------

const orderCodec = toCodecXml(Order, { rootName: ROOT });
const reportCodec = toCodecXml(Report, { rootName: REPORT_ROOT });
const noteCodec = toCodecXml(Note, { rootName: NOTE_ROOT });

/**
 * @description The settings that make a builder produce the same bytes as this codec, applied to both versions of it. `attributeNamePrefix: '@'` is the one that
 * matters: it is the prefix this codec's convention uses, and with it the two produce the same document. `ignoreAttributes: false` is required for a
 * builder to read prefixed keys as attributes at all — its default drops them. `suppressEmptyNode` matches this codec's default, and `format: false`
 * is what both sides do by default anyway.
 */
const BUILDER_OPTIONS = { attributeNamePrefix: '@', ignoreAttributes: false, suppressEmptyNode: true, format: false } as const;

/**
 * @description `@endevops/xml-builder`, the fork maintained in this workspace.
 */
const builder = new XMLBuilder({ ...BUILDER_OPTIONS });

/**
 * @description Upstream `fast-xml-builder` from npm, at the same version as the fork.
 */
const upstreamBuilder = new UpstreamXMLBuilder({ ...BUILDER_OPTIONS });

/**
 * @description `@endevops/flexible-xml-parser-effect`. Attributes are skipped by default, and the `@` prefix has to be set separately, so both are given.
 */
const parser = new XMLParser({ skip: { attributes: false }, attributes: { prefix: '@' } });

/**
 * @description Upstream `fast-xml-parser`. `parseAttributeValue: false` keeps attribute values as the strings they are in the document, which is what this codec's
 * `@` fields hold; tag values are left to coerce as they normally would.
 */
const upstream = new UpstreamXMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false });

/**
 * @description The documents, rendered by this codec so that all three decode from the same bytes.
 */
const orderDocument = orderCodec.encodeTextSync(order);
const reportDocument = reportCodec.encodeTextSync(report);
const noteDocument = noteCodec.encodeTextSync(note);

/**
 * @description Accumulates the outcome of every operation the benchmarks perform, so the work is observable rather than discardable.
 */
let observed = 0;

/**
 * @description How long to sample each benchmark, and how long to warm it up first. A small document takes single-digit microseconds, so a shorter sample than
 * Tinybench's default still collects tens of thousands of samples without a suite that takes a minute.
 */
const BUDGET = { time: 300, warmupTime: 50 } as const;

/**
 * @description The benchmark bodies below call straight into the library functions rather than through a wrapper, so that the numbers include exactly one call
 * each and nothing of this file's own.
 *
 * @param call - What the implementation is asked to do.
 *
 * @returns A function that calls it and folds a number into the counter.
 */
const measure =
  (call: () => unknown): (() => void) =>
  () => {
    observed += call() === undefined ? 0 : 1;
  };

/**
 * @description A number derived from a parsed value, so a decode benchmark can fold its result into the counter. A parsed object has no `length` of its own, and
 * counting its keys is enough to keep the work from being optimised away.
 *
 * @param value - The value the parser produced.
 *
 * @returns A number that depends on the value.
 */
const sizeOf = (value: unknown): number => (typeof value === 'object' && value !== null ? Object.keys(value).length : String(value).length);

beforeAll(() => {
  // The equivalence the whole comparison rests on. If a change to the renderer, a builder's defaults, or a parser's options breaks it, the benchmark says
  // so here instead of reporting a speed-up over work that is not the same.
  expect(builder.build({ [ROOT]: order })).toBe(orderDocument);
  expect(upstreamBuilder.build({ [ROOT]: order })).toBe(orderDocument);
  expect(JSON.stringify((parser.parse(orderDocument) as Record<string, unknown>)[ROOT])).toBe(JSON.stringify(order));
  // Upstream's key order puts attributes last rather than first, so the check is that every field survives rather than that the serialisation matches.
  expect(JSON.stringify((upstream.parse(orderDocument) as Record<string, unknown>)[ROOT], Object.keys(order).reverse())).toBe(
    JSON.stringify(order, Object.keys(order).reverse())
  );
});

afterAll(() => {
  // An empty sink means the benchmark bodies never reached the line that folds a result in, so the tables describe a run that did no work.
  expect(observed).toBeGreaterThan(0);
});

describe('encoding — a small document', () => {
  bench(
    'this codec',
    measure(() => orderCodec.encodeTextSync(order).length),
    BUDGET
  );
  bench(
    '@endevops/xml-builder',
    measure(() => builder.build({ [ROOT]: order }).length),
    BUDGET
  );
  bench(
    'fast-xml-builder',
    measure(() => upstreamBuilder.build({ [ROOT]: order }).length),
    BUDGET
  );
});

describe('encoding — a 500-row document', () => {
  bench(
    'this codec',
    measure(() => reportCodec.encodeTextSync(report).length),
    BUDGET
  );
  bench(
    '@endevops/xml-builder',
    measure(() => builder.build({ [REPORT_ROOT]: report }).length),
    BUDGET
  );
  bench(
    'fast-xml-builder',
    measure(() => upstreamBuilder.build({ [REPORT_ROOT]: report }).length),
    BUDGET
  );
});

describe('encoding — one large text node', () => {
  bench(
    'this codec',
    measure(() => noteCodec.encodeTextSync(note).length),
    BUDGET
  );
  bench(
    '@endevops/xml-builder',
    measure(() => builder.build({ [NOTE_ROOT]: note }).length),
    BUDGET
  );
  bench(
    'fast-xml-builder',
    measure(() => upstreamBuilder.build({ [NOTE_ROOT]: note }).length),
    BUDGET
  );
});

describe('decoding — a small document', () => {
  bench(
    'this codec',
    measure(() => orderCodec.decodeTextSync(orderDocument)),
    BUDGET
  );
  bench(
    '@endevops/flexible-xml-parser',
    measure(() => sizeOf((parser.parse(orderDocument) as Record<string, unknown>)[ROOT])),
    BUDGET
  );
  bench(
    'fast-xml-parser',
    measure(() => sizeOf((upstream.parse(orderDocument) as Record<string, unknown>)[ROOT])),
    BUDGET
  );
});

describe('decoding — a 500-row document', () => {
  bench(
    'this codec',
    measure(() => reportCodec.decodeTextSync(reportDocument)),
    BUDGET
  );
  bench(
    '@endevops/flexible-xml-parser',
    measure(() => sizeOf((parser.parse(reportDocument) as Record<string, unknown>)[REPORT_ROOT])),
    BUDGET
  );
  bench(
    'fast-xml-parser',
    measure(() => sizeOf((upstream.parse(reportDocument) as Record<string, unknown>)[REPORT_ROOT])),
    BUDGET
  );
});

describe('decoding — one large text node', () => {
  bench(
    'this codec',
    measure(() => noteCodec.decodeTextSync(noteDocument)),
    BUDGET
  );
  bench(
    '@endevops/flexible-xml-parser',
    measure(() => sizeOf((parser.parse(noteDocument) as Record<string, unknown>)[NOTE_ROOT])),
    BUDGET
  );
  bench(
    'fast-xml-parser',
    measure(() => sizeOf((upstream.parse(noteDocument) as Record<string, unknown>)[NOTE_ROOT])),
    BUDGET
  );
});

describe('a full round trip, both halves measured', () => {
  // The number an application actually cares about: the cost of writing a document and reading it back. Neither builder nor either parser can do both
  // halves, so the last two rows are each ecosystem doing the same work with two libraries and hand-joining them, which is what using them together
  // costs. The two ecosystems are measured separately because a caller picks one, and the difference between them is the difference between the fork
  // and what is on npm.
  bench(
    'this codec',
    measure(() => orderCodec.decodeTextSync(orderCodec.encodeTextSync(order))),
    BUDGET
  );
  bench(
    'then parser, both @endevops',
    measure(() => sizeOf((parser.parse(builder.build({ [ROOT]: order })) as Record<string, unknown>)[ROOT])),
    BUDGET
  );
  bench(
    'then parser, both from npm',
    measure(() => sizeOf((upstream.parse(upstreamBuilder.build({ [ROOT]: order })) as Record<string, unknown>)[ROOT])),
    BUDGET
  );
});
