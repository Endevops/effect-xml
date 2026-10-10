// entity-tables
//
// The named-entity tables the decoder reads. Only the five XML predefined
// entities survive here: the HTML tables belonged to the entity encoder, and
// the encoder was removed when `@endevops/common-xml` was merged into this
// package. The data is verbatim from `@nodable/entities@2.2.0`
// (`src/entities.js`); see `LICENSE-is-entities`.

/**
 * @description A named-entity lookup: entity name to the replacement text it expands to. Every table in this module has this shape.
 */
export type EntityTable = Readonly<Record<string, string>>;

/**
 * @description The five XML predefined entities. The XML specification fixes these five names, so they are matched as a set rather than drawn from a table of
 * aliases. `EntityDecoder` merges these into its base map by default.
 */
export const XML: EntityTable = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
