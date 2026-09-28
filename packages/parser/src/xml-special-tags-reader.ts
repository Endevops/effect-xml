import type { TagExpressionParser } from './internal/parser-types.ts';

import { InvalidTag } from './parse-error.js';
import { expectMatch, errorPositionOf, sanitizeContent } from './util.js';
import { readPiExp, flushAttributes } from './xml-part-reader.js';

/**
 * @description Read a CDATA section. `<![` has already been consumed by the caller. Normalization is unconditional — it applies even under `xml:space="preserve"`.
 *
 * @param parser - Parser context.
 *
 * @throws {ParseError} `UNEXPECTED_END` on a chunk boundary mid-section, `ILLEGAL_CHARACTER` on an illegal control code.
 */
export function readCdata(parser: TagExpressionParser): void {
  // Level-1 inner mark: records where this reader began, used only by flush()
  // as a safe trim boundary. Does NOT overwrite the level-0 outer mark set by
  // parseXml()'s loop before it consumed '<![', which rewindToMark() restores to.
  parser.source.markTokenStart(1);

  //<![ already consumed up to this point
  expectMatch(parser.source, 'CDATA[', 'CDATA preamble');

  let text = parser.source.readUpto(']]>');
  // Normalization is unconditional — applies even under xml:space="preserve".
  text = sanitizeContent(text, parser.source);
  parser.outputBuilder.addLiteral(text);
}

/**
 * @description Read a processing instruction (`<?…?>`). `<?` has already been consumed by the caller. A `<?xml …?>` declaration additionally seeds
 * {@link TagExpressionParser.xmlDec} and invalidates the memoized name validators, which were built before the document's XML version was known — see
 * the inline note below.
 *
 * @param parser - Parser context.
 *
 * @throws {ParseError} `INVALID_TAG` when the expression can't be read, plus whatever `readPiExp()` throws.
 */
export function readPiTag(parser: TagExpressionParser): void {
  const skipOptions = parser.options.skip;
  parser.source.markTokenStart(1);
  //<? already consumed
  const tagExp = readPiExp(parser);
  if (!tagExp) {
    throw new InvalidTag({ message: 'Invalid Pi Tag expression.', index: errorPositionOf(parser.source).index });
  } else if (tagExp.tagName === 'xml') {
    // Read version from the declaration and store it on the parser for validators.
    const version = tagExp.rawAttributes?.['version'];
    if (version === '1.1') {
      parser.xmlDec.version = 1.1;
    }
    parser.xmlDec.encoding = (tagExp.rawAttributes?.['encoding'] as string | undefined) ?? null;
    parser.xmlDec.standalone = (tagExp.rawAttributes?.['standalone'] as string | undefined) ?? null;

    // BUG FIX: getNameValidator('qName') was already called (and memoized)
    // above the moment this PI tag's own name ("xml") got validated — before
    // xmlDec.version was known, so it was always cached with the '1.0'
    // default. Every subsequent tag/attribute name in the document —
    // including the root element — would silently be checked against XML
    // 1.0 rules even for a document declaring version="1.1". Reset the
    // cache now that the real version is known; this runs at most once per
    // document (a <?xml?> declaration can only appear once), so the cost is
    // negligible.
    // parser._nameValidators = Object.create(null);
    parser._nameValidators = {};
  }

  // Flush attributes into the output builder's this.attributes accumulator
  // so addDeclaration() / addInstruction() pick them up, mirroring what readOpeningTag
  // does for regular tags. PI tags are not pushed onto the matcher, so no
  // updateCurrent() call is needed here.
  if (!skipOptions.attributes) {
    flushAttributes(tagExp._parsedAttrs, parser, tagExp._attrsExpStart, tagExp._rawAttrMatchCount, tagExp.tagName);
  }

  if (tagExp.tagName === 'xml') {
    //TODO: move it to above if condition
    //TODO: verify it is very first tag else error
    if (!skipOptions.declaration) {
      //TODO: unnecessary. builder can ommit it from response if not needed
      parser.outputBuilder.addDeclaration('?xml', parser.xmlDec);
    }
  } else if (!skipOptions.pi) {
    //TODO: unnecessary. builder can ommit it from response if not needed
    parser.outputBuilder.addInstruction('?' + tagExp.tagName); // TODO: send without '?'
  }
}

/**
 * @description Read a comment. `<!-` has already been consumed by the caller.
 *
 * @param parser - Parser context.
 *
 * @throws {ParseError} `UNEXPECTED_END` on a chunk boundary mid-comment, `ILLEGAL_CHARACTER` on an illegal control code.
 */
export function readComment(parser: TagExpressionParser): void {
  parser.source.markTokenStart(1);
  //<!- already consumed
  expectMatch(parser.source, '-', 'comment second dash');
  let text = parser.source.readUpto('-->');
  text = sanitizeContent(text, parser.source);
  parser.outputBuilder.addComment(text);
}
