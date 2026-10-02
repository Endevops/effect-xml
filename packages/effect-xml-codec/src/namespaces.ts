// Namespaces: attributing an element to a namespace URI, and resolving that at
// the text boundary.
//
// A schema describes a value in local names. This module lets a schema node say
// which namespace its element belongs to, through Effect's own annotations:
//
//   - `xmlNamespace` is the namespace URI of the element. A field that carries
//     one has its element placed in that namespace; the field's name stays the
//     local name, so the schema does not hard-code a wire prefix.
//   - `xmlPrefix` is the wire prefix to write for that URI. When it is omitted
//     the namespace is written as the default namespace (`xmlns="…"`), and an
//     unprefixed element name is used.
//
// The namespace of an element is inherited by its descendants, the way an XML
// default namespace is. An attribute never inherits: it is in a namespace only
// when it is annotated with one explicitly, because a default namespace does
// not apply to attributes.
//
// On the way out, each element writes its own declaration when the prefix or
// default is not already in scope. On the way in, the parser's own declarations
// are read into scope and every name is resolved to its URI, so a document that
// binds the same URI to a different prefix still decodes to the same value. The
// declaration attributes are dropped from the decoded value; they are the
// codec's to manage, not the schema's.
//
// The plan is built per local name, which is what a schema field is. One local
// name cannot belong to two namespaces in one codec; that is reported when the
// codec is built rather than guessed at.

import type { Schema } from 'effect';

import { SchemaAST } from 'effect';

import type { XmlRecord, XmlValue } from './xml-value.ts';

import { ATTRIBUTE_PREFIX, isAttributeKey, TEXT_KEY } from './conventions.ts';

declare module 'effect/Schema' {
  namespace Annotations {
    interface Annotations {
      /**
       * @description The namespace URI this schema's element belongs to. Read as the local name on the wire, with `xmlPrefix` choosing the prefix.
       */
      readonly xmlNamespace?: string | undefined;

      /**
       * @description The wire prefix to write for {@link xmlNamespace}. Omit it to write the namespace as the default (`xmlns="…"`) with unprefixed element names.
       */
      readonly xmlPrefix?: string | undefined;
    }
  }
}

/**
 * @description The annotation key holding an element's namespace URI.
 */
export const NAMESPACE_KEY = 'xmlNamespace';

/**
 * @description The annotation key holding the wire prefix for an element's namespace.
 */
export const PREFIX_KEY = 'xmlPrefix';

/**
 * @description An element's namespace: the URI, and the prefix to write it with. An empty prefix is the default namespace.
 */
export interface XmlNamespace {
  readonly uri: string;
  readonly prefix: string;
}

/**
 * @description What one codec needs to place and resolve names: the namespace of every local name in the schema, the root element's namespace, and the reverse
 * lookup from a resolved `(uri, local)` back to the schema's key.
 */
export interface NamespacePlan {
  /**
   * @description The namespace of each schema key, keyed by the key as written in the schema (an `@`-prefixed key is an attribute).
   */
  readonly byKey: ReadonlyMap<string, XmlNamespace>;

  /**
   * @description The root element's namespace, or `undefined` when the root is unannotated.
   */
  readonly root: XmlNamespace | undefined;

  /**
   * @description The schema key for a resolved `(uri, local)` name, keyed `uri|local`. Lets a document with any prefix resolve back to the schema.
   */
  readonly byResolved: ReadonlyMap<string, string>;
}

/**
 * @description The namespace an AST's own annotations declare, or `undefined`. `Schema.optional` and `Schema.suspend` wrap a node without moving its annotation,
 * so both are unwrapped to find the namespace the field actually carries.
 *
 * @param ast - The AST to read.
 *
 * @returns The namespace, or `undefined`.
 */
const namespaceOf = (ast: SchemaAST.AST): XmlNamespace | undefined => {
  const seen = new Set<SchemaAST.AST>();
  const find = (node: SchemaAST.AST): XmlNamespace | undefined => {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const annotations = SchemaAST.resolve(node);
    if (typeof annotations?.[NAMESPACE_KEY] === 'string') {
      return { uri: annotations[NAMESPACE_KEY], prefix: typeof annotations[PREFIX_KEY] === 'string' ? annotations[PREFIX_KEY] : '' };
    }
    if (node._tag === 'Union') {
      for (const member of node.types) {
        const found = find(member);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    return node._tag === 'Suspend' ? find(node.thunk()) : undefined;
  };
  return find(ast);
};

/**
 * @description The namespace a property carries when its annotation was attached with `Schema.annotateKey` rather than to the field's schema.
 *
 * @param ast - The property's value AST, whose context holds the key annotations.
 *
 * @returns The namespace, or `undefined`.
 */
const keyNamespaceOf = (ast: SchemaAST.AST): XmlNamespace | undefined => {
  const annotations = ast.context?.annotations;
  if (typeof annotations?.[NAMESPACE_KEY] === 'string') {
    return { uri: annotations[NAMESPACE_KEY], prefix: typeof annotations[PREFIX_KEY] === 'string' ? annotations[PREFIX_KEY] : '' };
  }
  return undefined;
};

/**
 * @description Whether a value is a record of children rather than an array. `Array.isArray` does not narrow a `ReadonlyArray` out of the union here, so the walk
 * uses a guard of its own before it can treat a value as a record.
 *
 * @param value - The candidate.
 *
 * @returns Whether the value is a record.
 */
const isRecord = (value: XmlValue): value is XmlRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @description The local name a schema key names, with the attribute prefix removed. This is what a declaration resolves to.
 *
 * @param key - The schema key.
 *
 * @returns The local name.
 */
const localName = (key: string): string => (isAttributeKey(key) ? key.slice(ATTRIBUTE_PREFIX.length) : key);

/**
 * @description The mutable state one namespace scan carries: the plan under construction, the local names that resolve to more than one namespace, and the AST
 * nodes already visited so a recursive schema terminates.
 */
interface Scan {
  readonly byKey: Map<string, XmlNamespace>;
  readonly problems: Array<string>;
  readonly seen: Set<SchemaAST.AST>;
}

/**
 * @description Records a field's namespace, reporting a local name that would belong to two namespaces at once.
 *
 * @param scan - The scan state.
 * @param key - The schema key.
 * @param namespace - The namespace, or `undefined` when the field has none.
 */
const record = (scan: Scan, key: string, namespace: XmlNamespace | undefined): void => {
  if (namespace === undefined) return;
  const previous = scan.byKey.get(key);
  if (previous !== undefined && (previous.uri !== namespace.uri || previous.prefix !== namespace.prefix))
    scan.problems.push(`the local name "${key}" belongs to more than one namespace`);
  else scan.byKey.set(key, namespace);
};

/**
 * @description Records one struct property. An attribute carries its namespace only when annotated; an element field falls back to the namespace it inherits. A
 * field whose name already carries a prefix cannot also carry a namespace annotation, and an attribute namespace needs a prefix because a default
 * namespace does not apply to attributes.
 *
 * @param scan - The scan state.
 * @param property - The property signature.
 * @param inherited - The namespace the enclosing element passes down.
 */
const scanProperty = (scan: Scan, property: SchemaAST.PropertySignature, inherited: XmlNamespace | undefined): void => {
  const key = typeof property.name === 'string' ? property.name : String(property.name);
  const isAttribute = isAttributeKey(key);
  const field = keyNamespaceOf(property.type) ?? namespaceOf(property.type);
  if (field !== undefined && key.includes(':'))
    scan.problems.push(`"${key}" already carries a prefix, so it cannot also carry a namespace annotation`);
  else if (isAttribute && field !== undefined && field.prefix === '')
    scan.problems.push(`the attribute "${key}" needs xmlPrefix, because a default namespace does not apply to attributes`);
  else record(scan, key, isAttribute ? field : (field ?? inherited));
  scanNode(scan, property.type, isAttribute ? inherited : (field ?? inherited));
};

/**
 * @description Walks a list of child ASTs under one inherited namespace.
 *
 * @param scan - The scan state.
 * @param nodes - The child ASTs.
 * @param inherited - The namespace they inherit.
 */
const scanAll = (scan: Scan, nodes: ReadonlyArray<SchemaAST.AST>, inherited: XmlNamespace | undefined): void => {
  for (const node of nodes) scanNode(scan, node, inherited);
};

/**
 * @description Records the names in one object node: its properties and its index signatures, each under the namespace the object passes down.
 *
 * @param scan - The scan state.
 * @param ast - The object AST.
 * @param namespace - The namespace the object passes to its members.
 */
const scanObject = (scan: Scan, ast: SchemaAST.Objects, namespace: XmlNamespace | undefined): void => {
  for (const property of ast.propertySignatures) scanProperty(scan, property, namespace);
  for (const index of ast.indexSignatures) scanNode(scan, index.type, namespace);
};

/**
 * @description Records every name in one schema AST, carrying the namespace an element passes to its descendants.
 *
 * @param scan - The scan state.
 * @param ast - The AST to walk.
 * @param inherited - The namespace the enclosing element passes down.
 */
const scanNode = (scan: Scan, ast: SchemaAST.AST, inherited: XmlNamespace | undefined): void => {
  if (scan.seen.has(ast)) return;
  scan.seen.add(ast);
  const namespace = namespaceOf(ast) ?? inherited;
  switch (ast._tag) {
    case 'Objects':
      scanObject(scan, ast, namespace);
      return;
    case 'Arrays':
      scanAll(scan, [...ast.elements, ...ast.rest], namespace);
      return;
    case 'Union':
      scanAll(scan, ast.types, namespace);
      return;
    case 'Suspend':
      scanNode(scan, ast.thunk(), namespace);
      return;
    case 'Declaration':
      scanAll(scan, ast.typeParameters, namespace);
      return;
    default:
      return;
  }
};

/**
 * @description Collects the namespace of every name in a schema. A namespace is inherited by descendant elements, the way a default namespace is, and an element
 * field records its own namespace, so encode and decode can find it by the local name alone.
 *
 * @param schema - The schema to walk.
 *
 * @returns The plan, or the annotations that cannot be honored.
 */
export const namespacePlan = (schema: Schema.Constraint): { readonly plan: NamespacePlan } | { readonly error: string } => {
  const scan: Scan = { byKey: new Map(), problems: [], seen: new Set() };
  scanNode(scan, schema.ast, undefined);
  if (scan.problems.length > 0) return { error: [...new Set(scan.problems)].join('; ') };

  const byResolved = new Map<string, string>();
  for (const [key, namespace] of scan.byKey) byResolved.set(`${namespace.uri}|${localName(key)}`, key);
  return { plan: { byKey: scan.byKey, root: namespaceOf(schema.ast), byResolved } };
};

/**
 * @description Whether a key is a namespace declaration the codec manages: `@xmlns` or `@xmlns:prefix`.
 *
 * @param key - The record key.
 *
 * @returns Whether the key is a declaration.
 */
const isDeclarationKey = (key: string): boolean => key === `${ATTRIBUTE_PREFIX}xmlns` || key.startsWith(`${ATTRIBUTE_PREFIX}xmlns:`);

/**
 * @description The prefix a declaration key carries, or `''` for the default namespace.
 *
 * @param key - A key {@link isDeclarationKey} accepted.
 *
 * @returns The prefix.
 */
const declarationPrefix = (key: string): string => (key === `${ATTRIBUTE_PREFIX}xmlns` ? '' : key.slice(`${ATTRIBUTE_PREFIX}xmlns:`.length));

/**
 * @description Writes the declaration for a namespace into an element's record, when the scope does not already bind it. A prefixed namespace is declared as
 * `xmlns:prefix`; the default namespace as `xmlns`; and an element that leaves a default namespace in scope for no namespace of its own clears it
 * with `xmlns=""`.
 *
 * @param out - The element's record, written in place.
 * @param scope - The in-scope prefix bindings, updated in place.
 * @param namespace - The element's namespace, or `undefined`.
 */
const declare = (out: Record<string, XmlValue>, scope: Record<string, string | undefined>, namespace: XmlNamespace | undefined): void => {
  if (namespace !== undefined && namespace.prefix !== '') {
    if (scope[namespace.prefix] === namespace.uri) return;
    out[`${ATTRIBUTE_PREFIX}xmlns:${namespace.prefix}`] = namespace.uri;
    scope[namespace.prefix] = namespace.uri;
    return;
  }
  if (namespace !== undefined) {
    if (scope[''] === namespace.uri) return;
    out[`${ATTRIBUTE_PREFIX}xmlns`] = namespace.uri;
    scope[''] = namespace.uri;
    return;
  }
  if (scope[''] === undefined) return;
  out[`${ATTRIBUTE_PREFIX}xmlns`] = '';
  scope[''] = undefined;
};

/**
 * @description The wire key for one schema key: the local name with the prefix its namespace declares, or the key unchanged when there is no prefix.
 *
 * @param key - The schema key.
 * @param namespace - The key's namespace, or `undefined`.
 *
 * @returns The key to write.
 */
const wireKey = (key: string, namespace: XmlNamespace | undefined): string => {
  if (namespace === undefined || namespace.prefix === '') return key;
  const isAttribute = isAttributeKey(key);
  return `${isAttribute ? ATTRIBUTE_PREFIX : ''}${namespace.prefix}:${localName(key)}`;
};

/**
 * @description Writes one record's fields under the element's scope: an attribute is a leaf and declares its prefix on this element, while a child element
 * recurses with its own namespace.
 *
 * @param value - The element's record, keyed by the schema's local names.
 * @param plan - The namespace plan.
 * @param out - The wire record, written in place.
 * @param scope - The prefix bindings in scope for this element.
 */
const encodeFields = (value: XmlRecord, plan: NamespacePlan, out: Record<string, XmlValue>, scope: Record<string, string | undefined>): void => {
  for (const [key, child] of Object.entries(value)) {
    if (isDeclarationKey(key)) continue;
    const childNamespace = plan.byKey.get(key);
    if (isAttributeKey(key)) {
      if (childNamespace !== undefined) declare(out, scope, childNamespace);
      out[wireKey(key, childNamespace)] = child;
      continue;
    }
    out[wireKey(key, childNamespace)] = encodeNames(child, plan, childNamespace, scope);
  }
};

/**
 * @description Rewrites a value tree into its namespaced wire form: every field with a plan entry gets its prefix, and every element declares the namespace its
 * subtree uses. A leaf that has to carry a declaration is wrapped as a `#text` record so the attribute has somewhere to live.
 *
 * @param value - The value tree, keyed by the schema's local names.
 * @param plan - The namespace plan.
 * @param namespace - This element's namespace.
 * @param scope - The prefix bindings in scope above this element.
 *
 * @returns The wire tree.
 */
export const encodeNames = (
  value: XmlValue,
  plan: NamespacePlan,
  namespace: XmlNamespace | undefined,
  scope: Record<string, string | undefined>
): XmlValue => {
  if (Array.isArray(value)) return value.map(member => encodeNames(member, plan, namespace, scope));

  const out: Record<string, XmlValue> = {};
  const inner = { ...scope };
  declare(out, inner, namespace);

  if (value === undefined) return undefined;
  if (typeof value === 'string') return Object.keys(out).length > 0 ? { ...out, [TEXT_KEY]: value } : value;
  if (!isRecord(value)) return value;

  encodeFields(value, plan, out, inner);
  return out;
};

/**
 * @description Resolves a wire name to its URI and local name against the in-scope bindings. An unprefixed element takes the default namespace; an unprefixed
 * attribute has no namespace, because a default namespace does not apply to attributes.
 *
 * @param name - The name as written, without the attribute prefix.
 * @param isAttribute - Whether the name belongs to an attribute.
 * @param scope - The in-scope prefix bindings.
 *
 * @returns The resolved URI (possibly `undefined`) and local name.
 */
const resolveName = (
  name: string,
  isAttribute: boolean,
  scope: Record<string, string | undefined>
): { readonly uri: string | undefined; readonly local: string } => {
  const colon = name.indexOf(':');
  if (colon === -1) return { uri: isAttribute ? undefined : scope[''], local: name };
  return { uri: scope[name.slice(0, colon)], local: name.slice(colon + 1) };
};

/**
 * @description Reads an element's declarations into a fresh scope that falls back to the enclosing one.
 *
 * @param value - The element's record.
 * @param scope - The bindings in scope above the element.
 *
 * @returns The element's own scope.
 */
const scopeOf = (value: XmlRecord, scope: Record<string, string | undefined>): Record<string, string | undefined> => {
  const inner = { ...scope };
  for (const [key, declaration] of Object.entries(value)) {
    if (isDeclarationKey(key) && typeof declaration === 'string') inner[declarationPrefix(key)] = declaration;
  }
  return inner;
};

/**
 * @description The schema key a wire key resolves to: the plan's key for its URI and local name, or the local name when the schema left it unannotated.
 *
 * @param plan - The namespace plan.
 * @param key - The wire key.
 * @param scope - The in-scope prefix bindings.
 *
 * @returns The schema key.
 */
const schemaKey = (plan: NamespacePlan, key: string, scope: Record<string, string | undefined>): string => {
  const isAttribute = isAttributeKey(key);
  const { uri, local } = resolveName(localName(key), isAttribute, scope);
  return plan.byResolved.get(`${uri ?? ''}|${local}`) ?? (isAttribute ? `${ATTRIBUTE_PREFIX}${local}` : local);
};

/**
 * @description Rewrites a wire value tree back to the schema's local names, resolving every name against the declarations the document carries and dropping those
 * declarations. A record left holding only character data collapses back to that string, which is how a namespaced leaf stays a `Schema.String`.
 *
 * @param value - The parsed wire tree.
 * @param plan - The namespace plan.
 * @param scope - The prefix bindings in scope above this element.
 *
 * @returns The value tree, keyed by the schema's names.
 */
export const decodeNames = (value: XmlValue, plan: NamespacePlan, scope: Record<string, string | undefined>): XmlValue => {
  if (Array.isArray(value)) return value.map(member => decodeNames(member, plan, scope));
  if (typeof value === 'string' || value === undefined) return value;
  if (!isRecord(value)) return value;

  const inner = scopeOf(value, scope);
  const out: Record<string, XmlValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isDeclarationKey(key)) continue;
    out[schemaKey(plan, key, inner)] = decodeNames(child, plan, inner);
  }

  const keys = Object.keys(out);
  if (keys.length === 1 && keys[0] === TEXT_KEY) return out[TEXT_KEY];
  return out;
};
