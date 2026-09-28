import type { Expression, ExpressionSet } from '@endevops/common-xml';

import { Expression as CompiledExpression, ExpressionSet as ExpressionSetImpl } from '@endevops/common-xml';

import type { FactoryOptions, ResolvedFactoryOptions } from './options.ts';

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
 * @returns The resolved options, with `_alwaysArraySet` present and sealed.
 *
 * @throws {Error} `<optionName> expression cannot be empty` for an empty pattern, or `Invalid <optionName> entry: expected a string, or Expression.`
 *   for an entry that is neither.
 */
export function buildOptions(options: FactoryOptions | undefined): ResolvedFactoryOptions {
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
    _alwaysArraySet: compileAlwaysArray([]),
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
    merged._alwaysArraySet = compileAlwaysArray(alwaysArray);
  }
  return merged;
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
function compileAlwaysArray(entries: (string | Expression)[]): ExpressionSet {
  const set = new ExpressionSetImpl();
  for (const entry of entries) {
    set.add(new CompiledExpression(toPattern(entry, 'alwaysArray')));
  }
  set.seal();
  return set;
}

/**
 * @description Reduce one `alwaysArray` entry to a pattern string. A pre-built expression is accepted by duck-typing rather than `instanceof`, because a caller's
 * copy of `path-expression-matcher` can be a different module instance from this package's — a monorepo with its own `node_modules`, or a CJS/ESM
 * interop case — and `instanceof` would reject an expression that is perfectly usable.
 *
 * @param entry - A pattern string or an expression-like object.
 * @param optionName - Used in the error message.
 *
 * @returns The pattern string.
 *
 * @throws {Error} When the entry is neither a non-empty string nor an expression-like object.
 */
function toPattern(entry: string | Expression, optionName: string): string {
  if (typeof entry === 'string') {
    if (entry.length === 0) throw new Error(`${optionName} expression cannot be empty`);
    return entry;
  }
  if (
    typeof (entry as Expression | undefined)?.pattern === 'string' &&
    (entry as Expression).pattern.length > 0 &&
    Array.isArray((entry as Expression).segments)
  ) {
    return entry.toString();
  }
  throw new Error(`Invalid ${optionName} entry: expected a string, or Expression.`);
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
    if (typeof value === 'function' || Array.isArray(value)) {
      target[key] = value;
    } else if (value !== null && typeof value === 'object') {
      const existing = target[key];
      target[key] = copyProperties(
        existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {},
        value as Record<string, unknown>
      );
    } else {
      target[key] = value;
    }
  }

  return target as T;
}
