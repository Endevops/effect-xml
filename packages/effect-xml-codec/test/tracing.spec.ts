/**
 * @description Specs for the tracing surface: every `Effect` entry point carries a span with the size of the work it covers, so a profile can attribute a slow
 * serialize to the input that produced it. The `…Sync` forms are deliberately untraced and are not asserted here.
 */

import { Effect, Option, Schema, Tracer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { parseXml, toCodecXml } from '#/index.ts';

/**
 * @description Runs an effect with a tracer that keeps every span it creates, so a spec can assert on what a trace would have shown.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value and the spans, in creation order.
 */
const traced = <A, E>(effect: Effect.Effect<A, E, never>): { readonly spans: ReadonlyArray<Tracer.NativeSpan>; readonly value: A } => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const value = Effect.runSync(effect.pipe(Effect.withTracer(tracer)));
  return { spans, value };
};

/**
 * @description The one span with the given name, or `undefined`. A trace is a list, and a spec naming the span it wants to look at reads better than an index into
 * it.
 *
 * @param spans - Every span the run created.
 * @param name - The span name to find.
 *
 * @returns The span, or `undefined` when the run did not create one under that name.
 */
const spanNamed = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string): Tracer.NativeSpan | undefined => spans.find(span => span.name === name);

describe('tracing — parseXml()', () => {
  it('creates a span named for the operation', () => {
    const { spans } = traced(parseXml('<r><a>1</a></r>'));
    expect(spanNamed(spans, 'XmlCodec.parseXml')).toBeDefined();
  });

  it('records the document length, so a slow parse is attributable to its input', () => {
    const text = '<r><a>1</a></r>';
    const { spans } = traced(parseXml(text));
    expect(spanNamed(spans, 'XmlCodec.parseXml')?.attributes.get('xml.length')).toBe(text.length);
  });

  it('ends the span even when the parse fails, so a failed parse is still in the trace', () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    Effect.runSyncExit(parseXml('<r><a>1</b></r>').pipe(Effect.withTracer(tracer)));
    expect(spanNamed(spans, 'XmlCodec.parseXml')?.status._tag).toBe('Ended');
  });
});

describe('tracing — codec methods', () => {
  const codec = toCodecXml(Schema.Struct({ a: Schema.String }), { rootName: 'r' });

  it('spans encodeText with the root name', () => {
    const { spans } = traced(codec.encodeText({ a: 'x' }));
    expect(spanNamed(spans, 'XmlCodec.encodeText')?.attributes.get('xml.root')).toBe('r');
  });

  it('spans decodeText with the document length', () => {
    const text = '<r><a>x</a></r>';
    const { spans } = traced(codec.decodeText(text));
    expect(spanNamed(spans, 'XmlCodec.decodeText')?.attributes.get('xml.length')).toBe(text.length);
  });

  it('nests the parser span inside the decode span, so a decode trace splits parse from validation', () => {
    const { spans } = traced(codec.decodeText('<r><a>x</a></r>'));
    const parse = spanNamed(spans, 'XmlCodec.parseXml');
    const decode = spanNamed(spans, 'XmlCodec.decodeText');
    expect(parse).toBeDefined();
    expect(decode).toBeDefined();
    expect(Option.getOrUndefined(parse?.parent ?? Option.none())).toBe(decode);
  });

  it('spans readDocument with the document length', () => {
    const text = '<r><a>x</a></r>';
    const { spans } = traced(codec.readDocument(text));
    expect(spanNamed(spans, 'XmlCodec.readDocument')?.attributes.get('xml.length')).toBe(text.length);
  });
});
