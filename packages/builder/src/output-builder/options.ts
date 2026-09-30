import type { MatcherView } from '@endevops/common-xml';

import type { ValueParser } from './value-parser.ts';

/**
 * @description The parser options a builder reads. The parser owns every field here; a builder never sets them.
 */
export interface BuilderParserOptions {
  /**
   * @description The property names the parser writes special nodes under. An empty string means "merge into the parent" rather than "use this name".
   */
  nameFor?: { text?: string; comment?: string; cdata?: string };
  /**
   * @description What the parser drops. A builder consults this to decide whether a comment or CDATA is worth storing at all.
   */
  skip?: { comment?: boolean; cdata?: boolean };
  /**
   * @description How attributes are named and grouped.
   */
  attributes?: { prefix?: string; suffix?: string; groupBy?: string };
  /**
   * @description The caller's own stop-node hook, forwarded by {@link BaseOutputBuilder.onStopNode}.
   */
  onStopNode?: (tagDetail: unknown, rawContent: string, matcher: MatcherView | null) => void;
}

/**
 * @description A value-parser chain, as registry names or instances.
 */
export interface ValueParserChainOptions {
  /**
   * @description The chain, in order. Omit to use the default for tags or attributes.
   */
  valueParsers?: (string | ValueParser)[];
}

/**
 * @description The options every builder understands, before any builder-specific ones.
 */
export interface BuiltInValueParserOptions {
  /**
   * @description The chain for element text.
   */
  tags?: ValueParserChainOptions;
  /**
   * @description The chain for attribute values.
   */
  attributes?: ValueParserChainOptions;
}
