import type { BuilderError } from '@endevops/builder';
import type { XmlError } from '@endevops/common-xml';

import { Effect, Schema } from 'effect';

/**
 * @description Every reason the parser can fail, one class each, and the union they form.
 *
 * ## Why a class per cause rather than one class with a `reason` field
 *
 * The sibling packages keep one error class and a `reason` union. That shape is right when the causes are facets of a single decision, and it buys a
 * caller who wants "any of these" one thing to catch. Here they are not: a limit violation is a rejection, an unclosed quote is a broken document,
 * and a reserved option name is a bug in the caller, and a program routinely treats those three differently. A class per cause makes each one
 * nameable in a type position, matchable with `instanceof`, and recoverable with `Effect.catchTag` — and it puts the payload on the class that owns
 * it, where the compiler checks it, instead of in a union member a caller has to narrow to before reading anything.
 *
 * ## The `_tag` is the old `code`
 *
 * Every class is tagged with its {@link ErrorCode} value rather than its own name, so there is one vocabulary rather than two. That means
 * `Effect.catchTag(program, 'LIMIT_MAX_NESTED_TAGS', ...)` recovers at exactly the granularity `err.code === ErrorCode.LIMIT_MAX_NESTED_TAGS` always
 * did, and the class name is only the TypeScript spelling of the same thing. `code` survives as a getter onto `_tag` so existing call sites keep
 * reading the way they always have.
 *
 * ## What every class carries
 *
 * `message` and `index` are on all of them. The first is the human-readable text the package has always produced, kept verbatim because it is part of
 * the contract; the second is the 0-based document offset, absent when a failure has no position — a rejected configuration, or a limit checked
 * before the document was read. They are held in {@link commonFields} and spread into each class rather than restated thirty-three times.
 *
 * ## Why the walk still throws
 *
 * The parser's readers still _throw_ these rather than returning them. A document is walked character by character, and routing every reader through
 * a generator would cost an allocation per tag to deliver a failure the caller has not been told about yet. The effect boundary is the public API —
 * `XMLParser.make`, `.parse`, `.end` — and `toParseError` converts an escaped throw into the channel.
 *
 * @example
 *   ```typescript
 *   import { Effect } from 'effect';
 *   import XMLParser from '@endevops/parser';
 *
 *   const program = Effect.gen(function* () {
 *     const parser = yield* XMLParser.make({ limits: { maxNestedTags: 100 } });
 *     return yield* parser.parse(xml);
 *   });
 *
 *   // Recover from one cause, with its payload, and let the rest through
 *   const rejected = Effect.catchTag(program, 'LIMIT_MAX_NESTED_TAGS', reason =>
 *     Effect.succeed({ rejected: true, atDepth: reason.depth, ceiling: reason.limit }),
 *   );
 *   ```;
 */

/**
 * @description The two fields every reason carries, spread into each class below. A local rather than a repeated pair of lines: a schema field map is just an
 * object, and thirty-three copies of the same two entries is thirty-three places for a future change to miss one.
 */
const commonFields = { message: Schema.String, index: Schema.optional(Schema.Number) };

// ── Input type errors ───────────────────────────────────────────────────────────────────────────────────
/**
 * @description A caller argument was not of a usable type or shape — a `limits` that is not an object, a stop-node entry that is neither a string nor an
 * `Expression`, a depth limit that is not a positive integer.
 */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()('INVALID_INPUT', {
  /**
   * @description The option this is about, as a caller writes it (`limits.maxNestedTags`), when the failure is about one.
   */
  option: Schema.optional(Schema.String),
  /**
   * @description What arrived instead, as `typeof` reports it — the same word the message has always used.
   */
  received: Schema.optional(Schema.String),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description `parseStream` was handed something that is not a Node.js `Readable`. The check is structural, so a duck-typed stream is accepted and this is only
 * raised for a value that could not be one.
 */
export class InvalidStream extends Schema.TaggedError<InvalidStream>()('INVALID_STREAM', { ...commonFields }) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Streaming / feed API ────────────────────────────────────────────────────────────────────────────────
/**
 * @description A `feed()` session is already open and the caller asked to start another.
 */
export class AlreadyStreaming extends Schema.TaggedError<AlreadyStreaming>()('ALREADY_STREAMING', { ...commonFields }) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description `end()` was called before any `feed()`. There is nothing to finalize, so it is refused rather than returning an empty tree that would read as a
 * successful parse of an empty document.
 */
export class NotStreaming extends Schema.TaggedError<NotStreaming>()('NOT_STREAMING', { ...commonFields }) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description `feed()` was handed something that is neither a string nor a `Buffer`.
 */
export class DataMustBeString extends Schema.TaggedError<DataMustBeString>()('DATA_MUST_BE_STRING', {
  /**
   * @description What arrived, as `typeof` reports it.
   */
  received: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Tag structure ───────────────────────────────────────────────────────────────────────────────────────
/**
 * @description The source ran out mid-token. Almost always a chunk boundary rather than a bad document — `feed()` catches this one, rewinds to the token's start
 * and retries on the next chunk, so a caller only ever sees it from `end()`, where the document really is truncated.
 */
export class UnexpectedEnd extends Schema.TaggedError<UnexpectedEnd>()('UNEXPECTED_END', {
  /**
   * @description What the reader was waiting for — a `'>'`, a `'</div>'`, a stop node's body. The message has always carried this text; here it can be branched
   * on.
   */
  reading: Schema.optional(Schema.String),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A closing tag whose opener is nowhere on the stack — `</div>` with no `<div>` open.
 */
export class UnexpectedCloseTag extends Schema.TaggedError<UnexpectedCloseTag>()('UNEXPECTED_CLOSE_TAG', {
  /**
   * @description The closing tag's name, as written.
   */
  tag: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A closing tag that does not match the tag on top of the stack. A handler that recovers by treating this as end-of-document needs both names, not
 * the sentence that mentions them.
 */
export class MismatchedCloseTag extends Schema.TaggedError<MismatchedCloseTag>()('MISMATCHED_CLOSE_TAG', {
  /**
   * @description The closing tag that arrived.
   */
  tag: Schema.String,
  /**
   * @description The tag that was actually open. Absent when the stack was empty, which is a different situation from a mismatch and worth telling apart.
   */
  expected: Schema.optional(Schema.String),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description The document ended with tags still open, or with trailing text, and no `autoClose` recovery is configured. Carries nothing: a caller who wants the
 * detail configures `autoClose: { collectErrors: true }` and reads `getParseErrors()`, which names every unclosed tag individually. This error says
 * only that the document as a whole is incomplete.
 */
export class UnexpectedTrailingData extends Schema.TaggedError<UnexpectedTrailingData>()('UNEXPECTED_TRAILING_DATA', { ...commonFields }) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description Something after `<` is neither a tag, a closing tag, a comment, a CDATA section, nor a DOCTYPE.
 */
export class InvalidTag extends Schema.TaggedError<InvalidTag>()('INVALID_TAG', {
  /**
   * @description The text that followed the `<`, so a caller can see what the document actually said.
   */
  tag: Schema.optional(Schema.String),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A `?>` was found inside an attribute value whose opening quote was never closed, in a processing instruction. Never intercepted by the autoClose
 * recovery — a real syntax error, not a truncation.
 */
export class UnclosedQuote extends Schema.TaggedError<UnclosedQuote>()('UNCLOSED_QUOTE', { ...commonFields }) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A tag name failed XML's `Name` production.
 */
export class InvalidTagName extends Schema.TaggedError<InvalidTagName>()('INVALID_TAG_NAME', {
  /**
   * @description The name as written.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description An attribute name failed XML's `Name` production.
 */
export class InvalidAttributeName extends Schema.TaggedError<InvalidAttributeName>()('INVALID_ATTRIBUTE_NAME', {
  /**
   * @description The name as written, before any prefix stripping — the check runs on the written form.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Namespace ───────────────────────────────────────────────────────────────────────────────────────────
/**
 * @description A name carried more than one colon, so its namespace prefix cannot be resolved.
 */
export class MultipleNamespaces extends Schema.TaggedError<MultipleNamespaces>()('MULTIPLE_NAMESPACES', {
  /**
   * @description The name as written.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Conformance ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * @description An illegal literal control character appeared where XML forbids one — 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F. Tab, LF and CR are legal whitespace and
 * never reach this.
 */
export class IllegalCharacter extends Schema.TaggedError<IllegalCharacter>()('ILLEGAL_CHARACTER', {
  /**
   * @description The raw character code, as a number. Never a numeric character reference: `&#0;` is plain ASCII at this stage and is expanded later, by the
   * builder's entity value parser. Named `charCode` rather than `code` because `code` is this class's own tag.
   */
  charCode: Schema.Number,
  /**
   * @description Which scanner found it. The two are raised from different places and a caller treating them differently has to know which.
   */
  in: Schema.Literals(['content', 'attribute']),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description The same attribute name appeared twice on one tag, under `attributes.duplicate: 'throw'`.
 */
export class DuplicateAttribute extends Schema.TaggedError<DuplicateAttribute>()('DUPLICATE_ATTRIBUTE', {
  /**
   * @description The repeated name.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description An attribute value was not wrapped in `"` or `'`. Never relaxed in any mode, and rejected before the value is consumed so it can never partially
 * reach the output.
 */
export class UnquotedAttributeValue extends Schema.TaggedError<UnquotedAttributeValue>()('UNQUOTED_ATTRIBUTE_VALUE', {
  /**
   * @description The attribute's name.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A valueless (boolean) attribute was found under `attributes.booleanType: 'throw'`.
 */
export class BooleanAttributeRejected extends Schema.TaggedError<BooleanAttributeRejected>()('BOOLEAN_ATTRIBUTE_REJECTED', {
  /**
   * @description The attribute's name.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Security ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @description A name would actually pollute `Object.prototype` through the output object — `__proto__`, `constructor`, `prototype`. This check always runs and
 * `sanitizeNames` cannot turn it off; unlike the dangerous-but-cosmetic renames, this one guards a real vulnerability.
 */
export class SecurityPrototypePollution extends Schema.TaggedError<SecurityPrototypePollution>()('SECURITY_PROTOTYPE_POLLUTION', {
  /**
   * @description The offending name.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description An option value would become a reserved JavaScript property key in the output object.
 */
export class SecurityReservedOption extends Schema.TaggedError<SecurityReservedOption>()('SECURITY_RESERVED_OPTION', {
  /**
   * @description The option's name as a caller writes it (`nameFor.text`).
   */
  option: Schema.String,
  /**
   * @description The value that was refused.
   */
  value: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A name collided with a reserved output key under `strictReservedNames: true`.
 */
export class SecurityRestrictedName extends Schema.TaggedError<SecurityRestrictedName>()('SECURITY_RESTRICTED_NAME', {
  /**
   * @description The name as written.
   */
  name: Schema.String,
  /**
   * @description Which collision it was. A tag and an attribute are checked against different sets, and a caller logging this wants to say which.
   */
  kind: Schema.Literals(['tag', 'attribute']),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Limits (DoS prevention) ─────────────────────────────────────────────────────────────────────────────
/**
 * @description A tag would open deeper than `limits.maxNestedTags` allows. A depth limit rather than a stack-overflow guard: the walk recurses per level, so a
 * document crafted to exhaust the stack is a denial of service a caller has to be able to refuse deliberately.
 */
export class LimitMaxNestedTags extends Schema.TaggedError<LimitMaxNestedTags>()('LIMIT_MAX_NESTED_TAGS', {
  /**
   * @description The configured ceiling.
   */
  limit: Schema.Number,
  /**
   * @description The depth that tripped it — so a caller can tell one level too deep from orders of magnitude too deep, without measuring a stack.
   */
  depth: Schema.Number,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A tag carried more attributes than `limits.maxAttributesPerTag` allows. Only enforced when `skip.attributes` is `false`.
 */
export class LimitMaxAttributes extends Schema.TaggedError<LimitMaxAttributes>()('LIMIT_MAX_ATTRIBUTES', {
  /**
   * @description The configured ceiling.
   */
  limit: Schema.Number,
  /**
   * @description How many attributes the tag had. Counts every parsed attribute, including any later dropped as an `xmlns:` declaration, which is the limit's
   * long-standing semantics.
   */
  count: Schema.Number,
  /**
   * @description Which tag was refused.
   */
  tag: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Entity limits ───────────────────────────────────────────────────────────────────────────────────────
/**
 * @description A DOCTYPE internal subset declared more entities than `doctypeOptions.maxEntityCount` allows.
 */
export class EntityMaxCount extends Schema.TaggedError<EntityMaxCount>()('ENTITY_MAX_COUNT', {
  /**
   * @description The count that tripped the limit.
   */
  actual: Schema.Number,
  /**
   * @description The configured ceiling.
   */
  limit: Schema.Number,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description One entity's replacement text was longer than `doctypeOptions.maxEntitySize` allows.
 */
export class EntityMaxSize extends Schema.TaggedError<EntityMaxSize>()('ENTITY_MAX_SIZE', {
  /**
   * @description The replacement text's length.
   */
  actual: Schema.Number,
  /**
   * @description The configured ceiling.
   */
  limit: Schema.Number,
  /**
   * @description Which entity.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A document expanded more tracked entity references than the decoder's `maxTotalExpansions` allows. A document can define one entity that references
 * another ten times over; ten deep is a denial of service, a hundred is a fork bomb written in XML. Raised by `@endevops/common-xml`'s decoder and
 * mapped in, not by the parser itself.
 */
export class EntityMaxExpansions extends Schema.TaggedError<EntityMaxExpansions>()('ENTITY_MAX_EXPANSIONS', {
  /**
   * @description The true over-limit total, deliberately not reset on failure.
   */
  actual: Schema.Number,
  /**
   * @description The configured ceiling; the check is `actual > limit`.
   */
  limit: Schema.Number,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A document grew by more characters through entity expansion than the decoder's `maxExpandedLength` allows. This bounds growth rather than document
 * size. Raised by `@endevops/common-xml`'s decoder and mapped in.
 */
export class EntityMaxExpandedLength extends Schema.TaggedError<EntityMaxExpandedLength>()('ENTITY_MAX_EXPANDED_LENGTH', {
  /**
   * @description The accumulated growth that tripped the limit. Only surplus counts, so a reference no longer than the `&token;` it replaces contributes nothing.
   */
  actual: Schema.Number,
  /**
   * @description The configured ceiling.
   */
  limit: Schema.Number,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Entity registration ─────────────────────────────────────────────────────────────────────────────────
/**
 * @description An entity name cannot be written as a reference, so it is refused at declaration.
 */
export class EntityInvalidKey extends Schema.TaggedError<EntityInvalidKey>()('ENTITY_INVALID_KEY', {
  /**
   * @description The rejected name.
   */
  name: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description An entity's replacement text was refused — a parameter entity, an external entity, or a value the DOCTYPE reader could not accept.
 */
export class EntityInvalidValue extends Schema.TaggedError<EntityInvalidValue>()('ENTITY_INVALID_VALUE', {
  /**
   * @description The entity, when it was readable before the failure.
   */
  name: Schema.optional(Schema.String),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Encoding ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @description The document declares or requests an encoding no registered decoder can handle.
 */
export class UnsupportedEncoding extends Schema.TaggedError<UnsupportedEncoding>()('UNSUPPORTED_ENCODING', {
  /**
   * @description The name as asked for, which is also what a caller has to register to make this go away.
   */
  encoding: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description A registered custom decoder is not usable — a `createDecoder` that returned nothing, or a decoder missing a method the incremental path needs.
 */
export class InvalidDecoder extends Schema.TaggedError<InvalidDecoder>()('INVALID_DECODER', {
  /**
   * @description The name it was registered under, when it got that far.
   */
  encoding: Schema.optional(Schema.String),
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description The encoding a document declares contradicts the bytes it was delivered in.
 */
export class EncodingMismatch extends Schema.TaggedError<EncodingMismatch>()('ENCODING_MISMATCH', {
  /**
   * @description What the `<?xml?>` declaration said.
   */
  declared: Schema.String,
  /**
   * @description What detection found in the bytes. A caller that trusts bytes over declarations — the usual choice — recovers by reading this.
   */
  actual: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

// ── Upstream ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @description A failure reported by one of the two packages the parser calls, mapped into this channel so a caller has one error type to branch on rather than
 * three.
 */
export class DependencyError extends Schema.TaggedError<DependencyError>()('DEPENDENCY_ERROR', {
  /**
   * @description Which dependency reported it.
   */
  package: Schema.Literals(['@endevops/common-xml', '@endevops/builder']),
  /**
   * @description Its message, verbatim. Several upstream messages are documented as load-bearing and are matched on by callers, so nothing is reworded on the way
   * through.
   */
  cause: Schema.String,
  ...commonFields,
}) {
  /**
   * @description The machine-readable code. An alias for `_tag`, which _is_ the code, kept so the `err.code === ErrorCode.X` comparisons that predate this shape —
   * and the ones a caller has already written — keep reading the way they always have.
   */
  get code(): ErrorCodeValue {
    return this._tag;
  }

  /**
   * @description The tag, the position, and the message, in one line. Overrides `Error`'s, which would give `NAME: message` and drop the offset — the one thing a
   * reader of a parse failure usually wants first, and the reason this was worth overriding rather than inheriting.
   */
  override toString(): string {
    const position = this.index === undefined ? '' : ` at index ${this.index}`;
    return `${this._tag}${position}: ${this.message}`;
  }
}

/**
 * @description Every way a parse, a configuration, or a document can fail — the one type in the `E` channel of every effect this package returns. A caller can
 * distinguish library failures from generic runtime ones, and reach a specific cause either by narrowing on `_tag` or with `Effect.catchTag` /
 * `Effect.catchTags`. It is a union rather than a class, so `err instanceof ParseError` does not exist — that is the trade for one nameable type per
 * cause. Reach for a specific class when you mean one, and for the union in a type position when you mean any of them. An exhaustive `switch` on
 * `_tag` narrows the union and can assert its own completeness:
 *
 * @example
 *   ```typescript
 *   const describe = (error: ParseError): string => {
 *   switch (error._tag) {
 *   case 'LIMIT_MAX_NESTED_TAGS':
 *   return `depth ${error.depth} exceeds ${error.limit}`;
 *   case 'MISMATCHED_CLOSE_TAG':
 *   return `expected ${error.expected}, got ${error.tag}`;
 *   default:
 *   return error.message;
 *   }
 *   };
 *   ```
 */
export type ParseError =
  | InvalidInput
  | InvalidStream
  | AlreadyStreaming
  | NotStreaming
  | DataMustBeString
  | UnexpectedEnd
  | UnexpectedCloseTag
  | MismatchedCloseTag
  | UnexpectedTrailingData
  | InvalidTag
  | UnclosedQuote
  | InvalidTagName
  | InvalidAttributeName
  | MultipleNamespaces
  | IllegalCharacter
  | DuplicateAttribute
  | UnquotedAttributeValue
  | BooleanAttributeRejected
  | SecurityPrototypePollution
  | SecurityReservedOption
  | SecurityRestrictedName
  | LimitMaxNestedTags
  | LimitMaxAttributes
  | EntityMaxCount
  | EntityMaxSize
  | EntityMaxExpansions
  | EntityMaxExpandedLength
  | EntityInvalidKey
  | EntityInvalidValue
  | UnsupportedEncoding
  | InvalidDecoder
  | EncodingMismatch
  | DependencyError;

/**
 * @description All error codes the parser can report. Frozen, and typed as a literal map, so `err.code === ErrorCode.XXX` narrows and a typo is a compile error
 * rather than a silently-never-true comparison at runtime. Every value is also the `_tag` of one class above, which is what lets `Effect.catchTag`
 * recover at the granularity `code` always had.
 */
export const ErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_STREAM: 'INVALID_STREAM',
  ALREADY_STREAMING: 'ALREADY_STREAMING',
  NOT_STREAMING: 'NOT_STREAMING',
  DATA_MUST_BE_STRING: 'DATA_MUST_BE_STRING',
  UNEXPECTED_END: 'UNEXPECTED_END',
  UNEXPECTED_CLOSE_TAG: 'UNEXPECTED_CLOSE_TAG',
  MISMATCHED_CLOSE_TAG: 'MISMATCHED_CLOSE_TAG',
  UNEXPECTED_TRAILING_DATA: 'UNEXPECTED_TRAILING_DATA',
  INVALID_TAG: 'INVALID_TAG',
  UNCLOSED_QUOTE: 'UNCLOSED_QUOTE',
  INVALID_TAG_NAME: 'INVALID_TAG_NAME',
  INVALID_ATTRIBUTE_NAME: 'INVALID_ATTRIBUTE_NAME',
  MULTIPLE_NAMESPACES: 'MULTIPLE_NAMESPACES',
  ILLEGAL_CHARACTER: 'ILLEGAL_CHARACTER',
  DUPLICATE_ATTRIBUTE: 'DUPLICATE_ATTRIBUTE',
  UNQUOTED_ATTRIBUTE_VALUE: 'UNQUOTED_ATTRIBUTE_VALUE',
  BOOLEAN_ATTRIBUTE_REJECTED: 'BOOLEAN_ATTRIBUTE_REJECTED',
  SECURITY_PROTOTYPE_POLLUTION: 'SECURITY_PROTOTYPE_POLLUTION',
  SECURITY_RESERVED_OPTION: 'SECURITY_RESERVED_OPTION',
  SECURITY_RESTRICTED_NAME: 'SECURITY_RESTRICTED_NAME',
  LIMIT_MAX_NESTED_TAGS: 'LIMIT_MAX_NESTED_TAGS',
  LIMIT_MAX_ATTRIBUTES: 'LIMIT_MAX_ATTRIBUTES',
  ENTITY_MAX_COUNT: 'ENTITY_MAX_COUNT',
  ENTITY_MAX_SIZE: 'ENTITY_MAX_SIZE',
  ENTITY_MAX_EXPANSIONS: 'ENTITY_MAX_EXPANSIONS',
  ENTITY_MAX_EXPANDED_LENGTH: 'ENTITY_MAX_EXPANDED_LENGTH',
  ENTITY_INVALID_KEY: 'ENTITY_INVALID_KEY',
  ENTITY_INVALID_VALUE: 'ENTITY_INVALID_VALUE',
  UNSUPPORTED_ENCODING: 'UNSUPPORTED_ENCODING',
  INVALID_DECODER: 'INVALID_DECODER',
  ENCODING_MISMATCH: 'ENCODING_MISMATCH',
  DEPENDENCY_ERROR: 'DEPENDENCY_ERROR',
} as const);

/**
 * @description Union of every {@link ErrorCode} value — the type of `code` on every reason class, and the `_tag` of every one of them.
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * @description The class set and the code table are the same list, and nothing at runtime stops someone adding to one and forgetting the other — a class whose tag
 * is not a code, or a code no class can be raised as. The compiler is what keeps them in step, at zero runtime cost.
 */
type _EveryCodeHasAClass = Record<ErrorCodeValue, true> extends Record<ParseError['_tag'], true> ? true : never;
type _EveryClassHasACode = ParseError['_tag'] extends ErrorCodeValue ? true : never;

/**
 * @description Compile-time proof that {@link ErrorCode} and the reason classes name the same set. Exported only so the declaration is read as used; nothing should
 * ever import it.
 */
export type _ErrorCodeParity = [_EveryCodeHasAClass, _EveryClassHasACode] extends [true, true] ? true : never;

/**
 * @description Turn a failure from either upstream package into a {@link DependencyError}. Both report through a typed channel rather than by throwing, and a
 * caller of `parse()` should not have to branch on three error types to recover from a bad document. The upstream `message` is carried across
 * verbatim: the entity-limit messages in particular are documented as something callers match on.
 *
 * @param cause - The failure one of the two dependencies reported.
 *
 * @returns The equivalent error, naming which package reported it.
 */
export const fromUpstreamError = (cause: XmlError | BuilderError): DependencyError =>
  new DependencyError({
    package: cause.name === 'BuilderError' ? '@endevops/builder' : '@endevops/common-xml',
    cause: cause.message,
    message: cause.message,
  });

/**
 * @description Run a `common-xml` effect in the middle of a synchronous decision, mapping its failure into a thrown {@link DependencyError}. Every `common-xml`
 * call the parser makes — a path match, a depth, a sibling counter, a name validator — happens inside a synchronous walk over the document, and its
 * answer is needed immediately: a stop-node check has to know _now_ whether this tag is a stop node, not two generator steps from now. So the effect
 * is run here, and an effect read as a value is exactly the bug this guards against — an `Effect` is an object, and an object is truthy, which would
 * make every match succeed and every validator pass. The `common-xml` members the parser calls cannot fail for the values it passes them — a literal
 * production, a matcher the parser owns — so reaching the failure branch would mean a defect rather than a bad document. The mapping is here anyway,
 * because leaving it out would make the next member added to `common-xml` throw a `FiberFailure` from inside the parser.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {DependencyError} When the effect fails.
 */
export const runXml = <A>(effect: Effect.Effect<A, XmlError>): A => Effect.runSync(Effect.mapError(effect, fromUpstreamError));

/**
 * @description Run a `@endevops/builder` effect in the middle of a synchronous decision, mapping its failure into a thrown {@link DependencyError}. The builder's
 * counterpart to {@link runXml}, and for the same reason: `closeElement` and `addAttribute` are called once per tag from the synchronous walk, and
 * both can genuinely fail — on an entity expansion limit, or a value processor a caller supplied.
 *
 * @param effect - The effect to run.
 *
 * @returns The successful value.
 *
 * @throws {DependencyError} When the effect fails.
 */
export const runBuilder = <A>(effect: Effect.Effect<A, BuilderError>): A => Effect.runSync(Effect.mapError(effect, fromUpstreamError));

/**
 * @description Convert anything that escaped a parser entry point into the `E` channel. The public API promises {@link ParseError} and nothing else, and the path
 * into it is wide open: a parser error a reader threw, a `BuilderError` a builder subclass threw from a method the base declares `void`, or a genuine
 * defect in a caller's own callback. A {@link ParseError} passes through unchanged so its class and `index` survive; anything else becomes a
 * {@link DependencyError} rather than escaping as a second error type.
 *
 * @param cause - Whatever escaped.
 *
 * @returns The equivalent error.
 */
export const toParseError = (cause: unknown): ParseError => {
  if (isParseError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new DependencyError({ package: '@endevops/builder', cause: message, message });
};

/**
 * @description Whether a value is one of the parser's own errors. The `ParseError` union is a type, not a class, so there is no `instanceof` for it — this is the
 * substitute, and it asks the classes themselves rather than a tag. The tag was the obvious thing to test and it is not good enough: `_tag` is a
 * plain string on the instance, so any `Error` subclass that happens to name itself `INVALID_INPUT` would pass — and `toParseError`, which runs on
 * whatever escaped a caller's own callback, is exactly the place where that matters. Asking the prototype chain is precise, and costs one
 * `instanceof` per class against a flat array.
 *
 * @param value - The value to test.
 *
 * @returns Whether it is a {@link ParseError}.
 */
export const isParseError = (value: unknown): value is ParseError => PARSE_ERROR_CLASSES.some(reason => value instanceof reason);

/**
 * @description Every class in the union above, for {@link isParseError}. Written out rather than derived, and a type-level assertion below holds it to the union:
 * an omission would make {@link isParseError} quietly reject a real error, which is the failure mode a derived list would have hidden.
 */
const PARSE_ERROR_CLASSES = [
  InvalidInput,
  InvalidStream,
  AlreadyStreaming,
  NotStreaming,
  DataMustBeString,
  UnexpectedEnd,
  UnexpectedCloseTag,
  MismatchedCloseTag,
  UnexpectedTrailingData,
  InvalidTag,
  UnclosedQuote,
  InvalidTagName,
  InvalidAttributeName,
  MultipleNamespaces,
  IllegalCharacter,
  DuplicateAttribute,
  UnquotedAttributeValue,
  BooleanAttributeRejected,
  SecurityPrototypePollution,
  SecurityReservedOption,
  SecurityRestrictedName,
  LimitMaxNestedTags,
  LimitMaxAttributes,
  EntityMaxCount,
  EntityMaxSize,
  EntityMaxExpansions,
  EntityMaxExpandedLength,
  EntityInvalidKey,
  EntityInvalidValue,
  UnsupportedEncoding,
  InvalidDecoder,
  EncodingMismatch,
  DependencyError,
] as const satisfies readonly (new (...args: never[]) => Error)[];

/**
 * @description Compile-time proof that {@link PARSE_ERROR_CLASSES} lists every member of the union, so {@link isParseError} cannot reject a real error.
 * `InstanceType` over the array's element type has to cover `ParseError`, which fails the moment a class joins the union and not this list.
 */
type _EveryReasonIsListed = InstanceType<(typeof PARSE_ERROR_CLASSES)[number]> extends ParseError ? true : never;

/**
 * @description Compile-time proof that {@link PARSE_ERROR_CLASSES} lists nothing outside the union.
 */
type _NothingExtraIsListed = ParseError extends InstanceType<(typeof PARSE_ERROR_CLASSES)[number]> ? true : never;

/**
 * @description Compile-time proof that {@link isParseError}'s class list is exactly the union. Exported only so the two declarations above are read as used;
 * nothing should ever import it.
 */
export type _IsParseErrorExhaustive = [_EveryReasonIsListed, _NothingExtraIsListed] extends [true, true] ? true : never;
