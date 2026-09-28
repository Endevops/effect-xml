/**
 * @description Specs for `BaseOutputBuilder` and `BaseOutputBuilderFactory` — the contract a concrete output builder is written against. The base class supplies
 * everything that does not depend on the output shape: the two pipelines, the per-document shared context, and the policy for comments, CDATA,
 * declarations and stop nodes. Each of those policies is driven by a parser option rather than hardcoded, so the interesting cases are the option
 * combinations — and especially the ones where an empty string means "omit" rather than "use this name". The base is abstract in practice, so most of
 * these drive it through a minimal concrete subclass, which is also the shape a real builder takes.
 */

import type { MatcherView } from '@endevops/common-xml';

import { Matcher } from '@endevops/common-xml';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { BuilderError } from '#/errors.ts';
import type { BuilderParserOptions, TagDetailLike, ValueParser, ValueParserRegistryLike } from '#/index.ts';

import { BaseOutputBuilder, BaseOutputBuilderFactory, BooleanParser, Context, ValueParserRegistry } from '#/index.ts';
import { failed, run, runXml } from '#/test/helpers/effect.ts';

/**
 * @description A concrete builder that records the child keys the base's hooks add, and nothing else. This is the minimum needed to observe the base class's own
 * policy without a subclass's output shape getting in the way.
 */
class RecordingBuilder extends BaseOutputBuilder {
  /**
   * @description Every `_addChild` call, as `[key, value]`.
   */
  readonly children: [string, unknown][] = [];
  /**
   * @description Every `addRawValue` call, as the text passed in.
   */
  readonly raw: string[] = [];

  override _addChild(key: string, val: unknown): void {
    this.children.push([key, val]);
  }

  override addRawValue(text: string): void {
    this.raw.push(text);
  }
}

/**
 * @description A read-only view positioned on a single `<a>` element, which is what a builder hands to `addAttribute`.
 *
 * @returns The view.
 */
const atA = (): MatcherView => {
  const matcher = new Matcher();
  runXml(matcher.push('a'));
  return runXml(matcher.readOnly());
};

const registry = (): ValueParserRegistryLike => new ValueParserRegistry();

/**
 * @description The stop-node detail a parser sends: a name and a position. Typed as {@link TagDetailLike} rather than written inline at each call site, because
 * `onStopNode` and `onExit` promise only a `name` — that is the minimum any parser can keep — and a fresh object literal carrying an extra `index`
 * would fail the excess-property check. A named value of the wider type is assignable, which is the point: real parsers do send the position, and a
 * builder may rely on it if it declares for it.
 */
const scriptDetail: TagDetailLike = { name: 'script', index: 3 };

/**
 * @description Build a recording builder with the given parser and builder options.
 *
 * @param parserOptions - What the parser would have been configured with.
 * @param builderOptions - This builder's own options.
 *
 * @returns The builder.
 */
const builder = (parserOptions: BuilderParserOptions, builderOptions: Record<string, unknown> = {}): RecordingBuilder =>
  new RecordingBuilder(parserOptions as BuilderParserOptions & Record<string, unknown>, builderOptions, null, registry()) as RecordingBuilder;

// ─── Construction ─────────────────────────────────────────────────────────────────────────────────────────────

describe('BaseOutputBuilder — construction', () => {
  it('starts at the root sentinel, with no stop node pending', () => {
    const b = builder({});
    expect(b._rootName).toBe('^');
    expect(b._pendingStopNode).toBe(false);
  });

  it('builds both pipelines, defaulting to the built-in chains', () => {
    const b = builder({});
    expect(b.tagsPipeline.valParsers).toEqual(['ws', 'entity', 'boolean', 'number']);
    expect(b.attrsPipeline.valParsers).toEqual(['entity', 'boolean', 'number']);
  });

  it('omits ws from the attribute default — attribute whitespace is data', () => {
    expect(builder({}).attrsPipeline.valParsers).not.toContain('ws');
    expect(builder({}).tagsPipeline.valParsers).toContain('ws');
  });

  it('takes a configured chain in place of the default', () => {
    const b = builder({}, { tags: { valueParsers: ['trim'] } });
    expect(b.tagsPipeline.valParsers).toEqual(['trim']);
    // The attribute chain was not configured, so it keeps its default.
    expect(b.attrsPipeline.valParsers).toEqual(['entity', 'boolean', 'number']);
  });

  it('gives both pipelines the same shared context', () => {
    const b = builder({});
    expect(b.tagsPipeline.sharedContext).toBe(b.sharedContext);
    expect(b.attrsPipeline.sharedContext).toBe(b.sharedContext);
  });

  it('holds the matcher it was given, including null', () => {
    expect(builder({}).matcher).toBeNull();
    const matcher = atA();
    expect(new RecordingBuilder({} as BuilderParserOptions & Record<string, unknown>, {}, matcher, registry()).matcher).toBe(matcher);
  });

  it('resets the parsers by default, so a second builder starts clean', () => {
    let resets = 0;
    const counting: ValueParser = {
      parse: (v: unknown) => Effect.succeed(v),
      reset: () => {
        resets++;
      },
    };
    const reg = new ValueParserRegistry();
    run(reg.register('counting', counting));
    new RecordingBuilder({} as BuilderParserOptions & Record<string, unknown>, { tags: { valueParsers: ['counting'] } }, null, reg);
    expect(resets).toBeGreaterThan(0);
  });

  it('skips the reset when told to, for a caller that already reset', () => {
    let resets = 0;
    const counting: ValueParser = {
      parse: (v: unknown) => Effect.succeed(v),
      reset: () => {
        resets++;
      },
    };
    const reg = new ValueParserRegistry();
    run(reg.register('counting', counting));
    new RecordingBuilder({} as BuilderParserOptions & Record<string, unknown>, { tags: { valueParsers: ['counting'] } }, null, reg, false);
    expect(resets).toBe(0);
  });
});

// ─── addAttribute ───────────────────────────────────────────────────────────────────────────────────────────

describe('BaseOutputBuilder — addAttribute', () => {
  it('applies the configured prefix and suffix', () => {
    const b = builder({ attributes: { prefix: '@_', suffix: '' } }) as RecordingBuilder & { attributes: Record<string, unknown> };
    b.attributes = {};
    run(b.addAttribute('id', '1', atA()));
    expect(Object.keys(b.attributes)).toEqual(['@_id']);
  });

  it('uses no prefix or suffix when neither is configured', () => {
    const b = builder({}) as RecordingBuilder & { attributes: Record<string, unknown> };
    b.attributes = {};
    run(b.addAttribute('id', '1', atA()));
    expect(Object.keys(b.attributes)).toEqual(['id']);
  });

  it('runs the value through the attribute pipeline, so "1" becomes 1', () => {
    const b = builder({ attributes: { prefix: '@_' } }) as RecordingBuilder & { attributes: Record<string, unknown> };
    b.attributes = {};
    run(b.addAttribute('n', '42', atA()));
    expect(b.attributes['@_n']).toBe(42);
  });

  it('passes an isAttribute context, so ws leaves the value alone', () => {
    const b = builder({ attributes: { prefix: '@_' } }, { attributes: { valueParsers: ['ws'] } }) as RecordingBuilder & {
      attributes: Record<string, unknown>;
    };
    b.attributes = {};
    run(b.addAttribute('t', '  a  b  ', atA()));
    expect(b.attributes['@_t']).toBe('  a  b  ');
  });

  it('records the XML version from the root declaration, where a value parser can read it', () => {
    const b = builder({}) as RecordingBuilder & { attributes: Record<string, unknown>; tagName: string };
    b.attributes = {};
    b.tagName = b._rootName;
    run(b.addAttribute('version', '1.1', atA()));
    expect(b.sharedContext.get('xmlVersion')).toBe(1.1);
  });

  it('ignores a version attribute on any other tag', () => {
    const b = builder({}) as RecordingBuilder & { attributes: Record<string, unknown>; tagName: string };
    b.attributes = {};
    b.tagName = 'other';
    run(b.addAttribute('version', '1.1', atA()));
    expect(b.sharedContext.get('xmlVersion')).toBeUndefined();
  });

  it('does nothing when the subclass has no flat attribute bag', () => {
    // The base shape has nowhere to put an attribute; a builder with a different
    // structure overrides addAttribute rather than relying on this.
    const b = builder({ attributes: { prefix: '@_' } });
    run(b.addAttribute('id', '1', atA()));
  });
});

// ─── Comment and CDATA policy ─────────────────────────────────────────────────────────────────────────────────

describe('BaseOutputBuilder — comments', () => {
  it('stores a comment under nameFor.comment', () => {
    const b = builder({ nameFor: { comment: '#c' } });
    b.addComment('hi');
    expect(b.children).toEqual([['#c', 'hi']]);
  });

  it('omits a comment when nameFor.comment is empty', () => {
    const b = builder({ nameFor: { comment: '' } });
    b.addComment('hi');
    expect(b.children).toEqual([]);
  });

  it('drops a comment entirely when skip.comment is set', () => {
    const b = builder({ skip: { comment: true }, nameFor: { comment: '#c' } });
    b.addComment('hi');
    expect(b.children).toEqual([]);
  });

  it('survives a parser that supplied no nameFor or skip at all', () => {
    const b = builder({});
    b.addComment('hi');
    expect(b.children).toEqual([]);
  });
});

describe('BaseOutputBuilder — CDATA', () => {
  it('stores CDATA under nameFor.cdata', () => {
    const b = builder({ nameFor: { cdata: '#d' } });
    b.addLiteral('data');
    expect(b.children).toEqual([['#d', 'data']]);
  });

  it('merges CDATA into the element text when nameFor.cdata is empty', () => {
    const b = builder({ nameFor: { cdata: '' } });
    b.addLiteral('data');
    expect(b.raw).toEqual(['data']);
    expect(b.children).toEqual([]);
  });

  it('merges an empty CDATA body as an empty string rather than skipping it', () => {
    const b = builder({ nameFor: { cdata: '' } });
    b.addLiteral('');
    expect(b.raw).toEqual(['']);
  });

  it('drops CDATA entirely when skip.cdata is set', () => {
    const b = builder({ skip: { cdata: true }, nameFor: { cdata: '#d' } });
    b.addLiteral('data');
    expect(b.children).toEqual([]);
    expect(b.raw).toEqual([]);
  });
});

// ─── addInputEntities ─────────────────────────────────────────────────────────────────────────────────────────

describe('BaseOutputBuilder — addInputEntities', () => {
  it('puts the DOCTYPE entities where the entity parser can read them', () => {
    const b = builder({});
    b.addInputEntities({ myent: 'X' });
    expect(b.sharedContext.get('inputEntities')).toEqual({ myent: 'X' });
  });

  it('is readable by an entity parser mid-document', () => {
    const b = builder({});
    b.addInputEntities({ myent: 'value' });
    expect(b.sharedContext.get('inputEntities')).toEqual({ myent: 'value' });
  });
});

// ─── onStopNode ───────────────────────────────────────────────────────────────────────────────────────────────

describe('BaseOutputBuilder — onStopNode', () => {
  it('marks a stop node pending, so its content bypasses the value chain', () => {
    const b = builder({});
    expect(b._pendingStopNode).toBe(false);
    b.onStopNode(scriptDetail, 'raw');
    expect(b._pendingStopNode).toBe(true);
  });

  it('forwards to the parser option when the caller set one', () => {
    const calls: unknown[][] = [];
    const b = builder({ onStopNode: (...args) => calls.push(args) });
    const detail = { name: 'script', index: 3 };
    b.onStopNode(detail, 'raw');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(detail);
    expect(calls[0]?.[1]).toBe('raw');
    expect(calls[0]?.[2]).toBeNull();
  });

  it('passes the live matcher to the hook, so it can read the position', () => {
    const calls: unknown[][] = [];
    const matcher = atA();
    const b = new RecordingBuilder(
      { onStopNode: (...args) => calls.push(args) } as BuilderParserOptions & Record<string, unknown>,
      {},
      matcher,
      registry()
    );
    b.onStopNode(scriptDetail, 'raw');
    expect(calls[0]?.[2]).toBe(matcher);
  });

  it('does not throw when the caller set no hook', () => {
    const b = builder({});
    b.onStopNode(scriptDetail, 'raw');
  });
});

// ─── Declarations, instructions and exit ─────────────────────────────────────────────────────────────────────

describe('BaseOutputBuilder — declarations and instructions', () => {
  it('routes a declaration through addInstruction', () => {
    const seen: string[] = [];
    const b = builder({});
    b.addInstruction = name => seen.push(name);
    b.addDeclaration('<?xml version="1.0"?>');
    expect(seen).toEqual(['<?xml version="1.0"?>']);
  });

  it('has a no-op addInstruction, so a base builder tolerates one', () => {
    const b = builder({});
    b.addInstruction('<?pi?>');
    expect(b.children).toEqual([]);
  });

  it('has a no-op onExit and onStopNode-adjacent hooks', () => {
    const b = builder({});
    b.onExit({ tagDetail: scriptDetail, matcher: atA(), depth: 1 });
  });
});

describe('BaseOutputBuilder — getOutput', () => {
  it('returns undefined on the base, which has no output shape of its own', () => {
    // Upstream's declarations promised this method but the runtime class never
    // defined it, so calling it on a bare base builder threw. It exists here so
    // the declared contract holds.
    expect(builder({}).getOutput()).toBeUndefined();
  });
});

// ─── BaseOutputBuilderFactory ─────────────────────────────────────────────────────────────────────────────────

describe('BaseOutputBuilderFactory', () => {
  it('starts with empty builder options and a populated registry', () => {
    const f = new BaseOutputBuilderFactory();
    expect(f.builderOptions).toEqual({});
    expect(f.registry).toBeInstanceOf(ValueParserRegistry);
  });

  it('keeps the options it was given', () => {
    const f = new BaseOutputBuilderFactory({ tags: { valueParsers: ['trim'] } });
    expect(f.builderOptions.tags?.valueParsers).toEqual(['trim']);
  });

  it('refuses to produce a builder — a subclass must implement getInstance', () => {
    const f = new BaseOutputBuilderFactory();
    expect(failed(f.getInstance({}, null)).message).toContain('getInstance is not implemented');
  });

  it('registers a value parser for every builder it produces afterwards', () => {
    const f = new BaseOutputBuilderFactory();
    const parser = new BooleanParser();
    run(f.registerValueParser('flag', parser));
    expect(run(f.registry.get('flag'))).toBe(parser);
    // The builder the factory hands out shares the factory's registry.
    const b = new RecordingBuilder({} as BuilderParserOptions & Record<string, unknown>, { tags: { valueParsers: ['flag'] } }, null, f.registry);
    expect(run(b.tagsPipeline.run('true'))).toBe(true);
  });

  it('hands each builder a fresh instance, so per-document state cannot leak', () => {
    // This is the factory's whole reason for existing: a builder is per-document,
    // and the factory is not. The two builders must not share a shared context,
    // which is where a document's XML version and DOCTYPE entities live.
    class Flagging extends BaseOutputBuilderFactory {
      override getInstance(
        parserOptions: Record<string, unknown>,
        readonlyMatcher: MatcherView | null
      ): Effect.Effect<BaseOutputBuilder, BuilderError> {
        return Effect.succeed(
          new RecordingBuilder(
            parserOptions as BuilderParserOptions & Record<string, unknown>,
            {},
            readonlyMatcher,
            this.registry
          ) as RecordingBuilder
        );
      }
    }
    const f = new Flagging();
    const a = run(f.getInstance({}, null));
    const b = run(f.getInstance({}, null));
    expect(a).not.toBe(b);
    expect(a.sharedContext).not.toBe(b.sharedContext);
    // A value written for one document is invisible to the next.
    a.sharedContext.set('xmlVersion', 1.1);
    expect(b.sharedContext.get('xmlVersion')).toBeUndefined();
  });

  it('passes its own registry to every builder it produces', () => {
    class Flagging extends BaseOutputBuilderFactory {
      override getInstance(
        parserOptions: Record<string, unknown>,
        readonlyMatcher: MatcherView | null
      ): Effect.Effect<BaseOutputBuilder, BuilderError> {
        return Effect.succeed(
          new RecordingBuilder(
            parserOptions as BuilderParserOptions & Record<string, unknown>,
            {},
            readonlyMatcher,
            this.registry
          ) as RecordingBuilder
        );
      }
    }
    const f = new Flagging();
    expect(run(f.getInstance({}, null)).registry).toBe(f.registry);
  });
});

describe('Context is what a builder hands its value parsers', () => {
  it('reports the element name the builder was closing', () => {
    const ctx = new Context('price', atA(), true, false);
    expect(ctx.elementName).toBe('price');
    expect(ctx.isLeafNode).toBe(true);
  });
});
