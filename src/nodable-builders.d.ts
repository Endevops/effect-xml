/**
 * @description Type augmentations for `@nodable/base-output-builder@2.0.0` and `@nodable/compact-builder@2.0.0`.
 *
 * Their shipped declarations disagree with the implementations this parser actually drives, in ways that make the real classes unassignable to the
 * structural builder contract `src/internal/parser-types.ts` describes:
 *
 * 1. **`onStopNode` / `onExit` demand `line` and `col` on the tag detail.** This parser reports positions index-only — `BufferSource` and `StringSource`
 *    both document that line/column bookkeeping was deliberately dropped — so `{ name, line, col, index }` is a shape the parser can never produce. The
 *    runtime signature is `onStopNode(tagDetail, rawContent)` and the implementation forwards `this.matcher` to the user's own `onStopNode` option
 *    itself, so it needs no `matcher` parameter either. Declared here as the index-only detail the parser actually supplies.
 *
 * `onStopNode` and `onExit` are *not* touched here: an interface augmentation adds an overload rather than replacing a member, so the original
 * two-argument `onStopNode` survives alongside any corrected signature and the class stays unsatisfiable. A builder that overrides those two takes them
 * from the parser's own structural contract (`OutputBuilderLike`) instead; the one cast that needs is in `OptionsBuilder`, where the reason is
 * recorded. The members widened here are the ones the parser calls with a fixed, larger arity that the published declarations simply omit.
 *
 * 2. **`addElement` / `closeElement` / `addValue` are declared with fewer parameters than they receive.** The base declares `addElement(tag)`; the parser
 *    calls `addElement(tag, matcher)`. A function that takes fewer parameters is assignable to one that takes more, so this direction is harmless — but
 *    `closeElement()` declared with zero parameters is not enough to satisfy the `closeMeta` the parser passes as a second argument, and the compact
 *    builder's `addValue(text)` hides that the parser always supplies the matcher. Declared with the arity the parser uses.
 *
 * 3. **`getInstance` is declared to return the base builder** on the base factory, which makes a real factory unassignable wherever a specific builder
 *    type is expected. Left alone here — the structural `OutputBuilderFactoryLike` is what the parser depends on, and widening these would be papering
 *    over a different defect.
 *
 * These are additive: no declared member is removed, only ones whose declared shape is unreachable in practice are corrected. That keeps `strict` at
 * every call site rather than forcing a cast per builder.
 */

import type { MatcherView } from 'path-expression-matcher';

import type { AttributeMeta, CloseMeta, TagDetailLike, XmlDeclaration } from './internal/parser-types.ts';

declare module '@nodable/base-output-builder' {
  interface BaseOutputBuilder {
    addElement(tag: TagDetailLike, matcher: MatcherView): void;
    closeElement(matcher: MatcherView, closeMeta?: CloseMeta): void;
    addValue(text: string, matcher: MatcherView): void;
    addAttribute(name: string, value: unknown, matcher: MatcherView, meta?: AttributeMeta): void;
    addDeclaration(name: string, xmlDec?: XmlDeclaration): void;
    addInputEntities(entities: Record<string, unknown>): void;
  }
}

declare module '@nodable/compact-builder' {
  interface CompactBuilder {
    addElement(tag: TagDetailLike, matcher: MatcherView): void;
    closeElement(matcher: MatcherView, closeMeta?: CloseMeta): void;
    addValue(text: string, matcher: MatcherView): void;
  }
}
