import { ParseError, ErrorCode } from '../ParseError.js';
import { createTextDecoderAdapter, createUtf16BeAdapter } from './TextDecoderAdapter.js';

/**
 * @description EncodingRegistry — owns the set of known EncodingDescriptors. A descriptor is a pure data + factory bundle: { name, aliases, bomBytes // Buffer |
 * null — signature to detect this encoding via BOM selfSynchronizing // boolean — true if an ASCII delimiter byte (<,>,",') // can never appear as
 * part of a multi-byte sequence. // Only self-synchronizing encodings are eligible for // BufferSource's byte-level scan fast path. variableWidth //
 * boolean — true if bytes-per-character varies. // Informational only for now (position reporting // is index-only, so nothing currently branches //
 * on this) — kept on the descriptor shape so // existing custom-encoding registrations don't // need to change. createDecoder() // -> { write(buf):
 * string, end(): string } stateful decoder } SRP: this class only stores/validates/resolves descriptors. It knows nothing about scanning strategy —
 * see ScanStrategy/, composed together in EncodingProfile.js.
 */
export default class EncodingRegistry {
  constructor() {
    this._byName = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    this.register({
      name: 'utf8',
      aliases: ['utf-8'],
      bomBytes: Buffer.from([0xef, 0xbb, 0xbf]),
      selfSynchronizing: true,
      variableWidth: true,
      createDecoder: () => createTextDecoderAdapter('utf-8'),
    });
    this.register({
      name: 'ascii',
      aliases: [],
      bomBytes: null,
      selfSynchronizing: true,
      variableWidth: false,
      // TextDecoder has no dedicated 'ascii' label. windows-1252 is a strict
      // superset of ASCII and decodes any valid ASCII byte identically —
      // only bytes 0x80-0x9F (never legal ASCII) would differ, so behavior
      // for real ASCII input is unchanged.
      createDecoder: () => createTextDecoderAdapter('windows-1252'),
    });
    this.register({
      name: 'latin1',
      aliases: ['iso-8859-1', 'binary'],
      bomBytes: null,
      selfSynchronizing: true,
      variableWidth: false,
      createDecoder: () => createTextDecoderAdapter('iso-8859-1'),
    });
    this.register({
      name: 'utf16le',
      aliases: ['utf-16le', 'ucs2', 'ucs-2'],
      bomBytes: Buffer.from([0xff, 0xfe]),
      selfSynchronizing: false,
      variableWidth: true,
      createDecoder: () => createTextDecoderAdapter('utf-16le'),
    });
    this.register({
      name: 'utf16be',
      aliases: ['utf-16be'],
      // No native TextDecoder label for utf16be either; byte-swap then
      // decode as utf16le, same trick as before.
      bomBytes: Buffer.from([0xfe, 0xff]),
      selfSynchronizing: false,
      variableWidth: true,
      createDecoder: () => createUtf16BeAdapter(),
    });
  }

  /**
   * @description Register a descriptor. Validates shape immediately (fail-fast), same spirit as ValueParserRegistry.register() in base-output-builder: a broken
   * custom encoding should throw at registration time, not silently corrupt data three parses later.
   */
  register(descriptor) {
    if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name) {
      throw new ParseError('Encoding descriptor requires a non-empty "name"', ErrorCode.INVALID_DECODER);
    }
    if (typeof descriptor.createDecoder !== 'function') {
      throw new ParseError(`Encoding "${descriptor.name}" is missing createDecoder()`, ErrorCode.INVALID_DECODER);
    }
    const probe = descriptor.createDecoder();
    if (!probe || typeof probe.write !== 'function' || typeof probe.end !== 'function') {
      throw new ParseError(`Encoding "${descriptor.name}"'s createDecoder() must return an object with write()/end()`, ErrorCode.INVALID_DECODER);
    }
    const resolved = {
      selfSynchronizing: false, // safe default per savepoint §3 — opt-in speed, not opt-in correctness
      variableWidth: true,
      aliases: [],
      bomBytes: null,
      ...descriptor,
    };
    this._byName.set(resolved.name.toLowerCase(), resolved);
    for (const alias of resolved.aliases) this._byName.set(alias.toLowerCase(), resolved);
  }

  resolve(name) {
    const descriptor = this._byName.get(String(name).toLowerCase());
    if (!descriptor) {
      throw new ParseError(`Unsupported encoding "${name}"`, ErrorCode.UNSUPPORTED_ENCODING);
    }
    return descriptor;
  }

  /**
   * @description All descriptors that carry a BOM signature, for detection (longest first).
   */
  bomCandidates() {
    const seen = new Set();
    const out = [];
    for (const d of this._byName.values()) {
      if (d.bomBytes && !seen.has(d.name)) {
        seen.add(d.name);
        out.push(d);
      }
    }
    return out.sort((a, b) => b.bomBytes.length - a.bomBytes.length);
  }
}

export const defaultEncodingRegistry = new EncodingRegistry();
