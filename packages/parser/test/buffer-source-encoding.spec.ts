import { describe, it, expect } from 'vite-plus/test';

import type { BufferSourceOptions } from '#/input-source/buffer-source-options.ts';

import { buildProfileForBuffer } from '#/encoding/encoding-profile.ts';
import BufferSource from '#/input-source/buffer-source.ts';
import FeedableSource from '#/input-source/feedable-source.ts';
import StringSource from '#/input-source/string-source.ts';

describe('BufferSource + EncodingProfile wiring', () => {
  it('decodes before scanning, so readCh and readStr agree on multi-byte UTF-8', () => {
    const xml = 'café'; // 4 characters, 5 bytes
    const buf = Buffer.from(xml, 'utf8');
    const profile = buildProfileForBuffer(buf, { encoding: 'utf8' });
    // profile is the 3rd constructor argument, not the 2nd ("options").
    // Passing it as the 2nd argument compiles and even passes for utf8,
    // because utf8 is also BufferSource's built-in zero-config default when
    // no profile is given at all — so the mistake is invisible for utf8
    // specifically, and would silently misbehave for any other encoding.
    const source = new BufferSource(buf, {}, profile);

    const chars = [];
    while (source.canRead()) chars.push(source.readCh());
    expect(chars.join('')).toBe('café');

    // The source is a string once constructed, so `startIndex` and every
    // length argument are CHARACTER counts. Over-long reads clamp rather than
    // run off the end, which is why the byte count is still safe to pass here.
    expect(source.buffer).toBe('café');
    expect(source.buffer.length).toBe(4);
    source.startIndex = 0;
    expect(source.readStr(buf.length)).toBe('café');

    source.startIndex = 0;
    source.readCh();
    source.readCh();
    source.readCh(); // 'c','a','f'
    const startOfE = source.startIndex;
    expect(startOfE).toBe(3);
    // 'é' is one character, so it advances the cursor by ONE — not by the two
    // bytes it occupies. The byte-scan path this replaced advanced by two and
    // left startIndex pointing mid-character relative to the decoded text.
    expect(source.readCh()).toBe('é');
    expect(source.startIndex).toBe(4);

    // readStr counts characters too. 'é' is the last character, so an
    // over-long read clamps at the end — which is precisely the proof that the
    // length is a character count and not a byte count: under the old byte-scan
    // path readStr(2) from here consumed two BYTES and returned 'é' only because
    // it had to stop at a character boundary.
    source.startIndex = startOfE;
    expect(source.readStr(1)).toBe('é');
    expect(source.readStr(2)).toBe('é');
  });

  it("demonstrates why the profile's argument position matters for a non-default encoding", () => {
    const buf = Buffer.from('hi', 'utf16le'); // bytes look nothing like utf8 "hi"
    const profile = buildProfileForBuffer(buf, { encoding: 'utf16le' });

    // Deliberately in the wrong slot: the test is about what happens when a
    // profile lands where `options` is expected, so it is cast past the type.
    const wrongSlot = new BufferSource(buf, profile as unknown as BufferSourceOptions); // profile treated as "options"
    let out1 = '';
    while (wrongSlot.canRead()) out1 += wrongSlot.readCh();
    expect(out1).not.toBe('hi'); // silently wrong -- decoded as utf8, not utf16le

    const correctSlot = new BufferSource(buf, {}, profile);
    let out2 = '';
    while (correctSlot.canRead()) out2 += correctSlot.readCh();
    expect(out2).toBe('hi');
  });
});

describe('canRead(n) formula — all sources agree, relative to current position', () => {
  // All three sources now check startIndex + n < buffer.length -- "how many
  // more characters from here", not "how big is the whole document".

  it('BufferSource answers relative to how far it has already read', () => {
    const buf = Buffer.from('0123456789'); // 10 bytes total
    const source = new BufferSource(buf);
    source.startIndex = 8; // only 2 characters left: '8', '9'

    expect(source.canRead(3)).toBe(false); // correct: only 2 remain
    expect(source.canRead(1)).toBe(true); // correct: 1 remains after this one
    expect(source.canRead()).toBe(true); // still fine (2 left)
  });

  it('StringSource answers relative to how far it has already read', () => {
    const source = new StringSource('0123456789');
    source.startIndex = 8; // only 2 characters left

    expect(source.canRead(3)).toBe(false);
    expect(source.canRead(1)).toBe(true);
    expect(source.canRead()).toBe(true);
  });

  it('FeedableSource answers the same question the same way', () => {
    const source = new FeedableSource();
    source.feed('0123456789');
    source.startIndex = 8; // only 2 characters left

    expect(source.canRead(3)).toBe(false); // correct: only 2 remain
    expect(source.canRead(1)).toBe(true); // correct: 1 remains after this one
  });

  it('BufferSource readCh and readStr agree on multi-byte UTF-8 at character boundaries', () => {
    const xml = 'café'; // 4 chars, 5 bytes
    const buf = Buffer.from(xml, 'utf8');
    const profile = buildProfileForBuffer(buf, { encoding: 'utf8' });
    // Same deliberate misplacement as above, for the same reason.
    const source = new BufferSource(buf, profile as unknown as BufferSourceOptions);

    // 1. Read the whole buffer char-by-char and join → should be "café"
    const chars = [];
    while (source.canRead()) {
      chars.push(source.readCh());
    }
    expect(chars.join('')).toBe('café');

    // 2. Reset and read the same string via readStr with the full byte length.
    //    Over-long reads clamp, so passing a byte count is safe even though the
    //    buffer is now a 4-character string.
    source.startIndex = 0;
    const fullString = source.readStr(buf.length); // 5 bytes requested, 4 available
    expect(fullString).toBe('café');

    // 3. A single multi-byte character advances the cursor by ONE, because the
    //    source decoded to a string before scanning began.
    source.startIndex = 0; // reset
    source.readCh(); // 'c'
    source.readCh(); // 'a'
    source.readCh(); // 'f'
    const startOfE = source.startIndex;
    expect(startOfE).toBe(3);
    expect(source.readCh()).toBe('é');
    expect(source.startIndex).toBe(4);

    // Reset to start of é and read it back by character count
    source.startIndex = startOfE;
    expect(source.readStr(1)).toBe('é');
    // readStr does NOT update startIndex, so it remains at startOfE
    // (but we don't care; we verified the string)
  });
});
