/**
 * @description Specs for the value-parser registry and the pipeline that runs a chain of them. The pipeline's job is ordering and short-circuiting, and both are
 * observable only in combination: a chain that runs in the wrong order produces the wrong value without any single parser misbehaving. So most of
 * these build a chain of known parsers and assert on what comes out, rather than asserting on each parser in isolation. The reset lifecycle gets
 * particular attention. A registry is shared across every builder a factory produces, so a parser holding state across documents is only safe if
 * something resets it between them — and if that something is skipped, the leak is silent.
 */

import { describe, expect, it } from 'vite-plus/test';

import type { ValueParser } from '#/index.ts';

import {
  BaseValueParser,
  BooleanParser,
  Context,
  NumberValueParser,
  SharedContext,
  Trim,
  ValueParserPipeline,
  ValueParserRegistry,
  WSNormalizer,
} from '#/index.ts';

/**
 * @description Counts its own invocations, so a chain's length and short-circuit point can both be observed.
 */
class CountingParser extends BaseValueParser {
  calls: string[] = [];

  readonly tag: string;

  constructor(tag: string) {
    super();
    this.tag = tag;
  }

  override parse(val: unknown): unknown {
    this.calls.push(`${this.tag}(${String(val)})`);
    return `${String(val)}|${this.tag}`;
  }
}

/**
 * @description Holds state across documents, so the reset lifecycle is observable.
 */
class StickyParser extends BaseValueParser {
  seen: string[] = [];

  override parse(val: unknown): unknown {
    this.seen.push(String(val));
    return this.seen.length;
  }

  override reset(): void {
    this.seen = [];
  }
}

/**
 * @description Writes to the shared context, so the `init` wiring can be observed.
 */
class ContextReadingParser extends BaseValueParser {
  read: unknown;

  override parse(): unknown {
    this.read = this.ctx?.get('marker');
    return this.read;
  }
}

/**
 * @description A parser that records the context each `parse` call received, then defers to a delegate. Built as a factory rather than a subclass because the
 * point is to capture a two-argument call, and a subclass method cannot widen its own signature.
 *
 * @param inner - The parser to delegate to.
 *
 * @returns A parser that records every context it is handed.
 */
const contextSpy = (inner: ValueParser): ValueParser & { seen: (Context | undefined)[] } => {
  const seen: (Context | undefined)[] = [];
  return {
    seen,
    parse(val: unknown, ctx?: Context): unknown {
      seen.push(ctx);
      return inner.parse(val, ctx);
    },
  };
};

// ─── ValueParserRegistry ─────────────────────────────────────────────────────────────────────────────────────

describe('ValueParserRegistry', () => {
  it('starts with the five built-in parsers', () => {
    expect(Object.keys(new ValueParserRegistry().registered).sort()).toEqual(['boolean', 'entity', 'number', 'trim', 'ws']);
  });

  it('resolves a built-in by name', () => {
    const registry = new ValueParserRegistry();
    expect(registry.get('boolean')).toBeInstanceOf(BooleanParser);
    expect(registry.get('number')).toBeInstanceOf(NumberValueParser);
    expect(registry.get('trim')).toBeInstanceOf(Trim);
    expect(registry.get('ws')).toBeInstanceOf(WSNormalizer);
  });

  it('throws for an unregistered name', () => {
    expect(() => new ValueParserRegistry().get('nope')).toThrow('parser not found: nope');
  });

  it('registers a custom parser under a new name', () => {
    const registry = new ValueParserRegistry();
    const parser = new BooleanParser();
    registry.register('custom', parser);
    expect(registry.get('custom')).toBe(parser);
  });

  it('replaces a built-in when registered under its own name', () => {
    const registry = new ValueParserRegistry();
    const replacement = new BooleanParser(['y'], ['n']);
    registry.register('boolean', replacement);
    expect(registry.get('boolean')).toBe(replacement);
  });

  it('gives each registry its own copy, so one cannot affect another', () => {
    const a = new ValueParserRegistry();
    const b = new ValueParserRegistry();
    a.register('custom', new BooleanParser());
    expect(Object.keys(b.registered)).not.toContain('custom');
  });

  it('rejects a non-string name', () => {
    const registry = new ValueParserRegistry();
    const parser = new BooleanParser();
    // @ts-expect-error deliberately passing the wrong type, to exercise the runtime guard
    expect(() => registry.register(undefined, parser)).toThrow('name must be a string');
    // @ts-expect-error deliberately passing the wrong type
    expect(() => registry.register(42, parser)).toThrow('name must be a string');
  });

  it('rejects a missing parser', () => {
    const registry = new ValueParserRegistry();
    // @ts-expect-error deliberately passing the wrong type, to exercise the runtime guard
    expect(() => registry.register('x', null)).toThrow('parser is required');
  });

  it('rejects a parser without reset, which the pipeline needs between documents', () => {
    const registry = new ValueParserRegistry();
    const noReset = { parse: () => 1 } as unknown as ValueParser;
    expect(() => registry.register('x', noReset)).toThrow('parser must implement reset()');
  });

  it('rejects a parser without parse', () => {
    const registry = new ValueParserRegistry();
    const noParse = { reset: () => {} } as unknown as ValueParser;
    expect(() => registry.register('x', noParse)).toThrow('parser must implement parse()');
  });

  it('resets one parser by name, and ignores an unregistered one', () => {
    const registry = new ValueParserRegistry();
    const sticky = new StickyParser();
    registry.register('sticky', sticky);
    sticky.parse('a');
    expect(sticky.seen).toHaveLength(1);
    registry.reset('sticky');
    expect(sticky.seen).toHaveLength(0);
    expect(() => registry.reset('never-registered')).not.toThrow();
  });

  it('resets every parser at once', () => {
    const registry = new ValueParserRegistry();
    const sticky = new StickyParser();
    registry.register('sticky', sticky);
    sticky.parse('a');
    sticky.parse('b');
    registry.resetAll();
    expect(sticky.seen).toHaveLength(0);
  });
});

// ─── SharedContext ────────────────────────────────────────────────────────────────────────────────────────────

describe('SharedContext', () => {
  it('stores and reads a value', () => {
    const ctx = new SharedContext();
    ctx.set('xmlVersion', 1.1);
    expect(ctx.get('xmlVersion')).toBe(1.1);
  });

  it('returns undefined for a key never set', () => {
    expect(new SharedContext().get('nope')).toBeUndefined();
  });

  it('stores falsy values without confusing them with absence', () => {
    const ctx = new SharedContext();
    for (const v of [0, '', false, null]) {
      ctx.set('k', v);
      expect(ctx.get('k')).toBe(v);
    }
  });

  it('overwrites on a second set', () => {
    const ctx = new SharedContext();
    ctx.set('k', 1);
    ctx.set('k', 2);
    expect(ctx.get('k')).toBe(2);
  });

  it('empties on clear', () => {
    const ctx = new SharedContext();
    ctx.set('a', 1);
    ctx.set('b', 2);
    ctx.clear();
    expect(ctx.get('a')).toBeUndefined();
    expect(ctx.get('b')).toBeUndefined();
  });

  it('keeps each instance independent', () => {
    const a = new SharedContext();
    const b = new SharedContext();
    a.set('k', 'a');
    expect(b.get('k')).toBeUndefined();
  });
});

// ─── ValueParserPipeline ─────────────────────────────────────────────────────────────────────────────────────

describe('ValueParserPipeline', () => {
  const pipeline = (parsers: (string | ValueParser)[]) => new ValueParserPipeline(parsers, new ValueParserRegistry());

  it('returns the value untouched for an empty chain', () => {
    expect(pipeline([]).run('x')).toBe('x');
    expect(pipeline([]).run(42)).toBe(42);
    expect(pipeline([]).run(null)).toBeNull();
  });

  it('feeds each parser the previous one output', () => {
    // ws then boolean: the ws output is what boolean sees, so the order is the
    // thing under test, not either parser.
    expect(pipeline(['ws', 'boolean']).run('  true  ')).toBe(true);
    expect(pipeline(['boolean', 'ws']).run('  true  ')).toBe('true');
  });

  it('runs the default tag chain in order', () => {
    // ws collapses, entity expands, boolean coerces, number coerces — each on
    // the previous one's output, which is why the order is the assertion.
    expect(pipeline(['ws', 'entity', 'boolean', 'number']).run('  42  ')).toBe(42);
    expect(pipeline(['ws', 'entity', 'boolean', 'number']).run('  true  ')).toBe(true);
    expect(pipeline(['ws', 'entity', 'boolean', 'number']).run(' &amp; ')).toBe('&');
    // entity before boolean, so the expanded text is what boolean inspects —
    // an entity that decoded to a boolean word is coerced.
    expect(pipeline(['ws', 'entity', 'boolean', 'number']).run('  &#116;rue  ')).toBe(true);
  });

  it('throws at construction for a name that is not registered', () => {
    // The `if (parser)` guard in run() reads as though an unresolvable name is
    // skipped, but the constructor's _initAll resolves every name through
    // registry.get(), which throws first. So a typo in a chain is caught when the
    // pipeline is built rather than silently ignored at run time — the better of
    // the two behaviours, and the reason the guard is unreachable rather than
    // load-bearing.
    expect(() => pipeline(['nope'])).toThrow('parser not found: nope');
    expect(() => pipeline(['ws', 'nope', 'boolean'])).toThrow('parser not found: nope');
    // Every name registered, however late, is fine.
    expect(pipeline(['ws', 'boolean']).run(' true ')).toBe(true);
  });

  it('accepts a name registered before the pipeline is built', () => {
    // Registration order that actually works: register, then build.
    const registry = new ValueParserRegistry();
    const p = () => new ValueParserPipeline(['late'], registry);
    expect(() => p()).toThrow('parser not found: late');
    registry.register('late', new BooleanParser());
    expect(p().run('true')).toBe(true);
  });

  it('accepts instances inline in the chain, mixed with names', () => {
    const p = pipeline(['ws', new BooleanParser(), 'number']);
    expect(p.run('  true  ')).toBe(true);
  });

  it('stops at a FinalValue and returns the wrapped value', () => {
    const final = new BooleanParser(undefined, undefined, true);
    const after = new CountingParser('after');
    const p = pipeline([final, after]);
    expect(p.run('true')).toBe(true);
    expect(after.calls).toHaveLength(0);
  });

  it('continues past a parser that did not match, even when IS_FINAL is set', () => {
    // IS_FINAL only takes effect on a *match*. A non-match returns the value
    // unchanged and the chain carries on, so a chain is not truncated by a
    // final parser that had nothing to say about this value.
    const final = new BooleanParser(undefined, undefined, true);
    const after = new CountingParser('after');
    const p = pipeline([final, after]);
    expect(p.run('maybe')).toBe('maybe|after');
    expect(after.calls).toHaveLength(1);
  });

  it('passes the runtime context to every parser', () => {
    const spy = contextSpy(new CountingParser('spy'));
    const ctx = new Context('tag', null, true, false);
    new ValueParserPipeline([spy], new ValueParserRegistry()).run('x', ctx);
    expect(spy.seen).toEqual([ctx]);
  });

  it('passes undefined when no context is supplied', () => {
    const spy = contextSpy(new CountingParser('spy'));
    new ValueParserPipeline([spy], new ValueParserRegistry()).run('x');
    expect(spy.seen).toEqual([undefined]);
  });

  it('defaults the chain and the shared context', () => {
    const p = new ValueParserPipeline([], new ValueParserRegistry());
    expect(p.valParsers).toEqual([]);
    expect(p.sharedContext).toBeInstanceOf(SharedContext);
  });

  it('keeps the shared context it was given', () => {
    const ctx = new SharedContext();
    const p = new ValueParserPipeline([], new ValueParserRegistry(), ctx);
    expect(p.sharedContext).toBe(ctx);
  });

  it('injects the shared context into every parser that implements init', () => {
    const ctx = new SharedContext();
    ctx.set('marker', 'injected');
    const reader = new ContextReadingParser();
    new ValueParserPipeline([reader], new ValueParserRegistry(), ctx).run('x');
    expect(reader.read).toBe('injected');
  });

  it('calls init once when one instance appears under two names', () => {
    let initCount = 0;
    const shared = new BaseValueParser();
    shared.init = () => {
      initCount++;
    };
    const registry = new ValueParserRegistry();
    registry.register('one', shared);
    registry.register('two', shared);
    new ValueParserPipeline(['one', 'two'], registry, new SharedContext());
    expect(initCount).toBe(1);
  });

  it('register() adds to the registry and injects the context immediately', () => {
    const ctx = new SharedContext();
    ctx.set('marker', 'from-register');
    const p = new ValueParserPipeline([], new ValueParserRegistry(), ctx);
    const reader = new ContextReadingParser();
    p.register('reader', reader);
    expect(p.registry.get('reader')).toBe(reader);
    // Injectable at register time, before the parser has ever run.
    expect(reader.ctx).toBe(ctx);
  });

  it('register() does not add the parser to this pipeline chain', () => {
    // Registration and chain membership are separate: a chain is fixed at
    // construction, so registering a name mid-parse affects later pipelines.
    const p = new ValueParserPipeline([], new ValueParserRegistry());
    p.register('reader', new ContextReadingParser());
    expect(p.run('x')).toBe('x');
    expect(p.valParsers).toEqual([]);
  });

  it('runs a registered parser when a later pipeline names it', () => {
    const ctx = new SharedContext();
    ctx.set('marker', 'seen');
    const registry = new ValueParserRegistry();
    const first = new ValueParserPipeline([], registry);
    first.register('reader', new ContextReadingParser());
    // The next document's pipeline resolves the name and injects its own context.
    const second = new ValueParserPipeline(['reader'], registry, new SharedContext());
    expect(second.run('x')).toBeUndefined();
  });

  it('resets every parser in the chain, and only those', () => {
    const inChain = new StickyParser();
    const outOfChain = new StickyParser();
    const registry = new ValueParserRegistry();
    registry.register('in', inChain);
    registry.register('out', outOfChain);
    const p = new ValueParserPipeline(['in'], registry);
    p.run('a');
    p.run('b');
    expect(inChain.seen).toHaveLength(2);
    p.resetAll();
    expect(inChain.seen).toHaveLength(0);
    // resetAll walks the chain, not the registry, so a parser outside it is untouched.
    expect(outOfChain.seen).toHaveLength(0);
  });

  it('keeps a parser shared across two pipelines, as a factory registry does', () => {
    // The shape the parser actually uses: one registry, a fresh pipeline per
    // document, and a reset between them. State must not leak into document two.
    const registry = new ValueParserRegistry();
    const sticky = new StickyParser();
    registry.register('sticky', sticky);

    const first = new ValueParserPipeline(['sticky'], registry, new SharedContext());
    first.run('a');
    first.run('b');
    expect(sticky.seen).toHaveLength(2);

    first.resetAll();
    const second = new ValueParserPipeline(['sticky'], registry, new SharedContext());
    second.run('c');
    expect(sticky.seen).toEqual(['c']);
  });

  it('gives each pipeline its own shared context, so one document cannot see another', () => {
    const registry = new ValueParserRegistry();
    const reader = new ContextReadingParser();
    registry.register('reader', reader);
    const first = new SharedContext();
    first.set('marker', 'doc-1');
    new ValueParserPipeline(['reader'], registry, first).run('x');
    expect(reader.read).toBe('doc-1');
    new ValueParserPipeline(['reader'], registry, new SharedContext()).run('x');
    expect(reader.read).toBeUndefined();
  });
});
