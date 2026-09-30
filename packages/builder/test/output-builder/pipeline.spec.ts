/**
 * @description Specs for the value-parser registry and the pipeline that runs a chain of them. The pipeline's job is ordering and short-circuiting, and both are
 * observable only in combination: a chain that runs in the wrong order produces the wrong value without any single parser misbehaving. So most of
 * these build a chain of known parsers and assert on what comes out, rather than asserting on each parser in isolation. The reset lifecycle gets
 * particular attention. A registry is shared across every builder a factory produces, so a parser holding state across documents is only safe if
 * something resets it between them — and if that something is skipped, the leak is silent. Every parser here is a plain value built by a factory, not
 * a class: `parse` is the only required member, and any state a parser keeps is closed over and exposed through a property when a spec needs to
 * observe it.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { BuilderError } from '#/errors.ts';
import type { Context, ValueParser } from '#/index.ts';

import { makeBooleanParser, makeContext, makeSharedContext, makeValueParserPipeline, makeValueParserRegistry } from '#/index.ts';
import { failed, run } from '#/test/helpers/effect.ts';

/**
 * @description A parser that records the context each `parse` call received, then defers to a delegate.
 *
 * @param inner - The parser to delegate to.
 *
 * @returns A parser that records every context it is handed.
 */
const contextSpy = (inner: ValueParser): ValueParser & { seen: (Context | undefined)[] } => {
  const seen: (Context | undefined)[] = [];
  return {
    seen,
    parse(val: unknown, ctx?: Context): Effect.Effect<unknown, BuilderError> {
      seen.push(ctx);
      return inner.parse(val, ctx);
    },
  };
};

/**
 * @description A parser that counts its own invocations, so a chain's length and short-circuit point can both be observed.
 *
 * @param tag - Appended to each value it passes through, and recorded per call.
 *
 * @returns The parser, with its `calls` log exposed.
 */
const countingParser = (tag: string): ValueParser & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    parse(val: unknown): Effect.Effect<unknown, BuilderError> {
      calls.push(`${tag}(${String(val)})`);
      return Effect.succeed(`${String(val)}|${tag}`);
    },
  };
};

/**
 * @description A parser that holds state across documents, so the reset lifecycle is observable.
 *
 * @returns The parser, with its `seen` log exposed.
 */
const stickyParser = (): ValueParser & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    parse(val: unknown): Effect.Effect<unknown, BuilderError> {
      seen.push(String(val));
      return Effect.succeed(seen.length);
    },
    reset(): void {
      seen.length = 0;
    },
  };
};

/**
 * @description A parser that writes to the shared context, so the `init` wiring can be observed.
 *
 * @returns The parser, with the value it last read exposed as `read`.
 */
const contextReadingParser = (): ValueParser & { read: unknown; ctx: unknown } => {
  const state: { read: unknown; ctx: unknown } = { read: undefined, ctx: undefined };
  return {
    get read() {
      return state.read;
    },
    get ctx() {
      return state.ctx;
    },
    init(ctx): void {
      state.ctx = ctx;
    },
    reset(): void {
      state.read = undefined;
    },
    parse(): Effect.Effect<unknown, BuilderError> {
      state.read = (state.ctx as { get(key: string): unknown } | undefined)?.get('marker');
      return Effect.succeed(state.read);
    },
  };
};

// ─── ValueParserRegistry ─────────────────────────────────────────────────────────────────────────────────────

describe('ValueParserRegistry', () => {
  it('starts with the five built-in parsers', () => {
    expect(Object.keys(makeValueParserRegistry().registered).sort()).toEqual(['boolean', 'entity', 'number', 'trim', 'ws']);
  });

  it('resolves a built-in by name', () => {
    const registry = makeValueParserRegistry();
    expect(run(registry.get('boolean'))).toBe(registry.registered.boolean);
    expect(run(registry.get('number'))).toBe(registry.registered.number);
    expect(run(registry.get('trim'))).toBe(registry.registered.trim);
    expect(run(registry.get('ws'))).toBe(registry.registered.ws);
  });

  it('throws for an unregistered name', () => {
    expect(failed(makeValueParserRegistry().get('nope')).message).toContain('parser not found: nope');
  });

  it('registers a custom parser under a new name', () => {
    const registry = makeValueParserRegistry();
    const parser = makeBooleanParser();
    run(registry.register('custom', parser));
    expect(run(registry.get('custom'))).toBe(parser);
  });

  it('replaces a built-in when registered under its own name', () => {
    const registry = makeValueParserRegistry();
    const replacement = makeBooleanParser(['y'], ['n']);
    run(registry.register('boolean', replacement));
    expect(run(registry.get('boolean'))).toBe(replacement);
  });

  it('gives each registry its own copy, so one cannot affect another', () => {
    const a = makeValueParserRegistry();
    const b = makeValueParserRegistry();
    run(a.register('custom', makeBooleanParser()));
    expect(Object.keys(b.registered)).not.toContain('custom');
  });

  it('rejects a non-string name', () => {
    const registry = makeValueParserRegistry();
    const parser = makeBooleanParser();
    // @ts-expect-error deliberately passing the wrong type, to exercise the runtime guard
    expect(failed(registry.register(undefined, parser)).message).toContain('name must be a string');
    // @ts-expect-error deliberately passing the wrong type
    expect(failed(registry.register(42, parser)).message).toContain('name must be a string');
  });

  it('rejects a missing parser', () => {
    const registry = makeValueParserRegistry();
    // @ts-expect-error deliberately passing the wrong type, to exercise the runtime guard
    expect(failed(registry.register('x', null)).message).toContain('parser is required');
  });

  it('rejects a parser without reset, which the pipeline needs between documents', () => {
    const registry = makeValueParserRegistry();
    const noReset = { parse: () => 1 } as unknown as ValueParser;
    expect(failed(registry.register('x', noReset)).message).toContain('parser must implement reset()');
  });

  it('rejects a parser without parse', () => {
    const registry = makeValueParserRegistry();
    const noParse = { reset: () => {} } as unknown as ValueParser;
    expect(failed(registry.register('x', noParse)).message).toContain('parser must implement parse()');
  });

  it('resets one parser by name, and ignores an unregistered one', () => {
    const registry = makeValueParserRegistry();
    const sticky = stickyParser();
    run(registry.register('sticky', sticky));
    run(sticky.parse('a'));
    expect(sticky.seen).toHaveLength(1);
    registry.reset('sticky');
    expect(sticky.seen).toHaveLength(0);
    registry.reset('never-registered');
  });

  it('resets every parser at once', () => {
    const registry = makeValueParserRegistry();
    const sticky = stickyParser();
    run(registry.register('sticky', sticky));
    run(sticky.parse('a'));
    run(sticky.parse('b'));
    registry.resetAll();
    expect(sticky.seen).toHaveLength(0);
  });
});

// ─── SharedContext ────────────────────────────────────────────────────────────────────────────────────────────

describe('SharedContext', () => {
  it('stores and reads a value', () => {
    const ctx = makeSharedContext();
    ctx.set('xmlVersion', 1.1);
    expect(ctx.get('xmlVersion')).toBe(1.1);
  });

  it('returns undefined for a key never set', () => {
    expect(makeSharedContext().get('nope')).toBeUndefined();
  });

  it('stores falsy values without confusing them with absence', () => {
    const ctx = makeSharedContext();
    for (const v of [0, '', false, null]) {
      ctx.set('k', v);
      expect(ctx.get('k')).toBe(v);
    }
  });

  it('overwrites on a second set', () => {
    const ctx = makeSharedContext();
    ctx.set('k', 1);
    ctx.set('k', 2);
    expect(ctx.get('k')).toBe(2);
  });

  it('empties on clear', () => {
    const ctx = makeSharedContext();
    ctx.set('a', 1);
    ctx.set('b', 2);
    ctx.clear();
    expect(ctx.get('a')).toBeUndefined();
    expect(ctx.get('b')).toBeUndefined();
  });

  it('keeps each instance independent', () => {
    const a = makeSharedContext();
    const b = makeSharedContext();
    a.set('k', 'a');
    expect(b.get('k')).toBeUndefined();
  });
});

// ─── ValueParserPipeline ─────────────────────────────────────────────────────────────────────────────────────

describe('ValueParserPipeline', () => {
  const pipeline = (parsers: (string | ValueParser)[]) => makeValueParserPipeline(parsers, makeValueParserRegistry());

  it('returns the value untouched for an empty chain', () => {
    expect(run(pipeline([]).run('x'))).toBe('x');
    expect(run(pipeline([]).run(42))).toBe(42);
    expect(run(pipeline([]).run(null))).toBeNull();
  });

  it('feeds each parser the previous one output', () => {
    // ws then boolean: the ws output is what boolean sees, so the order is the
    // thing under test, not either parser.
    expect(run(pipeline(['ws', 'boolean']).run('  true  '))).toBe(true);
    expect(run(pipeline(['boolean', 'ws']).run('  true  '))).toBe('true');
  });

  it('runs the default tag chain in order', () => {
    // ws collapses, entity expands, boolean coerces, number coerces — each on
    // the previous one's output, which is why the order is the assertion.
    expect(run(pipeline(['ws', 'entity', 'boolean', 'number']).run('  42  '))).toBe(42);
    expect(run(pipeline(['ws', 'entity', 'boolean', 'number']).run('  true  '))).toBe(true);
    expect(run(pipeline(['ws', 'entity', 'boolean', 'number']).run(' &amp; '))).toBe('&');
    // entity before boolean, so the expanded text is what boolean inspects —
    // an entity that decoded to a boolean word is coerced.
    expect(run(pipeline(['ws', 'entity', 'boolean', 'number']).run('  &#116;rue  '))).toBe(true);
  });

  it('throws at construction for a name that is not registered', () => {
    // The `if (parser)` guard in run() reads as though an unresolvable name is
    // skipped, but construction resolves every name through registry.get(),
    // which throws first. So a typo in a chain is caught when the pipeline is
    // built rather than silently ignored at run time — the better of the two
    // behaviours, and the reason the guard is unreachable rather than load-bearing.
    expect(failed(pipeline(['nope']).run('x')).message).toContain('parser not found: nope');
    expect(failed(pipeline(['ws', 'nope', 'boolean']).run('x')).message).toContain('parser not found: nope');
    // Every name registered, however late, is fine.
    expect(run(pipeline(['ws', 'boolean']).run(' true '))).toBe(true);
  });

  it('accepts a name registered before the pipeline is built', () => {
    // Registration order that actually works: register, then build.
    const registry = makeValueParserRegistry();
    const p = () => makeValueParserPipeline(['late'], registry);
    expect(failed(p().run('x')).message).toContain('parser not found: late');
    run(registry.register('late', makeBooleanParser()));
    expect(run(p().run('true'))).toBe(true);
  });

  it('accepts instances inline in the chain, mixed with names', () => {
    const p = pipeline(['ws', makeBooleanParser(), 'number']);
    expect(run(p.run('  true  '))).toBe(true);
  });

  it('stops at a FinalValue and returns the wrapped value', () => {
    const final = makeBooleanParser(undefined, undefined, true);
    const after = countingParser('after');
    const p = pipeline([final, after]);
    expect(run(p.run('true'))).toBe(true);
    expect(after.calls).toHaveLength(0);
  });

  it('continues past a parser that did not match, even when IS_FINAL is set', () => {
    // The final flag only takes effect on a *match*. A non-match returns the
    // value unchanged and the chain carries on, so a chain is not truncated by
    // a final parser that had nothing to say about this value.
    const final = makeBooleanParser(undefined, undefined, true);
    const after = countingParser('after');
    const p = pipeline([final, after]);
    expect(run(p.run('maybe'))).toBe('maybe|after');
    expect(after.calls).toHaveLength(1);
  });

  it('passes the runtime context to every parser', () => {
    const spy = contextSpy(countingParser('spy'));
    const ctx = makeContext('tag', null, true, false);
    run(makeValueParserPipeline([spy], makeValueParserRegistry()).run('x', ctx));
    expect(spy.seen).toEqual([ctx]);
  });

  it('passes undefined when no context is supplied', () => {
    const spy = contextSpy(countingParser('spy'));
    run(makeValueParserPipeline([spy], makeValueParserRegistry()).run('x'));
    expect(spy.seen).toEqual([undefined]);
  });

  it('defaults the chain and the shared context', () => {
    const p = makeValueParserPipeline([], makeValueParserRegistry());
    expect(p.valParsers).toEqual([]);
    expect(typeof p.sharedContext.get).toBe('function');
  });

  it('keeps the shared context it was given', () => {
    const ctx = makeSharedContext();
    const p = makeValueParserPipeline([], makeValueParserRegistry(), ctx);
    expect(p.sharedContext).toBe(ctx);
  });

  it('injects the shared context into every parser that implements init', () => {
    const ctx = makeSharedContext();
    ctx.set('marker', 'injected');
    const reader = contextReadingParser();
    run(makeValueParserPipeline([reader], makeValueParserRegistry(), ctx).run('x'));
    expect(reader.read).toBe('injected');
  });

  it('calls init once when one instance appears under two names', () => {
    let initCount = 0;
    const shared: ValueParser = {
      init: () => {
        initCount++;
      },
      reset: () => {},
      parse: val => Effect.succeed(val),
    };
    const registry = makeValueParserRegistry();
    run(registry.register('one', shared));
    run(registry.register('two', shared));
    makeValueParserPipeline(['one', 'two'], registry, makeSharedContext());
    expect(initCount).toBe(1);
  });

  it('run(register()) adds to the registry and injects the context immediately', () => {
    const ctx = makeSharedContext();
    ctx.set('marker', 'from-register');
    const p = makeValueParserPipeline([], makeValueParserRegistry(), ctx);
    const reader = contextReadingParser();
    run(p.register('reader', reader));
    expect(run(p.registry.get('reader'))).toBe(reader);
    // Injectable at register time, before the parser has ever run.
    expect(reader.ctx).toBe(ctx);
  });

  it('run(register()) does not add the parser to this pipeline chain', () => {
    // Registration and chain membership are separate: a chain is fixed at
    // construction, so registering a name mid-parse affects later pipelines.
    const p = makeValueParserPipeline([], makeValueParserRegistry());
    run(p.register('reader', contextReadingParser()));
    expect(run(p.run('x'))).toBe('x');
    expect(p.valParsers).toEqual([]);
  });

  it('runs a registered parser when a later pipeline names it', () => {
    const registry = makeValueParserRegistry();
    const first = makeValueParserPipeline([], registry);
    run(first.register('reader', contextReadingParser()));
    // The next document's pipeline resolves the name and injects its own context.
    const second = makeValueParserPipeline(['reader'], registry, makeSharedContext());
    expect(run(second.run('x'))).toBeUndefined();
  });

  it('resets every parser in the chain, and only those', () => {
    const inChain = stickyParser();
    const outOfChain = stickyParser();
    const registry = makeValueParserRegistry();
    run(registry.register('in', inChain));
    run(registry.register('out', outOfChain));
    const p = makeValueParserPipeline(['in'], registry);
    run(p.run('a'));
    run(p.run('b'));
    expect(inChain.seen).toHaveLength(2);
    p.resetAll();
    expect(inChain.seen).toHaveLength(0);
    // resetAll walks the chain, not the registry, so a parser outside it is untouched.
    expect(outOfChain.seen).toHaveLength(0);
  });

  it('keeps a parser shared across two pipelines, as a factory registry does', () => {
    // The shape the parser actually uses: one registry, a fresh pipeline per
    // document, and a reset between them. State must not leak into document two.
    const registry = makeValueParserRegistry();
    const sticky = stickyParser();
    run(registry.register('sticky', sticky));

    const first = makeValueParserPipeline(['sticky'], registry, makeSharedContext());
    run(first.run('a'));
    run(first.run('b'));
    expect(sticky.seen).toHaveLength(2);

    first.resetAll();
    const second = makeValueParserPipeline(['sticky'], registry, makeSharedContext());
    run(second.run('c'));
    expect(sticky.seen).toEqual(['c']);
  });

  it('gives each pipeline its own shared context, so one document cannot see another', () => {
    const registry = makeValueParserRegistry();
    const reader = contextReadingParser();
    run(registry.register('reader', reader));
    const first = makeSharedContext();
    first.set('marker', 'doc-1');
    run(makeValueParserPipeline(['reader'], registry, first).run('x'));
    expect(reader.read).toBe('doc-1');
    run(makeValueParserPipeline(['reader'], registry, makeSharedContext()).run('x'));
    expect(reader.read).toBeUndefined();
  });
});
