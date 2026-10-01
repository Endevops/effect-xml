import type { Expression, ExpressionSet } from '@endevops/common-xml';

import { ExpressionSet as ExpressionSetImpl } from '@endevops/common-xml';
import { Effect } from 'effect';

import type { FactoryOptions, ResolvedFactoryOptions } from './options.ts';

import { BuilderError, addToSet, compilePattern } from '../errors.ts';

/**
 * @description The chain used for element text when the caller configures none.
 */
const DEFAULT_TAG_PARSERS = ['ws', 'entity', 'boolean', 'number'];

/**
 * @description The chain used for attribute values when the caller configures none. No `'ws'`: attribute whitespace is data. `number` before `boolean`, and the
 * two cannot in practice be told apart — the boolean lists are `['true']` and `['false']`, which `number` never matches, and `number` leaves them
 * alone. The order is preserved from upstream regardless.
 */
const DEFAULT_ATTR_PARSERS = ['entity', 'number', 'boolean'];

/**
 * @description Keys that must never be written through an options merge, whatever the caller passes. Assigning any of these would reach `Object.prototype` and
 * corrupt every object in the process. The check is by name rather than by prototype, so a null-prototype options object is equally safe.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @description Resolve builder options: apply the value-parser chain defaults, compile `alwaysArray`, then merge the caller's options over the top. The order
 * matters. `alwaysArray` is compiled from the _caller's_ array if there is one, before the merge, because the merge would otherwise replace the raw
 * array with the compiled set under a different key. The compiled set is written last so a caller cannot overwrite it with something un-compiled.
 *
 * @param options - The caller's options.
 *
 * @returns An effect producing the resolved options, with `_alwaysArraySet` present and sealed. Fails with {@link BuilderError} and the
 *   `InvalidOptionEntry` reason for an entry that is neither a non-empty pattern string nor an expression, or with the `PatternCompilationFailed`
 *   reason when a pattern does not compile.
 */
export function buildOptions(options: FactoryOptions | undefined): Effect.Effect<ResolvedFactoryOptions, BuilderError> {
  return Effect.gen(function* () {
    const caller = options ?? {};

    // The baseline is built from literals, never from a spread of the caller's
    // object. A spread copies own enumerable keys — and a `__proto__` key that
    // `JSON.parse` produced *is* own and enumerable — so it would smuggle a
    // forbidden key past the filter in copyProperties. Going through copyProperties
    // for everything the caller supplies is what makes the guard total.
    const resolved: ResolvedFactoryOptions = {
      tags: { valueParsers: [...DEFAULT_TAG_PARSERS] },
      attributes: { valueParsers: [...DEFAULT_ATTR_PARSERS] },
      alwaysArray: [],
      textJoint: '',
      // `null` rather than `undefined`, so the resolved options always carry the key
      // and a reader can test presence without knowing which absence was meant.
      forceArray: null,
      forceTextNode: false,
      _alwaysArraySet: yield* compileAlwaysArray([]),
    };

    // The two derived fields the caller also supplies: the chains per key, so
    // setting `tags.valueParsers` leaves the attribute chain at its default, and
    // `alwaysArray`, which must be compiled rather than copied.
    const { tags, attributes, alwaysArray, _alwaysArraySet: _callerSet, ...rest } = caller as FactoryOptions & { _alwaysArraySet?: ExpressionSet };
    void _callerSet;

    const merged = copyProperties(resolved, rest as Record<string, unknown>);
    if (tags?.valueParsers) merged.tags = { ...merged.tags, valueParsers: tags.valueParsers };
    if (attributes?.valueParsers) merged.attributes = { ...merged.attributes, valueParsers: attributes.valueParsers };
    if (alwaysArray) {
      merged.alwaysArray = alwaysArray;
      merged._alwaysArraySet = yield* compileAlwaysArray(alwaysArray);
    }
    return merged;
  });
}

/**
 * @description Compile the `alwaysArray` patterns into a sealed set, so the per-tag check is an indexed lookup rather than a scan. Built unconditionally, even
 * when empty: the builder's close path consults it on every tag, and an always-present empty set means that path never has to test for a missing
 * one.
 *
 * @param entries - Pattern strings or pre-compiled expressions.
 *
 * @returns The sealed set.
 */
function compileAlwaysArray(entries: (string | Expression)[]): Effect.Effect<ExpressionSet, BuilderError> {
  return Effect.gen(function* () {
    const set = new ExpressionSetImpl();
    for (const entry of entries) {
      const pattern = yield* toPattern(entry, 'alwaysArray');
      const compiled = yield* compilePattern(pattern);
      yield* addToSet(set, compiled);
    }
    set.seal();
    return set;
  });
}

/**
 * @description Reduce one `alwaysArray` entry to a pattern string. A pre-built expression is accepted by duck-typing rather than `instanceof`, because a caller's
 * copy of `path-expression-matcher` can be a different module instance from this package's — a monorepo with its own `node_modules`, or a CJS/ESM
 * interop case — and `instanceof` would reject an expression that is perfectly usable.
 *
 * @param entry - A pattern string or an expression-like object.
 * @param optionName - Used in the error message.
 *
 * @returns An effect producing the pattern string. Fails with {@link BuilderError} and the `InvalidOptionEntry` reason when the entry is neither a
 *   non-empty string nor an expression-like object; the `problem` is one of the two messages the original threw.
 */
function toPattern(entry: string | Expression, optionName: string): Effect.Effect<string, BuilderError> {
  const reject = (problem: 'expression cannot be empty' | 'expected a string, or Expression') =>
    Effect.fail(
      new BuilderError({
        reason: { _tag: 'InvalidOptionEntry', option: optionName, problem },
        message:
          problem === 'expression cannot be empty'
            ? `${optionName} expression cannot be empty`
            : `Invalid ${optionName} entry: expected a string, or Expression.`,
      })
    );

  if (typeof entry === 'string') {
    if (entry.length === 0) return reject('expression cannot be empty');
    return Effect.succeed(entry);
  }
  if (
    typeof (entry as Expression | undefined)?.pattern === 'string' &&
    (entry as Expression).pattern.length > 0 &&
    Array.isArray((entry as Expression).segments)
  ) {
    return Effect.succeed(entry.toString());
  }
  return reject('expected a string, or Expression');
}

/**
 * @description Merge `source` over `defaults`, deeply, without trusting the input's shape. Functions and arrays are carried by reference rather than copied: a
 * value-parser instance must stay identical across the merge, or the registry would not recognise the copy it holds. Each level is built as a new
 * object rather than written into, so one builder's resolved options can never be mutated by the next.
 *
 * @param defaults - The baseline.
 * @param source - The caller's options, merged over it.
 *
 * @returns A new object; neither argument is modified.
 */
function copyProperties<T extends object>(defaults: T, source: Record<string, unknown>): T {
  const target = { ...defaults } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = source[key];
    // Anything that is not a plain object is assigned as it stands, which covers
    // primitives, null, undefined, arrays and functions alike.
    target[key] = isPlainObject(value) ? copyProperties(asMergeBase(target[key]), value) : value;
  }

  return target as T;
}

/**
 * @description Whether a value is a plain object, and so the one case {@link copyProperties} merges rather than assigns. `typeof null === 'object'` and `typeof []
 * === 'object'` both hold, which is why neither is taken at face value here.
 *
 * @param value - The value to test.
 *
 * @returns Whether it merges.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @description The baseline for a nested merge. An existing plain object at that key continues it; anything else — a missing key, a primitive, an array, a
 * function — starts from an empty object, because there is nothing there to merge into.
 *
 * @param value - The value already at that key in the target.
 *
 * @returns The object to merge into.
 */
function asMergeBase(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
