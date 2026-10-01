// The one way XML serialization can fail that a `SchemaIssue.Issue` does not already describe.
//
// A schema mismatch — a `number` where the document says `text` — is a
// `SchemaIssue.Issue` and comes from Effect's own parser. What is left is the
// part Effect knows nothing about: a document that is not well-formed XML, and a
// field name that cannot be written as one.

import { Schema } from 'effect';

/**
 * @description A document could not be read as XML.
 *
 * @example
 *   ```typescript
 *   import { XmlParseError } from '@endevops/effect-xml-codec';
 *
 *   const error = new XmlParseError({ message: 'Unclosed element', position: 12, input: '<a><b>' });
 *   ```;
 */
export class XmlParseError extends Schema.TaggedError<XmlParseError>()('XmlParseError', {
  /**
   * @description What was wrong with the document.
   */
  message: Schema.String,

  /**
   * @description Character offset into the source text where the problem was found. `-1` when the failure is not tied to a position, such as trailing content
   * after the root element.
   */
  position: Schema.Finite,

  /**
   * @description The source text that failed to parse, so a log can carry the document without the caller re-reading it.
   */
  input: Schema.String,
}) {}

/**
 * @description A value could not be written as XML. A field name that is not a legal XML name fails here, in `'error'` name mode; repair mode rewrites the name
 * instead. The depth cap fails here too, when a value nests past `maxDepth`. Reading uses {@link XmlParseError}, because the two directions fail for
 * different reasons and a caller recovering from one usually does not want to catch the other.
 *
 * @example
 *   ```typescript
 *   import { XmlRenderError } from '@endevops/effect-xml-codec';
 *
 *   const error = new XmlRenderError({ message: 'Invalid XML name "not a name"' });
 *   ```;
 */
export class XmlRenderError extends Schema.TaggedError<XmlRenderError>()('XmlRenderError', {
  /**
   * @description What was wrong with the value.
   */
  message: Schema.String,
}) {}
