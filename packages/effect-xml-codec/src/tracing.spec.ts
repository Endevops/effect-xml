/**
 * @description Specs for the tracing surface. `parseXml` carries a span with the size of the work it covers, so a profile can attribute a slow parse to the input
 * that produced it. `toCodecXml` is a Schema, and tracing a schema encode or decode is Effect's concern rather than this package's; `renderXml` is an
 * `Effect` too but opens no span, and `parseXmlDocument` is left untraced.
 */

import { Effect, Tracer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { parseXml } from '#/index.ts';

/**
 * @description Runs an effect with a tracer that keeps every span it creates, so a spec can assert on what a trace would have shown.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value and the spans, in creation order.
 */
const traced = <A, E>(effect: Effect.Effect<A, E>): { readonly spans: ReadonlyArray<Tracer.NativeSpan>; readonly value: A } => {
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
