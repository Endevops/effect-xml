import type { EncodingDescriptor } from '../options.ts';

import { ParseError, ErrorCode } from '../ParseError.ts';
import { createTextDecoderAdapter, createUtf16BeAdapter } from './TextDecoderAdapter.ts';

/**
 * @description A descriptor with every optional field filled in, so readers never have to test for `undefined`. `Omit` rather than an intersection: intersecting
 * with `EncodingDescriptor` would intersect `bomBytes: Buffer | null` with `bomBytes?: Buffer` and collapse the `null` back to `Buffer` — losing
 * exactly the case `bomCandidates()` filters on.
 */
export type ResolvedEncodingDescriptor = Omit<EncodingDescriptor, 'aliases' | 'bomBytes' | 'selfSynchronizing' | 'variableWidth'> & {
  /**
   * @description Alternative names this encoding is also resolvable by.
   */
  aliases: string[];
  /**
   * @description Byte-order-mark signature used by auto-detection, or `null` when the encoding has no BOM.
   */
  bomBytes: Buffer | null;
  /**
   * @description True only when an ASCII delimiter byte can never appear as part of a multi-byte sequence — the precondition for `BufferSource`'s byte-level scan
   * fast path.
   */
  selfSynchronizing: boolean;
  /**
   * @description True when bytes-per-character varies. Informational; position reporting is index-only, so nothing branches on it.
   */
  variableWidth: boolean;
};

/**
 * @description EncodingRegistry — owns the set of known `EncodingDescriptor`s. A descriptor is a pure data + factory bundle, and this class only stores, validates
 * and resolves them. It knows nothing about scanning strategy — see `ScanStrategy/`, composed together in `EncodingProfile.ts`.
 */
export default class EncodingRegistry {
  /**
   * @description Lowercased name/alias → descriptor. Aliases share the descriptor instance with their canonical name.
   */
  private _byName: Map<string, ResolvedEncodingDescriptor>;

  constructor() {
    this._byName = new Map();
    this._seedDefaults();
  }

  private _seedDefaults(): void {
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
      // The WHATWG label is `iso-8859-1` (with a 9). `iso-8852-1` is not a
      // registered label and `new TextDecoder()` throws on it, which would
      // take down the whole registry at module load.
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
   * @description Register a descriptor. Validates shape immediately (fail-fast), same spirit as `ValueParserRegistry.register()` in base-output-builder: a broken
   * custom encoding should throw at registration time, not silently corrupt data three parses later.
   *
   * @param descriptor - Descriptor to store. Missing optional fields take their safe defaults.
   *
   * @throws {ParseError} `INVALID_DECODER` when `name` is missing/non-string, `createDecoder` is absent, or `createDecoder()` doesn't return a `{
   *   write, end }` pair.
   */
  register(descriptor: EncodingDescriptor): void {
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
    const resolved: ResolvedEncodingDescriptor = {
      selfSynchronizing: false, // safe default per savepoint §3 — opt-in speed, not opt-in correctness
      variableWidth: true,
      aliases: [],
      bomBytes: null,
      ...descriptor,
    };
    this._byName.set(resolved.name.toLowerCase(), resolved);
    for (const alias of resolved.aliases) this._byName.set(alias.toLowerCase(), resolved);
  }

  /**
   * @description Look up a descriptor by name or alias, case-insensitively.
   *
   * @param name - Encoding name as configured, declared in a `<?xml?>` document, or passed to `decoding.encoding`.
   *
   * @throws {ParseError} `UNSUPPORTED_ENCODING` when no descriptor is registered under that name or any of its aliases.
   */
  resolve(name: string): ResolvedEncodingDescriptor {
    const descriptor = this._byName.get(String(name).toLowerCase());
    if (!descriptor) {
      throw new ParseError(`Unsupported encoding "${name}"`, ErrorCode.UNSUPPORTED_ENCODING);
    }
    return descriptor;
  }

  /**
   * @description All descriptors that carry a BOM signature, for detection — longest signature first, so a longer BOM always wins over a shorter one that happens
   * to be its prefix.
   */
  bomCandidates(): ResolvedEncodingDescriptor[] {
    const seen = new Set<string>();
    const out: ResolvedEncodingDescriptor[] = [];
    for (const d of this._byName.values()) {
      if (d.bomBytes && !seen.has(d.name)) {
        seen.add(d.name);
        out.push(d);
      }
    }
    return out.sort((a, b) => (b.bomBytes as Buffer).length - (a.bomBytes as Buffer).length);
  }
}

/**
 * @description Registry seeded once at module load and shared by every `XMLParser` that registers no custom decoders.
 */
export const defaultEncodingRegistry: EncodingRegistry = new EncodingRegistry();
