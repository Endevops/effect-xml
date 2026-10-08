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
//     to such a schema;
//   - a union rewrites its record against each object member in turn, so a plain
//     value nested under any branch is still read; a repeated field derives as a
//     union of an array and `undefined`, so a record is also read through the
//     first array node reachable behind a union;
//   - an empty element under an array field reads as one empty object when the
//     member is structural, because an empty array renders as a single empty
//     element (see `renderRepeated`) and a member the schema requires must still
//     read; a plain-value member reads as an empty array.
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
 * @description The array node a value is read against. An optional repeated field derives as a union of an array and `undefined`, so an array node can sit behind
 * a union rather than at the top; the first one reachable through the union's members is the one a repeated value belongs to.
 *
 * @param node - The resolved node to search.
 *
 * @returns The array node, or `undefined` when none is reachable.
 */
const arrayNode = (node: SchemaAST.AST): SchemaAST.Arrays | undefined => {
  if (SchemaAST.isArrays(node)) return node;
  if (SchemaAST.isUnion(node)) {
    for (const member of node.types) {
      const found = arrayNode(resolveNode(member));
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/**
 * @description Whether an array's member is a structure - a struct, an array, or a union reachable to one - rather than a plain value. An empty element under such
 * an array reads as one empty object, because a structural member cannot be empty character data; a plain-value member reads as an empty array
 * instead.
 *
 * @param node - The array node.
 *
 * @returns Whether the member is structural.
 */
const arrayMemberIsStructural = (node: SchemaAST.Arrays): boolean => {
  const member = memberAst(node, 0);
  return member !== undefined && isStructural(member);
};

/**
 * @description The value an empty element under an array field reads as: one empty object when the member is structural, so a member the schema requires still
 * reads, and an empty array otherwise.
 *
 * @param node - The array node.
 *
 * @returns The array to decode.
 */
const emptyArrayElement = (node: SchemaAST.Arrays): XmlValue => (arrayMemberIsStructural(node) ? [{}] : []);

/**
 * @description Whether a parsed element carries nothing at all: no character data, no attributes and no children. The parser reduces such an element to an empty
 * string, and the codec reduces one whose only attributes were namespace declarations to an empty record. An array field reads either as one empty
 * object or as an empty array, depending on whether its member is structural.
 *
 * @param value - The parsed value.
 *
 * @returns Whether the element is empty.
 */
const isEmptyElement = (value: XmlValue): boolean => value === '' || (Predicate.isReadonlyObject(value) && Object.keys(value).length === 0);

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
 * @description Folds every member of an array against the array node that describes them. A member that is an empty element - the parser reduces it to an empty
 * string, or to an empty record once the codec drops the namespace declarations it carried - cannot be a structural member, so it is kept as one
 * empty object. That is how the renderer writes an empty array, and how a repeated empty tag reads back as one empty object per element.
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
    if (isEmptyElement(value[index]) && isStructural(element)) {
      out.push({});
      continue;
    }
    const normalized = normalizePlainValue(value[index], element, `${path}[${index}]`);
    if (Result.isFailure(normalized)) return normalized;
    out.push(normalized.success);
  }
  return Result.succeed(out);
};

/**
 * @description Folds a record against every object member of a union, so a plain value nested under any branch is still read from its character data. Which branch
 * the value belongs to is the decoder's job, so the first branch that folds the record cleanly wins; a branch that refuses the record - because a
 * field it wants as a plain value also carries a child element - is skipped. When the union has no object member, or none of them folds the record,
 * the record is left for the decoder to read as a plain value.
 *
 * @param record - The record to fold.
 * @param node - The union node.
 * @param path - The path of the record, for a failure message.
 *
 * @returns The folded value, the first object member's failure, or the record unchanged.
 */
const normalizeUnion = (record: XmlRecord, node: SchemaAST.Union, path: string): Result.Result<XmlValue, string> => {
  let failure: Result.Result<XmlValue, string> | undefined;
  let sawObject = false;
  for (const member of node.types) {
    const resolved = resolveNode(member);
    if (!SchemaAST.isObjects(resolved)) continue;
    sawObject = true;
    const normalized = normalizeFields(record, resolved, path);
    if (Result.isSuccess(normalized)) return normalized;
    failure ??= normalized;
  }
  if (failure !== undefined) return failure;
  return sawObject ? Result.succeed(record) : readCharacterData(record, path);
};

/**
 * @description Folds a record against the node that describes it. An object node is folded field by field; a union folds against its object members so a plain
 * value nested under any branch is read; anything else wants a plain value and reads the character data.
 *
 * @param record - The record to fold.
 * @param node - The resolved node.
 * @param path - The path of the record, for a failure message.
 *
 * @returns The folded value, or the failure that makes it impossible.
 */
const normalizeRecord = (record: XmlRecord, node: SchemaAST.AST, path: string): Result.Result<XmlValue, string> => {
  if (SchemaAST.isObjects(node)) return normalizeFields(record, node, path);
  if (SchemaAST.isUnion(node)) return normalizeUnion(record, node, path);
  if (isStructural(node)) return Result.succeed(record);
  return readCharacterData(record, path);
};

/**
 * @description Folds a parsed value against the derived StringTree AST, so a plain value can be read from an element that carries attributes. An empty element
 * under an array field reads as one empty object when the member is structural, and as an empty array otherwise.
 *
 * @param value - The value the parser produced, after namespaces were resolved.
 * @param ast - The derived StringTree AST the decoder will read the value with.
 * @param path - The path of this value, for a failure message.
 *
 * @returns The value to decode, or the message describing why a plain value could not be read.
 */
export const normalizePlainValue = (value: XmlValue, ast: SchemaAST.AST, path: string): Result.Result<XmlValue, string> => {
  if (Predicate.isUndefined(value)) return Result.succeed(value);

  const node = resolveNode(ast);
  const arrays = arrayNode(node);

  if (Predicate.isString(value)) {
    // An empty element under an array field is how the renderer writes an empty array; a structural member still reads as one empty object.
    if (arrays !== undefined && value === '') return Result.succeed(emptyArrayElement(arrays));
    return Result.succeed(value);
  }

  if (Array.isArray(value)) {
    return arrays !== undefined ? normalizeMembers(value, arrays, path) : Result.succeed(value);
  }

  if (!Predicate.isReadonlyObject(value)) return Result.succeed(value);

  // The same empty element, after the codec dropped the namespace declarations it carried, arrives as an empty record.
  if (arrays !== undefined && isEmptyElement(value)) return Result.succeed(emptyArrayElement(arrays));

  return normalizeRecord(value as XmlRecord, node, path);
};
