import type { EncodingDescriptor } from '#/options.ts';

import { InvalidDecoder, UnsupportedEncoding } from '#/parse-error.ts';

import { createTextDecoderAdapter, createUtf16BeAdapter } from './text-decoder-adapter.ts';

/**
 * @description A descriptor with every optional field filled in, so readers never have to test for `undefined`. `Omit` rather than an intersection: intersecting
 * with `EncodingDescriptor` would intersect `bomBytes: Uint8Array | null` with `bomBytes?: Uint8Array` and collapse the `null` back to `Uint8Array` —
 * losing exactly the case `bomCandidates()` filters on.
 */
export type ResolvedEncodingDescriptor = Omit<EncodingDescriptor, 'aliases' | 'bomBytes' | 'selfSynchronizing' | 'variableWidth'> & {
  /**
   * @description Alternative names this encoding is also resolvable by.
   */
  aliases: Array<string>;
  /**
   * @description Byte-order-mark signature used by auto-detection, or `null` when the encoding has no BOM.
   */
  bomBytes: Uint8Array | null;
  /**
   * @description True when an ASCII delimiter byte can never appear as part of a multi-byte sequence.
   */
  selfSynchronizing: boolean;
  /**
   * @description True when bytes-per-character varies.
   */
  variableWidth: boolean;
};

/**
 * @description The set of known `EncodingDescriptor`s a parser resolves bytes against: stores, validates and resolves them. It knows nothing about scanning
 * strategy — see `scan-strategy/`, composed together in `encoding-profile.ts`. Built by {@link makeEncodingRegistry}, not constructed.
 */
export interface EncodingRegistry {
  /**
   * @description Register a descriptor. Validates shape immediately (fail-fast): a broken custom encoding should throw at registration time, not silently corrupt
   * data three parses later.
   *
   * @param descriptor - Descriptor to store. Missing optional fields take their safe defaults.
   *
   * @throws {ParseError} `INVALID_DECODER` when `name` is missing/non-string, `createDecoder` is absent, or `createDecoder()` doesn't return a `{
   *   write, end }` pair.
   */
  register(descriptor: EncodingDescriptor): void;
  /**
   * @description Look up a descriptor by name or alias, case-insensitively.
   *
   * @param name - Encoding name as configured, declared in a `<?xml?>` document, or passed to `decoding.encoding`.
   *
   * @throws {ParseError} `UNSUPPORTED_ENCODING` when no descriptor is registered under that name or any of its aliases.
   */
  resolve(name: string): ResolvedEncodingDescriptor;
  /**
   * @description All descriptors that carry a BOM signature, for detection — longest signature first, so a longer BOM always wins over a shorter one that happens
   * to be its prefix.
   */
  bomCandidates(): Array<ResolvedEncodingDescriptor>;
}

/**
 * @description Create an encoding registry, seeded with the built-in encodings.
 *
 * @returns The registry.
 */
export const makeEncodingRegistry = (): EncodingRegistry => {
  /**
   * @description Lowercased name/alias → descriptor. Aliases share the descriptor instance with their canonical name.
   */
  const byName = new Map<string, ResolvedEncodingDescriptor>();

  const register = (descriptor: EncodingDescriptor): void => {
    if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name) {
      throw new InvalidDecoder({ message: 'Encoding descriptor requires a non-empty "name"' });
    }
    if (typeof descriptor.createDecoder !== 'function') {
      throw new InvalidDecoder({ encoding: descriptor.name, message: `Encoding "${descriptor.name}" is missing createDecoder()` });
    }
    const probe = descriptor.createDecoder();
    if (!probe || typeof probe.write !== 'function' || typeof probe.end !== 'function') {
      throw new InvalidDecoder({
        encoding: descriptor.name,
        message: `Encoding "${descriptor.name}"'s createDecoder() must return an object with write()/end()`,
      });
    }
    const resolved: ResolvedEncodingDescriptor = {
      selfSynchronizing: false, // safe default per savepoint §3 — opt-in speed, not opt-in correctness
      variableWidth: true,
      aliases: [],
      bomBytes: null,
      ...descriptor,
    };
    byName.set(resolved.name.toLowerCase(), resolved);
    for (const alias of resolved.aliases) byName.set(alias.toLowerCase(), resolved);
  };

  register({
    name: 'utf8',
    aliases: ['utf-8'],
    bomBytes: new Uint8Array([0xef, 0xbb, 0xbf]),
    selfSynchronizing: true,
    variableWidth: true,
    createDecoder: () => createTextDecoderAdapter('utf-8'),
  });
  register({
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
  register({
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
  register({
    name: 'utf16le',
    aliases: ['utf-16le', 'ucs2', 'ucs-2'],
    bomBytes: new Uint8Array([0xff, 0xfe]),
    selfSynchronizing: false,
    variableWidth: true,
    createDecoder: () => createTextDecoderAdapter('utf-16le'),
  });
  register({
    name: 'utf16be',
    aliases: ['utf-16be'],
    // No native TextDecoder label for utf16be either; byte-swap then
    // decode as utf16le, same trick as before.
    bomBytes: new Uint8Array([0xfe, 0xff]),
    selfSynchronizing: false,
    variableWidth: true,
    createDecoder: () => createUtf16BeAdapter(),
  });

  return {
    register,
    resolve: (name: string): ResolvedEncodingDescriptor => {
      const descriptor = byName.get(String(name).toLowerCase());
      if (!descriptor) {
        throw new UnsupportedEncoding({ encoding: name, message: `Unsupported encoding "${name}"` });
      }
      return descriptor;
    },
    bomCandidates: (): Array<ResolvedEncodingDescriptor> => {
      const seen = new Set<string>();
      const out: Array<ResolvedEncodingDescriptor> = [];
      for (const d of byName.values()) {
        if (d.bomBytes && !seen.has(d.name)) {
          seen.add(d.name);
          out.push(d);
        }
      }
      return out.sort((a, b) => (b.bomBytes as Uint8Array).length - (a.bomBytes as Uint8Array).length);
    },
  };
};

/**
 * @description Registry seeded once at module load and shared by every `XMLParser` that registers no custom decoders.
 */
export const defaultEncodingRegistry = makeEncodingRegistry();
