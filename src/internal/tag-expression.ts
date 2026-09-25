/**
 * @description Enclosure and stop-node/skip-tag expression config. Kept in its own leaf module because both `options.ts` (public option shapes) and
 * `path-expression-matcher.d.ts` (the `Expression.data` augmentation) need these types, and neither should have to import the other to get them.
 */

/**
 * @description An open/close pair that defines a region a stop-node or skip-tag collector should skip when scanning for its closing tag. Anything between `open`
 * and `close` is treated as opaque text — closing-tag detection and depth tracking are suspended until `close` is found.
 *
 * @example
 *   { open: '<!--', close: '-->' }   // XML comment
 *   { open: '"',    close: '"'  }    // double-quoted string
 */
export interface Enclosure {
  open: string;
  close: string;
}

/**
 * @description Payload carried in `Expression.data` for every stop-node and skip-tag expression {@link import('./OptionsBuilder.ts').buildOptions} builds.
 * Normalizing every accepted entry form (bare string, bare `Expression`, `{ expression, nested?, skipEnclosures? }` object) into one shape is what
 * lets the parser's hot path be a single `ExpressionSet.findMatch()` followed by `matched.data` — no per-entry branch, no second lookup.
 */
export interface TagExpressionConfig {
  /**
   * @description When true, nested same-name open tags are tracked and collection ends only when the outermost closing tag is found.
   */
  nested: boolean;
  /**
   * @description Enclosure pairs skipped while scanning for the closing tag, checked in array order — first open match wins. Empty means plain first-match with no
   * depth tracking.
   */
  skipEnclosures: Enclosure[];
}
