import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vite-plus/test';

import { bytesDoc, makeParser, parseDoc } from '#/test/helpers/test-runner.ts';

/**
 * @description Guards the property that lets this package run in a browser: the parser depends on `Uint8Array` and the global `TextDecoder`, never on a Node
 * builtin. The byte-scan fast path and the `Buffer` type were removed to get here (see `encoding-profile.ts` for the measurement that retired them),
 * and nothing in the test suite would otherwise notice if a `node:` import or a `Buffer` call crept back in — the whole suite runs under Node, where
 * `Buffer` simply exists. These are the assertions that make the property hold. Two halves, deliberately:
 *
 * - A source scan, which is the real guard. It is deterministic, needs no build, and catches a re-introduced dependency at the exact file that did it.
 * - A runtime parse whose input is built from `Uint8Array` literals with no `Buffer` involved anywhere, so a runtime dependency on `Buffer` fails
 *   loudly even if it somehow escaped the scan.
 *
 * @see {@link https://developer.mozilla.org/docs/Web/API/TextDecoder} for why `TextDecoder` is the portable choice.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * @description Strip block and line comments, leaving string literals intact. This is what the `node:` import scan needs: an import specifier _is_ a string
 * literal, so a stripper that removed strings would delete the very text it is looking for — which is exactly the bug this helper exists to avoid
 * having been introduced alongside it.
 *
 * @param source - Raw file contents.
 *
 * @returns The same source with comments removed.
 */
const noComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * @description Strip comments _and_ string literals, leaving only code. The `Buffer` scan needs this because doc comments in this package name `Buffer` repeatedly
 * while explaining why the package does not use it, and one error message reads "Buffer size limit exceeded" — a description of a byte limit, not a
 * reference to the type. Without stripping, the scan would report the very files that document the rule it enforces. A template literal is stripped
 * whole, `${…}` included, which would hide a `Buffer` written inside an interpolation; no code in this package does that, and the `node:` scan still
 * catches a dependency that arrives as an import.
 *
 * @param source - Raw file contents.
 *
 * @returns The same source with comments and string bodies removed.
 */
const codeOnly = (source: string): string => noComments(source).replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');

/**
 * @description Every `.ts` file under `src/`, recursively. Symlinks are not followed — `src/` is a plain directory tree.
 */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('Browser compatibility', () => {
  it('imports nothing from node: builtins', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      // Comments only, NOT strings: the specifier `from 'node:buffer'` is
      // itself a string literal.
      if (/(?:from|import|require\()\s*\(?\s*['"]node:/.test(noComments(readFileSync(file, 'utf8')))) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it('never uses Buffer as a value or a type', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      // A `Buffer` *type* annotation would be just as bad as a call: it would
      // put a `@types/node` dependency into the emitted .d.ts, which is what
      // makes the browser build fail. So any occurrence in real code counts.
      if (/\bBuffer\b/.test(codeOnly(readFileSync(file, 'utf8')))) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it('uses only globals that exist in a browser for decoding', () => {
    // The decoders are built on TextDecoder precisely because it is available
    // natively in both Node (since 11) and every modern browser, where
    // `node:string_decoder` is not. This asserts the built-in descriptors
    // still resolve, which they cannot without a global TextDecoder.
    const parser = makeParser();
    const utf8 = new Uint8Array([0x3c, 0x72, 0x3e, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x3c, 0x2f, 0x72, 0x3e]); // <r>café</r>
    expect(bytesDoc(parser, utf8)).toEqual({ r: 'café' });
  });

  it('parses byte input built without Buffer anywhere', () => {
    // Every byte below is written out by hand, so this whole path never touches
    // a Node global to produce its input. A dependency on Buffer would throw a
    // ReferenceError here rather than pass silently under Node.
    const doc = new Uint8Array([
      0x3c,
      0x72,
      0x6f,
      0x6f,
      0x74,
      0x3e, // <root>
      0x3c,
      0x61,
      0x20,
      0x69,
      0x64,
      0x3d,
      0x22,
      0x31,
      0x22,
      0x3e, // <a id="1">
      0xe2,
      0x9c,
      0x93, // ✓ three bytes
      0x3c,
      0x2f,
      0x61,
      0x3e, // </a>
      0x3c,
      0x2f,
      0x72,
      0x6f,
      0x6f,
      0x74,
      0x3e, // </root>
    ]);
    const parser = makeParser({ skip: { attributes: false } });
    expect(bytesDoc(parser, doc)).toEqual({ root: { a: { '@_id': 1, '#text': '✓' } } });
  });

  it('reports a character offset for byte input, matching the string path', () => {
    // A consequence of decoding before scanning: the reported index is a
    // character offset for every input, so it can be used to slice the decoded
    // text. Under the old byte-scan path this was a byte offset, which could
    // not be used against the text at all.
    const indexOf = (xml: string, asBytes: boolean) => {
      const parser = makeParser();
      try {
        if (asBytes) bytesDoc(parser, new TextEncoder().encode(xml));
        else parseDoc(parser, xml);
        return null;
      } catch (e) {
        return (e as { index?: number }).index;
      }
    };
    const strIndex = indexOf('<root>café</wrong></root>', false);
    const byteIndex = indexOf('<root>café</wrong></root>', true);
    expect(byteIndex).toBe(strIndex);
  });
});
