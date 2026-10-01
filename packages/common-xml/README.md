# @endevops/common-xml

[![license](https://img.shields.io/npm/l/@endevops/common-xml.svg)](./LICENSE)

The primitives the rest of this workspace shares: XML and HTML entity encoding and
decoding, path tracking and pattern matching, and validation of the XML name
productions.

These were published separately as `@endevops/entities`,
`@endevops/path-expression-matcher` and `@endevops/xml-naming`. They are now one
package because they are always installed together — the parser needs all three,
and so does the builder — and none of them has a use without the other two
nearby. A caller who wanted `sanitize` from `xml-naming` had to know the other
two existed.

None of the three exports a name another uses, so the root export is flat:

```bash
npm install @endevops/common-xml
```

```typescript
import { Effect } from 'effect';
import { EntityDecoder, COMMON_HTML, Matcher, Expression, createValidator, sanitize } from '@endevops/common-xml';
```

## What is in here

| Section                             | Exports                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Entities](#entities)               | `EntityDecoder`, `EntityEncoder`, the sixteen named entity tables, `ENTITY_ACTION`                         |
| [Path matching](#path-matching)     | `Matcher`, `MatcherView`, `Expression`, `ExpressionSet` and the read-only view types                       |
| [Name validation](#name-validation) | `name`, `ncName`, `qName`, `nmToken`, `nmTokens`, `createValidator`, `validate`, `validateAll`, `sanitize` |

The source is still split into `src/entities/`, `src/naming/` and
`src/path-matcher/`, each with its own barrel, and the specs sit under the
matching `test/` subdirectory. Nothing is exposed per-area at the package
boundary — the three areas are one package, and a caller imports from one place.

---

## Errors

Every fallible operation returns an `Effect` with one error type, `XmlError`,
in its `E` channel. Nothing in this package throws, and a failure is a value you
can branch on rather than a `catch` you have to string-match.

`XmlError` carries a `reason` — a tagged union of the eight things that can go
wrong — rather than a pile of separate classes, so recovering from a specific
cause is a `catchReason` away and the `message` stays available for a log:

```typescript
import { Effect } from 'effect';
import { EntityDecoder, Expression, XmlError } from '@endevops/common-xml';

const program = Effect.gen(function* () {
  const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 100 } });
  return yield* decoder.decode('a &amp; b');
});

Effect.catchReason(program, 'XmlError', 'ExpansionLimitExceeded', reason => Effect.succeed(`gave up after ${reason.actual} expansions`));
```

The eight reasons, and what raises each:

| Reason                         | Raised by                                                | Means                                          |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------- |
| `InvalidProduction`            | `createValidator`, `validate`, `validateAll`             | A production outside the five known ones       |
| `InvalidPattern`               | `Expression.make`                                        | A pattern segment that will not parse          |
| `SealedExpressionSet`          | `ExpressionSet.add`, `ExpressionSet.addAll`              | An add after `seal()`                          |
| `InvalidEntityName`            | `EntityDecoder.setExternalEntities`, `addExternalEntity` | A name that cannot be written as `&name;`      |
| `EntityRejected`               | the same three registration methods                      | A hook returned `throw`                        |
| `ExpansionLimitExceeded`       | `EntityDecoder.decode`                                   | A document expanded past `maxTotalExpansions`  |
| `ExpandedLengthLimitExceeded`  | `EntityDecoder.decode`                                   | A document grew past `maxExpandedLength`       |
| `ProhibitedCharacterReference` | `EntityDecoder.decode`                                   | A numeric reference the `ncr` policy prohibits |

The messages are reproduced verbatim from what this package used to throw,
including the `[EntityReplacer]` prefix on the two limit errors and the two
name-validation errors. That prefix named a class this package does not have and
never did, and it is documented as load-bearing for anything matching on it, so
it is preserved rather than tidied.

### What stayed synchronous, and why

A regex test cannot fail and a character substitution has nothing to fail about,
so the five boolean validators, `sanitize`, and every pure `Matcher` /
`MatcherView` query stayed plain synchronous functions. Keeping them callable as
predicates is what lets the builder and the codec use them per name, inside their
own hot loops. `EntityEncoder.encode` does return an `Effect` even though it
cannot fail — not so the caller has to handle a case that does not exist, but so
it composes with `EntityDecoder.decode`, which does.

The rule this drew: **anything that can fail is an `Effect`; anything that
cannot stays a plain function.**

---

## Entities

XML and HTML entity encoding and decoding, with expansion limits and registration hooks.

### This is a fork

This project is not the original package. It started as a copy of [`@nodable/entities`](https://www.npmjs.com/package/@nodable/entities) and is
maintained separately by Endevops. The name changed and the code was rewritten in TypeScript, so this repository is the place to file issues against
the fork, not the upstream one.

Behaviour is byte-identical. What changed is how the code is written and tested:

| Change                                                | Why                                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain JavaScript with a hand-written `index.d.ts`     | Types now come from the implementation that enforces them. Upstream declared `EntityDecoder` as the module's **default** export while the runtime exports it by name, so the two import forms failed in opposite directions |
| `EntityDecoder` and `EntityEncoder` are named exports | Same problem, fixed. A named import is the one that runs                                                                                                                                                                    |
| No default export                                     | The module has two classes of equal standing, and picking one as "the" default would be arbitrary in a way a named import is not                                                                                            |
| `EntityTable` type for the sixteen tables             | Upstream's `.d.ts` did not declare them at all                                                                                                                                                                              |
| Test suite written from scratch, 295 cases            | Upstream shipped no tests for the package this repo had installed as a dependency                                                                                                                                           |

License keeps the upstream MIT copyright notice at `LICENSE-is-entities`; package metadata moves to Endevops.

### The decoder is the interesting half

It parses the reference syntax XML inherits from HTML — `&name;`, `&#NNN;`, `&#xHH;` — with three things layered on that a naive expander does not
have.

**Expansion limits.** A document can define an entity that references another entity ten times over. Ten deep is a denial of service; a hundred is
a fork bomb written in XML. `limit` caps how many references expand and how many characters they may add, per document.

```typescript
const decoder = new EntityDecoder({ limit: { maxTotalExpansions: 100 } });
```

`applyLimitsTo` decides which entities count: `'external'` (the default, so only untrusted input-tier entities are capped), `'base'`,
`'all'`, or an explicit array.

**Registration hooks.** Entities arrive two ways. From the parser's configuration (`namedEntities`) — trusted. From the document being parsed
(`addInputEntities`) — not. A hook decides per entity.

```typescript
const decoder = new EntityDecoder({ onInputEntity: (name, value) => (name.startsWith('x') ? ENTITY_ACTION.BLOCK : ENTITY_ACTION.ALLOW) });
decoder.addInputEntities({ safe: 'ok', xss: '<script>' });
```

`ENTITY_ACTION` is `ALLOW`, `BLOCK` or `THROW`. Hooks run at **registration** time, not during `decode`, so a decision is made once per entity rather
than once per occurrence.

**A numeric-reference policy.** `&#0;` and `&#xD800;` are parseable and are not valid text. `ncr` decides whether they are dropped, left alone, or
made to fail the parse.

```typescript
const decoder = new EntityDecoder({ ncr: { xmlVersion: 1.1, onNCR: 'throw', nullNCR: 'remove' } });
yield * decoder.decode('a &amp; b');
```

The three registration methods — `setExternalEntities`, `addExternalEntity` and
`addInputEntities` — return `Effect<void, XmlError>` for the same reason
`decode` does, and fail with `InvalidEntityName` or `EntityRejected`. A `null`
options object is read as `{}` rather than faulting on the first property read.

### The encoder

```typescript
const encoder = new EntityEncoder();
yield * encoder.encode('<a href="x">& é');
// '&lt;a href=&QUOT;x&QUOT;&gt;&amp; &COPY; é'
```

`maxReplacements` caps replacements **cumulatively** across `encode()` calls, for streaming a document through an encoder in pieces. `reset()` clears
the counter.

### Preserved upstream behaviour

This port is deliberately faithful, which means it carries a catalogue of upstream quirks. They are all pinned by the test suite so a future change
that fixes one is a visible act rather than a silent behaviour change. None is endorsed.

The ones most likely to surprise:

- **Four decoder error messages say `EntityReplacer`, not `EntityDecoder`.** The class has never been called that; the source's own block comment and
  example do, referring to a method that does not exist. Those four messages are now on `XmlError.message` rather than on a thrown error, reproduced
  verbatim.
- **`decode` returns a non-string argument unchanged**, against its own `string` return type.
- **`postCheck` is skipped on both fast paths** — called once for `'&amp'`, zero times for `'plain'` and for `''`.
- **The encoder's 3-character trie is always empty.** No HTML5 entity value is 3 UTF-16 code units, so the whole 3-character branch is dead and a
  value of length 4 or more is dropped silently.
- **`encodeAllNamed: false` only disables the one-character lookup.** The two- and three-character probes are ungated.
- **`MATH.bumpe` and `SHAPES.circ` point at the wrong characters** — the intended glyphs are in the table under three other names each. `&bumpe;`
  gives U+224F where HTML5 says U+224E; `&circ;` gives U+02C6 where it says U+25CB.
- **`encode('&')` is `&amp;`, but the trie says `&AMP;`.** The ASCII branch intercepts before consulting a trie, so roughly 130 trie entries are
  unreachable. The last-inserted name wins by table order, which is why `©` encodes as `&COPY;` and not `&copy;`.

Two worth calling out because they weaken a security boundary rather than merely surprising:

- **`addInputEntities` validates no entity names at all.** Both external setters throw on `#` and on the 16 `SPECIAL_CHARS`; this one accepts
  everything, and a `#`-prefixed name then registers as unreachable, since `decode` routes `#` tokens to the numeric path first.
- **An out-of-union `onNCR` or `nullNCR` silently disables numeric-reference classification.** The lookup reads through `Object.prototype`, so
  `onNCR: 'constructor'` resolves to the `Object` function, the comparison yields `NaN`, and `&#0;` decodes to a literal NUL. Unreachable from
  typed code — which is exactly why the type is a union.

### Verification

Beyond the test suite, four differential harnesses compared this build against the installed original and found zero differences:

| Area      | Assertions | Covers                                                                                                         |
| --------- | ---------: | -------------------------------------------------------------------------------------------------------------- |
| Decoder   |      9,339 | 37 option sets × 60 inputs, the registration throw sites, hook dispatch, `reset`, limits, 3,000 fuzzed strings |
| Encoder   |    219,880 | 11 option sets × 31 inputs, every value in three tables, the replacement counter, 100,504 fuzzed strings       |
| Whole pkg |      7,033 | All 16 tables entry-by-entry, decoder and encoder together, `decode(encode(x))` round-trips                    |
| Tables    |      1,967 | Every key and value in every table, byte-for-byte                                                              |

The decoder's harness was mutation-tested rather than trusted: 26 deliberate defects were injected, 22 were caught, and the four that survived were
verified individually as genuine no-op rewrites.

---

## Path matching

Efficient path tracking and pattern matching for XML, JSON, YAML or any other parsers.

### This is a fork

This project is not the original package. It started as a copy of [`path-expression-matcher`](https://github.com/NaturalIntelligence/path-expression-matcher) and is maintained separately by Endevops. The package name changed and the code was rewritten, so this repository is the place to file issues against the fork, not the upstream one.

Runtime behaviour is unchanged. What changed is how the code is written, typed and tested:

| Change                                                                         | Why                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain JavaScript with a hand-written `index.d.ts`                              | Types now come from the implementation itself, so they cannot drift from it                                                                                            |
| `Expression<T>` and `ExpressionSet<T>` are generic over the expression payload | `data` was declared but untyped and undocumented, so a parser hanging its own config off an expression had to augment the shipped types to get it back                 |
| `findMatch()` returns `Expression \| null`                                     | The shipped declaration claimed a bare `Expression`, so `matched ? … : …` narrowing was impossible without augmenting it                                               |
| `MatcherSnapshot.siblingStacks` is `SiblingLevel[]`                            | The shipped declaration said `Map<string, number>[]`; the runtime has always built `{ counts, total }` objects. The old type would have crashed any `restore()` caller |
| `PathNode.values` and the `get*Attr` methods are `unknown` rather than `any`   | The attribute bag is genuinely arbitrary, and `unknown` makes the caller narrow it                                                                                     |
| Source files renamed to dash-case                                              | Matches the rest of the workspace; upstream used PascalCase                                                                                                            |
| Test suite converted from a hand-rolled `assert` script to vitest              | The old script was not a test framework — it logged a tick per assertion and threw on the first failure                                                                |
| ESM only                                                                       | Matches the rest of the workspace; the CJS/webpack build is gone                                                                                                       |

#### The upstream test suite was red

`node test/readOnly_test.js` failed on its third assertion against upstream's own source. `readOnly()` had been reimplemented from a fresh `Proxy` per call to a single cached `MatcherView`, but the test still asserted that every call returned a new proxy — so the script threw before reaching the other 30-odd blocks, and `npm test` exited non-zero.

The ported spec asserts what the class actually does: `readOnly()` returns the same view every time, which is what makes it safe to cache and hand to callbacks. Six other blocks made claims about the old Proxy — that mutation attempts throw, that `path` is frozen, that assigning `separator` throws — that no longer hold for a class whose mutators are simply absent. Those became assertions that the members are absent, which is the guarantee that survived, now enforced by the type system rather than by a Proxy trap.

Behaviour was verified separately, not just by the suite: 65 patterns across 6 option combinations, every push/pop/update/reset step of a fixed walk script, all three separators, snapshot/restore round-trips including a legacy snapshot with no `keptAttrs`, and every throw site all produce results identical to upstream.

License keeps the upstream MIT copyright notice; package metadata moves to Endevops.

### 🎯 Purpose

The path matcher provides three core classes for tracking and matching paths:

- **`Expression`**: Parses and stores pattern expressions (e.g., `"root.users.user[id]"`)
- **`Matcher`**: Tracks current path during parsing and matches against expressions
- **`MatcherView`**: A lightweight read-only view of a `Matcher`, safe to pass to callbacks

Compatible with [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) and similar tools.

### 📦 Installation

```bash
npm install @endevops/common-xml
```

### 🚀 Quick Start

```javascript
import { Expression, Matcher } from '@endevops/common-xml';

// Create expression (parse once, reuse many times)
const expr = new Expression('root.users.user');

// Create matcher (tracks current path)
const matcher = new Matcher();

matcher.push('root');
matcher.push('users');
matcher.push('user', { id: '123' });

// Match current path against expression
if (matcher.matches(expr)) {
  console.log('Match found!');
  console.log('Current path:', matcher.toString()); // "root.users.user"
}

// Namespace support
const nsExpr = new Expression('soap::Envelope.soap::Body..ns::UserId');
matcher.push('Envelope', null, 'soap');
matcher.push('Body', null, 'soap');
matcher.push('UserId', null, 'ns');
console.log(matcher.toString()); // "soap:Envelope.soap:Body.ns:UserId"
```

### 📖 Pattern Syntax

#### Basic Paths

```javascript
'root.users.user'; // Exact path match
'*.users.user'; // Wildcard: any parent
'root.*.user'; // Wildcard: any middle
'root.users.*'; // Wildcard: any child
```

#### Deep Wildcard

```javascript
'..user'; // user anywhere in tree
'root..user'; // user anywhere under root
'..users..user'; // users somewhere, then user below it
```

#### Attribute Matching

```javascript
'user[id]'; // user with "id" attribute
'user[type=admin]'; // user with type="admin" (current node only)
```

> **Note:** Attribute conditions in expressions only ever look at the **current** (last) node in the path — `..user` matches `user` at any depth, but bracket conditions like `[lang]` still apply to `user` itself, never to an ancestor tag. To check an _ancestor's_ attribute (e.g. "is there a `lang` attribute somewhere above this node?"), use `push(..., { keep: [...] })` with `getAnyParentAttr()` / `hasAnyParentAttr()` — see [Ancestor Attributes (`keep`)](#ancestor-attributes-keep) below.

#### Position Selectors

```javascript
'user:first'; // First user (counter=0)
'user:nth(2)'; // Third user (counter=2, zero-based)
'user:odd'; // Odd-numbered users (counter=1,3,5...)
'user:even'; // Even-numbered users (counter=0,2,4...)
'root.users.user:first'; // First user under users
```

**Note:** Position selectors use the **counter** (occurrence count of the tag name), not the position (child index). For example, in `<root><a/><b/><a/></root>`, the second `<a/>` has position=2 but counter=1.

#### Namespaces

```javascript
'ns::user'; // user with namespace "ns"
'soap::Envelope'; // Envelope with namespace "soap"
'ns::user[id]'; // user with namespace "ns" and "id" attribute
'ns::user:first'; // First user with namespace "ns"
'*::user'; // user with any namespace
'..ns::item'; // item with namespace "ns" anywhere in tree
'soap::Envelope.soap::Body'; // Nested namespaced elements
'ns::first'; // Tag named "first" with namespace "ns" (NO ambiguity!)
```

**Namespace syntax:**

- Use **double colon (::)** for namespace: `ns::tag`
- Use **single colon (:)** for position: `tag:first`
- Combined: `ns::tag:first` (namespace + tag + position)

**Namespace matching rules:**

- Pattern `ns::user` matches only nodes with namespace "ns" and tag "user"
- Pattern `user` (no namespace) matches nodes with tag "user" regardless of namespace
- Pattern `*::user` matches tag "user" with any namespace (wildcard namespace)
- Namespaces are tracked separately for counter/position (e.g., `ns1::item` and `ns2::item` have independent counters)

#### Wildcard Differences

**Single wildcard (`*`)** - Matches exactly ONE level:

- `"*.fix1"` matches `root.fix1` (2 levels) ✅
- `"*.fix1"` does NOT match `root.another.fix1` (3 levels) ❌
- Path depth MUST equal pattern depth

**Deep wildcard (`..`)** - Matches ZERO or MORE levels:

- `"..fix1"` matches `root.fix1` ✅
- `"..fix1"` matches `root.another.fix1` ✅
- `"..fix1"` matches `a.b.c.d.fix1` ✅
- Works at any depth

#### Combined Patterns

```javascript
'..user[id]:first'; // First user with id, anywhere
'root..user[type=admin]'; // Admin user under root
'ns::user[id]:first'; // First namespaced user with id
'soap::Envelope..ns::UserId'; // UserId with namespace ns under SOAP envelope
```

### 🔧 API Reference

#### Expression

##### Construction

The constructor is private, because a pattern that will not parse is a typed
failure and a constructor has nowhere to put an error channel. Use
`Expression.make`, which returns an `Effect`:

```typescript
Expression.make(pattern, (options = {}), data); // Effect<Expression<T>, XmlError>
```

Fails with the `InvalidPattern` reason for an empty namespace
(`detail: 'EmptyNamespace'`) or a segment that resolves to no tag
(`detail: 'MissingTag'`).

**Parameters:**

- `pattern` (string): Pattern to parse
- `options.separator` (string): Path separator (default: `'.'`)
- `data` (any): Opaque payload, stored on `.data` and returned verbatim. This package never reads it.

**Example:**

```javascript
const expr1 = new Expression('root.users.user');
const expr2 = new Expression('root/users/user', { separator: '/' });
const expr3 = new Expression('root/users/user', { separator: '/' }, { extra: 'data' });
console.log(expr3.data); // { extra: "data" }
```

**In TypeScript**, `data` is a type parameter, so an embedding parser gets its own payload back out of `findMatch` without a cast. Declare it on both classes and the pairing is preserved:

```typescript
interface StopConfig {
  nested: boolean;
}

const stopNodes = new ExpressionSet<StopConfig>();
stopNodes.add(new Expression('root.users.user', {}, { nested: true }));

const matched = stopNodes.findMatch(matcher); // Expression<StopConfig> | null
if (matched?.data?.nested) {
  // matched.data is StopConfig, not unknown
}
```

Omit the type argument and `data` is `unknown`, which is what an untyped embedder wants. A set with no declared payload type still accepts expressions that carry one, so `new ExpressionSet().add(new Expression(p, {}, cfg))` is fine — but reading `.data` off a match from _that_ set needs the annotation, because the set cannot know what it holds.

##### Methods

- `hasDeepWildcard` → boolean (getter)
- `hasAttributeCondition` → boolean (getter)
- `hasPositionSelector` → boolean (getter)
- `toString()` → string

#### Matcher

##### Constructor

```javascript
new Matcher(options);
```

**Parameters:**

- `options.separator` (string): Default path separator (default: `'.'`)

##### Path Tracking Methods

###### `push(tagName, attrValues, namespace, options)`

Add a tag to the current path. Position and counter are automatically calculated.

**Parameters:**

- `tagName` (string): Tag name
- `attrValues` (object, optional): Attribute key-value pairs (current node only)
- `namespace` (string, optional): Namespace for the tag
- `options` (object, optional):
  - `keep` (string[], optional): Names of attributes (from `attrValues`) to retain for ancestor lookup via `getAnyParentAttr()` / `hasAnyParentAttr()`, even after this node is no longer the current node. See [Ancestor Attributes (`keep`)](#ancestor-attributes-keep).

**Example:**

```javascript
matcher.push('user', { id: '123', type: 'admin' });
matcher.push('item'); // No attributes
matcher.push('Envelope', null, 'soap'); // With namespace
matcher.push('Body', { version: '1.1' }, 'soap'); // With both
matcher.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] }); // Retain "version" for descendants
```

**Position vs Counter:**

- **Position**: The child index in the parent (0, 1, 2, 3...)
- **Counter**: How many times this tag name appeared at this level (0, 1, 2...)

Example:

```xml
<root>
  <a/>      <!-- position=0, counter=0 -->
  <b/>      <!-- position=1, counter=0 -->
  <a/>      <!-- position=2, counter=1 -->
</root>
```

###### `pop()`

Remove the last tag from the path.

```javascript
matcher.pop();
```

###### `updateCurrent(attrValues)`

Update current node's attributes (useful when attributes are parsed after push).

```javascript
matcher.push('user'); // Don't know values yet
// ... parse attributes ...
matcher.updateCurrent({ id: '123' });
```

###### `reset()`

Clear the entire path.

```javascript
matcher.reset();
```

##### Query Methods

###### `matches(expression)`

Check if current path matches an Expression.

```javascript
const expr = new Expression('root.users.user');
if (matcher.matches(expr)) {
  // Current path matches
}
```

##### `matchesAny(exprSet)` → `boolean`

Please check `ExpressionSet` class for more details.

```javascript
const matcher = new Matcher();
const exprSet = new ExpressionSet();
exprSet.add(new Expression('root.users.user'));
exprSet.add(new Expression('root.config.*'));
exprSet.seal();

if (matcher.matchesAny(exprSet)) {
  // Current path matches any expression in the set
}
```

###### `getCurrentTag()`

Get current tag name.

```javascript
const tag = matcher.getCurrentTag(); // "user"
```

###### `getCurrentNamespace()`

Get current namespace.

```javascript
const ns = matcher.getCurrentNamespace(); // "soap" or undefined
```

###### `getAttrValue(attrName)`

Get attribute value of current node.

```javascript
const id = matcher.getAttrValue('id'); // "123"
```

###### `hasAttr(attrName)`

Check if current node has an attribute.

```javascript
if (matcher.hasAttr('id')) {
  // Current node has "id" attribute
}
```

###### `getAnyParentAttr(attrName)`

Get the value of an attribute that was explicitly **kept** (via `push(..., { keep: [...] })`) by the current node or any ancestor. Unlike `getAttrValue()`, this works regardless of how far the path has descended since the attribute was pushed — but only for names that were marked with `keep` at push time. If the same name was kept at multiple depths, the **nearest** (most recent) one wins.

```javascript
matcher.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
matcher.push('GetUserRequest');
matcher.push('UserId');

matcher.getAttrValue('version'); // undefined — Body is no longer current
matcher.getAnyParentAttr('version'); // "1.1" — still reachable, because it was kept
```

###### `hasAnyParentAttr(attrName)`

Check whether the current node or any ancestor kept the given attribute via `push(..., { keep: [...] })`.

```javascript
if (matcher.hasAnyParentAttr('version')) {
  // Some node on the path (current or ancestor) kept "version"
}
```

###### `getPosition()`

Get sibling position of current node (child index in parent).

```javascript
const position = matcher.getPosition(); // 0, 1, 2, ...
```

###### `getCounter()`

Get repeat counter of current node (occurrence count of this tag name).

```javascript
const counter = matcher.getCounter(); // 0, 1, 2, ...
```

###### `getIndex()` (deprecated)

Alias for `getPosition()`. Use `getPosition()` or `getCounter()` instead for clarity.

```javascript
const index = matcher.getIndex(); // Same as getPosition()
```

###### `getDepth()`

Get current path depth.

```javascript
const depth = matcher.getDepth(); // 3 for "root.users.user"
```

###### `toString(separator?, includeNamespace?)`

Get path as string.

**Parameters:**

- `separator` (string, optional): Path separator (uses default if not provided)
- `includeNamespace` (boolean, optional): Whether to include namespaces (default: true)

```javascript
const path = matcher.toString(); // "root.ns:user.item"
const path2 = matcher.toString('/'); // "root/ns:user/item"
const path3 = matcher.toString('.', false); // "root.user.item" (no namespaces)
```

###### `toArray()`

Get path as array.

```javascript
const arr = matcher.toArray(); // ["root", "users", "user"]
```

##### State Management

###### `snapshot()`

Create a snapshot of current state.

```javascript
const snapshot = matcher.snapshot();
```

###### `restore(snapshot)`

Restore from a snapshot.

```javascript
matcher.restore(snapshot);
```

##### Read-Only Access

###### `readOnly()`

Returns a **`MatcherView`** — a lightweight, live read-only view of the matcher. All query and inspection methods work normally and always reflect the current state of the underlying matcher. Mutation methods (`push`, `pop`, `reset`, `updateCurrent`, `restore`) simply don't exist on `MatcherView`, so misuse is caught at **compile time** by TypeScript rather than at runtime.

The **same instance** is returned on every call — no allocation occurs per invocation. This is the recommended way to share the matcher with callbacks, plugins, or any external code that only needs to inspect the current path.

```javascript
const view = matcher.readOnly();
// Same reference every time — safe to cache
view === matcher.readOnly(); // true
```

**What works on the view:**

```javascript
view.matches(expr); // ✓ pattern matching
view.getCurrentTag(); // ✓ current tag name
view.getCurrentNamespace(); // ✓ current namespace
view.getAttrValue('id'); // ✓ attribute value
view.hasAttr('id'); // ✓ attribute presence check
view.getPosition(); // ✓ sibling position
view.getCounter(); // ✓ occurrence counter
view.getDepth(); // ✓ path depth
view.toString(); // ✓ path as string
view.toArray(); // ✓ path as array
```

**What doesn't exist (compile-time error in TypeScript):**

```javascript
view.push('child', {}); // ✗ Property 'push' does not exist on type 'MatcherView'
view.pop(); // ✗ Property 'pop' does not exist on type 'MatcherView'
view.reset(); // ✗ Property 'reset' does not exist on type 'MatcherView'
view.updateCurrent({}); // ✗ Property 'updateCurrent' does not exist on type 'MatcherView'
view.restore(snapshot); // ✗ Property 'restore' does not exist on type 'MatcherView'
```

**The view is live** — it always reflects the current state of the underlying matcher.

```javascript
const matcher = new Matcher();
const view = matcher.readOnly();

matcher.push('root');
view.getDepth(); // 1 — immediately reflects the push
matcher.push('users');
view.getDepth(); // 2 — still live
```

### 💡 Usage Examples

#### Example 1: XML Parser with stopNodes

```javascript
import { XMLParser } from 'fast-xml-parser';
import { Expression, Matcher } from '@endevops/common-xml';

class MyParser {
  constructor() {
    this.matcher = new Matcher();

    // Pre-compile stop node patterns
    this.stopNodeExpressions = [new Expression('html.body.script'), new Expression('html.body.style'), new Expression('..svg')];
  }

  parseTag(tagName, attrs) {
    this.matcher.push(tagName, attrs);

    // Check if this is a stop node
    for (const expr of this.stopNodeExpressions) {
      if (this.matcher.matches(expr)) {
        // Don't parse children, read as raw text
        return this.readRawContent();
      }
    }

    // Continue normal parsing
    this.parseChildren();

    this.matcher.pop();
  }
}
```

#### Example 2: Conditional Processing

```javascript
const matcher = new Matcher();
const userExpr = new Expression('..user[type=admin]');
const firstItemExpr = new Expression('..item:first');

function processTag(tagName, value, attrs) {
  matcher.push(tagName, attrs);

  if (matcher.matches(userExpr)) {
    value = enhanceAdminUser(value);
  }

  if (matcher.matches(firstItemExpr)) {
    value = markAsFirst(value);
  }

  matcher.pop();
  return value;
}
```

#### Example 3: Path-based Filtering

```javascript
const patterns = [new Expression('data.users.user'), new Expression('data.posts.post'), new Expression('..comment[approved=true]')];

function shouldInclude(matcher) {
  return patterns.some(expr => matcher.matches(expr));
}
```

#### Example 4: Custom Separator

```javascript
const matcher = new Matcher({ separator: '/' });
const expr = new Expression('root/config/database', { separator: '/' });

matcher.push('root');
matcher.push('config');
matcher.push('database');

console.log(matcher.toString()); // "root/config/database"
console.log(matcher.matches(expr)); // true
```

#### Example 5: Attribute Checking

```javascript
const matcher = new Matcher();
matcher.push('root');
matcher.push('user', { id: '123', type: 'admin', status: 'active' });

// Check attribute existence (current node only)
console.log(matcher.hasAttr('id')); // true
console.log(matcher.hasAttr('email')); // false

// Get attribute value (current node only)
console.log(matcher.getAttrValue('type')); // "admin"

// Match by attribute
const expr1 = new Expression('user[id]');
console.log(matcher.matches(expr1)); // true

const expr2 = new Expression('user[type=admin]');
console.log(matcher.matches(expr2)); // true
```

> Need to check an attribute from an _ancestor_ node, not just the current one? See [Example 5b](#example-5b-ancestor-attributes-keep) and [Ancestor Attributes (`keep`)](#ancestor-attributes-keep).

#### Example 5b: Ancestor Attributes (`keep`)

`getAttrValue()` / `hasAttr()` only ever see the **current** node — by design, ancestor attribute values are discarded as soon as you push past them, to keep memory usage low. If you know in advance that a specific attribute (e.g. a SOAP envelope's `version`, or `xml:space`) will matter much deeper in the tree, mark it to be **kept**:

```javascript
const matcher = new Matcher();
matcher.push('Envelope', null, 'soap');
matcher.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
matcher.push('GetUserRequest', { id: '42' });
matcher.push('UserId');

// Ordinary attribute access only sees the current node:
console.log(matcher.getAttrValue('version')); // undefined

// getAnyParentAttr/hasAnyParentAttr still see it, however deep we've gone:
console.log(matcher.hasAnyParentAttr('version')); // true
console.log(matcher.getAnyParentAttr('version')); // "1.1"

matcher.pop();
matcher.pop();
matcher.pop(); // back to Envelope
console.log(matcher.hasAnyParentAttr('version')); // false — Body (and its kept attrs) was popped
```

**When to use this:** only for the small number of attributes you specifically know you'll need many levels deeper — not as a general substitute for `getAttrValue()`. Each name passed to `keep` adds a tiny, constant amount of bookkeeping at `push()` time; lookups scan only the kept-attributes list (typically 0-3 entries), never the full path, so cost does not grow with document depth.

#### Example 6: Position vs Counter

```javascript
const matcher = new Matcher();
matcher.push('root');

// Mixed tags at same level
matcher.push('item'); // position=0, counter=0 (first item)
matcher.pop();

matcher.push('div'); // position=1, counter=0 (first div)
matcher.pop();

matcher.push('item'); // position=2, counter=1 (second item)

console.log(matcher.getPosition()); // 2 (third child overall)
console.log(matcher.getCounter()); // 1 (second "item" specifically)

// :first uses counter, not position
const expr = new Expression('root.item:first');
console.log(matcher.matches(expr)); // false (counter=1, not 0)
```

#### Example 8: Passing a Read-Only View to External Consumers

When passing the matcher into callbacks, plugins, or other code you don't control, use `readOnly()` to get a `MatcherView` — it can inspect but never mutate parser state.

```javascript
import { Expression, Matcher } from '@endevops/common-xml';

const matcher = new Matcher();

const adminExpr = new Expression('..user[type=admin]');

function parseTag(tagName, attrs, onTag) {
  matcher.push(tagName, attrs);

  // Pass MatcherView — consumer can inspect but not mutate
  onTag(matcher.readOnly());

  matcher.pop();
}

// Safe consumer — can only read
function myPlugin(view) {
  if (view.matches(adminExpr)) {
    console.log('Admin at path:', view.toString());
    console.log('Depth:', view.getDepth());
    console.log('ID:', view.getAttrValue('id'));
  }
}

// view.push(...) or view.reset() don't exist on MatcherView —
// TypeScript catches misuse at compile time.
parseTag('user', { id: '1', type: 'admin' }, myPlugin);
```

```javascript
const matcher = new Matcher();
const soapExpr = new Expression('soap::Envelope.soap::Body..ns::UserId');

// Parse SOAP document
matcher.push('Envelope', { xmlns: '...' }, 'soap');
matcher.push('Body', null, 'soap');
matcher.push('GetUserRequest', null, 'ns');
matcher.push('UserId', null, 'ns');

// Match namespaced pattern
if (matcher.matches(soapExpr)) {
  console.log('Found UserId in SOAP body');
  console.log(matcher.toString()); // "soap:Envelope.soap:Body.ns:GetUserRequest.ns:UserId"
}

// Namespace-specific counters
matcher.reset();
matcher.push('root');
matcher.push('item', null, 'ns1'); // ns1::item counter=0
matcher.pop();
matcher.push('item', null, 'ns2'); // ns2::item counter=0 (different namespace)
matcher.pop();
matcher.push('item', null, 'ns1'); // ns1::item counter=1

const firstNs1Item = new Expression('root.ns1::item:first');
console.log(matcher.matches(firstNs1Item)); // false (counter=1)

const secondNs1Item = new Expression('root.ns1::item:nth(1)');
console.log(matcher.matches(secondNs1Item)); // true

// NO AMBIGUITY: Tags named after position keywords
matcher.reset();
matcher.push('root');
matcher.push('first', null, 'ns'); // Tag named "first" with namespace

const expr = new Expression('root.ns::first');
console.log(matcher.matches(expr)); // true - matches namespace "ns", tag "first"
```

### 🏗️ Architecture

#### Data Storage Strategy

**Ancestor nodes:** Store only tag name, position, and counter (minimal memory)
**Current node:** Store tag name, position, counter, and attribute values

This design minimizes memory usage:

- No attribute names stored (derived from values object when needed)
- Attribute values only for current node, not ancestors, **by default**
- For 1M nodes with 3 attributes each, saves ~50MB vs storing attribute names

#### Ancestor Attributes (`keep`)

The trade-off above is the right default, but XML/SOAP documents occasionally have a handful of attributes — `xml:space`, a SOAP envelope's `version`, a feature-flag at the document root — that genuinely need to be visible many levels deeper. Rather than retaining _all_ attribute values for _every_ node (defeating the memory savings above), `push()` accepts an explicit opt-in:

```javascript
matcher.push('Body', { version: '1.1' }, 'soap', { keep: ['version'] });
```

Only the named attribute(s) are copied into a small side-stack (`_keptAttrs`), independent of the normal per-node `values`. Reachable later via `getAnyParentAttr(name)` / `hasAnyParentAttr(name)` regardless of depth — see [Example 5b](#example-5b-ancestor-attributes-keep).

**Why this stays cheap:**

- Pushing without `options` costs two extra property reads — no allocation, no measurable overhead (benchmarked: within run-to-run noise vs. plain `push()`).
- Lookups scan only the kept-attributes stack, not the full path — cost is proportional to _how many distinct attributes are currently kept_ (typically 0-3 in real usage), not to document depth.
- `pop()` truncates kept entries belonging to the popped subtree in the same backward-scan style, so the stack never grows unbounded.
- The core `matches()` / `_matchSegment` pattern-matching path is completely unaffected — `keep` is a separate, opt-in mechanism with no new expression syntax.

This is intentionally a narrow escape hatch, not a general "remember everything" toggle — overusing `keep` (e.g. keeping every attribute on every node) reintroduces the same memory cost this library avoids by default.

#### Matching Strategy

Matching is performed **bottom-to-top** (from current node toward root):

1. Start at current node
2. Match segments from pattern end to start
3. Attribute _expression_ conditions (`[attr=value]`) only apply to the current node — ancestors have no attribute data in the path itself. For genuinely ancestor-scoped checks outside of expression matching, use `keep` (above).
4. Position selectors use **counter** (occurrence count), not position (child index)

#### Performance

- **Expression parsing:** One-time cost when Expression is created
- **Expression analysis:** Cached (hasDeepWildcard, hasAttributeCondition, hasPositionSelector)
- **Path tracking:** O(1) for push/pop operations (O(k) additionally when `options.keep` is used, where k = number of kept attribute names — typically 0-3)
- **Pattern matching:** O(n*m) where n = path depth, m = pattern segments
- **Ancestor attribute lookup:** O(k) where k = number of currently-kept attributes, independent of path depth
- **Memory per ancestor node:** ~40-60 bytes (tag, position, counter only)
- **Memory per current node:** ~80-120 bytes (adds attribute values)

### 🎓 Design Patterns

#### Pre-compile Patterns (Recommended)

```javascript
// ✅ GOOD: Parse once, reuse many times
const expr = new Expression('..user[id]');

for (let i = 0; i < 1000; i++) {
  if (matcher.matches(expr)) {
    // ...
  }
}
```

```javascript
// ❌ BAD: Parse on every iteration
for (let i = 0; i < 1000; i++) {
  if (matcher.matches(new Expression('..user[id]'))) {
    // ...
  }
}
```

#### Batch Pattern Checking with ExpressionSet (Recommended)

For checking multiple patterns on every tag, use `ExpressionSet` instead of a manual loop.
It pre-indexes expressions at build time so each call to `matchesAny()` does an O(1) bucket
lookup rather than a full O(N) scan:

```javascript
import { Expression, ExpressionSet, Matcher } from '@endevops/common-xml';

// Build once at config/startup time
const stopNodes = new ExpressionSet();
stopNodes.add(new Expression('root.users.user')).add(new Expression('root.config.*')).add(new Expression('..script')).seal(); // prevent accidental mutation during parsing

// Per-tag — hot path
if (stopNodes.matchesAny(matcher)) {
  // handle stop node
}
```

This replaces the manual loop pattern:

```javascript
// ❌ Before — O(N) per tag
function isStopNode(expressions, matcher) {
  for (let i = 0; i < expressions.length; i++) {
    if (matcher.matches(expressions[i])) return true;
  }
  return false;
}

// ✅ After — O(1) lookup per tag
const stopNodes = new ExpressionSet();
stopNodes.addAll(expressions);
stopNodes.matchesAny(matcher);
//or matcher.matchesAny(stopNodes)
```

---

### 📦 ExpressionSet API

`ExpressionSet` is an indexed collection of `Expression` objects designed for efficient
bulk matching. Build it once from your config, then call `matchesAny()` on every tag.

#### Constructor

```javascript
const set = new ExpressionSet();
```

#### `add(expression)` → `Effect<this, XmlError>`

Add a single `Expression`. Duplicate patterns (same pattern string) are silently ignored.
Fails with the `SealedExpressionSet` reason if the set has been sealed.

```typescript
yield * set.add(Expression.make('root.users.user'));
yield * set.add(Expression.make('..script'));
```

#### `addAll(expressions)` → `Effect<this, XmlError>`

Add an array of `Expression` objects at once. Fails with the
`SealedExpressionSet` reason; the expressions added before the failure are kept,
matching the original behaviour of a throw mid-loop.

```typescript
yield * set.addAll(config.stopNodes.map(p => Expression.make(p)));
```

#### `has(expression)` → `boolean`

Check whether an expression with the same pattern is already present.

```javascript
set.has(new Expression('root.users.user')); // true / false
```

#### `seal()` → `this`

Prevent further additions. Any subsequent call to `add()` or `addAll()` throws a `TypeError`.
Useful to guard against accidental mutation once parsing has started.

```javascript
const stopNodes = new ExpressionSet();
stopNodes.addAll(patterns).seal();

stopNodes.add(new Expression('root.extra')); // ❌ TypeError: ExpressionSet is sealed
```

#### `size` → `number`

Number of distinct expressions in the set.

```javascript
set.size; // 3
```

#### `isSealed` → `boolean`

Whether `seal()` has been called.

#### `matchesAny(matcher)` → `boolean`

Returns `true` if the matcher's current path matches **any** expression in the set.
Accepts both a `Matcher` instance and a `MatcherView`.

```javascript
if (stopNodes.matchesAny(matcher)) {
  /* ... */
}
if (stopNodes.matchesAny(matcher.readOnly())) {
  /* ... */
} // also works
```

**How indexing works:** expressions are bucketed at `add()` time, not at match time.

| Expression type                              | Bucket          | Lookup cost           |
| -------------------------------------------- | --------------- | --------------------- |
| Fixed path, concrete tag (`root.users.user`) | `depth:tag` map | O(1)                  |
| Fixed path, wildcard tag (`root.config.*`)   | `depth` map     | O(1)                  |
| Deep wildcard (`..script`)                   | flat list       | O(D) — always scanned |

In practice, deep-wildcard expressions are rare in configs, so the list stays small.

#### `findMatch(matcher)` → `Expression | null`

Returns the first Expression whose pattern matches the current path, or `null` if none does. Accepts both a `Matcher` instance and a `MatcherView`.

The return value is nullable, so the guard is the narrowing step — there is no separate `matchesAny` call needed first when you want the match itself:

```javascript
const node = stopNodes.findMatch(matcher);
```

`matchesAny(matcher)` is `findMatch(matcher) !== null`, for when only the boolean matters.

#### Example 7: ExpressionSet in a real parser loop

```javascript
import { XMLParser } from 'fast-xml-parser';
import { Expression, ExpressionSet, Matcher } from '@endevops/common-xml';

// Config-time setup
const stopNodes = new ExpressionSet();
stopNodes.addAll(['script', 'style'].map(t => new Expression(`..${t}`))).seal();

const matcher = new Matcher();

const parser = new XMLParser({
  onOpenTag(tagName, attrs) {
    matcher.push(tagName, attrs);
    if (stopNodes.matchesAny(matcher)) {
      // treat as stop node
    }
  },
  onCloseTag() {
    matcher.pop();
  },
});
```

### 🔗 Integration with fast-xml-parser

**Basic integration:**

```javascript
import { XMLParser } from 'fast-xml-parser';
import { Expression, Matcher } from '@endevops/common-xml';

const parser = new XMLParser({
  // Custom options using path-expression-matcher
  stopNodes: ['script', 'style'].map(tag => new Expression(`..${tag}`)),

  tagValueProcessor: (tagName, value, jPath, hasAttrs, isLeaf, matcher) => {
    // matcher is available in callbacks
    if (matcher.matches(new Expression('..user[type=admin]'))) {
      return enhanceValue(value);
    }
    return value;
  },
});
```

---

## Name validation

Validates XML name productions as defined in the [XML 1.0](https://www.w3.org/TR/xml/) and [XML 1.1](https://www.w3.org/TR/xml11/) specifications.

Covers all five productions:

| Production | Description                               | Colon         | Digit/hyphen start |
| ---------- | ----------------------------------------- | ------------- | ------------------ |
| `Name`     | General XML name                          | ✅            | ❌                 |
| `NCName`   | Non-Colonized name                        | ❌            | ❌                 |
| `QName`    | Namespace-qualified name (`prefix:local`) | ✅ (one only) | ❌                 |
| `NMToken`  | Name token (relaxed start)                | ✅            | ✅                 |
| `NMTokens` | Whitespace-separated NMToken list         | ✅            | ✅                 |

### This is a fork

This project is not the original package. It started as a copy of [`xml-naming`](https://github.com/NaturalIntelligence/xml-naming) and is maintained separately by Endevops. The package name changed and the code was rewritten, so this repository is the place to file issues against the fork, not the upstream one.

The runtime behaviour is unchanged. What changed is how the code is written and built:

| Change                                              | Why                                                      |
| --------------------------------------------------- | -------------------------------------------------------- |
| Plain JavaScript with a hand-written `.d.ts`        | Types now come from the implementation itself            |
| `ValidationResult` is a discriminated union         | `reason`/`position` need no cast or optional chaining    |
| Specs and benchmark fully typed                     | Both are compiler-checked, which surfaced latent drift   |
| ESM only                                            | Matches the rest of the workspace; the CJS build is gone |
| Built with Vite+ (`vp pack`, `vp test`, `vp check`) | Replaces the previous ad-hoc build setup                 |

`bench/naming.bench.ts` is a [Vitest benchmark](https://vitest.dev/guide/benchmarking.html) measuring the `asciiOnly` fast path against the unicode-aware default. Run it with `vp run bench` from the workspace root, or `vp test bench packages/common-xml` for this package alone. `vp test` skips it.

---

### Install

```bash
npm install @endevops/common-xml
```

---

### Usage

#### Boolean validators

```js
import { name, ncName, qName, nmToken, nmTokens } from '@endevops/common-xml';

// Name — colon allowed anywhere, used for DOCTYPE entity names
name('foo'); // true
name('a:b:c'); // true  ← multiple colons fine for Name
name('1foo'); // false ← digit start invalid

// NCName — no colon, used for SVG id attributes, namespace prefixes
ncName('my-id'); // true
ncName('xlink:href'); // false ← colon not allowed

// QName — exactly one colon as prefix separator, used for element/attribute names
isQName('svg:circle'); // true
isQName('foo'); // true  ← unprefixed QName is valid
isQName('a:b:c'); // false ← only one colon allowed
isQName(':foo'); // false ← cannot start with colon

// NMToken — any NameChar at start, used for DTD NMTOKEN attributes
nmToken('123'); // true  ← digit start is fine
nmToken('-bar'); // true
nmToken('foo bar'); // false ← space not allowed

// NMTokens — whitespace-separated NMToken list
nmTokens('tok1 tok2 -foo 123'); // true
```

#### XML version option

All validators accept an optional `{ xmlVersion }` option:

```js
import { name } from '@endevops/common-xml';

name('\u0085', { xmlVersion: '1.0' }); // false — NEL (Next Line), not in 1.0 ranges
name('\u0085', { xmlVersion: '1.1' }); // true  — explicitly allowed in 1.1

name('\uD800\uDC00', { xmlVersion: '1.0' }); // false
name('\uD800\uDC00', { xmlVersion: '1.1' }); // true
```

---

#### ASCII-only fast path

All validators, `validate`, `validateAll`, and `sanitize` also accept `{ asciiOnly: true }`.
When set, matching is restricted to the ASCII subset of the NameStartChar/NameChar
productions and skips unicode-aware regex matching entirely — no `\u00C0-\uFFFD`-style
ranges, and (for XML 1.1) no `/u` regex flag. Unicode-aware regexes are measurably slower
than plain ASCII matching in JS engines, so this is a real performance win when you know
your input is ASCII-only, which is the common case for HTML/SVG ids and most XML tags.

**This is opt-in and defaults to `false`** for backward compatibility: turning it on
changes behavior, since it rejects legitimate non-ASCII XML names that would otherwise be
valid. Only enable it when you control the input and know it's ASCII (e.g. internal
identifiers, machine-generated names), not for validating arbitrary user- or
externally-supplied XML/SVG content.

```js
import { name, sanitize } from '@endevops/common-xml';

name('café', { asciiOnly: true }); // false — 'é' is not ASCII, even though it's
name('café'); //  true    a valid XML 1.0/1.1 NameChar

sanitize('café', 'name', { asciiOnly: true }); // 'caf_' — non-ASCII replaced too
sanitize('café', 'name'); // 'café' — left untouched by default
```

---

#### Memoized validator (`createValidator`)

Real documents tend to reuse a small vocabulary of tag/attribute names across many
siblings (`id`, `class`, `href`, ... repeated across hundreds of elements). Calling the
plain boolean validators re-runs the regex on every call, even for names seen before.

`createValidator(production, opts)` returns a memoized validator function: `xmlVersion`
and `asciiOnly` are fixed at creation time (so the regex is resolved once, not per call),
and repeated inputs after the first are served from an internal cache instead of
re-matching the regex.

```js
import { createValidator } from '@endevops/common-xml';

const isQName = createValidator('qName', { xmlVersion: '1.0' });

isQName('sku'); // false → regex test (cache miss), result cached
isQName('sku'); // false → cache hit, no regex run
```

Use one instance per document/parse (or reuse across a session — your choice), rather
than creating one per call:

```js
// e.g. inside a parser, once per parse call:
const isValidTag = createValidator('qName', { asciiOnly: true });

for (const tagName of tagNames) {
  if (!isValidTag(tagName)) throw new Error(`Invalid tag name: ${tagName}`);
}
```

Because the validator is a plain function, this loop already gets short-circuit
behaviour (via `break`/`throw` on first failure) and zero extra allocation on the happy
path — no separate "bulk" API is needed for that.

**Cache bound:** the internal cache is capped by `maxCacheSize` (default `2048`). Once
the cap is reached, new distinct strings are still validated correctly, they're just no
longer cached — existing cached entries keep being served. This keeps memory bounded
even against high-cardinality or adversarial input (e.g. externally-supplied names that
never repeat), without the cost of a full LRU or the perf cliff of reset-and-refill.

Call `.reset()` on the returned function to clear the cache manually, e.g. between
unrelated parse calls if you're reusing one validator instance across a long-running
process:

```js
isQName.reset();
```

The cache is private to each `createValidator()` instance — there's no shared/global
cache, so unrelated callers never interfere with each other.

---

#### Diagnostic validation

```js
import { validate } from '@endevops/common-xml';

validate('svg:circle', 'qName');
// { valid: true, production: 'qName', input: 'svg:circle' }

validate('1foo', 'ncName');
// {
//   valid: false,
//   production: 'ncName',
//   input: '1foo',
//   reason: 'First character "1" is not a valid NameStartChar',
//   position: 0
// }

validate('foo:bar', 'ncName');
// {
//   valid: false,
//   production: 'ncName',
//   input: 'foo:bar',
//   reason: 'Colon is not allowed in NCName',
//   position: 3
// }

validate('a:b:c', 'qName');
// {
//   valid: false,
//   production: 'qName',
//   input: 'a:b:c',
//   reason: 'QName can have at most one colon',
//   position: 3
// }
```

---

#### Batch validation

```js
import { validateAll } from '@endevops/common-xml';

validateAll(['svg', 'circle', '123bad', 'xlink:href'], 'ncName');
// [
//   { valid: true,  production: 'ncName', input: 'svg' },
//   { valid: true,  production: 'ncName', input: 'circle' },
//   { valid: false, production: 'ncName', input: '123bad',    reason: '...', position: 0 },
//   { valid: false, production: 'ncName', input: 'xlink:href',reason: '...', position: 5 }
// ]
```

---

#### Sanitize / auto-fix

Useful when generating XML/SVG programmatically from user-supplied strings:

```js
import { sanitize } from '@endevops/common-xml';

sanitize('123abc', 'ncName'); // '_123abc'   ← digit start fixed
sanitize('my element', 'name'); // 'my_element' ← space replaced
sanitize('foo:bar', 'ncName'); // 'foobar'     ← colon stripped
sanitize('hello!', 'name'); // 'hello_'     ← illegal char replaced

// Custom replacement character
sanitize('my element', 'name', { replacement: '-' }); // 'my-element'
```

---

### Which production should I use?

| Context                                       | Production |
| --------------------------------------------- | ---------- |
| XML element/attribute names (namespace-aware) | `qName`    |
| SVG `id` attribute values                     | `ncName`   |
| Namespace prefix alone                        | `ncName`   |
| DOCTYPE `<!ENTITY name ...>`                  | `name`     |
| DOCTYPE `<!NOTATION name ...>`                | `name`     |
| DTD `NMTOKEN` attribute values                | `nmToken`  |
| DTD `NMTOKENS` attribute values               | `nmTokens` |

> **Note:** DOCTYPE entity and notation names must use `Name`, not `QName`. Colons carry no namespace meaning in the DTD subset.

---

### API

#### `isName(str, opts?)` → `boolean`

#### `isNcName(str, opts?)` → `boolean`

#### `isQName(str, opts?)` → `boolean`

#### `isNmToken(str, opts?)` → `boolean`

#### `isNmTokens(str, opts?)` → `boolean`

`opts`:

- `xmlVersion`: `'1.0'` (default) | `'1.1'`
- `asciiOnly`: boolean (default `false`) — ASCII-only fast path, see above

#### `createValidator(production, opts?)` → `MemoizedValidator`

The returned validator is memoized and synchronous — `(str) => boolean` with a
`.reset()` — and throws an `XmlError` with the `InvalidProduction` reason for an
unknown production, which is unreachable from TypeScript where `Production` is a
closed union.

`opts`:

- `xmlVersion`: `'1.0'` (default) | `'1.1'`
- `asciiOnly`: boolean (default `false`)
- `maxCacheSize`: number (default `2048`) — cache stops accepting new entries once reached; existing entries keep serving hits

#### `validate(str, production, opts?)` → `ValidationResult`

`production`: `'name'` | `'ncName'` | `'qName'` | `'nmToken'` | `'nmTokens'`

Throws only with the `InvalidProduction` reason. A name that fails to _validate_
is a result carrying `valid: false` — being invalid is the question being
answered, not a failure of the function.

`opts`: same as boolean validators (`xmlVersion`, `asciiOnly`)

#### `validateAll(strings[], production, opts?)` → `ValidationResult[]`

Throws with the `InvalidProduction` reason, checked once up front rather than per
element, so an empty array fails the same way a populated one does.

`opts`: same as `validate`

#### `sanitize(str, production?, opts?)` → `string`

`opts`:

- `xmlVersion`: `'1.0'` | `'1.1'` — accepted and ignored, see below
- `replacement`: string (default `'_'`)
- `asciiOnly`: boolean (default `false`) — also replaces non-ASCII characters, not just XML-illegal ones

Sanitizing is not version-dependent — the character set it treats as illegal is the union of both versions — so `xmlVersion` has no effect. It stays in the signature because removing it would break callers that pass a shared options object through.

---

---

## License

MIT. The upstream copyright notices for all three merged packages are preserved
as `LICENSE-is-entities`, `LICENSE-is-path-expression-matcher` and
`LICENSE-is-xml-naming`.
