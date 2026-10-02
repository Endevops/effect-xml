import { Predicate, Schema } from 'effect';

/**
 * @description A record of child elements, attributes and character data. A key starting with `@` is an attribute, the reserved `#text` key is character data, and
 * every other key is a child element name. An `undefined` value means the field is absent, which is how an absent optional field stays
 * distinguishable from an empty one.
 */
export interface XmlRecord {
  readonly [name: string]: XmlValue | undefined;
}

/**
 * @description One value in an XML document: nothing at all, character data, a repeated run of children, or a record of attributes, text and child elements.
 * `undefined` is a value of its own rather than an omission, because that is how an absent optional field survives a round trip: a field with no
 * value stays distinguishable from a field whose value is the empty string, and the renderer writes neither of them. The shape is deliberately the
 * same one `Schema.toCodecStringTree` derives, which is what lets every schema feature Effect supports round-trip through this package without
 * re-implementing the derivation.
 */
export type XmlValue = string | undefined | ReadonlyArray<XmlValue> | XmlRecord;

/**
 * @description How deep {@link isXmlValue} will walk before giving up. A document nested deeper than this is treated as invalid rather than allowed to exhaust the
 * stack.
 */
const MAX_GUARD_DEPTH = 512;

/**
 * @description Whether an arbitrary value is a well-formed {@link XmlValue}.
 *
 * @param input - The candidate value.
 *
 * @returns Whether the value is absent, character data, an array of `XmlValue`, or a plain record of them.
 */
export const isXmlValue = (input: unknown): input is XmlValue => check(input, 0);

/**
 * @description One level of {@link isXmlValue}, with the depth it was reached at. The depth is the whole defence against a value built to be hostile: a
 * self-referential object would otherwise recurse until the stack gave out, and a value nested thousands deep would take it with it. Both are
 * rejected here instead, which is why this is a real recursion with a bound rather than a loop — the model is a tree, and a tree is walked by walking
 * it.
 *
 * @param input - The candidate value.
 * @param depth - How many levels down this value sits.
 *
 * @returns Whether this level is legal, and the rest of the value with it.
 */
const check = (input: unknown, depth: number): boolean => {
  // `undefined` is a value in its own right: it is how an absent optional field survives a round trip, so a
  // record is allowed to hold one and a document is allowed to be missing a field.
  if (Predicate.isUndefined(input) || Predicate.isString(input)) return true;
  if (Predicate.isNull(input) || !Predicate.isObjectOrArray(input)) return false;

  if (depth > MAX_GUARD_DEPTH) return false;

  // Arrays and records are the only two things left, and each is a walk of its
  // own rather than another branch here: an array of them or a record of them.
  return Array.isArray(input) ? everyMemberIs(input, depth) : everyFieldIs(input, depth);
};

/**
 * @description Whether an array holds nothing but legal values one level down.
 *
 * @param members - The array's members.
 * @param depth - The depth the array itself sits at.
 *
 * @returns Whether every member is a legal `XmlValue`.
 */
const everyMemberIs = (members: ReadonlyArray<unknown>, depth: number): boolean => {
  for (const member of members) {
    if (!check(member, depth + 1)) return false;
  }
  return true;
};

/**
 * @description Whether an object is a plain record of legal values one level down. Plainness is checked here rather than by the caller because a `Date` or a `Map`
 * has values a record cannot hold, and walking them would be walking something the model has no way to represent.
 *
 * @param input - The object to walk.
 * @param depth - The depth the object itself sits at.
 *
 * @returns Whether the object is a plain record whose every field is a legal `XmlValue`.
 */
const everyFieldIs = (input: object, depth: number): boolean => {
  if (!Predicate.isReadonlyObject(input)) return false;
  for (const key of Object.keys(input)) {
    if (!check(input[key], depth + 1)) return false;
  }
  return true;
};

/**
 * @description A schema for {@link XmlValue}, so a value can be validated on its own — when it arrives from a store or a queue rather than from {@link parseXml},
 * and the schema it belongs to is not in hand.
 *
 * @example
 *   ```typescript
 *   import { Schema } from 'effect';
 *   import { XmlValue } from '@endevops/effect-xml-codec';
 *
 *   Schema.decodeUnknownSync(XmlValue)({ book: { '@id': '1', title: 'Dune' } }); // => { book: { '@id': '1', title: 'Dune' } }
 *   Schema.decodeUnknownSync(XmlValue)({ book: { title: 42 } }); // => throws XmlValue
 *   ```;
 */
export const XmlValue: Schema.Codec<XmlValue> = Schema.declare<XmlValue>(isXmlValue, {
  identifier: 'XmlValue',
  expected: 'an XML value: character data, an array of them, or a record of them',
});
