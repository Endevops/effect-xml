// A plain value read from an element that carries more than character data.
//
// The parser reduces an element with no attributes and no children to its
// character data, so a field like `Schema.String` is usually handed a bare
// string. An element that also carries attributes does not reduce: it arrives
// as a record holding the attributes, the `#text` character data, and any child
// elements, because the value model has nowhere else to put them:
//
//   { "@lang": "en", "#text": "Dune" }
//
// Effect's `Schema.toCodecStringTree` derivation knows nothing about the `#text`
// convention, so where a field wants a scalar it sees a record and fails with an
// `InvalidType`. This module bridges the two. Walking the derived StringTree AST
// beside the parsed value:
//
//   - a node that wants character data takes the `#text` key and discards the
//     attributes, because an attribute is not part of the value the schema
//     describes;
//   - a node that wants character data but also finds a child element fails,
//     because a plain value cannot hold one and silently dropping it would lose
//     a field the document actually carried;
//   - a node that describes a struct, array or record keeps its record and
//     recurses, because `@`-prefixed fields and `#text` are ordinary field names
//     to such a schema.
//
// The AST is the one `Schema.toCodecStringTree` produces for the source schema,
// so it is the same shape the decoder is about to read; this pass only rewrites
// the value, it does not derive a schema.

import { Predicate, Result, SchemaAST } from 'effect';

import type { XmlRecord, XmlValue } from './xml-value.ts';

import { isAttributeKey, TEXT_KEY } from './conventions.ts';

/**
 * @description Whether an AST describes a structure - a struct, an array, or a union reachable to one - rather than a plain value. A node that describes a
 * structure keeps a record as a record; a node that does not is where `#text` is read.
 *
 * @param ast - The derived StringTree AST to classify.
 *
 * @returns Whether the node is structural.
 */
const isStructural = (ast: SchemaAST.AST): boolean => {
  if (SchemaAST.isSuspend(ast)) return isStructural(ast.thunk());
  if (SchemaAST.isObjects(ast) || SchemaAST.isArrays(ast)) return true;
  return SchemaAST.isUnion(ast) && ast.types.some(isStructural);
};

/**
 * @description The AST a value is read against, with `Suspend` wrappers unwrapped so a recursive schema reaches its node.
 *
 * @param ast - The AST to unwrap.
 *
 * @returns The first node that is not a `Suspend`.
 */
const resolveNode = (ast: SchemaAST.AST): SchemaAST.AST => {
  let node = ast;
  while (SchemaAST.isSuspend(node)) node = node.thunk();
  return node;
};

/**
 * @description The AST a record value under one key is read against: the matching property signature, or the first index signature when the object is a record.
 * `undefined` leaves the value alone, which is what an object with neither describes.
 *
 * @param node - The object node.
 * @param key - The record key.
 *
 * @returns The AST for the value, or `undefined`.
 */
const fieldAst = (node: SchemaAST.Objects, key: string): SchemaAST.AST | undefined => {
  const property = node.propertySignatures.find(candidate => candidate.name === key);
  return property?.type ?? node.indexSignatures[0]?.type;
};

/**
 * @description The AST one member of an array is read against: the tuple element at that index, or the array's rest element.
 *
 * @param node - The array node.
 * @param index - The member's index.
 *
 * @returns The AST for the member, or `undefined`.
 */
const memberAst = (node: SchemaAST.Arrays, index: number): SchemaAST.AST | undefined => node.elements[index] ?? node.rest[0];

/**
 * @description The path of a field, for a failure message. The root has no name, so its fields are named on their own.
 *
 * @param parent - The parent's path.
 * @param key - The field's key.
 *
 * @returns The field's path.
 */
const childPath = (parent: string, key: string): string => (parent === '' ? key : `${parent}.${key}`);

/**
 * @description Reads the character data of a record that wants a plain value, discarding the attributes around it. A record that also carries a child element is
 * refused, because a plain value has nowhere to put one and dropping it would lose a field the document carried. A record with no `#text` at all is
 * left for the decoder to refuse, which reports the attributes it found instead of a value.
 *
 * @param record - The record to read.
 * @param path - The path of the value, for the failure message.
 *
 * @returns The `#text` value, or the message describing the child element that makes a plain value impossible.
 */
const readCharacterData = (record: XmlRecord, path: string): Result.Result<XmlValue, string> => {
  if (!(TEXT_KEY in record)) return Result.succeed(record);

  const child = Object.keys(record).find(key => key !== TEXT_KEY && !isAttributeKey(key));
  if (child !== undefined) {
    return Result.fail(
      `the field "${path === '' ? 'root' : path}" wants a plain value, but the element also carries the child element "${child}"; only attributes are discarded alongside ${TEXT_KEY}`
    );
  }

  return Result.succeed(record[TEXT_KEY]);
};

/**
 * @description Folds the fields of a record against the object node that describes them, so each field is normalized by its own AST.
 *
 * @param record - The record to fold.
 * @param node - The object node.
 * @param path - The path of the record, for a failure message.
 *
 * @returns The folded record, or the first field's failure.
 */
const normalizeFields = (record: XmlRecord, node: SchemaAST.Objects, path: string): Result.Result<XmlValue, string> => {
  const out: Record<string, XmlValue> = {};
  for (const [key, child] of Object.entries(record)) {
    const field = fieldAst(node, key);
    if (field === undefined || child === undefined) {
      out[key] = child;
      continue;
    }
    const normalized = normalizePlainValue(child, field, childPath(path, key));
    if (Result.isFailure(normalized)) return normalized;
    out[key] = normalized.success;
  }
  return Result.succeed(out);
};

/**
 * @description Folds every member of an array against the array node that describes them.
 *
 * @param value - The array to fold.
 * @param node - The array node.
 * @param path - The path of the array, for a failure message.
 *
 * @returns The folded array, or the first member's failure.
 */
const normalizeMembers = (value: ReadonlyArray<XmlValue>, node: SchemaAST.Arrays, path: string): Result.Result<XmlValue, string> => {
  const out: Array<XmlValue> = [];
  for (let index = 0; index < value.length; index++) {
    const element = memberAst(node, index);
    if (element === undefined) {
      out.push(value[index]);
      continue;
    }
    const normalized = normalizePlainValue(value[index], element, `${path}[${index}]`);
    if (Result.isFailure(normalized)) return normalized;
    out.push(normalized.success);
  }
  return Result.succeed(out);
};

/**
 * @description Folds a record against the node that describes it. An object node is folded field by field; a node that can hold a structure - a union with a
 * structural member, or a declaration - keeps the record as it is, because choosing between members is the decoder's job; anything else wants a plain
 * value and reads the character data.
 *
 * @param record - The record to fold.
 * @param node - The resolved node.
 * @param path - The path of the record, for a failure message.
 *
 * @returns The folded value, or the failure that makes it impossible.
 */
const normalizeRecord = (record: XmlRecord, node: SchemaAST.AST, path: string): Result.Result<XmlValue, string> => {
  if (SchemaAST.isObjects(node)) return normalizeFields(record, node, path);
  if (isStructural(node)) return Result.succeed(record);
  return readCharacterData(record, path);
};

/**
 * @description Folds a parsed value against the derived StringTree AST, so a plain value can be read from an element that carries attributes.
 *
 * @param value - The value the parser produced, after namespaces were resolved.
 * @param ast - The derived StringTree AST the decoder will read the value with.
 * @param path - The path of this value, for a failure message.
 *
 * @returns The value to decode, or the message describing why a plain value could not be read.
 */
export const normalizePlainValue = (value: XmlValue, ast: SchemaAST.AST, path: string): Result.Result<XmlValue, string> => {
  if (Predicate.isString(value) || Predicate.isUndefined(value)) return Result.succeed(value);

  const node = resolveNode(ast);

  if (Array.isArray(value)) {
    return SchemaAST.isArrays(node) ? normalizeMembers(value, node, path) : Result.succeed(value);
  }

  if (!Predicate.isReadonlyObject(value)) return Result.succeed(value);

  return normalizeRecord(value as XmlRecord, node, path);
};
