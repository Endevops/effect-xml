/**
 * @description Specs for `makeBaseOutputBuilder` and the `CompactBuilderFactory` service — the contract a concrete output builder is written against. The base
 * supplies everything that does not depend on the output shape: the two pipelines, the per-document shared context, and the policy for comments,
 * CDATA, declarations and stop nodes. Each of those policies is driven by a parser option rather than hardcoded, so the interesting cases are the
 * option combinations — and especially the ones where an empty string means "omit" rather than "use this name". The base is a value factory rather
 * than an abstract class, so most of these build one and override the two hooks the recorder observes.
 */

import type { MatcherView } from '@endevops/common-xml';

import { Matcher } from '@endevops/common-xml';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { BuilderParserOptions, OutputBuilder, TagDetailLike, ValueParser, ValueParserRegistryLike } from '#/index.ts';

import { CompactBuilderFactory, makeBaseOutputBuilder, makeBooleanParser, makeContext, makeValueParserRegistry } from '#/index.ts';
import { failed, run } from '#/test/helpers/effect.ts';

/**
 * @description The base builder plus the two hooks a spec observes: the child keys `addComment`/`addLiteral` write, and the raw values `addLiteral` merges. This
 * is the minimum needed to observe the base's own policy without a concrete shape getting in the way.
 */
interface RecordingBuilder extends OutputBuilder {
  /**
   * @description Every `_addChild` call, as `[key, value]`.
   */
  children: [string, unknown][];
  /**
   * @description Every `addRawValue` call, as the text passed in.
   */
  raw: string[];
  /**
   * @description The flat attribute bag the base's `addAttribute` writes into.
   */
  attributes: Record<string, unknown>;
  /**
   * @description The tag in scope, read by `addAttribute` to spot a root declaration.
   */
  tagName: string;
}

/**
 * @description A read-only view positioned on a single `<a>` element, which is what a builder hands to `addAttribute`.
 *
 * @returns The view.
 */
const atA = (): MatcherView => {
  const matcher = new Matcher();
  matcher.push('a');
  return matcher.readOnly();
};

const registry = (): ValueParserRegistryLike => makeValueParserRegistry();

/**
 * @description The stop-node detail a parser sends: a name and a position.
 */
const scriptDetail: TagDetailLike = { name: 'script', index: 3 };

/**
 * @description Build a recording builder with the given parser and builder options.
 *
 * @param parserOptions - What the parser would have been configured with.
 * @param builderOptions - This builder's own options.
 * @param matcher - The live path, or `null`.
 *
 * @returns The builder.
 */
const builder = (
  parserOptions: BuilderParserOptions,
  builderOptions: Record<string, unknown> = {},
  matcher: MatcherView | null = null
): RecordingBuilder => {
  const base = makeBaseOutputBuilder(parserOptions as BuilderParserOptions & Record<string, unknown>, builderOptions, matcher, registry());
  const children: [string, unknown][] = [];
  const raw: string[] = [];
  return {
    ...base,
    children,
    raw,
    attributes: {},
    tagName: base._rootName,
    _addChild: (key, value) => {
      children.push([key, value]);
    },
    addRawValue: (text: string) => {
      raw.push(text);
    },
  };
};

// ─── Construction ─────────────────────────────────────────────────────────────────────────────────────────────

describe('makeBaseOutputBuilder — construction', () => {
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
    expect(makeBaseOutputBuilder({}, {}, matcher, registry()).matcher).toBe(matcher);
  });

  it('resets the parsers by default, so a second builder starts clean', () => {
    let resets = 0;
    const counting: ValueParser = {
      parse: (v: unknown) => Effect.succeed(v),
      reset: () => {
        resets++;
      },
    };
    const reg = makeValueParserRegistry();
    run(reg.register('counting', counting));
    makeBaseOutputBuilder({}, { tags: { valueParsers: ['counting'] } }, null, reg);
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
    const reg = makeValueParserRegistry();
    run(reg.register('counting', counting));
    makeBaseOutputBuilder({}, { tags: { valueParsers: ['counting'] } }, null, reg, false);
    expect(resets).toBe(0);
  });
});

// ─── addAttribute ───────────────────────────────────────────────────────────────────────────────────────────

describe('makeBaseOutputBuilder — addAttribute', () => {
  it('applies the configured prefix and suffix', () => {
    const b = builder({ attributes: { prefix: '@_', suffix: '' } });
    run(b.addAttribute('id', '1', atA()));
    expect(Object.keys(b.attributes)).toEqual(['@_id']);
  });

  it('uses no prefix or suffix when neither is configured', () => {
    const b = builder({});
    run(b.addAttribute('id', '1', atA()));
    expect(Object.keys(b.attributes)).toEqual(['id']);
  });

  it('runs the value through the attribute pipeline, so "1" becomes 1', () => {
    const b = builder({ attributes: { prefix: '@_' } });
    run(b.addAttribute('n', '42', atA()));
    expect(b.attributes['@_n']).toBe(42);
  });

  it('passes an isAttribute context, so ws leaves the value alone', () => {
    const b = builder({ attributes: { prefix: '@_' } }, { attributes: { valueParsers: ['ws'] } });
    run(b.addAttribute('t', '  a  b  ', atA()));
    expect(b.attributes['@_t']).toBe('  a  b  ');
  });

  it('records the XML version from the root declaration, where a value parser can read it', () => {
    const b = builder({});
    b.tagName = b._rootName;
    run(b.addAttribute('version', '1.1', atA()));
    expect(b.sharedContext.get('xmlVersion')).toBe(1.1);
  });

  it('ignores a version attribute on any other tag', () => {
    const b = builder({});
    b.tagName = 'other';
    run(b.addAttribute('version', '1.1', atA()));
    expect(b.sharedContext.get('xmlVersion')).toBeUndefined();
  });

  it('does nothing when the builder has no flat attribute bag', () => {
    // The base shape has nowhere to put an attribute; a builder with a different
    // structure overrides addAttribute rather than relying on this.
    const b = makeBaseOutputBuilder({ attributes: { prefix: '@_' } }, {}, null, registry());
    run(b.addAttribute('id', '1', atA()));
  });
});

// ─── Comment and CDATA policy ─────────────────────────────────────────────────────────────────────────────────

describe('makeBaseOutputBuilder — comments', () => {
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

describe('makeBaseOutputBuilder — CDATA', () => {
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
});

// ─── addInputEntities ─────────────────────────────────────────────────────────────────────────────────────────

describe('makeBaseOutputBuilder — addInputEntities', () => {
  it('puts the DOCTYPE entities where the entity parser can read them', () => {
    const b = builder({});
    b.addInputEntities({ myent: 'X' });
    expect(b.sharedContext.get('inputEntities')).toEqual({ myent: 'X' });
  });
});

// ─── onStopNode ───────────────────────────────────────────────────────────────────────────────────────────────

describe('makeBaseOutputBuilder — onStopNode', () => {
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
    const b = builder({ onStopNode: (...args) => calls.push(args) } as BuilderParserOptions, {}, matcher);
    b.onStopNode(scriptDetail, 'raw');
    expect(calls[0]?.[2]).toBe(matcher);
  });

  it('does not throw when the caller set no hook', () => {
    const b = builder({});
    b.onStopNode(scriptDetail, 'raw');
  });
});

// ─── Declarations, instructions and exit ─────────────────────────────────────────────────────────────────────

describe('makeBaseOutputBuilder — declarations and instructions', () => {
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

  it('has a no-op onExit', () => {
    const b = builder({});
    b.onExit({ tagDetail: scriptDetail, matcher: atA(), depth: 1 });
  });
});

describe('makeBaseOutputBuilder — getOutput', () => {
  it('returns undefined on the base, which has no output shape of its own', () => {
    expect(builder({}).getOutput()).toBeUndefined();
  });
});

// ─── CompactBuilderFactory ─────────────────────────────────────────────────────────────────────────────────

describe('CompactBuilderFactory', () => {
  it('starts with the given options and a populated registry', () => {
    const f = run(CompactBuilderFactory.make());
    expect(f.builderOptions.tags?.valueParsers).toEqual(['ws', 'entity', 'boolean', 'number']);
    expect(f.builderOptions.attributes?.valueParsers).toEqual(['entity', 'number', 'boolean']);
    expect(f.builderOptions.forceArray).toBeNull();
    expect(typeof f.registry.get).toBe('function');
  });

  it('keeps the options it was given', () => {
    const f = run(CompactBuilderFactory.make({ tags: { valueParsers: ['trim'] } }));
    expect(f.builderOptions.tags?.valueParsers).toEqual(['trim']);
  });

  it('fails with a typed error for a bad option', () => {
    expect(failed(CompactBuilderFactory.make({ alwaysArray: [''] })).reason._tag).toBe('InvalidOptionEntry');
  });

  it('registers a value parser for every builder it produces afterwards', () => {
    const f = run(CompactBuilderFactory.make());
    const parser = makeBooleanParser();
    run(f.registerValueParser('flag', parser));
    expect(run(f.registry.get('flag'))).toBe(parser);
    // The builder the factory hands out shares the factory's registry.
    const b = makeBaseOutputBuilder({}, { tags: { valueParsers: ['flag'] } }, null, f.registry);
    expect(run(b.tagsPipeline.run('true'))).toBe(true);
  });

  it('hands each builder a fresh instance, so per-document state cannot leak', () => {
    const f = run(CompactBuilderFactory.make());
    const a = run(f.getInstance({}, null));
    const b = run(f.getInstance({}, null));
    expect(a).not.toBe(b);
    expect(a.sharedContext).not.toBe(b.sharedContext);
    // A value written for one document is invisible to the next.
    a.sharedContext.set('xmlVersion', 1.1);
    expect(b.sharedContext.get('xmlVersion')).toBeUndefined();
  });

  it('passes its own registry to every builder it produces', () => {
    const f = run(CompactBuilderFactory.make());
    expect(run(f.getInstance({}, null)).registry).toBe(f.registry);
  });
});

describe('Context is what a builder hands its value parsers', () => {
  it('reports the element name the builder was closing', () => {
    const ctx = makeContext('price', atA(), true, false);
    expect(ctx.elementName).toBe('price');
    expect(ctx.isLeafNode).toBe(true);
  });
});
