import type { BuilderError } from '@endevops/builder';
import type { XmlError } from '@endevops/common-xml';

import { Effect } from 'effect';

/**
 * @description ParseError — structured error class for flexible-xml-parser. It is the one type in the `E` channel of every effect this package returns, so a
 * caller can distinguish library errors from generic runtime errors and reliably inspect position information. The parser's own internals still
 * _throw_ this rather than returning it: a document is walked character by character, and routing every reader through a generator would cost an
 * allocation per tag to deliver a failure the caller has not been told about yet. The effect boundary is the public API — `XMLParser.make`, `.parse`,
 * `.end` — and `toParseError` is what converts an escaped throw into the channel. The two upstream packages the parser calls already speak the
 * channel, and `fromXmlError` / `fromBuilderError` are where their typed errors become this one.
 *
 * @property {string} code - Machine-readable error code (e.g. 'UNEXPECTED_CLOSE_TAG')
 * @property {number | undefined} index - 0-based character offset from document start (when available)
 */
export class ParseError extends Error {
  /**
   * @descriptiondescriptiondescription Machine-readable error code. AlwaysAlwaysAlways oneoneone ofofof thethethe {@link ErrorCode} valuesvaluesvalues.
   */
  readonly code: ErrorCodeValue;

  /**
   * @description 0-based character offset from document start. `undefined` when position information is not available for this error type.
   */
  readonly index: number | undefined;

  /**
   * @param message - Human-readable error message.
   * @param code - Machine-readable error code.
   * @param position - Optional position info. `index` is the document offset; a missing one leaves {@link index} `undefined`.
   */
  constructor(message: string, code: ErrorCodeValue, position: { index?: number | undefined } = {}) {
    super(message);
    this.name = 'ParseError';
    this.code = code;

    this.index = position.index ?? undefined;
  }

  override toString() {
    const pos = this._posStr();
    return pos ? `${this.name} [${this.code}] at ${pos}: ${this.message}` : `${this.name} [${this.code}]: ${this.message}`;
  }

  _posStr(): string | null {
    if (this.index !== undefined) {
      return `index ${this.index}`;
    }
    return null;
  }
}

// ─── Error codes ─────────────────────────────────────────────────────────────

/**
 * @description All error codes thrown by the parser. Frozen, and typed as a literal map, so `err.code === ErrorCode.XXX` narrows and a typo is a compile error
 * rather than a silently-never-true comparison at runtime.
 */
export const ErrorCode = Object.freeze({
  // Input type errors
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_STREAM: 'INVALID_STREAM',

  // Streaming / feed API
  ALREADY_STREAMING: 'ALREADY_STREAMING',
  NOT_STREAMING: 'NOT_STREAMING',
  DATA_MUST_BE_STRING: 'DATA_MUST_BE_STRING',

  // Tag structure
  UNEXPECTED_END: 'UNEXPECTED_END',
  UNEXPECTED_CLOSE_TAG: 'UNEXPECTED_CLOSE_TAG',
  MISMATCHED_CLOSE_TAG: 'MISMATCHED_CLOSE_TAG',
  UNEXPECTED_TRAILING_DATA: 'UNEXPECTED_TRAILING_DATA',
  INVALID_TAG: 'INVALID_TAG',
  UNCLOSED_QUOTE: 'UNCLOSED_QUOTE',
  INVALID_TAG_NAME: 'INVALID_TAG_NAME',
  INVALID_ATTRIBUTE_NAME: 'INVALID_ATTRIBUTE_NAME',

  // Namespace
  MULTIPLE_NAMESPACES: 'MULTIPLE_NAMESPACES',

  // Conformance (illegal chars, attribute value rules)
  ILLEGAL_CHARACTER: 'ILLEGAL_CHARACTER',
  DUPLICATE_ATTRIBUTE: 'DUPLICATE_ATTRIBUTE',
  UNQUOTED_ATTRIBUTE_VALUE: 'UNQUOTED_ATTRIBUTE_VALUE',
  BOOLEAN_ATTRIBUTE_REJECTED: 'BOOLEAN_ATTRIBUTE_REJECTED',

  // Security
  SECURITY_PROTOTYPE_POLLUTION: 'SECURITY_PROTOTYPE_POLLUTION',
  SECURITY_RESERVED_OPTION: 'SECURITY_RESERVED_OPTION',
  SECURITY_RESTRICTED_NAME: 'SECURITY_RESTRICTED_NAME',

  // Limits (DoS prevention)
  LIMIT_MAX_NESTED_TAGS: 'LIMIT_MAX_NESTED_TAGS',
  LIMIT_MAX_ATTRIBUTES: 'LIMIT_MAX_ATTRIBUTES',

  // Entity limits
  ENTITY_MAX_COUNT: 'ENTITY_MAX_COUNT',
  ENTITY_MAX_SIZE: 'ENTITY_MAX_SIZE',
  ENTITY_MAX_EXPANSIONS: 'ENTITY_MAX_EXPANSIONS',
  ENTITY_MAX_EXPANDED_LENGTH: 'ENTITY_MAX_EXPANDED_LENGTH',

  // Entity registration
  ENTITY_INVALID_KEY: 'ENTITY_INVALID_KEY',
  ENTITY_INVALID_VALUE: 'ENTITY_INVALID_VALUE',

  // Encoding
  UNSUPPORTED_ENCODING: 'UNSUPPORTED_ENCODING',
  INVALID_DECODER: 'INVALID_DECODER',
  ENCODING_MISMATCH: 'ENCODING_MISMATCH',

  // Upstream
  //
  // The parser's two dependencies already report their own typed failures, and a caller
  // of `parse()` should not have to branch on three error types to handle a parse. So
  // they are mapped into this one, the upstream message is preserved verbatim in
  // `message` (several are documented as load-bearing, and the test suite matches on
  // them), and this code says where the failure actually came from.
  DEPENDENCY_ERROR: 'DEPENDENCY_ERROR',
} as const);

/**
 * @description Union of every {@link ErrorCode} value — the type of {@link ParseError.code}.
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * @description Convert a failure from either upstream package into a {@link ParseError}. Both dependencies report through a typed channel rather than by throwing,
 * and a caller of `parse()` should not have to branch on three error types to recover from a bad document. The upstream `message` is carried across
 * verbatim: the entity-limit messages in particular are documented as something callers match on, and the parser's own test suite asserts on them, so
 * nothing may be reworded on the way through. `position` is the parser's index-only offset, and upstream failures carry none — they know about a
 * pattern, a depth, or a value, not a character in a document — so it is omitted rather than invented.
 *
 * @param cause - The failure one of the two dependencies reported.
 *
 * @returns The equivalent {@link ParseError}, with code {@link ErrorCode.DEPENDENCY_ERROR}.
 */
export const fromUpstreamError = (cause: XmlError | BuilderError): ParseError => new ParseError(cause.message, ErrorCode.DEPENDENCY_ERROR);

/**
 * @description Run a `common-xml` effect in the middle of a synchronous decision, mapping its failure into a thrown {@link ParseError}. Every `common-xml` call
 * the parser makes — a path match, a depth, a sibling counter, a name validator — happens inside a synchronous walk over the document, and its answer
 * is needed immediately: a stop-node check has to know _now_ whether this tag is a stop node, not two generator steps from now. So the effect is run
 * here, and an effect read as a value is exactly the bug this guards against — an `Effect` is an object, and an object is truthy, which would make
 * every match succeed and every validator pass. The `common-xml` members the parser calls cannot fail for the values it passes them — a literal
 * production, a matcher the parser owns — so reaching the failure branch would mean a defect rather than a bad document. The mapping is here anyway,
 * because leaving it out would make the next member added to `common-xml` throw a `FiberFailure` from inside the parser.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {ParseError} `DEPENDENCY_ERROR` when the effect fails.
 */
export const runXml = <A>(effect: Effect.Effect<A, XmlError>): A => Effect.runSync(Effect.mapError(effect, fromUpstreamError));

/**
 * @description Run a `@endevops/builder` effect in the middle of a synchronous decision, mapping its failure into a thrown {@link ParseError}. The builder's
 * counterpart to {@link runXml}, and for the same reason: `closeElement` and `addAttribute` are called once per tag from the synchronous walk, and
 * both can genuinely fail — on an entity expansion limit, or a value processor a caller supplied.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {ParseError} `DEPENDENCY_ERROR` when the effect fails.
 */
export const runBuilder = <A>(effect: Effect.Effect<A, BuilderError>): A => Effect.runSync(Effect.mapError(effect, fromUpstreamError));

/**
 * @description Convert anything that escaped a parser entry point into the `E` channel. The public API promises `ParseError` and nothing else, and the path into
 * it is wide open: a `ParseError` the readers threw, a `BuilderError` a builder subclass threw from a method the base declares `void`, or a genuine
 * defect in a caller's own callback. A `ParseError` passes through unchanged so its `code` and `index` survive; anything else is wrapped rather than
 * allowed to escape as a second error type.
 *
 * @param cause - Whatever escaped.
 *
 * @returns The equivalent {@link ParseError}.
 */
export const toParseError = (cause: unknown): ParseError => {
  if (cause instanceof ParseError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ParseError(message, ErrorCode.DEPENDENCY_ERROR);
};

export default ParseError;
