import type { InputSourceLike } from './input-source/input-source.ts';
import type { StopNodeResult } from './internal/parser-types.ts';
import type { Enclosure } from './internal/tag-expression.ts';

import { ParseError, ErrorCode } from './parse-error.js';
import { isSpace, ensureCanRead, absolutePosition } from './util.js';

/**
 * @description Well-known enclosure presets. Import these in your parser config to compose `skipEnclosures` arrays:
 *
 * ```ts
 * import { xmlEnclosures, quoteEnclosures } from '@endevops/parser';
 * const parser = new XMLParser({
 *   tags: {
 *     stopNodes: [
 *       '..script', // plain — no enclosures (default)
 *       { expression: 'body..pre', skipEnclosures: [...xmlEnclosures] },
 *       { expression: 'head..style', skipEnclosures: [...xmlEnclosures, ...quoteEnclosures] },
 *       { expression: 'root.stopNode', nested: true, skipEnclosures: [{ open: '<!--', close: '-->' }] },
 *     ],
 *   },
 * });
 * ```
 */

/**
 * @description XML structural delimiters — comments, CDATA sections, processing instructions.
 */
export const xmlEnclosures: readonly Enclosure[] = [
  { open: '<!--', close: '-->' }, // comment
  { open: '<![CDATA[', close: ']]>' }, // CDATA section
  { open: '<?', close: '?>' }, // processing instruction
];

/**
 * @description String literal delimiters — useful for JS / CSS stop-node content.
 */
export const quoteEnclosures: readonly Enclosure[] = [
  { open: "'", close: "'" },
  { open: '"', close: '"' },
  { open: '`', close: '`' }, // template literal
];

/**
 * @description StopNodeProcessor options.
 */
export interface StopNodeProcessorOptions {
  /**
   * @description When true, nested same-name open tags increment a depth counter; the stop node ends only when depth returns to zero. Default is `false`.
   */
  nested?: boolean;
  /**
   * @description Enclosure pairs whose interiors suppress closing-tag detection. Default is `[]`.
   */
  skipEnclosures?: Enclosure[];
}

/**
 * @description StopNodeProcessor — self-contained processor for stop nodes. A stop node is a "sealed envelope": the parser goes blind the moment it enters one,
 * collecting raw characters until the matching closing tag is found. The content is returned as a raw string and never parsed by the XML engine.
 *
 * ### Modes
 *
 * The behaviour is controlled by two independent flags. **`nested`** (boolean, default `false`): when true, the processor tracks the depth of nested
 * same-name opening tags. The stop node ends only when the depth returns to zero — i.e. the closing tag that matches the original opening tag. When
 * false, the very first `</tagName>` ends the stop node regardless of nesting. **`skipEnclosures`** (array, default `[]`): a list of `{ open, close
 * }` pairs. When the processor encounters an open marker it consumes everything up to the close marker wholesale, suppressing all closing-tag (and
 * depth) logic for that span. Enclosures are checked in array order; the first match wins. When the array is empty, no enclosure skipping is
 * performed. The two flags compose freely:
 *
 * | nested  | skipEnclosures | Behaviour                                                             |
 * | ------- | -------------- | --------------------------------------------------------------------- |
 * | `false` | `[]`           | Plain: stop at first `</tagName>`.                                    |
 * | `true`  | `[]`           | Depth-only: track nested open tags, no enclosures.                    |
 * | `false` | `[...]`        | Enclosure-only: skip interiors, stop at first close tag outside them. |
 * | `true`  | `[...]`        | Full: depth tracking + enclosure skipping.                            |
 *
 * ### Chunk-boundary survival (feedable / stream sources)
 *
 * When input runs out mid-collection, `collect()` throws `UNEXPECTED_END`. The caller (`feed()` in `XMLParser`) catches it and rewinds the source to
 * the outer mark (the `<` of the stop node's opening tag). On the next `feed()` call `readOpeningTag()` sees the reader is already active
 * (`isActive()`) and calls `resumeAfterOpenTag()` to re-consume the opening tag before calling `collect()` again. All accumulated content and state
 * are preserved in instance fields between attempts.
 */
export class StopNodeProcessor {
  #tagName: string;
  #nested: boolean;
  #enclosures: Enclosure[];

  // Runtime state — reset in activate() / resumeAfterOpenTag()
  #content: string;
  #depth: number; // already inside the opening tag
  #active: boolean;

  /**
   * @param tagName The stop-node tag name to watch for.
   * @param opts.nested When true, nested same-name open tags increment a depth counter; the stop node ends only when depth returns to zero. Default
   *   is `false`
   * @param opts.skipEnclosures Enclosure pairs whose interiors suppress closing-tag detection. Default is `[]`
   */
  constructor(tagName: string, { nested = false, skipEnclosures = [] }: StopNodeProcessorOptions = {}) {
    this.#tagName = tagName;
    this.#nested = nested;
    this.#enclosures = skipEnclosures;

    // Runtime state — reset in activate() / resumeAfterOpenTag()
    this.#content = '';
    this.#depth = 1; // already inside the opening tag
    this.#active = false;
  }

  /**
   * @description True once activated; cleared when `collect()` returns successfully.
   */
  isActive(): boolean {
    return this.#active;
  }

  /**
   * @description Activate this processor. Called by `readOpeningTag()` the first time it encounters the stop node (after `readTagExp()` has consumed the opening
   * tag).
   */
  activate(): void {
    this.#active = true;
    this.#content = '';
    this.#depth = 1;
  }

  /**
   * @description Called on resume (chunk boundary): the source was rewound to the `<` of the stop node's opening tag, so the caller must re-consume the opening
   * tag via `readTagExp()` before calling `collect()`. Because the rewind replays the entire opening tag, any content accumulated during the failed
   * attempt is invalid. Reset to a clean post-activation state so the next `collect()` starts fresh from right after the opening tag.
   */
  resumeAfterOpenTag(): void {
    this.#content = '';
    this.#depth = 1;
  }

  /**
   * @description Collect raw content from `source` until the matching closing tag is found. Dispatches to one of four internal strategies based on the `nested`
   * flag and whether `skipEnclosures` is non-empty:
   *
   * - Plain (`nested: false`, no enclosures): fastest path — scan for the literal `</tagName>` string and stop immediately.
   * - Depth-only (`nested: true`, no enclosures): track open/close tags for depth, no enclosure skipping.
   * - Enclosure-only (`nested: false`, enclosures): skip enclosure interiors, stop at the first closing tag found outside them.
   * - Full (`nested: true`, enclosures): depth tracking AND enclosure skipping. Progress (`#content`, `#depth`) is stored in instance fields so a
   *   chunk-boundary `UNEXPECTED_END` can be retried seamlessly.
   *
   * @param source Any source object with the standard read interface.
   *
   * @returns `content` is the raw text between the opening and closing tags. `end` is the position immediately after the matched closing tag's `>` —
   *   mirrors `TagDetail.openEnd` / `closeMeta.closeEnd` for the opening-tag side, letting a caller recover the exact span of `<tag>...</tag>`
   *   including both delimiters, not just the inner content.
   *
   * @throws {ParseError} `UNEXPECTED_END` when the input runs out before the stop node is closed.
   */
  collect(source: InputSourceLike): StopNodeResult {
    source.markTokenStart(1);

    const enclosuresLen = this.#enclosures.length; //dont inline

    if (!this.#nested && enclosuresLen === 0) {
      return this.#collectPlain(source);
    }
    if (this.#nested && enclosuresLen === 0) {
      return this.#collectDepthOnly(source);
    }
    if (!this.#nested && enclosuresLen > 0) {
      return this.#collectEnclosureOnly(source);
    }
    // nested && enclosures.length > 0
    return this.#collectFull(source);
  }

  // ── Strategy 1: Plain ──────────────────────────────────────────────────────

  /**
   * @description Fastest path. No depth tracking, no enclosure skipping. Scans for the literal `</tagName>` followed by optional whitespace then `>`.
   */
  #collectPlain(source: InputSourceLike): StopNodeResult {
    while (source.canRead()) {
      const ch = source.readChAt(0);

      if (ch !== '<') {
        this.#content += source.readCh();
        continue;
      }

      if (this.#tryConsumeCloseTag(source)) return this.#finish(source);
      this.#content += source.readCh();
    }

    throw this.#unclosedError();
  }

  // ── Strategy 2: Depth-only ─────────────────────────────────────────────────

  /**
   * @description Depth tracking without enclosure skipping. Properly handles nested same-name open tags. No enclosure awareness.
   */
  #collectDepthOnly(source: InputSourceLike): StopNodeResult {
    while (this.#depth > 0) {
      ensureCanRead(source, 0, `stop node <${this.#tagName}> content`);
      if (this.#stepDepthTracking(source)) return this.#finish(source);
    }

    /* istanbul ignore next */
    throw this.#unclosedError();
  }

  // ── Strategy 3: Enclosure-only ─────────────────────────────────────────────

  /**
   * @description Enclosure skipping without depth tracking. Skips enclosure interiors; stops at the first `</tagName>` found outside them.
   */
  #collectEnclosureOnly(source: InputSourceLike): StopNodeResult {
    while (source.canRead()) {
      // Enclosure openers take priority over everything else
      if (this.#trySkipEnclosure(source)) continue;

      const ch = source.readChAt(0);

      if (ch !== '<') {
        this.#content += source.readCh();
        continue;
      }

      // At '<' outside any enclosure — check for our closing tag
      if (this.#tryConsumeCloseTag(source)) return this.#finish(source);
      this.#content += source.readCh();
    }

    throw this.#unclosedError();
  }

  // ── Strategy 4: Full (nested + enclosures) ─────────────────────────────────

  /**
   * @description Full mode: enclosure skipping AND depth tracking. Enclosure interiors suppress all closing-tag and depth logic for their span. Depth tracks
   * nested same-name open tags; the stop node ends at depth zero.
   */
  #collectFull(source: InputSourceLike): StopNodeResult {
    while (this.#depth > 0) {
      ensureCanRead(source, 0, `stop node <${this.#tagName}> content`);

      // Enclosure openers take priority over tag scanning
      if (this.#trySkipEnclosure(source)) continue;

      if (this.#stepDepthTracking(source)) return this.#finish(source);
    }

    /* istanbul ignore next */
    throw this.#unclosedError();
  }

  // ── Shared finish helper ───────────────────────────────────────────────────

  /**
   * @description Reset runtime state and return the accumulated content plus the end position (immediately after the matched closing tag's `>`). Called by every
   * strategy when the closing tag is confirmed — always right after that `>` has just been consumed from `source`.
   */
  #finish(source: InputSourceLike): StopNodeResult {
    const result = this.#content;
    const end = { index: absolutePosition(source) };
    this.#active = false;
    this.#content = '';
    this.#depth = 1;
    return { content: result, end };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * @description If an enclosure opens at the current position, consume it and its whole interior (added to `#content` verbatim) and return true. Returns false,
   * consuming nothing, if no enclosure opens here. Shared by the two enclosure-aware strategies (`#collectEnclosureOnly`, `#collectFull`).
   */
  #trySkipEnclosure(source: InputSourceLike): boolean {
    const encIdx = this.#matchEnclosureOpen(source);
    if (encIdx === -1) return false;
    const enc = this.#enclosures[encIdx] as Enclosure;
    this.#skipChars(source, enc.open.length);
    this.#content += enc.open;
    const interior = this.#readUpto(source, enc.close);
    this.#content += interior + enc.close;
    return true;
  }

  /**
   * @description At a '<' that isn't inside an enclosure: check whether it starts our own closing tag (`</tagName` + optional whitespace + `>`). If so, consume it
   * and return true — the caller then calls `#finish()`. If not a match, returns false without consuming anything, so the caller falls back to
   * treating the `<` as ordinary content. Shared by the two depth-unaware strategies (`#collectPlain`, `#collectEnclosureOnly`).
   */
  #tryConsumeCloseTag(source: InputSourceLike): boolean {
    const needed = '</' + this.#tagName;
    if (!this.#peekMatch(source, needed)) return false;

    let offset = needed.length;
    let validClose = false;
    while (true) {
      const c = source.readChAt(offset);
      if (c === '>') {
        validClose = true;
        break;
      }
      if (isSpace(c)) {
        offset++;
        continue;
      }
      break;
    }
    if (!validClose) return false;

    this.#skipChars(source, needed.length);
    while (source.canRead()) {
      const c = source.readCh();
      if (c === '>') break;
    }
    return true;
  }

  /**
   * @description Process one tag encountered while depth-tracking is active: plain content is appended as-is, a matching closing tag decrements depth (returning
   * true once depth reaches zero, telling the caller to finish), and any other tag — including a nested opener of our own tag name — is appended
   * verbatim and, for a same-name non-self-closing opener, increments depth. Shared by the two depth-tracking strategies (`#collectDepthOnly`,
   * `#collectFull`), which differ only in whether they check for enclosures before calling this.
   */
  #stepDepthTracking(source: InputSourceLike): boolean {
    const ch = source.readChAt(0);

    if (ch !== '<') {
      this.#content += source.readCh();
      return false;
    }

    // Consume '<'
    source.readCh();
    ensureCanRead(source, 0, `stop node <${this.#tagName}> tag after '<'`);

    const c0 = source.readChAt(0);

    if (c0 === '/') {
      // Closing tag
      source.readCh(); // consume '/'
      const closeName = this.#readTagName(source);
      const closeSuffix = this.#readToAngleClose(source);

      if (closeName === this.#tagName) {
        this.#depth--;
        if (this.#depth === 0) return true;
      }
      this.#content += '</' + closeName + closeSuffix;
      return false;
    }

    // Opening tag (including self-closing)
    const openName = this.#readTagName(source);
    this.#content += '<' + openName;

    const { selfClosing, attrText } = this.#readTagTail(source);
    this.#content += attrText;

    if (!selfClosing && openName === this.#tagName) {
      this.#depth++;
    }
    return false;
  }

  /**
   * @description The "ran out of input before the stop node closed" error, identical across all four collection strategies.
   */
  #unclosedError(): ParseError {
    return new ParseError(`Unclosed stop node <${this.#tagName}> — unexpected end of input`, ErrorCode.UNEXPECTED_END);
  }

  /**
   * @description Check whether any enclosure's `open` marker starts at the current source position (without consuming). Returns the index of the first matching
   * enclosure, or `-1` if none match.
   */
  #matchEnclosureOpen(source: InputSourceLike): number {
    const enclosuresLen = this.#enclosures.length;
    for (let i = 0; i < enclosuresLen; i++) {
      if (this.#peekMatch(source, (this.#enclosures[i] as Enclosure).open)) return i;
    }
    return -1;
  }

  /**
   * @description Read until `stopStr` is found, consuming `stopStr` itself. Returns the text before `stopStr`.
   *
   * @throws {ParseError} `UNEXPECTED_END` when the input runs out.
   */
  #readUpto(source: InputSourceLike, stopStr: string): string {
    const s0 = stopStr[0];
    const sLen = stopStr.length;
    const start = source.startIndex;
    let len = 0;

    while (source.canRead()) {
      if (source.readChAt(0) === s0 && this.#peekMatch(source, stopStr)) {
        const text = source.readStr(len, start);
        this.#skipChars(source, sLen);
        return text;
      }
      source.readCh();
      len++;
    }

    throw new ParseError(`Unclosed stop node <${this.#tagName}> — unexpected end looking for '${stopStr}'`, ErrorCode.UNEXPECTED_END);
  }

  /**
   * @description Check whether the source (starting at current position) starts with `str`. Does NOT consume.
   */
  #peekMatch(source: InputSourceLike, str: string): boolean {
    const strLen = str.length;
    for (let i = 0; i < strLen; i++) {
      if (source.readChAt(i) !== str[i]) return false;
    }
    return true;
  }

  /**
   * @description Consume exactly `n` characters from source (discarding them — the caller is responsible for appending to `#content` if needed).
   */
  #skipChars(source: InputSourceLike, n: number): void {
    for (let i = 0; i < n; i++) source.readCh();
  }

  /**
   * @description Read an XML name (tag name) from the current source position. Stops at `>`, `/`, or any whitespace. Does NOT consume the delimiter.
   */
  #readTagName(source: InputSourceLike): string {
    let name = '';
    while (source.canRead()) {
      const ch = source.readChAt(0);
      if (ch === '>' || ch === '/' || isSpace(ch)) break;
      name += source.readCh();
    }
    return name;
  }

  /**
   * @description Read from after the tag name up to and including the closing `>`, detecting self-closing `/>` and respecting quoted attribute values so a `>`
   * inside a value does not prematurely end the tag. Returns `{ selfClosing, attrText }` where `attrText` includes everything from the first
   * attribute character up to and including the closing `>` (or `/>`).
   *
   * @throws {ParseError} `UNEXPECTED_END` when the input runs out inside the tag.
   */
  #readTagTail(source: InputSourceLike): { selfClosing: boolean; attrText: string } {
    const start = source.startIndex;
    let len = 0;
    let inSingle = false;
    let inDouble = false;

    while (source.canRead()) {
      const ch = source.readCh();
      len++;

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (!inSingle && !inDouble) {
        if (ch === '>') {
          return { selfClosing: false, attrText: source.readStr(len, start) };
        }
        if (ch === '/' && source.canRead() && source.readChAt(0) === '>') {
          source.readCh(); // consume '>'
          len++;
          return { selfClosing: true, attrText: source.readStr(len, start) };
        }
      }
    }

    throw new ParseError(`Unclosed stop node <${this.#tagName}> — unexpected end inside tag`, ErrorCode.UNEXPECTED_END);
  }

  /**
   * @description After reading a closing tag name, read optional whitespace and the `>` returning them as a raw string (e.g. `' >'` or `'>'`). Preserves original
   * spacing when reconstructing inner closing tags.
   *
   * @throws {ParseError} `UNEXPECTED_END` when the input runs out, or the tag turns out to be malformed.
   */
  #readToAngleClose(source: InputSourceLike): string {
    const start = source.startIndex;
    let len = 0;
    while (source.canRead()) {
      const ch = source.readCh();
      len++;
      if (ch === '>') return source.readStr(len, start);
      if (!isSpace(ch)) {
        throw new ParseError(`Malformed closing tag for </${this.#tagName}>`, ErrorCode.UNEXPECTED_END);
      }
    }
    throw new ParseError(`Unclosed stop node <${this.#tagName}> — unexpected end looking for '>'`, ErrorCode.UNEXPECTED_END);
  }
}
