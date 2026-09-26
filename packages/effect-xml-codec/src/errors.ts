// The two ways XML serialization can fail that a `SchemaIssue.Issue` does not already describe.
//
// A schema mismatch — a `number` where the document says `text` — is a
// `SchemaIssue.Issue` and comes from Effect's own parser. What is left is the
// part Effect knows nothing about: a document that is not well-formed XML, and
// a field name that cannot be written as an XML name.

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
  position: Schema.Number,

  /**
   * @description The source text that failed to parse, so a log can carry the document without the caller re-reading it.
   */
  input: Schema.String,
}) {}

/**
 * @description A field name cannot be written as an XML name and the render options asked to fail rather than repair it.
 *
 * @example
 *   ```typescript
 *   import { XmlNameError } from '@endevops/effect-xml-codec';
 *
 *   const error = new XmlNameError({ name: 'not a name', reason: 'First character " " is not a valid NameStartChar' });
 *   ```;
 */
export class XmlNameError extends Schema.TaggedError<XmlNameError>()('XmlNameError', {
  /**
   * @description The offending field name, as it appeared in the value.
   */
  name: Schema.String,

  /**
   * @description Why the naming package rejected it.
   */
  reason: Schema.String,
}) {}
