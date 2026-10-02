import { Effect, Predicate, Result } from 'effect';

import type { XmlVersion } from './naming/index.ts';

import { XmlParseError } from './errors.ts';
import { isQName, sanitize, validate } from './naming/index.ts';

/**
 * @description The key prefix that marks a field as an XML attribute. `@xmlns` is written as `xmlns="…"`.
 */
export const ATTRIBUTE_PREFIX = '@';

/**
 * @description The reserved key holding an element's character data, alongside its attributes and child elements.
 */
export const TEXT_KEY = '#text';

/**
 * @description The element name used when nothing else names the root. Matches the default Effect uses in `Schema.toEncoderXml`.
 */
export const DEFAULT_ROOT_NAME = 'root';

/**
 * @description The element name used for array members that have no natural name of their own. Matches the default in `Schema.toEncoderXml`.
 */
export const DEFAULT_ITEM_NAME = 'item';

/**
 * @description What to do with a name that is not a legal XML name.
 *
 * - `repair` rewrites it into the nearest legal name. The default, because a serializer that silently produces a different tag name is worse than one
 *   that produces a legal one.
 * - `error` fails the render. Use it when a rewritten name would silently change the meaning of the document.
 * - `ignore` writes the name as given, producing a document that is not well-formed. Only useful when a downstream step rewrites names anyway.
 */
export type NameMode = 'error' | 'ignore' | 'repair';

/**
 * @description Options for {@link resolveName}.
 */
export interface ResolveNameOptions {
  /**
   * @description What to do with an illegal name. Defaults to `'repair'`.
   */
  readonly mode?: NameMode | undefined;

  /**
   * @description XML version to validate against. Defaults to `'1.0'`.
   */
  readonly xmlVersion?: XmlVersion | undefined;
}

/**
 * @description Whether a record key names an attribute rather than a child element.
 *
 * @param key - The key to classify.
 *
 * @returns Whether the key carries the {@link ATTRIBUTE_PREFIX}.
 */
export const isAttributeKey = (key: string): boolean => key.charCodeAt(0) === 64 && key.length > 1;

/**
 * @description The attribute name a record key stands for: `@xmlns` becomes `xmlns`.
 *
 * @param key - A key that {@link isAttributeKey} accepted.
 *
 * @returns The name with the prefix removed.
 */
export const attributeName = (key: string): string => key.slice(1);

/**
 * @description Whether a record key holds character data rather than a child element or an attribute.
 *
 * @param key - The key to classify.
 *
 * @returns Whether the key is the reserved {@link TEXT_KEY}.
 */
export const isTextKey = (key: string): boolean => key === TEXT_KEY;

/**
 * @description Whether a key is one this package reserves. Only {@link TEXT_KEY} is reserved today; every other key is read as a child element name.
 *
 * @param key - The key to classify.
 *
 * @returns Whether the key is reserved.
 */
export const isReservedKey = (key: string): boolean => isTextKey(key);

/**
 * @description Resolves a name to something legal in an XML document, synchronously. The renderer and the parser both resolve a name per element and per attribute
 * — the codec's hot path — so the walk calls this directly and keeps the work in plain JavaScript. `'error'` mode reports an illegal name by throwing
 * an {@link XmlParseError}; the callers that need it in a typed channel use {@link resolveName}, which wraps this.
 *
 * @param name - The candidate element or attribute name.
 * @param options - Repair mode and XML version.
 *
 * @returns The name to write, unchanged when it was already legal.
 *
 * @throws {XmlParseError} When the name is illegal and the mode is `'error'`.
 */
export const resolveNameSync = (name: string, { mode = 'repair', xmlVersion = '1.0' }: ResolveNameOptions = {}): string => {
  if (isQName(name, { xmlVersion })) return name;
  if (mode === 'ignore') return name;
  if (mode === 'repair') return sanitize(name, 'name', { replacement: '_' });

  // `validate` only fails for an unknown production, which `'qName'` is not, so
  // this runs a plain result and the failure is the reason the name is refused.
  const result = Effect.runSync(validate(name, 'qName', { xmlVersion }));
  const reason = !result.valid ? result.reason : 'is not a legal XML name';
  throw new XmlParseError({ message: `Invalid XML name ${JSON.stringify(name)}: ${reason}`, position: -1, input: name });
};

/**
 * @description {@link resolveNameSync} with the thrown failure folded into a {@link Result}, so an effectful caller can carry it in a typed channel without a
 * try/catch of its own.
 *
 * @param name - The candidate element or attribute name.
 * @param options - Repair mode and XML version.
 *
 * @returns The resolved name, or the failure to report.
 */
const resolveNameResult = (name: string, options: ResolveNameOptions): Result.Result<string, XmlParseError> => {
  try {
    return Result.succeed(resolveNameSync(name, options));
  } catch (cause) {
    if (cause instanceof XmlParseError) {
      return Result.fail(cause);
    }
    return Result.fail(new XmlParseError({ message: Predicate.isError(cause) ? cause.message : String(cause), position: -1, input: name }));
  }
};

/**
 * @description Resolves a name to something legal in an XML document. The renderer and the parser both resolve a name per element and per attribute, and an
 * illegal name under `'error'` mode is a rejection rather than a value, so this returns an `Effect` with the `XmlParseError` in its error channel
 * rather than throwing it. Callers `yield*` it and the failure composes with `catchTag` and the rest; the two internal call sites in `parse.ts` and
 * `render.ts` use {@link resolveNameSync} directly, because their walks are synchronous hot paths.
 *
 * @param name - The candidate element or attribute name.
 * @param options - Repair mode and XML version.
 *
 * @returns An effect producing the name to write, unchanged when it was already legal.
 */
export const resolveName = (name: string, options: ResolveNameOptions = {}): Effect.Effect<string, XmlParseError> =>
  Effect.suspend(() => Effect.fromResult(resolveNameResult(name, options)));
