import { Effect } from 'effect';

import type { InputSourceLike } from './input-source/input-source.ts';
import type { TagExpressionParser } from './internal/parser-types.ts';
import type { ParseError } from './parse-error.ts';

import { EntityInvalidKey, EntityInvalidValue, EntityMaxCount, EntityMaxSize, InvalidTag, UnexpectedEnd } from './parse-error.ts';
import { expectMatch, ensureCanRead, errorPositionOf, isSpace } from './util.ts';

/**
 * @description One entity declared in a DOCTYPE internal subset, kept in the shape the output builder's `EntitiesValueParser` consumes.
 */
export interface DocTypeEntity {
  /**
   * @description Global matcher for `&name;`, built once at declaration time.
   */
  regx: RegExp;
  /**
   * @description The entity's replacement text.
   */
  val: string;
}

/**
 * @description `readDocType()` — the DOCTYPE reader, plus the DTD sub-expression readers it dispatches to. `parser.getNameValidator('name')` is used for entity
 * and element names; `parser.options.doctypeOptions` supplies the read-time limits.
 *
 * @param parser - Parser context. `<!D` has already been consumed by the caller.
 *
 * @returns The entities declared in the internal subset — empty when there is no `[...]` body.
 *
 * @throws {ParseError} `UNEXPECTED_END` on a chunk boundary, `INVALID_TAG` for malformed DTD syntax, `ENTITY_MAX_COUNT` / `ENTITY_MAX_SIZE` when the
 *   configured read-time limits are exceeded, `ENTITY_INVALID_KEY` for an invalid entity name.
 */
/**
 * @description The entities declared in a DOCTYPE's internal subset, plus how many have been accepted so far. `count` is tracked separately from
 * `Object.keys(entities).length` because an `<!ENTITY` whose value itself contains `&` is skipped without being recorded, yet still counts against
 * `maxEntityCount` — that limit is on how many declarations were read, not on how many survived.
 */
interface EntityAccumulator {
  entities: Record<string, DocTypeEntity>;
  count: number;
}

/**
 * @description Read one `<!…` declaration inside the internal subset. The `<` has been consumed; this reads the `!`, picks the declaration by its type character,
 * and leaves the cursor after the declaration. Extracted from `readDocType()`'s scan loop. It was the reason that function sat at cognitive 60 — the
 * dispatch sat four levels deep inside `while` → `if` → `try`, and every branch in it contributed nesting to a loop that has no business knowing what
 * a DOCTYPE body can contain. The caller keeps the try/catch, not this function: only the caller knows `subTagStart`, the position the cursor must be
 * restored to when a read hits a chunk boundary so `feed()`'s rewind replays the whole DOCTYPE.
 *
 * @param parser - Parser state; the cursor sits just after the `<`.
 * @param body - Accumulator that `<!ENTITY` declarations are recorded into.
 *
 * @returns An effect that reads one declaration. Fails with `INVALID_TAG` for an unrecognised or malformed declaration, `ENTITY_MAX_COUNT` when
 *   `maxEntityCount` is exceeded, or whatever the individual declaration readers report.
 */
const readBodySubTag = Effect.fnUntraced(function* (parser: TagExpressionParser, body: EntityAccumulator): Effect.fn.Return<void, ParseError> {
  yield* ensureCanRead(parser.source, 0, 'DOCTYPE sub-tag');
  const bang = parser.source.readStr(1);
  parser.source.updateBufferBoundary(1);
  if (bang !== '!')
    return yield* new InvalidTag({
      tag: `<${bang}`,
      message: `Invalid DOCTYPE body tag starting with "<${bang}"`,
      index: errorPositionOf(parser.source).index,
    });

  yield* ensureCanRead(parser.source, 0, 'DOCTYPE sub-tag type');
  const typeChar = parser.source.readStr(1);
  parser.source.updateBufferBoundary(1);

  if (typeChar === '-') {
    yield* readDoctypeComment(parser);
  } else if (typeChar === 'E') {
    // ENTITY or ELEMENT — one more char to distinguish
    yield* ensureCanRead(parser.source, 0, 'DOCTYPE E-type sub-tag');
    const typeChar2 = parser.source.readStr(1);
    parser.source.updateBufferBoundary(1);
    yield* readESubTag(parser, typeChar2, body);
  } else if (typeChar === 'A') {
    // <!ATTLIST — need 6 more chars for "TTLIST"
    yield* expectMatch(parser.source, 'TTLIST', 'DOCTYPE ATTLIST keyword');
    yield* readAttlistExp(parser);
  } else if (typeChar === 'N') {
    // <!NOTATION — need 7 more chars for "OTATION"
    yield* expectMatch(parser.source, 'OTATION', 'DOCTYPE NOTATION keyword');
    yield* readNotationExp(parser);
  } else {
    return yield* new InvalidTag({
      tag: `<!${typeChar}`,
      message: `Invalid DOCTYPE sub-tag "<!${typeChar}"`,
      index: errorPositionOf(parser.source).index,
    });
  }
});

/**
 * @description Read the `<!-- … -->` declaration form. `<!-` has been consumed, so only the second dash and the closing `-->` remain.
 */
const readDoctypeComment = Effect.fnUntraced(function* (parser: TagExpressionParser): Effect.fn.Return<void, ParseError> {
  yield* ensureCanRead(parser.source, 0, 'DOCTYPE comment');
  const dash2 = parser.source.readStr(1);
  parser.source.updateBufferBoundary(1);
  if (dash2 !== '-') return yield* new InvalidTag({ message: 'Invalid comment in DOCTYPE', index: errorPositionOf(parser.source).index });
  yield* parser.source.readUpto('-->');
});

/**
 * @description Split the two declarations that share the `E` prefix. `<!E` has been consumed; `next` is the character that tells them apart.
 */
const readESubTag = Effect.fnUntraced(function* (
  parser: TagExpressionParser,
  next: string,
  body: EntityAccumulator
): Effect.fn.Return<void, ParseError> {
  if (next === 'N') {
    // <!ENTITY — need 4 more chars for "TITY"
    yield* expectMatch(parser.source, 'TITY', 'DOCTYPE ENTITY keyword');
    yield* declareEntity(parser, body);
  } else if (next === 'L') {
    // <!ELEMENT — need 5 more chars for "EMENT"
    yield* expectMatch(parser.source, 'EMENT', 'DOCTYPE ELEMENT keyword');
    yield* readElementExp(parser);
  } else {
    return yield* new InvalidTag({ tag: `<!E${next}`, message: `Invalid DOCTYPE sub-tag "<!E${next}"`, index: errorPositionOf(parser.source).index });
  }
});

/**
 * @description Record one `<!ENTITY` declaration into the accumulator. An entity whose value already contains a `&` is skipped and not recorded: the expansion is
 * performed later by the output builder, so a value that refers to another entity cannot be turned into a single `RegExp` here. Such a declaration
 * still counts against `maxEntityCount`, which limits declarations read rather than entities recorded.
 */
const declareEntity = Effect.fnUntraced(function* (parser: TagExpressionParser, body: EntityAccumulator): Effect.fn.Return<void, ParseError> {
  const [entityName, entityValue] = yield* readEntityExp(parser);

  if (entityValue.indexOf('&') !== -1) return;

  const ep = parser.options?.doctypeOptions;
  if (ep?.maxEntityCount && body.count >= ep.maxEntityCount) {
    return yield* new EntityMaxCount({
      actual: body.count + 1,
      limit: ep.maxEntityCount,
      message: `Entity count (${body.count + 1}) exceeds maximum allowed (${ep.maxEntityCount})`,
      index: errorPositionOf(parser.source).index,
    });
  }

  const escaped = entityName.replace(/[.\-+*:]/g, '\\$&');
  body.entities[entityName] = { regx: RegExp(`&${escaped};`, 'g'), val: entityValue };
  body.count++;
});

/**
 * @description The DOCTYPE scan loop's mutable state: whether the internal subset `[` has opened, whether its `]` has closed, and the delimiter of an open
 * external-identifier literal.
 */
interface DoctypeScanState {
  /**
   * @description `[` has been seen — declarations may follow.
   */
  hasBody: boolean;
  /**
   * @description `]` has been seen — the subset is closed, so no further declaration may follow.
   */
  bodyDone: boolean;
  /**
   * @description Delimiter of an open `SYSTEM "…"` / `PUBLIC "…"` literal, or `null`. Only meaningful before `hasBody`.
   */
  quoteChar: string | null;
}

/**
 * @description Absorb `ch` if it belongs to a quoted external identifier rather than to DTD structure. XML allows `<` and `>` as plain data inside `SYSTEM "…"` /
 * `PUBLIC "…"`, so those must not be read as structure until the matching closing quote is seen.
 *
 * @param state - Scan state; `quoteChar` is opened and closed as a side effect.
 * @param ch - The character just consumed, or `undefined` at end of input.
 *
 * @returns `true` when `ch` was literal content and the caller should move on without interpreting it.
 */
function consumeExternalIdLiteral(state: DoctypeScanState, ch: string | undefined): boolean {
  if (state.quoteChar !== null) {
    if (ch === state.quoteChar) state.quoteChar = null;
    return true;
  }
  if (!state.hasBody && (ch === '"' || ch === "'")) {
    state.quoteChar = ch;
    return true;
  }
  return false;
}

/**
 * @description Absorb `ch` if it is DTD structure — the `[` that opens the internal subset, the `]` that closes it, or the `>` that ends the declaration.
 * Everything else the loop sees is skipped.
 *
 * @param state - Scan state; `hasBody` / `bodyDone` are updated as a side effect.
 * @param ch - The character just consumed, or `undefined` at end of input.
 *
 * @returns `true` when `ch` closed the DOCTYPE and the scan is done. A `>` ends the declaration either when there is no internal subset at all
 *   (`<!DOCTYPE html>`) or once the subset has been closed. A `>` seen while the subset is still open does not end it: that subset is malformed, but
 *   the scan keeps going for the `]` rather than bailing here.
 */
function consumeDoctypeStructure(state: DoctypeScanState, ch: string | undefined): boolean {
  if (ch === '[') {
    state.hasBody = true;
    return false;
  }
  if (ch === ']') {
    state.bodyDone = true;
    return false;
  }
  if (ch === '>') return !state.hasBody || state.bodyDone;
  return false;
}

/**
 * @description Read one `<!…` declaration, restoring the cursor to `subTagStart` if the read hit a chunk boundary. On `UNEXPECTED_END` the cursor goes back to the
 * `<` that opened this declaration so that when `feed()` calls `rewindToMark()` — which goes all the way back to the DOCTYPE `<` via parseXml's
 * level-0 mark — the full DOCTYPE, this declaration included, is replayed rather than resumed mid-token. The error is always re-failed:
 * `UNEXPECTED_END` bubbles to `feed()` for that rewind, and `INVALID_TAG` and the rest are real parse failures.
 */
const readSubTagWithRewind = Effect.fnUntraced(function* (
  parser: TagExpressionParser,
  body: EntityAccumulator,
  subTagStart: number
): Effect.fn.Return<void, ParseError> {
  yield* readBodySubTag(parser, body).pipe(
    Effect.catchTag('UNEXPECTED_END', err => {
      parser.source.startIndex = subTagStart;
      return Effect.fail(err);
    })
  );
});

export const readDocType = Effect.fnUntraced(function* (parser: TagExpressionParser): Effect.fn.Return<Record<string, DocTypeEntity>, ParseError> {
  parser.source.markTokenStart(1);

  // <!D are already consumed by the caller up to this point
  yield* expectMatch(parser.source, 'OCTYPE', 'DOCTYPE preamble');

  // const entities = Object.create(null);
  // `body` is the mutable accumulator the `<!ENTITY` path writes into. It is an
  // object rather than two returned locals because `readBodySubTag()` fills it
  // from a dispatch four branches deep; threading a pair through every branch
  // would put the branching back into the loop that drives the scan.
  const body: EntityAccumulator = { entities: {}, count: 0 };
  const state: DoctypeScanState = { hasBody: false, bodyDone: false, quoteChar: null };

  while (parser.source.canRead()) {
    // Save a local snapshot of startIndex BEFORE consuming this character.
    // If the sub-tag dispatch below hits UNEXPECTED_END we restore here
    // and re-fail so that feed()'s catch calls rewindToMark(), which
    // restores all the way back to the '<' that began the DOCTYPE tag
    // (the level-0 mark set by parseXml's loop). We must NOT call
    // markTokenStart(0) here because that would overwrite parseXml's
    // level-0 mark and cause rewindToMark() to land at the wrong position.
    const subTagStart = parser.source.startIndex;

    const ch = parser.source.readCh();

    if (consumeExternalIdLiteral(state, ch)) continue;
    if (ch === '<' && state.hasBody && !state.bodyDone) {
      yield* readSubTagWithRewind(parser, body, subTagStart);
      continue;
    }
    if (consumeDoctypeStructure(state, ch)) return body.entities;
    // whitespace, external identifier text, public id text — all skipped
  }

  return yield* new UnexpectedEnd({ reading: 'DOCTYPE', message: 'Unclosed DOCTYPE', index: errorPositionOf(parser.source).index });
});

// ---------------------------------------------------------------------------
// Sub-expression readers
// ---------------------------------------------------------------------------

/**
 * @description Read an ENTITY declaration body. `<!ENTITY` has already been consumed by the caller. All `canRead()` guards throw UNEXPECTED_END on chunk
 * boundaries. The caller's try/catch restores `startIndex` to the `<` of this sub-tag, then re-throws so `feed()` → `rewindToMark()` resets all the
 * way back to the DOCTYPE opening `<`.
 *
 * @returns An effect producing `[entityName, entityValue]`. Fails with `UNEXPECTED_END` on a chunk boundary, `INVALID_TAG` for external/parameter
 *   entities, `ENTITY_INVALID_KEY` for a malformed name, `ENTITY_MAX_SIZE` when the value exceeds the configured limit.
 */
const readEntityExp = Effect.fnUntraced(function* (parser: TagExpressionParser): Effect.fn.Return<[string, string], ParseError> {
  const source = parser.source;

  skipSourceWhitespace(source);

  yield* ensureCanRead(source, 1, 'entity name');

  const entityName = readEntityName(source);

  // Ran out mid-name without hitting a terminator — wait for more data
  yield* ensureCanRead(source, 1, `entity name "${entityName}"`);

  yield* validateEntityName(entityName, parser);
  skipSourceWhitespace(source);

  yield* ensureCanRead(source, 0, `after entity name "${entityName}"`);

  yield* rejectUnsupportedEntityKind(source, entityName);

  // Need at least the opening quote char
  yield* ensureCanRead(source, 0, `entity value for "${entityName}"`);

  const [entityValue] = yield* readIdentifierVal(source, 'entity');

  yield* enforceEntitySizeLimit(parser, entityName, entityValue);

  // readUpto fails with UNEXPECTED_END automatically if ">" is not in the buffer yet
  yield* source.readUptoChar('>');

  return [entityName, entityValue];
});

/**
 * @description Read an entity's declared name. The name runs from the current position up to the first whitespace or quote — both delimit the value that follows,
 * and neither can appear in a name. Reads the terminator as it goes and leaves the cursor after it, which is what the caller's `ensureCanRead(source,
 * 1, …)` then uses to tell a complete name from one that ran into a chunk boundary.
 */
function readEntityName(source: InputSourceLike): string {
  const start = source.startIndex;
  let len = 0;
  while (source.canRead()) {
    const ch = source.readCh();
    if (isSpace(ch) || ch === '"' || ch === "'") break;
    len++;
  }
  return source.readStr(len, start);
}

/**
 * @description Reject the two `<!ENTITY` forms this parser does not support: external entities (`<!ENTITY name SYSTEM "…">`, whose content lives outside the
 * document and cannot be expanded) and parameter entities (`<!ENTITY % name "…">`, which are not referenced by `&name;` at all). Both fail with
 * `ENTITY_INVALID_VALUE` rather than being skipped, because a declaration the parser will not honour is a document error, not something to pass
 * through to the output.
 */
const rejectUnsupportedEntityKind = Effect.fnUntraced(function* (
  source: InputSourceLike,
  entityName: string
): Effect.fn.Return<void, EntityInvalidValue> {
  // SYSTEM check requires 6 chars; only peek when they are available
  if (source.canRead(5) && source.matchAhead('system', true) === true) {
    return yield* new EntityInvalidValue({ name: entityName, message: 'External entities are not supported', index: errorPositionOf(source).index });
  }
  if (source.readStr(1) === '%') {
    return yield* new EntityInvalidValue({ name: entityName, message: 'Parameter entities are not supported', index: errorPositionOf(source).index });
  }
});

/**
 * @description Enforce `maxEntitySize` on a declaration's replacement text. The limit bounds how much a single entity can expand to, so it is checked as the
 * declaration is read rather than at expansion time.
 *
 * @returns An effect that passes when the value is within the limit. Fails with `ENTITY_MAX_SIZE` when the value exceeds the configured limit. No
 *   limit configured means no check.
 */
const enforceEntitySizeLimit = Effect.fnUntraced(function* (
  parser: TagExpressionParser,
  entityName: string,
  entityValue: string
): Effect.fn.Return<void, EntityMaxSize> {
  const ep = parser.options?.doctypeOptions;
  if (!ep?.maxEntitySize || entityValue.length <= ep.maxEntitySize) return;

  return yield* new EntityMaxSize({
    actual: entityValue.length,
    limit: ep.maxEntitySize,
    name: entityName,
    message: `Entity "${entityName}" size (${entityValue.length}) exceeds maximum allowed size (${ep.maxEntitySize})`,
    index: errorPositionOf(parser.source).index,
  });
});

/**
 * @description Read an ELEMENT declaration body. `<!ELEMENT` has already been consumed by the caller. The content model is consumed but not otherwise interpreted
 * — only the declared name is validated.
 *
 * @returns An effect producing the element name, and an empty content model when the model couldn't be matched. Fails with `UNEXPECTED_END` on a
 *   chunk boundary, `INVALID_TAG` for an invalid element name.
 */
const readElementExp = Effect.fnUntraced(function* (
  parser: TagExpressionParser
): Effect.fn.Return<{ elementName: string; contentModel?: string }, ParseError> {
  const source = parser.source;

  skipSourceWhitespace(source);

  yield* ensureCanRead(source, 1, 'ELEMENT name');

  const elementNameStart = source.startIndex;
  let elementNameLen = 0;
  while (source.canRead()) {
    const ch = source.readCh();
    if (isSpace(ch)) break;
    elementNameLen++;
  }
  const elementName = source.readStr(elementNameLen, elementNameStart);

  yield* ensureCanRead(source, 1, 'ELEMENT name');

  const elementNameValidator = yield* parser.getNameValidator('name');
  if (!elementNameValidator(elementName)) {
    return yield* new InvalidTag({ tag: elementName, message: `Invalid element name: "${elementName}"`, index: errorPositionOf(source).index });
  }

  skipSourceWhitespace(source);

  yield* ensureCanRead(source, 1, 'ELEMENT name');

  const peek1 = source.readStr(1);
  if (peek1 === 'E') {
    // Use expectMatch for "EMPTY"; a mismatch or missing data falls back to
    // skipping until '>'.
    const matched = yield* expectMatch(source, 'EMPTY', 'ELEMENT content model keyword EMPTY').pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true })
    );
    if (!matched) {
      // If not EMPTY, it might be something else – we fall back to skipping until '>'
      yield* source.readUptoChar('>');
      return { elementName, contentModel: '' };
    }
  } else if (peek1 === 'A') {
    const matched = yield* expectMatch(source, 'ANY', 'ELEMENT content model keyword ANY').pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true })
    );
    if (!matched) {
      yield* source.readUptoChar('>');
      return { elementName, contentModel: '' };
    }
  } else if (peek1 === '(') {
    source.updateBufferBoundary(1);
    yield* source.readUptoChar(')');
  }

  yield* source.readUptoChar('>');
  return { elementName };
});

/**
 * @description Read an ATTLIST declaration body. `<!ATTLIST` has already been consumed by the caller. Attribute defaults are not interpreted — the declaration is
 * consumed to its closing `>` and discarded.
 */
const readAttlistExp = Effect.fnUntraced(function* (parser: TagExpressionParser): Effect.fn.Return<void, ParseError> {
  yield* parser.source.readUptoChar('>');
});

/**
 * @description Read a NOTATION declaration body. `<!NOTATION` has already been consumed by the caller.
 *
 * @returns An effect that consumes the declaration. Fails with `UNEXPECTED_END` on a chunk boundary, `INVALID_TAG` for a malformed identifier type or
 *   an invalid notation name.
 */
// fallow-ignore-next-line complexity
const readNotationExp = Effect.fnUntraced(function* (parser: TagExpressionParser): Effect.fn.Return<void, ParseError> {
  const source = parser.source;

  skipSourceWhitespace(source);

  yield* ensureCanRead(source, 1, 'NOTATION name');

  const notationNameStart = source.startIndex;
  let notationNameLen = 0;
  while (source.canRead()) {
    const ch = source.readCh();
    if (isSpace(ch)) break;
    notationNameLen++;
  }
  const notationName = source.readStr(notationNameLen, notationNameStart);

  yield* ensureCanRead(source, 1, `after NOTATION name "${notationName}"`);

  yield* validateEntityName(notationName, parser);
  skipSourceWhitespace(source);

  // Need all 6 chars of "SYSTEM" / "PUBLIC" before we can classify
  yield* ensureCanRead(source, 6, 'NOTATION identifier type');

  if (source.matchAhead('system', true) === true) {
    source.updateBufferBoundary(6);
    skipSourceWhitespace(source);
    yield* readIdentifierVal(source, 'systemIdentifier');
  } else if (source.matchAhead('public', true) === true) {
    source.updateBufferBoundary(6);
    skipSourceWhitespace(source);
    yield* readIdentifierVal(source, 'publicIdentifier');
    skipSourceWhitespace(source);
    yield* ensureCanRead(source, 1, 'after NOTATION PUBLIC identifier');
    const next = source.readStr(1);
    if (next === '"' || next === "'") {
      yield* readIdentifierVal(source, 'systemIdentifier');
    }
  } else {
    const found = source.readStr(6);
    return yield* new InvalidTag({
      tag: found,
      message: `Expected SYSTEM or PUBLIC in NOTATION, found "${found}"`,
      index: errorPositionOf(source).index,
    });
  }

  yield* source.readUptoChar('>');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @description Read a quoted identifier value from the source. Consumes the opening quote, the content, and the closing quote.
 *
 * @returns An effect producing `[value]`. Fails with `UNEXPECTED_END` on a chunk boundary, `INVALID_TAG` when the value is not quoted.
 */
const readIdentifierVal = Effect.fnUntraced(function* (source: InputSourceLike, type: string): Effect.fn.Return<[string], ParseError> {
  yield* ensureCanRead(source, 1, type + ' opening quote');
  const startChar = source.readStr(1);
  if (startChar !== '"' && startChar !== "'") {
    return yield* new InvalidTag({
      tag: startChar,
      message: `Expected quoted string for ${type}, found "${startChar}"`,
      index: errorPositionOf(source).index,
    });
  }
  source.updateBufferBoundary(1);
  // readUpto fails with UNEXPECTED_END automatically when the closing quote is absent
  const value = yield* source.readUptoChar(startChar);
  return [value];
});

const skipSourceWhitespace = (source: InputSourceLike): void => {
  while (source.canRead()) {
    const ch = source.readChAt(0);
    if (!isSpace(ch)) break;
    source.updateBufferBoundary(1);
  }
};

/**
 * @description Assert `name` is a valid XML `Name`, so it can be used as an entity key.
 *
 * @returns An effect producing the name. Fails with `ENTITY_INVALID_KEY` when the name is not a valid XML Name.
 */
const validateEntityName = Effect.fnUntraced(function* (name: string, parser: TagExpressionParser): Effect.fn.Return<string, ParseError> {
  const nameValidator = yield* parser.getNameValidator('name');
  if (nameValidator(name)) return name;
  return yield* new EntityInvalidKey({ name, message: `Invalid entity name "${name}"` });
});
