# @endevops/entities

XML and HTML entity encoding and decoding, with expansion limits and registration hooks.

## This is a fork

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

## The decoder is the interesting half

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
new EntityDecoder({ ncr: { xmlVersion: 1.1, onNCR: 'throw', nullNCR: 'remove' } });
```

## The encoder

```typescript
new EntityEncoder().encode('<a href="x">& é');
// '&lt;a href=&QUOT;x&QUOT;&gt;&amp; &COPY; é'
```

`maxReplacements` caps replacements **cumulatively** across `encode()` calls, for streaming a document through an encoder in pieces. `reset()` clears
the counter.

## Preserved upstream behaviour

This port is deliberately faithful, which means it carries a catalogue of upstream quirks. They are all pinned by the test suite so a future change
that fixes one is a visible act rather than a silent behaviour change. None is endorsed.

The ones most likely to surprise:

- **Four decoder error messages say `EntityReplacer`, not `EntityDecoder`.** The class has never been called that; the source's own block comment and
  example do, referring to a method that does not exist.
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

## Verification

Beyond the test suite, four differential harnesses compared this build against the installed original and found zero differences:

| Area      | Assertions | Covers                                                                                                         |
| --------- | ---------: | -------------------------------------------------------------------------------------------------------------- |
| Decoder   |      9,339 | 37 option sets × 60 inputs, the registration throw sites, hook dispatch, `reset`, limits, 3,000 fuzzed strings |
| Encoder   |    219,880 | 11 option sets × 31 inputs, every value in three tables, the replacement counter, 100,504 fuzzed strings       |
| Whole pkg |      7,033 | All 16 tables entry-by-entry, decoder and encoder together, `decode(encode(x))` round-trips                    |
| Tables    |      1,967 | Every key and value in every table, byte-for-byte                                                              |

The decoder's harness was mutation-tested rather than trusted: 26 deliberate defects were injected, 22 were caught, and the four that survived were
verified individually as genuine no-op rewrites.
