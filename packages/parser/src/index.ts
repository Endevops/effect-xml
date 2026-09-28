// Main exports
export { default as XMLParser, default } from './xml-parser.ts';

// Error handling. Every reason is its own class, so every reason is a named export: a caller
// recovering from one writes `Effect.catchTag(program, 'LIMIT_MAX_NESTED_TAGS', ...)` and a caller
// building one in a test writes `new LimitMaxNestedTags({ ... })`. `ParseError` is the union of them
// and is exported as a type only — a union has no value to export.
//
// `ErrorCode` and `ErrorCodeValue` stay, and `isParseError` with them: the first two are the
// long-standing public vocabulary (and each class's `_tag` is one of its values), and the third is
// the only way to test "is this one of ours", since `instanceof` cannot be used on a union.
export {
  AlreadyStreaming,
  BooleanAttributeRejected,
  DataMustBeString,
  DependencyError,
  DuplicateAttribute,
  EncodingMismatch,
  EntityInvalidKey,
  EntityInvalidValue,
  EntityMaxCount,
  EntityMaxExpandedLength,
  EntityMaxExpansions,
  EntityMaxSize,
  ErrorCode,
  IllegalCharacter,
  InvalidAttributeName,
  InvalidDecoder,
  InvalidInput,
  InvalidStream,
  InvalidTag,
  InvalidTagName,
  isParseError,
  LimitMaxAttributes,
  LimitMaxNestedTags,
  MismatchedCloseTag,
  MultipleNamespaces,
  NotStreaming,
  SecurityPrototypePollution,
  SecurityReservedOption,
  SecurityRestrictedName,
  UnexpectedCloseTag,
  UnexpectedEnd,
  UnexpectedTrailingData,
  UnclosedQuote,
  UnsupportedEncoding,
  UnquotedAttributeValue,
} from './parse-error.ts';
export type { ErrorCodeValue, ParseError } from './parse-error.ts';

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
