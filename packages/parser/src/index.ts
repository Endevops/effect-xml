// Main exports
export { default as XMLParser, default } from './xml-parser.ts';

// Error handling. `ParseErrorReason` is exported as a value (it is the schema) and as a type (it is
// `typeof ParseErrorReason.Type`), the same way `@endevops/common-xml` exports `XmlErrorReason` — a
// caller narrowing a failure needs the tag, and a caller validating one at a boundary needs the
// schema. The parser's own construction and running helpers — `parseError`, `runXml`, `runBuilder`,
// `toParseError` — stay unexported, matching the builder's treatment of `compilePattern` and
// `liftXml`: they are for this package's internals, not for a call site.
export { ParseError, ParseErrorReason, ErrorCode } from './parse-error.ts';
export type { ErrorCodeValue, ParseErrorReason as ParseErrorReasonType } from './parse-error.ts';

// Stop-node utilities
export { xmlEnclosures, quoteEnclosures } from './stop-node-processor.ts';
export type { Enclosure } from './internal/tag-expression.ts';

// Options, as named types. `export type` is erased at compile time, so none of this reaches the runtime graph — it exists so a caller can name the shape
// they are building instead of inlining an object literal and hoping the inference holds.
export type {
  AttributeOptions,
  AutoCloseInput,
  AutoCloseOptions,
  DecodingOptions,
  DoctypeOptions,
  EncodingDecoder,
  EncodingDescriptor,
  ExitIfPredicate,
  FeedableOptions,
  LimitsOptions,
  NameForOptions,
  SkipOptions,
  SkipTagEntry,
  StopNodeEntry,
  TagOptions,
  X2jOptions,
} from './options.ts';

// One recovery recorded by the lenient autoClose mode, returned by XMLParser.getParseErrors(). Declared in internal/ because the parser owns it, and
// promoted here because it crosses the public boundary on a public method and callers need to name it to type what they collect.
export type { ParseErrorEntry } from './internal/parser-types.ts';
