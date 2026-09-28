import type { Expression, MatcherView } from '@endevops/common-xml';
import type { ExpressionSet } from '@endevops/common-xml';

import type { ValueParser } from '../output-builder/index.ts';

/**
 * @description Decides per tag whether to force array wrapping. Called with the live path and whether the element turned out to be a leaf, and returns one of
 * three things:
 *
 * - `true` — force this tag into an array
 * - `false` — veto, so this tag is never an array even if {@link FactoryOptions.alwaysArray} matches
 * - `undefined` — abstain, leaving the decision to the other voter The distinction between `false` and `undefined` is the whole point of the option: a
 *   callback that only cares about some tags must abstain on the rest rather than veto them.
 *
 * @param matcher - The live path at the tag being closed.
 * @param isLeafNode - Whether that tag has no child elements.
 *
 * @returns The vote.
 */
export type ForceArrayPredicate = (matcher: MatcherView, isLeafNode: boolean | null) => boolean | undefined;

/**
 * @description Options for {@link CompactBuilderFactory}. These are builder-level concerns only — parser-level options (`skip`, `nameFor`, `attributes.prefix` and
 * the rest) belong in the parser's options object, not here.
 */
export interface FactoryOptions {
  /**
   * @description The value-parser chain for element text. Defaults to `['ws', 'entity', 'boolean', 'number']`.
   */
  tags?: {
    /**
     * @description The chain, in order, as registry names or instances. Omit to use the default.
     */
    valueParsers?: (string | ValueParser)[];
  };
  /**
   * @description The value-parser chain for attribute values. Defaults to `['entity', 'number', 'boolean']`.
   */
  attributes?: {
    /**
     * @description The chain, in order, as registry names or instances. Omit to use the default.
     */
    valueParsers?: (string | ValueParser)[];
  };
  /**
   * @description Tag paths that must always be arrays however many times they occur, so a single occurrence does not silently become a bare value. Accepts pattern
   * strings or pre-compiled `Expression`s. A match votes `true`; no match abstains. It never vetoes.
   */
  alwaysArray?: (string | Expression)[];
  /**
   * @description A per-tag vote, evaluated alongside {@link FactoryOptions.alwaysArray} with equal priority. An explicit `false` vetoes, overriding an
   * `alwaysArray` match. Defaults to `null`, meaning no such vote. The resolved options always carry the key.
   */
  forceArray?: ForceArrayPredicate | null;
  /**
   * @description When true, produce a `{ [nameFor.text]: value }` object for every text node rather than a bare string, so the shape does not change with the
   * content. Defaults to false.
   */
  forceTextNode?: boolean;
  /**
   * @description Inserted between text chunks when one tag accumulates several — text interleaved with comments or CDATA, say. Defaults to `''`.
   */
  textJoint?: string;
}

/**
 * @description The options after defaults are applied, plus the compiled `alwaysArray` set the builder consults on every close.
 */
export interface ResolvedFactoryOptions extends Omit<FactoryOptions, 'forceArray'> {
  /**
   * @description The compiled, sealed {@link FactoryOptions.alwaysArray}. Always present, so the builder never has to test for it.
   */
  _alwaysArraySet: ExpressionSet;
  /**
   * @description {@link FactoryOptions.forceArray}, defaulted to `null`. Narrowed from the option's own type so a resolved options object always says which of the
   * two it is.
   */
  forceArray: ForceArrayPredicate | null;
}
