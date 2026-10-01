import { assert, describe, expect, it } from '@effect/vitest';
// oxlint-disable vitest/no-disabled-tests
import { Expression } from '@endevops/common-xml';
import { Effect, Result } from 'effect';

import type { ExitIfPredicate } from '#/options.ts';
import type { ParsedNode } from '#/test/helpers/test-runner.ts';

import { runAcrossAllInputSources } from '#/test/helpers/test-runner.ts';
import { XMLParser } from '#/xml-parser.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Basic exitIf — stop on tag name
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — basic tag-name matching', function () {
  runAcrossAllInputSources(
    'stops parsing when exitIf returns true for a matching tag',
    `<root>
      <before>visible</before>
      <stop>this tag triggers exit</stop>
      <after>never reached</after>
    </root>`,
    result => {
      expect(result.root.before).toBe('visible');
      // <stop> opened → exitIf fires → parser closes all open tags immediately;
      // the text content of <stop> is not yet collected (we exited on open).
      // <after> is never reached.
      expect(result.root.after).toBeUndefined();
    },
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      return {
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      };
    })
  );

  runAcrossAllInputSources(
    'output before exit is fully intact',
    `<root>
      <a>one</a>
      <b>two</b>
      <c>three</c>
      <sentinel/>
      <d>four</d>
    </root>`,
    result => {
      expect(result.root.a).toBe('one');
      expect(result.root.b).toBe('two');
      expect(result.root.c).toBe('three');
      // <sentinel> is a self-closing tag — exitIf is NOT called for self-closing
      // tags; only regular pushed tags trigger the check.
      expect(result.root.d).toBeUndefined();
    },
    Effect.gen(function* () {
      const dExp = yield* Expression.make('root.d').pipe(Effect.orDie);
      return {
        exitIf(matcher) {
          return matcher.matches(dExp);
        },
      };
    })
  );

  runAcrossAllInputSources(
    'exitIf never fires when condition is never true',
    `<root>
      <a>one</a>
      <b>two</b>
    </root>`,
    result => {
      expect(result.root.a).toBe('one');
      expect(result.root.b).toBe('two');
    },
    Effect.gen(function* () {
      const noneExp = yield* Expression.make('root.nonexistent').pipe(Effect.orDie);
      return {
        exitIf(matcher) {
          return matcher.matches(noneExp);
        },
      };
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. wasExited reflection
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — wasExited reflection', function () {
  it.effect('wasExited returns true when exitIf fired', () =>
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      const parser = yield* XMLParser.make({
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      });
      yield* parser.parse(`<root><before>ok</before><stop>here</stop><after>never</after></root>`);
      expect(parser.wasExited).toBe(true);
    })
  );

  it.effect('wasExited returns false when exitIf never fires', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make({
        exitIf() {
          return false;
        },
      });
      yield* parser.parse(`<root><a>ok</a></root>`);
      expect(parser.wasExited).toBe(false);
    })
  );

  it.effect('wasExited returns false when exitIf is not configured', () =>
    Effect.gen(function* () {
      const parser = yield* XMLParser.make();
      yield* parser.parse(`<root><a>ok</a></root>`);
      expect(parser.wasExited).toBe(false);
    })
  );

  it.effect('wasExited resets between consecutive parse() calls', () =>
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      const parser = yield* XMLParser.make({
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      });
      yield* parser.parse(`<root><stop/></root>`);
      // Self-closing — exitIf not called on self-closing tags.
      // Parse a doc that actually triggers:
      yield* parser.parse(`<root><stop>x</stop></root>`);
      expect(parser.wasExited).toBe(true);

      // Second parse with a doc that doesn't trigger
      yield* parser.parse(`<root><a>ok</a></root>`);
      expect(parser.wasExited).toBe(false);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Depth / nesting — exit at nested tag
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — nested tags', function () {
  runAcrossAllInputSources(
    'exits at a deeply nested tag; ancestors are closed cleanly',
    `<root>
      <level1>
        <level2>
          <level3>deep</level3>
          <sibling>never</sibling>
        </level2>
      </level1>
      <after>never</after>
    </root>`,
    result => {
      // exitIf fires when <level3> opens; level3 gets no text content,
      // level2 and level1 are closed. <after> is never visited.
      expect(result.root.level1).toBeDefined();
      expect(result.root.level1.level2).toBeDefined();
      expect(result.root.after).toBeUndefined();
    },
    Effect.gen(function* () {
      const level3Exp = yield* Expression.make('..level3').pipe(Effect.orDie);
      return {
        exitIf(matcher) {
          return matcher.matches(level3Exp);
        },
      };
    })
  );

  runAcrossAllInputSources(
    'exits on second occurrence of a repeated tag',
    `<root>
      <item>first</item>
      <item>second triggers exit</item>
      <item>third</item>
    </root>`,
    result => {
      // first <item> closes normally; second <item> open triggers exit.
      // Only one item in output (the completed first one).
      const items = Array.isArray(result.root.item) ? result.root.item : [result.root.item];
      expect(items.length).toBe(1);
      expect(items[0]).toBe('first');
    },
    Effect.gen(function* () {
      const itemExp = yield* Expression.make('root.item:nth(1)').pipe(Effect.orDie);
      return {
        exitIf(matcher) {
          return matcher.matches(itemExp);
        },
      };
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. exitIf + attributes (matcher has attribute data)
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — matching on attributes', function () {
  runAcrossAllInputSources(
    'exits when a specific attribute value is matched',
    `<root>
      <item id="1">one</item>
      <item id="2">two</item>
      <item id="stop">this triggers exit</item>
      <item id="4">four</item>
    </root>`,
    result => {
      // items id=1 and id=2 complete; id=stop opens → exit.
      const items = Array.isArray(result.root.item) ? result.root.item : result.root.item !== undefined ? [result.root.item] : [];
      expect(items.length).toBe(2);
    },
    Effect.gen(function* () {
      const stopItemExp = yield* Expression.make('root.item[id=stop]').pipe(Effect.orDie);
      return {
        skip: { attributes: false },
        exitIf(matcher) {
          return matcher.matches(stopItemExp);
        },
      };
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. exitIf co-exists with other features
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — coexistence with other features', function () {
  runAcrossAllInputSources(
    'exitIf works alongside skip.tags',
    `<root>
      <keep>visible</keep>
      <drop><secret>gone</secret></drop>
      <stop>exits here</stop>
      <after>never</after>
    </root>`,
    result => {
      expect(result.root.keep).toBe('visible');
      expect(result.root.drop).toBeUndefined(); // dropped by skip.tags
      expect(result.root.after).toBeUndefined(); // not reached due to exit
    },
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      return {
        skip: { tags: ['root.drop'] },
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      };
    })
  );

  runAcrossAllInputSources(
    'exitIf works alongside stop nodes',
    `<root>
      <script>alert(1)</script>
      <stop>exits here</stop>
      <after>never</after>
    </root>`,
    result => {
      expect(result.root.script).toBe('alert(1)');
      expect(result.root.after).toBeUndefined();
    },
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      return {
        tags: { stopNodes: ['root.script'] },
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      };
    })
  );

  runAcrossAllInputSources(
    'exitIf works alongside autoClose (tolerant parsing)',
    `<root>
      <a>one</a>
      <stop>exit here</stop>
      <b>never
    `,
    result => {
      expect(result.root.a).toBe('one');
      expect(result.root.b).toBeUndefined();
    },
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      return {
        autoClose: { onEof: 'closeAll', onMismatch: 'discard', collectErrors: false },
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      };
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. feedable (feed/end) input source
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — feedable input source', function () {
  it.effect('exits correctly when fed character by character', () =>
    Effect.gen(function* () {
      const xml = `<root><before>ok</before><stop>here</stop><after>never</after></root>`;
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      const parser = yield* XMLParser.make({
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      });

      for (let i = 0; i < xml.length; i++) {
        yield* parser.feed(xml[i]);
      }
      const result = (yield* parser.end()) as ParsedNode;

      expect(result.root.before).toBe('ok');
      expect(result.root.after).toBeUndefined();
      expect(parser.wasExited).toBe(true);
    })
  );

  it.effect('exits correctly when fed in random-size chunks', () =>
    Effect.gen(function* () {
      const xml = `<root><a>one</a><b>two</b><exit>stop</exit><c>three</c></root>`;
      const exitExp = yield* Expression.make('root.exit').pipe(Effect.orDie);
      const parser = yield* XMLParser.make({
        exitIf(matcher) {
          return matcher.matches(exitExp);
        },
      });

      // Feed in chunks of 7 chars
      for (let i = 0; i < xml.length; i += 7) {
        yield* parser.feed(xml.slice(i, i + 7));
      }
      const result = (yield* parser.end()) as ParsedNode;

      expect(result.root.a).toBe('one');
      expect(result.root.b).toBe('two');
      expect(result.root.c).toBeUndefined();
      expect(parser.wasExited).toBe(true);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. onExit callback on CompactBuilder
// ─────────────────────────────────────────────────────────────────────────────
describe.skip('exitIf — onExit builder callback', function () {
  //TODO: create a custom output builder inherit CompactBuilder and add onExit callback
  it.effect.skip('attaches non-enumerable __exitInfo to output root', () =>
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      const parser = yield* XMLParser.make({
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      });
      const result = (yield* parser.parse(`<root><before>ok</before><stop>here</stop><after>never</after></root>`)) as ParsedNode;

      // __exitInfo is non-enumerable — invisible to JSON.stringify but accessible
      const info = Object.getOwnPropertyDescriptor(result, '__exitInfo');
      expect(info).toBeDefined();
      expect(info!.enumerable).toBe(false);
      expect(info!.value.tag).toBe('stop');
      expect(typeof info!.value.index).toBe('number');
      expect(typeof info!.value.depth).toBe('number');
    })
  );

  it.effect.skip('__exitInfo does not appear in JSON.stringify output', () =>
    Effect.gen(function* () {
      const stopExp = yield* Expression.make('root.stop').pipe(Effect.orDie);
      const parser = yield* XMLParser.make({
        exitIf(matcher) {
          return matcher.matches(stopExp);
        },
      });
      const result = (yield* parser.parse(`<root><stop>x</stop></root>`)) as ParsedNode;
      const json = JSON.stringify(result);
      expect(json).not.toContain('__exitInfo');
    })
  );

  it.effect.skip('depth in __exitInfo reflects nesting level at exit', () =>
    Effect.gen(function* () {
      const innerExp = yield* Expression.make('..inner').pipe(Effect.orDie);
      const parser = yield* XMLParser.make({
        exitIf(matcher) {
          return matcher.matches(innerExp);
        },
      });
      const result = (yield* parser.parse(`<root><outer><inner>deep</inner></outer></root>`)) as ParsedNode;
      const { depth } = Object.getOwnPropertyDescriptor(result, '__exitInfo')!.value;
      // root → outer is depth 1, so tagsStack has [root-sentinel, outer] at exit of inner
      expect(depth).toBeGreaterThanOrEqual(1);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. OptionsBuilder validation
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — OptionsBuilder validation', function () {
  it.effect('accepts a function as exitIf', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ exitIf: () => false }).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('accepts null as exitIf (feature disabled)', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ exitIf: null }).pipe(Effect.result);
      assert(Result.isSuccess(result));
    })
  );

  it.effect('accepts undefined / omitted exitIf (feature disabled)', () =>
    Effect.gen(function* () {
      const omitted = yield* XMLParser.make({}).pipe(Effect.result);
      assert(Result.isSuccess(omitted));
      const explicit = yield* XMLParser.make({ exitIf: undefined }).pipe(Effect.result);
      assert(Result.isSuccess(explicit));
    })
  );

  it.effect('throws INVALID_INPUT when exitIf is a non-function truthy value', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ exitIf: 'root.stop' as unknown as ExitIfPredicate }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/exitIf.*must be a function/i);
    })
  );

  it.effect('throws INVALID_INPUT when exitIf is a number', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ exitIf: 1 as unknown as ExitIfPredicate }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/exitIf.*must be a function/i);
    })
  );

  it.effect('throws INVALID_INPUT when exitIf is a plain object', () =>
    Effect.gen(function* () {
      const result = yield* XMLParser.make({ exitIf: { expression: 'root.stop' } as unknown as ExitIfPredicate }).pipe(Effect.result);
      assert(Result.isFailure(result));
      expect(result.failure.message).toMatch(/exitIf.*must be a function/i);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Self-closing tags are not subject to exitIf
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — self-closing tags are not exit candidates', function () {
  runAcrossAllInputSources(
    'exitIf is not called for self-closing tags',
    `<root>
      <a>one</a>
      <self-close/>
      <b>two</b>
    </root>`,
    result => {
      // If exitIf were called for self-close the spy would catch it and we'd exit
      // before <b>. Since it's NOT called, <b> must be present.
      expect(result.root.b).toBe('two');
    },
    Effect.gen(function* () {
      const selfCloseExp = yield* Expression.make('root.self-close').pipe(Effect.orDie);
      return {
        exitIf(matcher) {
          return matcher.matches(selfCloseExp);
        },
      };
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. exitIf on the very first tag
// ─────────────────────────────────────────────────────────────────────────────
describe('exitIf — exit on very first tag', function () {
  runAcrossAllInputSources(
    'exits immediately on the root tag if exitIf matches it',
    `<root><child>never</child></root>`,
    result => {
      // root is opened → exitIf returns true → root is closed with no children.
      // console.log(JSON.stringify(result, null, 2));
      expect(result).toEqual({});
    },
    Effect.gen(function* () {
      const rootExp = yield* Expression.make('root').pipe(Effect.orDie);
      return {
        exitIf(matcher) {
          return matcher.matches(rootExp);
        },
      };
    })
  );
});
