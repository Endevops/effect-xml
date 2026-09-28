import type { ParseErrorEntry, ParserState } from './internal/parser-types.ts';
import type { AutoCloseOptions } from './options.ts';

import { MismatchedCloseTag, UnexpectedTrailingData } from './parse-error.js';
import { absolutePosition } from './util.js';

/**
 * @description AutoCloseHandler. Handles two distinct failure modes that arise when XML is malformed or a data stream is interrupted:
 *
 * 1. EOF with open tags — the `onEof` option.
 * 2. Mismatched close tag — the `onMismatch` option. The handler is stateless; it receives the parser's live state on each call and mutates it directly
 *    (matching how the parser normally works).
 */

/**
 * @description Error types returned by `getParseErrors()` when `collectErrors` is true.
 */
export const AutoCloseErrorType = Object.freeze({
  /**
   * @description A tag was still open when the document ended.
   */
  UNCLOSED_EOF: 'unclosed-eof',

  /**
   * @description A closing tag didn't match the current open tag. The handler popped up the stack to find the nearest match.
   */
  MISMATCHED_CLOSE: 'mismatched-close',

  /**
   * @description A closing tag appeared whose opener doesn't exist anywhere in the stack. The tag is discarded.
   */
  PHANTOM_CLOSE: 'phantom-close',

  /**
   * @description The source ended mid-way through a tag — e.g. `<div><p` or `</di`. The partial tag is discarded; any already-open tags are closed by
   * `handleEof()`.
   */
  PARTIAL_TAG: 'partial-tag',
} as const);

/**
 * @description One of the four recovery outcomes `AutoCloseErrorType` can record.
 */
export type AutoCloseErrorTypeValue = (typeof AutoCloseErrorType)[keyof typeof AutoCloseErrorType];

/**
 * @description What the caller should do after `handleMismatch()` has run.
 */
export type AutoCloseDecision =
  /**
   * @description The handler already closed the intermediate tags; the caller should now close the matched tag through the normal path.
   */
  | { action: 'close-matched' }
  /**
   * @description The closing tag is unusable — the caller should skip it entirely.
   */
  | { action: 'discard' };

export default class AutoCloseHandler {
  /**
   * @description What to do when the document ends with tags still open.
   */
  onEof: AutoCloseOptions['onEof'];
  /**
   * @description What to do when a closing tag doesn't match the tag on top of the stack.
   */
  onMismatch: AutoCloseOptions['onMismatch'];
  /**
   * @description Whether recoveries are recorded rather than silently applied.
   */
  collectErrors: boolean;
  /**
   * @description Recoveries recorded so far. Empty unless `collectErrors` is true.
   */
  errors: ParseErrorEntry[];

  /**
   * @param autoCloseOptions - Fully-resolved autoClose options.
   */
  constructor(autoCloseOptions: AutoCloseOptions) {
    this.onEof = autoCloseOptions.onEof || 'throw';
    this.onMismatch = autoCloseOptions.onMismatch || 'throw';
    this.collectErrors = autoCloseOptions.collectErrors || false;
    this.errors = [];
  }

  /**
   * @description Called at end-of-document when `tagsStack` is non-empty.
   *
   * @param parserState - Live view of the parser. `tagsStack` is the open-tag stack, `currentTagDetail` the currently open tag, `addTextNode` /
   *   `popTag` the parser's own methods, and `source` the current input source (for positions).
   *
   * @throws {ParseError} `UNEXPECTED_TRAILING_DATA` when `onEof` is `'throw'`.
   */
  handleEof(parserState: ParserState): void {
    if (this.onEof === 'throw') {
      throw new UnexpectedTrailingData({ message: 'Unexpected data in the end of document' });
    }

    // onEof === 'closeAll'
    // Close from innermost outward using the parser's canonical popTag(),
    // which keeps the parser stack and output builder in sync automatically.

    let current = parserState.currentTagDetail;

    while (current && !current.root) {
      this.#recordError(AutoCloseErrorType.UNCLOSED_EOF, { tag: current.name, expected: null, index: current.index });

      parserState.addTextNode();
      parserState.popTag();

      // popTag() already updated currentTagDetail via tagsStack.pop()
      current = parserState.currentTagDetail;
    }
  }

  /**
   * @description Called when a closing tag name doesn't match `currentTagDetail.name`. Returns a decision describing what the caller should do: `{ action:
   * 'close-matched' }` — the handler already closed intermediates, so the caller should now close the matched tag normally; `{ action: 'discard' }` —
   * the caller should skip this closing tag entirely. @param closingTagName - The mismatched closing tag we just read. @param parserState - Live view
   * of the parser; same shape as `handleEof()`. @throws {ParseError} `MISMATCHED_CLOSE_TAG` when `onMismatch` is `'throw'`.
   */
  handleMismatch(closingTagName: string, parserState: ParserState): AutoCloseDecision {
    const { tagsStack, currentTagDetail, source } = parserState;

    if (this.onMismatch === 'throw') {
      throw new MismatchedCloseTag({
        tag: closingTagName,
        expected: currentTagDetail?.name,
        message: `Unexpected closing tag '${closingTagName}' expecting '${currentTagDetail?.name}'`,
        index: source ? absolutePosition(source) : undefined,
      });
    }

    if (this.onMismatch === 'discard') {
      this.#recordError(AutoCloseErrorType.MISMATCHED_CLOSE, {
        tag: closingTagName,
        expected: currentTagDetail?.name,
        index: source ? absolutePosition(source) : null,
      });
      return { action: 'discard' };
    }

    // onMismatch === 'recover'
    // Scan the stack (top → bottom) for the closest matching opener.
    // tagsStack holds ancestors with index 0 = root, last = parent of current.
    // currentTagDetail is the open tag at the top that didn't match.

    // Build a unified view: [root...ancestors, current] — we check current first
    // (it's the top), then walk down toward the root.
    const stackSnapshot = [...tagsStack, currentTagDetail];

    let matchIndex = -1;
    const stackSnapshotLength = stackSnapshot.length;
    for (let i = stackSnapshotLength - 1; i >= 0; i--) {
      if (stackSnapshot[i]?.name === closingTagName) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      // No match anywhere — phantom closing tag
      this.#recordError(AutoCloseErrorType.PHANTOM_CLOSE, {
        tag: closingTagName,
        expected: currentTagDetail?.name,
        index: source ? absolutePosition(source) : null,
      });
      return { action: 'discard' };
    }

    // Close everything above the match (innermost first), then signal the
    // caller to close the matched tag itself in the normal path.
    const levelsToClose = stackSnapshotLength - 1 - matchIndex;

    for (let i = 0; i < levelsToClose; i++) {
      const tag = stackSnapshot[stackSnapshotLength - 1 - i] as NonNullable<(typeof stackSnapshot)[number]>;

      this.#recordError(AutoCloseErrorType.MISMATCHED_CLOSE, { tag: tag.name, expected: closingTagName, index: tag.index });

      parserState.addTextNode();
      parserState.popTag();
    }

    // Update currentTagDetail to the matched one so the normal close path works.
    // popTag() has already walked the stack up by levelsToClose steps; the next
    // currentTagDetail is the one we want to match against.
    //
    // `matchIndex` is in range and non-null: the loop above only assigns it
    // after reading `.name` off a real element, and handleMismatch() is only
    // reachable with a tag actually open.
    parserState.currentTagDetail = stackSnapshot[matchIndex]!;

    return { action: 'close-matched' };
  }

  /**
   * @description Called when the source ended mid-way through a tag token. Records the partial-tag error and delegates remaining open tags to `handleEof()`.
   *
   * @param originalError - The error thrown by the read function.
   * @param parserState - Live view of the parser; same shape as `handleEof()`.
   */
  handlePartialTag(originalError: Error, parserState: ParserState): void {
    this.#recordError(AutoCloseErrorType.PARTIAL_TAG, {
      tag: extractPartialTagName(originalError),
      expected: null,
      index: parserState.source ? absolutePosition(parserState.source) : null,
    });

    // Discard any partially-accumulated text from the broken tag
    parserState.tagTextData = '';

    // Close whatever was legitimately open before this truncation
    this.handleEof(parserState);
  }

  /**
   * @description Return a copy of the collected error list. Empty array when `collectErrors` is false or no errors occurred.
   */
  getErrors(): ParseErrorEntry[] {
    return this.errors.slice();
  }

  /**
   * @description Reset the error log (useful if the same handler instance is reused).
   */
  reset(): void {
    this.errors = [];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  #recordError(type: AutoCloseErrorTypeValue, detail: Omit<ParseErrorEntry, 'type'>): void {
    if (!this.collectErrors) return;
    this.errors.push({ type, ...detail });
  }
}

/**
 * @description Best-effort extraction of a partial tag name from a source-exhausted error. Accepts the full error object so it can inspect both message and code.
 *
 * - `ParseError` from `readClosingTagName()` (new format): message `Unexpected end of source reading closing tag '</di'`
 * - Legacy plain `Error` (old format, kept for safety): message `Unexpected end of source. Reading closing tag '</di'`
 * - `ParseError` from `readTagExp()` / `readPiExp()` — an opening tag truncated before `>`: no tag name is embedded, so this returns `null`.
 */
function extractPartialTagName(err: Error | null | undefined): string | null {
  if (!err) return null;
  const message = typeof err.message === 'string' ? err.message : String(err);
  // Match both "reading closing tag" (new, lowercase) and
  // "Reading closing tag"  (old, capitalised, period-separated)
  const closeMatch = message.match(/[Rr]eading closing tag '<\/([^']*)/);
  if (closeMatch) return closeMatch[1] || null;
  return null;
}
