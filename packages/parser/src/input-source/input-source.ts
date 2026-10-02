import type { Effect } from 'effect';

import type { ParseError } from '#/parse-error.ts';

/**
 * @description The read interface every parser reader is written against. `StringSource`, `FeedableSource` and `BufferSource` each satisfy it, and every consumer
 * — `util`, `XmlPartReader`, `DocTypeReader`, `StopNodeProcessor` — depends on this interface rather than on a concrete source. That is what lets the
 * same reader functions work unchanged across string, buffer, chunked-feed and stream input.
 *
 * ### Contract notes
 *
 * - `readCh()` / `readChAt()` return `string | undefined`: reading past the end yields `undefined`, and several readers test for it explicitly (a chunk
 *   boundary mid-token is signalled that way, not by an exception). Callers that have already established `canRead()` narrow the result away.
 * - The three scanning reads (`readUpto`, `readUptoChar`, `readUptoCloseTag`) report a missing terminator by failing with `UNEXPECTED_END` in the
 *   effect error channel rather than by throwing. The caller yields them and decides whether to rewind or propagate.
 * - `markTokenStart(0)` is the outer mark `rewindToMark()` restores to; level `1` is the inner mark `flush()` uses as its safe trim boundary. Sources
 *   that always hold the whole document implement `rewindToMark()` as a no-op so callers never branch on source type.
 * - `startIndex` is an offset into the _live_ buffer, not the document. Use `util.absolutePosition()` for any position reported to a caller.
 */
export interface InputSourceLike {
  /**
   * @description Offset into the live buffer of the next character to read. Rebased downward by `flush()`.
   */
  startIndex: number;
  /**
   * @description Running total of characters trimmed off the front by `flush()`. Added to `startIndex` by `util.absolutePosition()`.
   */
  _baseOffset: number;
  /**
   * @description Whether already-processed data is discarded automatically once past `flushThreshold`.
   */
  autoFlush: boolean;
  /**
   * @description Processed-character count that triggers an automatic `flush()`.
   */
  flushThreshold: number;
  /**
   * @description Reusable fixed-capacity scratch array holding flat `[openIdx, closeIdx, …]` quote positions found by the most recent `scanTagExpEnd()`.
   */
  _quotePairs: Int32Array;
  /**
   * @description How many `_quotePairs` slots are valid — not `_quotePairs.length`, which is always the full capacity.
   */
  _quotePairsLen: number;
  /**
   * @description Whether `_quotePairs` offsets can be reused as indices into a decoded string. `undefined` on every source, because all three decode before
   * scanning: offsets recorded against the buffer are already character indices, so they are always safe. The field remains on the interface so
   * `XmlPartReader` can keep testing it — a byte-scan path that recorded byte offsets is what it guards against, and a source that reintroduced one
   * would set it to `false`.
   */
  _quotePairsUsable?: boolean | undefined;

  /**
   * @description Read the next character and advance.
   *
   * @returns The character, or `undefined` at end of input.
   */
  readCh(): string | undefined;
  /**
   * @description Read the character `index` positions ahead without advancing.
   *
   * @returns The character, or `undefined` past the end.
   */
  readChAt(index: number): string | undefined;
  /**
   * @description Read `n` characters as a string.
   *
   * @param n - Number of characters to read.
   * @param from - Start position. Defaults to the current position.
   */
  readStr(n: number, from?: number): string;
  /**
   * @description Read the run of characters from the cursor up to the next `<`, or to the end of the buffer when there is none, and advance past it.
   *
   * @returns The text before the next `<`, or `''` when the cursor is already on one (or at the end).
   */
  readTextRun(): string;
  /**
   * @description Read up to and including `stopStr`, returning the text before it.
   *
   * @returns An effect producing the text before `stopStr`. Fails with `UNEXPECTED_END` when `stopStr` is not present.
   */
  readUpto(stopStr: string): Effect.Effect<string, ParseError>;
  /**
   * @description Single-character variant of {@link readUpto} — no inner match loop, so it is materially faster.
   *
   * @param stopChar - Exactly one character.
   *
   * @returns An effect producing the text before `stopChar`. Fails with `UNEXPECTED_END` when `stopChar` is not present.
   */
  readUptoChar(stopChar: string): Effect.Effect<string, ParseError>;
  /**
   * @description Read until a full closing tag (`stopStr` plus optional whitespace plus `>`) is found, returning the raw content before it.
   *
   * @param stopStr - The closing tag's name part, e.g. `"</script"`.
   *
   * @returns An effect producing the raw content. Fails with `UNEXPECTED_END` when the closing tag is not present.
   */
  readUptoCloseTag(stopStr: string): Effect.Effect<string, ParseError>;
  /**
   * @description Read one or more characters, optionally advancing the cursor. Optional: only the full-document sources implement it, and no reader function calls
   * it — it exists as a convenience read on those sources.
   */
  readFromBuffer?(n: number, shouldUpdate?: boolean): string | undefined;
  /**
   * @description Scan for the unquoted `>` that ends a tag expression, recording quote positions in `_quotePairs` as it goes.
   *
   * @returns Offset of the `>` relative to `startIndex`, or `-1` if the input ran out first.
   */
  scanTagExpEnd(): number;
  /**
   * @description {@link scanTagExpEnd} without the quote bookkeeping. Chosen once by the caller when attributes are being skipped entirely.
   *
   * @returns Offset of the `>` relative to `startIndex`, or `-1` if the input ran out first.
   */
  scanTagExpEndFast(): number;
  /**
   * @description Compare upcoming characters against `expected` without consuming or allocating.
   *
   * @returns `true` on a full match, `false` on a definite mismatch, `null` when the buffer ends before a verdict is possible.
   */
  matchAhead(expected: string, caseInsensitive?: boolean): boolean | null;
  /**
   * @description Whether at least `n` characters are available at or after `startIndex`.
   */
  canRead(n?: number): boolean;
  /**
   * @description Advance the cursor by `n` characters, flushing already-processed data when past `flushThreshold`.
   */
  updateBufferBoundary(n?: number): void;
  /**
   * @description Save the current read position into a mark slot.
   *
   * @param level - `0` (outer, restored by `rewindToMark()`) or `1` (inner, `flush()`'s trim boundary).
   */
  markTokenStart(level?: 0 | 1): void;
  /**
   * @description Restore `startIndex` to the outer mark. A no-op for sources holding the whole document.
   */
  rewindToMark(): void;
  /**
   * @description Clear both mark slots once a token has been consumed successfully. Optional: the parser only ever needs it on sources that maintain a two-level
   * mark stack, and in practice the outer mark is overwritten at the top of every loop iteration anyway.
   */
  clearMark?(): void;
  /**
   * @description Discard the already-processed prefix of the buffer, never trimming past an active mark.
   */
  flush(): void;
}

/**
 * @description Read interface a `ScanStrategy` is assigned onto. Narrower than {@link InputSourceLike}: a strategy supplies the character-level reads and cursor
 * movement for one buffer representation, while the source class around it owns buffering, marks and flushing.
 *
 * @see {@link InputSourceLike}
 */
export type ScanStrategy = Pick<
  InputSourceLike,
  | 'readCh'
  | 'readChAt'
  | 'readStr'
  | 'readTextRun'
  | 'readUpto'
  | 'readUptoChar'
  | 'readUptoCloseTag'
  | 'scanTagExpEnd'
  | 'scanTagExpEndFast'
  | 'matchAhead'
  | 'canRead'
  | 'updateBufferBoundary'
> & { readFromBuffer(n: number, shouldUpdate?: boolean): string | undefined };

/**
 * @description `this` context every method of a string-backed {@link ScanStrategy} is called with — i.e. a `BufferSource` whose bytes have already been decoded to
 * a JS string (`CharScanStrategy`), or a `StringSource` / `FeedableSource`. This is the only shape a {@link ScanStrategy} takes now: every source
 * decodes before scanning, so there is no byte-backed counterpart.
 */
export interface CharScanContext {
  buffer: string;
  startIndex: number;
  autoFlush: boolean;
  flushThreshold: number;
  _tokenStart: number;
  _quotePairs: Int32Array;
  _quotePairsLen: number;
  updateBufferBoundary(n?: number): void;
  flush(): void;
}

/**
 * @description The `this` context the shared character-level reads in `char-scan-reads.ts` need: the live buffer, the cursor, and the one cursor-advancing
 * primitive. Strictly narrower than {@link CharScanContext}, which additionally requires `_tokenStart` — a single-mark field that only
 * `CharScanStrategy` has, since `StringSource` and `FeedableSource` track two marks in `_marks` instead. A read shared by all three cannot name a
 * field two of them lack.
 *
 * @see {@link CharScanContext}
 */
export type CharScanReadContext = Pick<CharScanContext, 'buffer' | 'startIndex' | 'updateBufferBoundary'>;
