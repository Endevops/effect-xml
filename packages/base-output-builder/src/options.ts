import type { MatcherView } from '@endevops/path-expression-matcher';

import type { ValueParser } from './value-parser.ts';

/**
 * @description The parser options a builder reads. The parser owns every field here; a builder never sets them.
 */
export interface BuilderParserOptions {
  /**
   * @description The property names the parser writes special nodes under. An empty string means "merge into the parent" rather than "use this name".
   */
  nameFor?: { text?: string; comment?: string; cdata?: string };
  /**
   * @description What the parser drops. A builder consults this to decide whether a comment or CDATA is worth storing at all.
   */
  skip?: { comment?: boolean; cdata?: boolean };
  /**
   * @description How attributes are named and grouped.
   */
  attributes?: { prefix?: string; suffix?: string; groupBy?: string };
  /**
   * @description The caller's own stop-node hook, forwarded by {@link BaseOutputBuilder.onStopNode}.
   */
  onStopNode?: (tagDetail: unknown, rawContent: string, matcher: MatcherView | null) => void;
}

/**
 * @description A value-parser chain, as registry names or instances.
 */
export interface ValueParserChainOptions {
  /**
   * @description The chain, in order. Omit to use the default for tags or attributes.
   */
  valueParsers?: (string | ValueParser)[];
}

/**
 * @description The options every builder understands, before any builder-specific ones.
 */
export interface BuiltInValueParserOptions {
  /**
   * @description The chain for element text.
   */
  tags?: ValueParserChainOptions;
  /**
   * @description The chain for attribute values.
   */
  attributes?: ValueParserChainOptions;
}

/**
 * @description The keys that must never be written, whatever a caller passes. Assigning any of these through an options object would reach `Object.prototype` and
 * corrupt every object in the process. The merge below skips them by name, which is a name check rather than a prototype check — so a null-prototype
 * options object is equally safe.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @description Merge caller options over a set of defaults, deeply, without trusting the input's shape. Functions and arrays are carried by reference rather than
 * copied: a value-parser instance must stay identical across the merge or the pipeline would hold a parser the registry cannot reset. The recursion
 * creates a new object at each level rather than writing into the defaults, so one builder's resolved options can never be mutated by the next.
 *
 * @param defaults - The baseline.
 * @param source - The caller's options, merged over it.
 *
 * @returns A new object; neither argument is modified.
 */
export function copyProperties<T extends Record<string, unknown>>(defaults: T, source: Record<string, unknown>): T {
  const target: Record<string, unknown> = { ...defaults };

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

/**
 * @description Apply the value-parser chain defaults, then merge the caller's options over them. A chain is defaulted per-key rather than wholesale, so setting
 * `tags.valueParsers` leaves the attribute chain at its default. The `'ws'` parser is absent from the attribute default on purpose — attribute
 * whitespace is data, not layout.
 *
 * @param options - The caller's options.
 * @param defaults - Per-chain defaults, keyed `'tags'` and `'attributes'`.
 *
 * @returns The resolved options.
 */
export function buildOptions<T extends BuiltInValueParserOptions & Record<string, unknown>>(
  options: T | undefined,
  defaults: BuiltInValueParserOptions
): T {
  const resolved = copyProperties({} as Record<string, unknown>, options ?? {}) as T;

  if (resolved.tags?.valueParsers === undefined) {
    resolved.tags = { ...resolved.tags, valueParsers: [...(defaults.tags?.valueParsers ?? [])] };
  }
  if (resolved.attributes?.valueParsers === undefined) {
    resolved.attributes = { ...resolved.attributes, valueParsers: [...(defaults.attributes?.valueParsers ?? [])] };
  }

  return resolved;
}
