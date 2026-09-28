// The naming conventions that give an `XmlValue` its XML meaning.
//
// An `XmlValue` is a plain JavaScript value — strings, arrays and records — so
// nothing in the value itself says which key is an attribute and which is a
// child element. These two rules carry that meaning, and they are deliberately
// the same rules `@endevops/builder` and this repo's parser already use, so
// an object that goes in comes back out unchanged:
//
//   - a key starting with `@` is an attribute; `@xmlns` becomes `xmlns="…"`.
//   - the key `#text` holds the element's character data.
//
// `@` is a good discriminator because it is not a legal XML `Name` character,
// so an `@`-prefixed key can never collide with a real element name, and a
// field that *is* a valid element name never gets mistaken for an attribute.

import type { XmlVersion } from '@endevops/common-xml';

import { qName, sanitize, validate } from '@endevops/common-xml';
import { Effect } from 'effect';

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
 * @description Resolves a name to something legal in an XML document, or fails.
 *
 * @param name - The candidate element or attribute name.
 * @param options - Repair mode and XML version.
 *
 * @returns The name to write, unchanged when it was already legal.
 *
 * @throws {TypeError} When `options.mode` is `'error'` and the name is not a legal XML name.
 */
export const resolveName = (name: string, { mode = 'repair', xmlVersion = '1.0' }: ResolveNameOptions = {}): string => {
  // QName is the widest production the naming package offers: an NCName, or an
  // NCName with a single namespace prefix. Both element names and attribute
  // names are QNames in a namespaced document, so one check covers both and a
  // prefixed name is not needlessly rejected.
  if (qName(name, { xmlVersion })) return name;

  switch (mode) {
    case 'ignore':
      return name;
    case 'error': {
      // `validate` reports an unknown production through its error channel, but
      // the production is the literal `'qName'` here, so that failure is
      // unreachable — `orElseSucceed` says so rather than a cast. `qName` above
      // has already rejected the name, so a successful result is the invalid
      // branch; it is narrowed rather than cast, so a change in the naming
      // package that made the two disagree would fail here instead of reading
      // `reason` off the valid branch.
      const result = Effect.runSync(Effect.orElseSucceed(validate(name, 'qName', { xmlVersion }), () => undefined));
      const reason = result !== undefined && !result.valid ? result.reason : 'is not a legal XML name';
      throw new TypeError(`Invalid XML name ${JSON.stringify(name)}: ${reason}`);
    }
    case 'repair':
      // `sanitize` needs the 'name' production, not 'qName': its NCName branch
      // would strip the namespace prefix off `ns:local`, losing information
      // rather than repairing it. The 'name' production keeps colons.
      return sanitize(name, 'name', { replacement: '_' });
  }
};

/**
 * @description Whether a string is a legal XML element or attribute name, without allocating a result. The guard {@link resolveName} calls before doing any work,
 * exposed so callers can pre-validate a document's names in bulk.
 *
 * @param name - The candidate name.
 * @param xmlVersion - XML version to validate against. Defaults to `'1.0'`.
 *
 * @returns Whether the name is legal.
 */
export const isValidName = (name: string, xmlVersion: XmlVersion = '1.0'): boolean => qName(name, { xmlVersion });
