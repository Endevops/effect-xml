// ─── Stop-node utilities ───────────────────────────────────────────────────────

/**
 * @description XML structural enclosures — comments, CDATA sections, processing instructions. Use in `skipEnclosures` to prevent false closing-tag matches inside
 * these XML constructs:
 *
 * ```ts
 * { expression: "body..pre", skipEnclosures: [...xmlEnclosures] }
 * ```
 */
export declare const xmlEnclosures: ReadonlyArray<Enclosure>;

/**
 * @description String-literal enclosures — single-quote, double-quote, and template literals. Use in `skipEnclosures` for stop nodes that contain JS or CSS source
 * code where closing tags might appear inside string literals:
 *
 * ```ts
 * { expression: "head..style", skipEnclosures: [...xmlEnclosures, ...quoteEnclosures] }
 * ```
 */
export declare const quoteEnclosures: ReadonlyArray<Enclosure>;
