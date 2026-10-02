// oxlint-disable effecttsgo/effect-succeed-with-void
// entity-decoder.ts
//
// Single-pass, zero-regex decoder. Scan for `&`, read to `;`, resolve, push chunks, join once. Ported from
// `@nodable/entities@2.2.0` (`src/EntityDecoder.js`) as native TypeScript.
//
// Three entity tiers exist and the distinction is the security model, not a performance detail. `input` and
// `external` entities are injected at runtime — DOCTYPE declarations, and whatever a caller hands the
// decoder — so they are the untrusted surface and are what the expansion limits count by default. `base` is
// the five XML predefined entities plus the caller's own `namedEntities`. Numeric references are always
// `base`: they cannot recurse.
//
// Behaviour is transcribed, not corrected. Several upstream quirks are load-bearing for the output a caller
// already sees — a `&` inside a registered value is not filtered the way the docs claim, `postCheck` is
// skipped on the two fast paths, C1 codepoints and the FFFE/FFFF noncharacters are not classified at all.
// Each is called out where it appears, and none of them is repaired, because this class sits in front of XXE
// and entity-expansion handling where a silent fix is a change to every consumer's output.

import { Effect, Match, Predicate } from 'effect';

import { XmlError } from '#/xml-error.ts';

import { XML as DEFAULT_XML_ENTITIES } from './entity-tables.ts';

// ---------------------------------------------------------------------------
// Character codes
//
// The scan is a hand-rolled `charCodeAt` loop, so the three codes it tests against are named here rather than
// written as literals. `&` opens a reference, `;` closes one, `#` is what makes a reference numeric.
// ---------------------------------------------------------------------------

const CODE_AMPERSAND = 38;
const CODE_SEMICOLON = 59;
const CODE_HASH = 35;
const CODE_LOWER_X = 120;
const CODE_UPPER_X = 88;

/**
 * @description The widest entity name {@link EntityDecoder.decode} will look for, in characters. The forward scan for `;` stops once more than this many characters
 * have passed since the `&`, so a longer run is not treated as one entity — it is copied through as literal text. The bound is what keeps a document
 * with a megabyte of non-entity text between two ampersands from being sliced.
 */
const MAX_TOKEN_LENGTH = 32;

/**
 * @description The largest codepoint `String.fromCodePoint` accepts, and the bound a numeric reference is checked against before it gets that far. Out of range is
 * `leave`, not `remove`: the reference is preserved verbatim rather than deleted.
 */
const MAX_CODE_POINT = 0x10ffff;

/**
 * @description Returned by `#classifyNCR` for a codepoint that carries no minimum action level, which is what distinguishes "no restriction" from
 * `NCR_LEVEL.allow` — both end up expanding, but only the first lets `numericAllowed: false` short-circuit the whole pipeline.
 */
const NO_MINIMUM_LEVEL = -1;

// ---------------------------------------------------------------------------
// Entity name validation
// ---------------------------------------------------------------------------

/**
 * @description Characters that may not appear in an entity name registered through {@link EntityDecoder.setExternalEntities} or
 * {@link EntityDecoder.addExternalEntity}. A name carrying one of these cannot be written as `&name;` at all, so registration refuses it rather than
 * storing a name no document could ever reference. The set is the upstream string verbatim, including its duplicated backslash — a `Set` discards the
 * duplicate, so the effective set is the eighteen characters below.
 */
const SPECIAL_CHARS: ReadonlySet<string> = new Set('!?\\/[]$%{}^&*()<>|+');

// ---------------------------------------------------------------------------
// Limit tiers
// ---------------------------------------------------------------------------

/**
 * @description Injected at runtime: DOCTYPE entities for the current document, and persistent external entities. The untrusted tier, and the only one the
 * expansion limits count by default.
 */
const LIMIT_TIER_EXTERNAL = 'external';

/**
 * @description Trusted: the five XML predefined entities, the caller's `namedEntities`, and every numeric reference.
 */
const LIMIT_TIER_BASE = 'base';

/**
 * @description Not a tier an entity belongs to but a switch on the tier filter. Selecting it makes every entity count against the limits regardless of where it
 * came from.
 */
const LIMIT_TIER_ALL = 'all';

/**
 * @description Which side of the trust boundary an entity came from, as `#tierCounts` and the limit errors name it.
 */
type LimitTier = typeof LIMIT_TIER_ALL | typeof LIMIT_TIER_BASE | typeof LIMIT_TIER_EXTERNAL;

/**
 * @description The NCR action levels, in severity order. A higher number is a stricter action, and the resolver takes the maximum of the configured level and the
 * minimum a codepoint range imposes, so a range can only ever make an entity stricter than the caller asked for — never more lenient.
 */
const NCR_LEVEL = Object.freeze({ allow: 0, leave: 1, remove: 2, throw: 3 });

/**
 * @description The action names {@link EntityDecoderNCROptions.onNCR} accepts, matching the keys of {@link NCR_LEVEL}.
 */
type NcrLevelName = keyof typeof NCR_LEVEL;

/**
 * @description The XML version that governs which codepoint ranges a numeric reference is checked against. Narrowed to the two values the constructor and
 * {@link EntityDecoder.setXmlVersion} can actually store, because `#classifyNCR` compares it with `=== 1.0` and a third value would silently disable
 * the XML 1.0 C0 check.
 */
type XmlVersion = 1 | 1.1;

/**
 * @description The C0 control codes XML 1.0 §2.2 permits as literal characters. Every other code in U+0001–U+001F is prohibited.
 */
const XML10_ALLOWED_C0: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

// ---------------------------------------------------------------------------
// Hook actions
// ---------------------------------------------------------------------------

/**
 * @description What an {@link EntityRegistrationHook} returns. Use {@link ENTITY_ACTION} rather than the bare strings, so a typo is a type error instead of an
 * entity that is accepted by default.
 */
export type EntityHookAction = 'allow' | 'block' | 'throw';

/**
 * @description A function-valued entity replacement: the `val` of the legacy `{ regex, val }` form when it is not a string. This decoder cannot use one — a
 * function has no meaning without the regex it was meant to be matched against — so such an entry is dropped at registration rather than expanded.
 */
export type EntityValFn = (match: string, captured: string, ...rest: Array<unknown>) => string;

/**
 * @description Called once per entity _at registration time_, never during {@link EntityDecoder.decode}. Receives the name without `&` and `;` and the resolved
 * string value, after any `{ regex, val }` envelope has been unwrapped.
 *
 * @param name - The entity name, e.g. `brand`.
 * @param value - The string the entity expands to.
 *
 * @returns The action to take. Anything other than `block` and `throw` is treated as `allow`, so an unrecognised return value never rejects an entity
 *   by accident.
 */
export type EntityRegistrationHook = (name: string, value: string) => EntityHookAction;

/**
 * @description The three actions a registration hook can return, as a frozen object. Prefer it over the bare strings: the literals stay narrow string-literal
 * types, so `ENTITY_ACTION.BLOK` fails to compile instead of silently registering the entity.
 *
 * @example
 *   ```typescript
 *   const decoder = new EntityDecoder({
 *     onInputEntity: () => ENTITY_ACTION.BLOCK,
 *   });
 *   ```;
 */
export const ENTITY_ACTION: Readonly<{ ALLOW: 'allow'; BLOCK: 'block'; THROW: 'throw' }> = Object.freeze({
  ALLOW: 'allow',
  BLOCK: 'block',
  THROW: 'throw',
} as const);

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/**
 * @description Which entity categories count toward the expansion limits.
 *
 * - `'external'` — only input/runtime + persistent external entities. The default, and the only one that ignores the built-in XML entities.
 * - `'base'` — only the built-in XML entities, the caller's `namedEntities`, and numeric references.
 * - `'all'` — every entity regardless of tier.
 * - `Array<'external' | 'base'>` — an explicit combination. An empty array is honoured literally: nothing counts, so the limits can never trip.
 */
export type ApplyLimitsTo = 'external' | 'base' | 'all' | Array<'external' | 'base'>;

/**
 * @description Ceilings on what a single document's entity references may cost. Both are cumulative across {@link EntityDecoder.decode} calls until
 * {@link EntityDecoder.reset}, and both default to `0`, meaning unlimited. `0` — and any negative or non-numeric value — is unlimited, because the
 * runtime tests `> 0` rather than truthiness of the configured number.
 */
export interface EntityDecoderLimitOptions {
  /**
   * @description Maximum number of tracked entity references expanded per document. The check is `> maxTotalExpansions`, so a limit of `2` allows two expansions
   * and throws on the third.
   *
   * @default 0
   */
  maxTotalExpansions?: number;

  /**
   * @description Maximum number of characters _added_ by expansion per document. Only the surplus counts: a reference whose replacement is no longer than the
   * `&token;` it replaces contributes zero, and a shrinking one contributes nothing and cannot trip the limit.
   *
   * @default 0
   */
  maxExpandedLength?: number;

  /**
   * @description Which tiers count against both limits. Defaults to `'external'`, which is what keeps the built-in entities — including every numeric reference —
   * from being able to trip a limit on a document the caller already trusts.
   *
   * @default 'external'
   */
  applyLimitsTo?: ApplyLimitsTo;
}

/**
 * @description Policy for numeric character references. The three fields are flattened into numeric levels at construction so the decode loop never re-reads the
 * object.
 */
export interface EntityDecoderNCROptions {
  /**
   * @description The XML version whose codepoint restrictions apply. `1.0` prohibits the C0 controls U+0001–U+001F other than tab, newline and carriage return;
   * `1.1` does not, since it permits them when written as references. Any value other than `1.1` is read as `1.0`.
   *
   * @default 1.0
   */
  xmlVersion?: 1.0 | 1.1;

  /**
   * @description The base action for every numeric reference. Codepoint ranges that carry a minimum — surrogates always, the XML 1.0 C0 controls under `1.0`, and
   * null under `nullNCR` — take the stricter of the two, so this is a floor and not an override.
   *
   * @default 'allow'
   */
  onNCR?: 'allow' | 'leave' | 'remove' | 'throw';

  /**
   * @description The action for U+0000. `'allow'` and `'leave'` are clamped up to `'remove'`, so a null reference is always at least deleted.
   *
   * @default 'remove'
   */
  nullNCR?: 'remove' | 'throw';
}

/**
 * @description Construction options for {@link EntityDecoder}. Every field is optional, and the defaults are the permissive ones.
 */
export interface EntityDecoderOptions {
  /**
   * @description Extra named entities merged into the `base` map alongside the five XML predefined ones. A string value is used directly; a `{ regex, val }` or `{
   * regx, val }` envelope is unwrapped to its `val`. Anything else — a number, `null`, a function, an envelope whose `val` is a function — is
   * dropped, leaving the name unresolvable rather than failing the construction. Upstream's documentation says a value containing `&` is skipped
   * here, to prevent recursive expansion. It is not: the code stores the value unchanged, and only {@link EntityDecoder.addExternalEntity} checks for
   * `&`. Preserved as-is; see the note on the class.
   *
   * @default null
   */
  namedEntities?: Record<string, string | { regex: RegExp; val: string | EntityValFn }> | null;

  /**
   * @description Called once on the finished string. Receives `(resolved, original)` and must return a string; return `original` to reject the expansion outright,
   * or a sanitised form of `resolved` to clean it. It is _not_ called for a string that never reaches the scanning loop — an empty string, a
   * non-string, or any string with no `&` in it. A caller relying on `postCheck` to sanitise therefore has to know that a string with no ampersand is
   * never inspected.
   *
   * @default null
   */
  postCheck?: ((resolved: string, original: string) => string) | null;

  /**
   * @description Whether numeric references expand at all. Turning it off leaves every one of them in the output verbatim — _except_ the codepoints that carry a
   * minimum action of `remove` or stricter, which are still handled, because that classification runs first and is what makes the option safe to rely
   * on.
   *
   * @default true
   */
  numericAllowed?: boolean;

  /**
   * @description Names to keep as literal `&name;` text, matched against the token with no `&` or `;`. Numeric references are matched as `#38` or `#x26`.
   *
   * @default [ ]
   */
  leave?: Array<string>;

  /**
   * @description Names to delete outright, matched the same way as {@link EntityDecoderOptions.leave}. A removed reference is charged to the `external` tier even
   * when the name is a built-in one, so a document full of removed built-ins can trip an `applyLimitsTo: 'external'` limit it would not otherwise be
   * subject to. Preserved as-is; the only in-code comment claims the charge is for unknown references, which is not what distinguishes them.
   *
   * @default [ ]
   */
  remove?: Array<string>;

  /**
   * @description Ceilings on expansion count and expanded length. See {@link EntityDecoderLimitOptions}.
   */
  limit?: EntityDecoderLimitOptions;

  /**
   * @description Policy for numeric references. See {@link EntityDecoderNCROptions}.
   */
  ncr?: EntityDecoderNCROptions;

  /**
   * @description Called once per entity as it is registered through {@link EntityDecoder.setExternalEntities} or {@link EntityDecoder.addExternalEntity}. `block`
   * skips the entity, `throw` aborts the whole registration, anything else registers it. With {@link EntityDecoder.setExternalEntities} a `throw`
   * leaves the previous external map in place, because the replacement is only assigned once every entry has passed.
   *
   * @default null
   */
  onExternalEntity?: EntityRegistrationHook | null;

  /**
   * @description Called once per entity as it is registered through {@link EntityDecoder.addInputEntities}. Same contract as
   * {@link EntityDecoderOptions.onExternalEntity}, and unlike it the hook is not the only filter — see the class note on name validation.
   *
   * @default null
   */
  onInputEntity?: EntityRegistrationHook | null;
}

// ---------------------------------------------------------------------------
// Internal types
//
// Looser than the exported option types on purpose. The runtime inspects whatever it is handed, and an entry it
// cannot read is dropped rather than rejected, so the helpers have to be able to describe an entry the public
// types claim cannot exist.
// ---------------------------------------------------------------------------

/**
 * @description The value side of a registration map as the merge helper reads it: a ready string, or a `{ regex | regx, val }` envelope whose `val` may itself be
 * absent, a string, or a function.
 */
type EntityInputValue =
  | string
  | { readonly regex?: RegExp | undefined; readonly regx?: RegExp | undefined; readonly val?: string | EntityValFn | undefined };

/**
 * @description One registration map, or nothing. `null` and `undefined` both mean "no entities here", which is how `setExternalEntities(null)` clears the map and
 * how the constructor declines to pass `namedEntities`.
 */
type EntityInputMap = Readonly<Record<string, EntityInputValue>> | null | undefined;

/**
 * @description What one reference expanded to, tagged with the tier its limit accounting charges. The field is the replacement text itself for a named entity, the
 * character for a numeric reference, and `''` for a removed one — the three shapes the walk pushes into its output.
 */
type ResolvedEntity = { value: string; tier: LimitTier };

/**
 * @description A registration context, as it appears in the error a rejecting hook produces.
 */
type HookContext = 'external' | 'input';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @description Reject an entity name that could never be written as a reference. `#` is refused positionally rather than by the character sweep, because a name
 * starting with `#` is a numeric reference's token and would collide with `#resolveNCR`. Everything else is refused per character.
 *
 * @param name - The name to check.
 *
 * @returns An effect producing the name, unchanged, so the call can be inlined. Fails with {@link XmlError} and the `InvalidEntityName` reason,
 *   carrying the offending character. The `[EntityReplacer]` prefix in the message is preserved verbatim from the original throw, despite naming a
 *   class this decoder does not have — it is load-bearing for anything matching on it.
 */
const checkEntityName = (name: string): Effect.Effect<string, XmlError> => {
  if (name.charCodeAt(0) === CODE_HASH) {
    return Effect.fail(
      new XmlError({
        reason: { _tag: 'InvalidEntityName', name, character: '#' },
        message: `[EntityReplacer] Invalid character '#' in entity name: "${name}"`,
      })
    );
  }
  for (const ch of name) {
    if (SPECIAL_CHARS.has(ch)) {
      return Effect.fail(
        new XmlError({
          reason: { _tag: 'InvalidEntityName', name, character: ch },
          message: `[EntityReplacer] Invalid character '${ch}' in entity name: "${name}"`,
        })
      );
    }
  }
  return Effect.succeed(name);
};

/**
 * @description Flatten registration maps into one name to string map, later maps winning over earlier ones for the same name. The result is a null-prototype
 * object, not a `Map`. That is not incidental: a `Map` iterates in pure insertion order, while `Object.keys` lifts array-index-like names to the
 * front in numeric order, and the registration hooks observe that order. A name of `"2"` registered after `"brand"` reaches the hook first here and
 * second in a `Map`.
 *
 * @param maps - The maps to merge. A falsy entry — `null`, `undefined`, `''`, `0` — contributes nothing rather than throwing.
 *
 * @returns A null-prototype object of own string-valued entries. Nothing from `Object.prototype` can be read out of it, so a document naming
 *   `constructor` or `toString` finds nothing. Each entry is read through {@link flattenEntityValue}, so an entry that cannot be reduced to a string
 *   is absent rather than present-and-unusable.
 */
function mergeEntityMaps(...maps: ReadonlyArray<EntityInputMap>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const map of maps) {
    if (!map) continue;
    for (const key of Object.keys(map)) {
      const value = flattenEntityValue(map[key]);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

/**
 * @description Reduce one registration entry to the string a reference to it expands to, or to nothing when the entry is a form the scanner has no use for. Three
 * shapes survive: the string itself, and a `{ regex | regx, val }` envelope whose `val` is a string. Everything else — a number, `null`, `undefined`,
 * a bare function, an envelope whose `val` is a function — has no string to substitute, so the name is dropped and a reference to it comes back out
 * as the text it was written as. Dropping is silent on purpose: the runtime inspects whatever it is handed, and failing the construction over one
 * unreadable entry would take every other entity in the table down with it.
 *
 * @param raw - The entry as it arrived, in whatever shape the caller supplied it — including no entry at all, which a table with a hole in it
 *   produces.
 *
 * @returns The replacement string, or `undefined` when the entry cannot be read. A name registered to the empty string yields `''`, which is why
 *   callers compare against `undefined` rather than testing for emptiness.
 */
function flattenEntityValue(raw: EntityInputValue | undefined): string | undefined {
  if (Predicate.isString(raw)) return raw;

  // The `raw &&` in upstream is a null check: every object is truthy, so it only ever rejects
  // `null` and `undefined` here, and the object check then rejects a bare function value.
  if (Predicate.isNullish(raw) || !Predicate.isObject(raw) || raw.val === undefined) return undefined;

  const val = raw.val;
  // A function `val` has no scanner equivalent and is dropped, upstream included.
  return Predicate.isString(val) ? val : undefined;
}

/**
 * @description Read one own entry out of a null-prototype entity map.
 *
 * @param map - The map to read.
 * @param key - The entity name.
 *
 * @returns The registered string, or `undefined` when the name is not an own key. A name registered to the empty string returns `''`, which is why
 *   callers must compare against `undefined` rather than test for emptiness.
 */
function ownEntity(map: Readonly<Record<string, string>>, key: string): string | undefined {
  // Upstream tests `name in map`, which reads as "is this name present at all". `Object.hasOwn` is
  // the same question asked explicitly, and it is the honest shape for the answer: an absent key
  // yields `undefined` and a present one yields the stored string, so the `string | undefined` this
  // returns is the real type rather than something an assertion has to paper over. The two maps are
  // null-prototype objects, so `in` and `hasOwn` cannot disagree here.
  if (!Object.hasOwn(map, key)) return undefined;
  return map[key];
}

/**
 * @description Normalise the `applyLimitsTo` option into the set of tiers that count against the limits.
 *
 * @param raw - The configured value.
 *
 * @returns The tier set. An unrecognised string falls back to `external` rather than to no filtering at all, so a typo cannot silently disable the
 *   limits. An array is taken as given, which is why an empty array disables limit accounting entirely while an empty string falls back to
 *   `external`.
 */
function parseLimitTiers(raw: ApplyLimitsTo | undefined): ReadonlySet<LimitTier> {
  if (!raw || raw === LIMIT_TIER_EXTERNAL) return new Set([LIMIT_TIER_EXTERNAL]);
  if (raw === LIMIT_TIER_ALL) return new Set([LIMIT_TIER_ALL]);
  if (raw === LIMIT_TIER_BASE) return new Set([LIMIT_TIER_BASE]);
  if (Array.isArray(raw)) return new Set(raw);
  return new Set([LIMIT_TIER_EXTERNAL]);
}

/**
 * @description Read one level out of {@link NCR_LEVEL} by name.
 *
 * @param name - The configured action name, or nothing.
 * @param fallback - The level to use when the name is absent.
 *
 * @returns The level. A name the table does not carry also yields `fallback`, so a value outside the union degrades to the default action rather than
 *   to `NaN`.
 */
function ncrLevelOf(name: NcrLevelName | undefined, fallback: number): number {
  if (name === undefined) return fallback;
  return NCR_LEVEL[name] ?? fallback;
}

/**
 * @description Flatten the `ncr` option into the three numeric fields the decode loop reads, so nothing has to be re-derived per reference.
 *
 * @param ncr - The configured policy, or nothing.
 *
 * @returns The XML version, the base action level, and the null action level already clamped up to `remove`.
 */
function parseNCRConfig(ncr: EntityDecoderNCROptions | undefined): { xmlVersion: XmlVersion; onLevel: number; nullLevel: number } {
  if (!ncr) {
    return { xmlVersion: 1.0, onLevel: NCR_LEVEL.allow, nullLevel: NCR_LEVEL.remove };
  }
  const xmlVersion: XmlVersion = ncr.xmlVersion === 1.1 ? 1.1 : 1.0;
  const onLevel = ncrLevelOf(ncr.onNCR, NCR_LEVEL.allow);
  // Null is never safe to emit, so anything weaker than `remove` is raised to it before it is stored.
  const nullLevel = Math.max(ncrLevelOf(ncr.nullNCR, NCR_LEVEL.remove), NCR_LEVEL.remove);
  return { xmlVersion, onLevel, nullLevel };
}

/**
 * @description Resolve {@link EntityDecoderOptions.postCheck} to something the decode loop can call unconditionally, or to the identity function. The fallback
 * exists so the path that actually scanned does not have to test for the option, while the two fast paths that return before the scan still skip the
 * call entirely. A non-function value is treated as an absent option rather than rejected, matching the hook rules: a mistyped option disables its
 * feature instead of failing the construction.
 *
 * @param raw - The configured hook, or nothing.
 *
 * @returns The hook itself, or a function returning its first argument.
 */
function readPostCheck(raw: EntityDecoderOptions['postCheck']): (resolved: string, original: string) => string {
  if (Predicate.isFunction(raw)) return raw;
  return r => r;
}

/**
 * @description Resolve a registration hook option to something safe to call, under the same non-function rule as {@link readPostCheck}.
 *
 * @param raw - The configured hook, or nothing.
 *
 * @returns The hook itself, or `null` for an absent option and for a value that is not a function. `null` is what lets every registration path ask
 *   unconditionally: a hook that is not there accepts.
 */
function readHook(raw: EntityRegistrationHook | null | undefined): EntityRegistrationHook | null {
  if (Predicate.isFunction(raw)) return raw;
  return null;
}

/**
 * @description Read one of the two entity-name lists as a set, under the same missing-value rule as the other options: absent is empty, not an error. The
 * `Array.isArray` test rather than a truthiness one is what keeps a mistyped list from reaching `new Set` and throwing there, so a caller's typo
 * disables the list instead of taking the decoder down. Matching against a set is also why a name in both lists is decided by the order
 * {@link EntityDecoder.decode} consults them in, not by the order the caller wrote them in.
 *
 * @param raw - The configured list, or nothing.
 *
 * @returns The names as a set, empty when the option is absent or is not an array.
 */
function readNameList(raw: Array<string> | undefined): ReadonlySet<string> {
  if (Array.isArray(raw)) return new Set(raw);
  return new Set();
}

/**
 * @description Scan forward from a `&` for the `;` that would close the reference it opens, giving up once more than {@link MAX_TOKEN_LENGTH} characters have
 * passed since the `&`.
 *
 * @param str - The string being scanned.
 * @param ampersand - The index of the `&`.
 *
 * @returns The index of the closing `;`, or `-1` when the run holds none inside the window. A `;` one character past the `&` is returned rather than
 *   refused: that is the empty token `&;`, and the caller decides it is not a reference.
 */
function scanTokenEnd(str: string, ampersand: number): number {
  const len = str.length;
  let j = ampersand + 1;
  while (j < len && str.charCodeAt(j) !== CODE_SEMICOLON && j - ampersand <= MAX_TOKEN_LENGTH) j++;
  if (j >= len || str.charCodeAt(j) !== CODE_SEMICOLON) return -1;
  return j;
}

/**
 * @description Single-pass, zero-regex entity decoder for XML and HTML content.
 *
 * ### Entity lookup priority
 *
 * 1. **input / runtime** — injected per document through {@link EntityDecoder.addInputEntities}
 * 2. **persistent external** — set through {@link EntityDecoder.setExternalEntities} and {@link EntityDecoder.addExternalEntity}, surviving
 *    {@link EntityDecoder.reset}
 * 3. **base** — the five XML predefined entities plus the constructor's `namedEntities` Both input and external resolve as the `external` tier for limit
 *    purposes, because both are injected at runtime. Numeric references (`&#NNN;`, `&#xHH;`) resolve directly through `String.fromCodePoint` and are
 *    always `base` tier: they cannot recurse, so a limit that counted them would only punish a document that spells its characters out.
 *
 * ### Upstream behaviour preserved
 *
 * Several quirks of the original are kept deliberately, because a consumer's output already depends on them:
 *
 * - A value containing `&` is **not** filtered from `namedEntities` or `setExternalEntities`, contrary to the documentation. Only
 *   {@link EntityDecoder.addExternalEntity} checks, and it drops the entry rather than storing it, so the same name registered either way can resolve
 *   to nothing.
 * - {@link EntityDecoderOptions.postCheck} is skipped entirely for input that never reaches the scan — an empty string, a non-string, or a string with
 *   no `&`.
 * - {@link EntityDecoder.decode} returns a non-string argument unchanged, despite being typed `string`.
 * - The expansion-limit errors are prefixed `EntityReplacer`, not `EntityDecoder`.
 * - Nothing in XML 1.0 §2.2 is enforced for U+007F–U+009F or for the U+FFFE/U+FFFF noncharacters, and the sweep for `&` leaves a name of
 *   {@link MAX_TOKEN_LENGTH} + 1 characters unresolvable.
 * - Numeric references are parsed with `parseInt`, so a leading space, sign, or trailing garbage is accepted: `&# 41;`, `&#x+41;` and `&#41zz;` all
 *   decode, and `&#0x41;` parses as a null reference rather than `A`.
 * - {@link EntityDecoder.addInputEntities} validates no names, so a `#`-prefixed or `&`-bearing name registers without complaint, where the two
 *   external setters would throw.
 *
 * @example
 *   ```typescript
 *   const decoder = new EntityDecoder({ namedEntities: { copy: '©' } });
 *   decoder.setExternalEntities({ brand: 'Acme' });
 *   decoder.addInputEntities({ version: '1.0' });
 *
 *   decoder.decode('&brand; v&version; &copy;'); // 'Acme v1.0 ©'
 *   decoder.decode('&#x26;#38;');               // '&&' — one pass, the output is never re-scanned
 *
 *   decoder.reset(); // drops the input entities and the counters, keeps the external ones
 *   ```;
 */
export class EntityDecoder {
  /**
   * @description {@link EntityDecoderLimitOptions.maxTotalExpansions}, or `0` for unlimited. A negative number or `NaN` is also unlimited, since the decode loop
   * tests `> 0`.
   */
  readonly #maxTotalExpansions: number;

  /**
   * @description {@link EntityDecoderLimitOptions.maxExpandedLength}, or `0` for unlimited, read the same way as `#maxTotalExpansions`.
   */
  readonly #maxExpandedLength: number;

  /**
   * @description {@link EntityDecoderOptions.postCheck}, or the identity function — so the decode loop can call it unconditionally on the path that actually
   * scanned, and never on the two fast paths that return early.
   */
  readonly #postCheck: (resolved: string, original: string) => string;

  /**
   * @description The resolved tier filter. See {@link parseLimitTiers}.
   */
  readonly #limitTiers: ReadonlySet<LimitTier>;

  /**
   * @description {@link EntityDecoderOptions.numericAllowed}. Only an explicit `false` turns it off, so an absent option cannot disable it.
   */
  readonly #numericAllowed: boolean;

  /**
   * @description The five XML predefined entities plus `namedEntities`, merged once at construction and never written again. The built-ins lose to a
   * `namedEntities` entry of the same name, since it is merged second.
   */
  readonly #baseMap: Record<string, string>;

  /**
   * @description Persistent external entities, as a null-prototype object. Replaced wholesale by {@link EntityDecoder.setExternalEntities} and added to by
   * {@link EntityDecoder.addExternalEntity}, and never touched by {@link EntityDecoder.reset} — that is the whole distinction from the input map.
   */
  #externalMap: Record<string, string>;

  /**
   * @description DOCTYPE entities for the document being processed, as a null-prototype object. Wiped by both {@link EntityDecoder.reset} and
   * {@link EntityDecoder.addInputEntities}.
   */
  #inputMap: Record<string, string>;

  /**
   * @description Tracked expansions since the last reset. Cumulative across {@link EntityDecoder.decode} calls, which is what makes a limit a per-document budget
   * rather than a per-call one. Deliberately not reset by a thrown limit error, so the over-limit count is what the error message reports.
   */
  #totalExpansions: number;

  /**
   * @description Characters _added_ by expansion since the last reset, accumulated the same way as `#totalExpansions`. Only positive contributions are counted.
   */
  #expandedLength: number;

  /**
   * @description {@link EntityDecoderOptions.remove} as a set, or empty. Checked before every other classification, so a name in here is deleted without the name
   * ever being resolved.
   */
  readonly #removeSet: ReadonlySet<string>;

  /**
   * @description {@link EntityDecoderOptions.leave} as a set, or empty. Checked after `remove` and before the numeric test, so a name in here is emitted as the
   * original `&name;` text.
   */
  readonly #leaveSet: ReadonlySet<string>;

  /**
   * @description The XML version governing numeric classification. Mutable, because a `<?xml version?>` declaration is normally only known after the decoder
   * exists; see {@link EntityDecoder.setXmlVersion}.
   */
  #ncrXmlVersion: XmlVersion;

  /**
   * @description {@link EntityDecoderNCROptions.onNCR} as a level from {@link NCR_LEVEL}. A floor, not an override: the resolver takes the maximum of this and
   * whatever minimum a codepoint range imposes.
   */
  readonly #ncrOnLevel: number;

  /**
   * @description {@link EntityDecoderNCROptions.nullNCR} as a level from {@link NCR_LEVEL}, already clamped to `remove` or stricter.
   */
  readonly #ncrNullLevel: number;

  /**
   * @description {@link EntityDecoderOptions.onExternalEntity}, or `null` when absent or not a function. A non-function is dropped rather than rejected, so a
   * mistyped option disables the hook instead of failing the construction.
   */
  readonly #onExternalEntity: EntityRegistrationHook | null;

  /**
   * @description {@link EntityDecoderOptions.onInputEntity}, or `null`, under the same non-function rule as `#onExternalEntity`.
   */
  readonly #onInputEntity: EntityRegistrationHook | null;

  /**
   * @description Create a decoder. A factory rather than a constructor, because it refuses a `null` options object. Every field is optional, so `null` is not "a
   * decoder with the defaults" — a caller who wrote it meant something the signature does not allow, and a decoder built from it would be
   * indistinguishable from one built from `{}` while hiding the mistake. Saying so is worth a factory; `EntityDecoderOptions` is a plain object and
   * nothing else about construction can fail.
   *
   * @example
   *   ```typescript
   *   const decoder = yield* EntityDecoder.make({ numericAllowed: false });
   *   yield* decoder.decode('caf&eacute;'); // 'café'
   *   ```;
   *
   * @param options - Configuration. See {@link EntityDecoderOptions}. Defaults to every field's own default.
   *
   * @returns An effect producing the decoder. Fails with {@link XmlError} and the `MissingOptions` reason for a `null`.
   */
  static make = (options: EntityDecoderOptions = {}): Effect.Effect<EntityDecoder, XmlError> =>
    Predicate.isNullish(options)
      ? Effect.fail(
          new XmlError({
            reason: { _tag: 'MissingOptions', parameter: 'options' },
            message: 'EntityDecoder.make: options is required. Use make({}) for a decoder with every default.',
          })
        )
      : Effect.succeed(new EntityDecoder(options));

  /**
   * @description Create a decoder. Every option is resolved here into the flat fields the decode loop reads, so nothing per-reference has to re-derive it. The
   * options whose wrong type disables them rather than failing the construction — the two hooks, the two name lists — are read through
   * {@link readHook} and {@link readNameList}, so that rule is written once instead of four times.
   *
   * @param resolved - Configuration, already checked. See {@link EntityDecoderOptions}.
   */
  private constructor(resolved: EntityDecoderOptions) {
    // `options.limit` is read first, deliberately: it is the first property the original touched, so
    // the property a `null` would have faulted on, and keeping that order means the reason still
    // names it. The option stays a local — every value the decode loop needs is flattened out of it
    // below, so retaining it on the instance would only be a way to observe the option back.
    const limit = resolved.limit ?? {};
    this.#maxTotalExpansions = limit.maxTotalExpansions || 0;
    this.#maxExpandedLength = limit.maxExpandedLength || 0;
    this.#postCheck = readPostCheck(resolved.postCheck);
    this.#limitTiers = parseLimitTiers(limit.applyLimitsTo ?? LIMIT_TIER_EXTERNAL);
    this.#numericAllowed = resolved.numericAllowed ?? true;
    this.#baseMap = mergeEntityMaps(DEFAULT_XML_ENTITIES, resolved.namedEntities || null);

    this.#externalMap = Object.create(null);
    this.#inputMap = Object.create(null);
    this.#totalExpansions = 0;
    this.#expandedLength = 0;

    this.#removeSet = readNameList(resolved.remove);
    this.#leaveSet = readNameList(resolved.leave);

    const ncrConfig = parseNCRConfig(resolved.ncr);
    this.#ncrXmlVersion = ncrConfig.xmlVersion;
    this.#ncrOnLevel = ncrConfig.onLevel;
    this.#ncrNullLevel = ncrConfig.nullLevel;

    this.#onExternalEntity = readHook(resolved.onExternalEntity);
    this.#onInputEntity = readHook(resolved.onInputEntity);
  }

  /**
   * @description Ask a registration hook about one name and value.
   *
   * @param hook - The hook, or `null`. A `null` hook accepts, which is what lets {@link EntityDecoder.addExternalEntity} call this unconditionally.
   * @param name - The entity name, without `&` or `;`.
   * @param value - The resolved value, after any `{ regex, val }` envelope was unwrapped.
   * @param context - Which registration is in progress, for the error message.
   *
   * @returns An effect producing `true` to register, `false` to skip silently. Fails with {@link XmlError} and the `EntityRejected` reason when the
   *   hook returns `throw`. The message quotes the entity, so it is the only record left that a document was rejected.
   */
  #applyRegistrationHook(hook: EntityRegistrationHook | null, name: string, value: string, context: HookContext): Effect.Effect<boolean, XmlError> {
    if (!hook) return Effect.succeed(true); // no hook to ask
    const action = hook(name, value);
    if (action === ENTITY_ACTION.BLOCK) return Effect.succeed(false);
    if (action === ENTITY_ACTION.THROW) {
      return Effect.fail(
        new XmlError({
          reason: { _tag: 'EntityRejected', context, name },
          message: `[EntityDecoder] Registration of ${context} entity "&${name};" was rejected by hook`,
        })
      );
    }
    return Effect.succeed(true); // ALLOW, and anything unrecognised, accepts
  }

  /**
   * @description Replace the whole set of persistent external entities. Every key is validated _before_ any value is read, so an invalid name fails even when its
   * value is a form the merge would have dropped. A non-object or `null` map clears the set without validating anything.
   *
   * @param map - The entities to register, or nothing to clear.
   *
   * @returns An effect that registers the map. Fails with {@link XmlError} when a key contains a character from {@link SPECIAL_CHARS} or begins with
   *   `#` (`InvalidEntityName`), or when {@link EntityDecoderOptions.onExternalEntity} returns `throw` (`EntityRejected`). A rejection from the hook
   *   aborts before the assignment, so the previous map survives.
   */
  setExternalEntities = Effect.fnUntraced(function* (
    this: EntityDecoder,
    map: Record<string, string | { regex: RegExp; val: string | EntityValFn }>
  ): Effect.fn.Return<void, XmlError> {
    if (map) {
      for (const key of Object.keys(map)) {
        yield* checkEntityName(key);
      }
    }
    if (!this.#onExternalEntity) {
      this.#externalMap = mergeEntityMaps(map);
      return;
    }
    // With a hook, values are flattened first and the hook sees what will actually be stored.
    const flat = mergeEntityMaps(map);
    const filtered: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(flat)) {
      if (yield* this.#applyRegistrationHook(this.#onExternalEntity, name, value, 'external')) {
        filtered[name] = value;
      }
    }
    this.#externalMap = filtered;
  });

  /**
   * @description Add one persistent external entity, keeping whatever is already registered. This is the only registration path that refuses a value containing
   * `&`; the two map setters store one unchanged. The omission is upstream's, and it is kept: the same name registered through either route can end
   * up resolving, or not resolving at all.
   *
   * @param key - The entity name, without `&` or `;`.
   * @param value - The replacement text.
   *
   * @returns An effect that adds the entity. Fails with {@link XmlError} and the `InvalidEntityName` reason when `key` contains a character from
   *   {@link SPECIAL_CHARS} or begins with `#`, or with the `EntityRejected` reason when {@link EntityDecoderOptions.onExternalEntity} returns
   *   `throw`.
   */
  addExternalEntity = Effect.fnUntraced(function* (this: EntityDecoder, key: string, value: string): Effect.fn.Return<void, XmlError> {
    yield* checkEntityName(key);
    // The two guards are unreachable from typed code — `value` is a `string` — and are kept for
    // untyped callers, which is the only way to reach them.
    if (Predicate.isString(value) && value.indexOf('&') === -1) {
      if (yield* this.#applyRegistrationHook(this.#onExternalEntity, key, value, 'external')) {
        this.#externalMap[key] = value;
      }
    }
  });

  /**
   * @description Register the DOCTYPE entities for the document about to be decoded, replacing any previous set and clearing both counters. Unlike the external
   * setters, no name is validated: a `#`-prefixed name, or one containing `&` or `<`, registers without complaint. A `#`-prefixed name is then
   * unreachable, since `decode` routes `#`-prefixed tokens to the numeric pipeline first.
   *
   * @param map - The entities to register, or nothing to clear.
   *
   * @returns An effect that registers the map. Fails with {@link XmlError} and the `EntityRejected` reason when
   *   {@link EntityDecoderOptions.onInputEntity} returns `throw`. The counters have already been cleared by then.
   */
  addInputEntities = Effect.fnUntraced(function* (
    this: EntityDecoder,
    map: Record<string, string | { regx: RegExp; val: string | EntityValFn } | { regex: RegExp; val: string | EntityValFn }>
  ): Effect.fn.Return<void, XmlError> {
    // Cleared first and unconditionally, so registering entities is itself the start of a new
    // document's budget — including when the call goes on to fail.
    this.#totalExpansions = 0;
    this.#expandedLength = 0;
    if (!this.#onInputEntity) {
      this.#inputMap = mergeEntityMaps(map);
      return;
    }
    const flat = mergeEntityMaps(map);
    const filtered: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(flat)) {
      if (yield* this.#applyRegistrationHook(this.#onInputEntity, name, value, 'input')) {
        filtered[name] = value;
      }
    }
    this.#inputMap = filtered;
  });

  /**
   * @description Start a new document: drop the input entities and both counters. The persistent external entities, the base map, the limits, the NCR policy and
   * the XML version all survive, which is the difference between this and constructing a fresh decoder.
   *
   * @returns This decoder, so a call can be chained onto the document it ends.
   */
  reset(): this {
    this.#inputMap = Object.create(null);
    this.#totalExpansions = 0;
    this.#expandedLength = 0;
    return this;
  }

  /**
   * @description Set the XML version used to classify numeric references, once a `<?xml version="…"?>` declaration has been read. Only the exact number `1.1`
   * selects XML 1.1; `1.0`, `1.15`, `'1.1'` and `NaN` all become `1.0`, so the stricter classification is the default rather than the looser one.
   *
   * @param version - The declared version.
   *
   * @returns Nothing.
   */
  setXmlVersion(version: number): void {
    this.#ncrXmlVersion = version === 1.1 ? 1.1 : 1.0;
  }

  /**
   * @description Expand every entity reference in a string, in one pass. The output is never re-scanned, so no expansion can produce a _second_ one: a registered
   * value that itself contains reference text reaches the caller as that literal text, unexpanded. What the limits bound is the growth of this single
   * pass — how much one round of expansion can add. Three inputs return before the scan and therefore never reach
   * {@link EntityDecoderOptions.postCheck}: a non-string, the empty string, and any string with no `&` in it. The scan itself is `#expandAll`; what
   * this method adds is the three inputs that skip it and the single join of what it collected.
   *
   * @example
   *   ```typescript
   *   import { Effect } from 'effect';
   *   import { EntityDecoder } from '@endevops/effect-xml-codec';
   *
   *   const decoder = new EntityDecoder({ namedEntities: { copy: '©' } });
   *   Effect.runSync(Effect.orElseSucceed(decoder.addExternalEntity('brand', 'Acme'), () => undefined));
   *   Effect.runSync(decoder.decode('&brand; &copy;')); // 'Acme ©'
   *   ```;
   *
   * @param str - The string to decode.
   *
   * @returns An effect producing the decoded string. A non-string argument comes back as the same non-string, which the `string` return type does not
   *   describe but callers passing untyped values depend on. Fails with {@link XmlError} when a numeric reference is prohibited under the configured
   *   policy (`ProhibitedCharacterReference`), or when a tracked tier would exceed {@link EntityDecoderLimitOptions.maxTotalExpansions}
   *   (`ExpansionLimitExceeded`) or {@link EntityDecoderLimitOptions.maxExpandedLength} (`ExpandedLengthLimitExceeded`). The two limit messages keep
   *   the `EntityReplacer` prefix from the original throw, which named a class this decoder does not have.
   */
  decode = Effect.fnUntraced(function* (this: EntityDecoder, str: string): Effect.fn.Return<string, XmlError> {
    if (!Predicate.isString(str) || str.length === 0) return str;
    if (str.indexOf('&') === -1) return str; // nothing here can be a reference

    const chunks = yield* this.#expandAll(str);

    // `chunks` is empty exactly when nothing was replaced, in which case the input is its own result.
    const result = chunks.length === 0 ? str : chunks.join('');

    return this.#postCheck(result, str);
  });

  /**
   * @description Walk the string once and collect the pieces of every reference that resolved. Two advance rules make the walk terminate and keep it correct: an
   * `&` that turns out to open nothing moves the cursor by one character rather than to the end of its run, so a second `&` in the same text is still
   * found; and a reference that did resolve moves it to just past the `;`, so the text that was substituted for it is never looked at again — that is
   * what makes the pass single, and a registered value containing `&` cannot expand a second level. What a reference becomes is `#resolveToken`'s to
   * decide and what it costs is `#chargeExpansion`'s to apply, which leaves the scanning here as the only thing with a rule of its own.
   *
   * @param str - The string to expand. It always holds at least one `&` and is never empty, or the caller would have returned before reaching the
   *   walk.
   *
   * @returns An effect producing the pieces in order. The array is empty exactly when nothing was replaced, which the caller reads as "the input is
   *   its own result". Fails with {@link XmlError} and the reason the offending reference carries — `ProhibitedCharacterReference`,
   *   `ExpansionLimitExceeded` or `ExpandedLengthLimitExceeded`.
   */
  #expandAll = Effect.fnUntraced(function* (this: EntityDecoder, str: string): Effect.fn.Return<Array<string>, XmlError> {
    const chunks: Array<string> = [];
    const len = str.length;
    let last = 0; // start of the next unprocessed literal run
    let i = 0;

    while (i < len) {
      if (str.charCodeAt(i) !== CODE_AMPERSAND) {
        i++;
        continue;
      }

      const end = scanTokenEnd(str, i);
      if (end <= i + 1) {
        // Nothing to resolve: no `;` inside the scan window, or an empty token (`&;`). A bare ampersand
        // rather than a reference, so advance past the `&` only and let the rest of the run be copied.
        i++;
        continue;
      }

      const token = str.slice(i + 1, end);
      const resolved = yield* this.#resolveToken(token);
      if (resolved === undefined) {
        // Left, unparseable or unknown: leave the text alone and resume scanning just after the `&`.
        i++;
        continue;
      }

      if (i > last) chunks.push(str.slice(last, i));
      chunks.push(resolved.value);
      last = end + 1;
      i = last;

      yield* this.#chargeExpansion(token, resolved.value, resolved.tier);
    }

    if (last < len) chunks.push(str.slice(last));

    return chunks;
  });

  /**
   * @description Decide what one reference expands to. The lists and maps are consulted in the one order the runtime uses, and the first that matches wins:
   *
   * 1. `remove` — deleted outright, without the name ever being resolved, so the name need not exist.
   * 2. `leave` — emitted as the original `&token;`, and charged to nothing.
   * 3. A `#`-prefixed token — the numeric pipeline, which is the only one of the four that can fail. Classification runs before any decision about
   *    `numericAllowed`, because the ranges that carry a minimum have to be caught whichever way that option is set.
   * 4. Anything else — resolved against the input map, then the external map, then the base map.
   *
   * @param token - The reference's token, e.g. `brand` or `#38`, with the `&` and the `;` already stripped. Never empty: the scanner drops `&;`
   *   before calling.
   *
   * @returns An effect producing what the reference expands to and the tier to charge it to, or `undefined` to leave it as written and charge it
   *   nothing. `undefined` covers all three ways of leaving a reference alone — a listed `leave` name, a numeric reference that is out of range, and
   *   a name registered nowhere — and none of them is distinguishable from outside. Fails with {@link XmlError} and the
   *   `ProhibitedCharacterReference` reason when the numeric policy throws on the codepoint.
   */
  #resolveToken = Effect.fnUntraced(function* (this: EntityDecoder, token: string): Effect.fn.Return<ResolvedEntity | undefined, XmlError> {
    if (this.#removeSet.has(token)) {
      // Deleted without being resolved, so the name need not exist. Upstream guards this charge with
      // `if (tier === undefined)`, and its `tier` is declared without an initialiser, so the branch is
      // unconditionally taken and the charge always lands on `external` — whatever tier the name would
      // have resolved in. That is why a document full of removed built-ins can trip an `external` limit
      // nothing it wrote could otherwise reach. Kept as written, since that is a behaviour a caller may
      // already be relying on.
      return { value: '', tier: LIMIT_TIER_EXTERNAL };
    }

    // Emitted as the original `&token;`. The walk advances only past the `&` and leaves the `;` to be
    // copied by the next literal run, which is what makes the text come back unchanged.
    if (this.#leaveSet.has(token)) return undefined;

    if (token.charCodeAt(0) === CODE_HASH) {
      const character = yield* this.#resolveNCR(token);
      // `''` for a removal and the character for an allow are both real replacements; `undefined` is the
      // numeric pipeline's own way of saying "leave it as written".
      if (character === undefined) return undefined;
      return { value: character, tier: LIMIT_TIER_BASE };
    }

    return this.#resolveName(token);
  });

  /**
   * @description Charge one expansion against the ceilings, or against neither. An expansion counts only when its tier passes `#tierCounts` and at least one
   * ceiling is configured, so a decoder with no limits set does no accounting at all, and an entity in a tier the filter excludes is free. Each
   * ceiling is guarded separately rather than left to its own check, because an unconfigured ceiling is not a ceiling of zero: `maxExpandedLength: 0`
   * means unlimited, so a decoder with only a count limit must not accumulate length it will then be compared against.
   *
   * @param token - The reference's token, with the `&` and `;` stripped. Its width is the baseline the expansion is measured against.
   * @param replacement - What the reference expanded to, including `''` for a removal.
   * @param tier - The tier the expansion is charged to.
   *
   * @returns An effect that fails with {@link XmlError} once a ceiling is exceeded, and succeeds otherwise. The count is checked before the length,
   *   so a document that breaches both is reported against the count.
   */
  #chargeExpansion = Effect.fnUntraced(function* (
    this: EntityDecoder,
    token: string,
    replacement: string,
    tier: LimitTier
  ): Effect.fn.Return<void, XmlError> {
    const counts = this.#maxTotalExpansions > 0;
    const grows = this.#maxExpandedLength > 0;
    if (!counts && !grows) return;
    if (!this.#tierCounts(tier)) return;

    if (counts) yield* this.#countExpansion();
    if (grows) yield* this.#countExpandedLength(token, replacement);
  });

  /**
   * @description Add one expansion to the running total and compare it against {@link EntityDecoderLimitOptions.maxTotalExpansions}. The comparison is `>` rather
   * than `>=`, so a limit of `n` allows exactly `n` expansions and throws on the `n + 1`th. That is a contract — the option's own documentation
   * states it — and the kind of off-by-one a tidy-up changes by accident. The counter is deliberately not reset before failing: the over-limit total
   * is what the error message reports, and {@link EntityDecoder.reset} is the caller's way to start a new document.
   *
   * @returns An effect that fails with {@link XmlError} and the `ExpansionLimitExceeded` reason once the count is past the ceiling, and succeeds
   *   otherwise. The `EntityReplacer` prefix in the message is preserved verbatim from the original throw, despite naming a class this decoder does
   *   not have.
   */
  #countExpansion(): Effect.Effect<void, XmlError> {
    this.#totalExpansions++;
    if (this.#totalExpansions > this.#maxTotalExpansions) {
      return Effect.fail(
        new XmlError({
          reason: { _tag: 'ExpansionLimitExceeded', actual: this.#totalExpansions, limit: this.#maxTotalExpansions },
          message: `[EntityReplacer] Entity expansion count limit exceeded: ${this.#totalExpansions} > ${this.#maxTotalExpansions}`,
        })
      );
    }
    return Effect.void;
  }

  /**
   * @description Add one expansion's surplus to the running total and compare it against {@link EntityDecoderLimitOptions.maxExpandedLength}. Only the surplus
   * counts, and only upward: a reference whose replacement is no longer than the `&token;` it replaces contributes zero, and a shrinking one
   * contributes nothing and cannot trip the limit at all. That is what makes the ceiling a bound on growth rather than on document size.
   *
   * @param token - The reference's token, with the `&` and `;` stripped. The two delimiters count towards what the expansion displaced.
   * @param replacement - What the reference expanded to, including `''` for a removal.
   *
   * @returns An effect that fails with {@link XmlError} and the `ExpandedLengthLimitExceeded` reason once the total is past the ceiling, and succeeds
   *   otherwise. The `EntityReplacer` prefix in the message is preserved verbatim from the original throw, for the same reason as in
   *   `#countExpansion`.
   */
  #countExpandedLength(token: string, replacement: string): Effect.Effect<void, XmlError> {
    const delta = replacement.length - (token.length + 2);
    if (delta <= 0) return Effect.void;

    this.#expandedLength += delta;
    if (this.#expandedLength > this.#maxExpandedLength) {
      return Effect.fail(
        new XmlError({
          reason: { _tag: 'ExpandedLengthLimitExceeded', actual: this.#expandedLength, limit: this.#maxExpandedLength },
          message: `[EntityReplacer] Expanded content length limit exceeded: ${this.#expandedLength} > ${this.#maxExpandedLength}`,
        })
      );
    }
    return Effect.void;
  }

  /**
   * @description Decide whether an entity of a given tier is charged against the limits.
   *
   * @param tier - The tier the replacement is charged to. Every expansion that reaches here carries one — a name deleted before it was ever resolved
   *   still carries the `external` tier — so there is no absent case to answer.
   *
   * @returns `true` when it counts. `'all'` short-circuits, so a filter naming every tier charges everything regardless of which map it came from.
   */
  #tierCounts(tier: LimitTier): boolean {
    if (this.#limitTiers.has(LIMIT_TIER_ALL)) return true;
    return this.#limitTiers.has(tier);
  }

  /**
   * @description Resolve a named entity token, with the `&` and `;` already stripped.
   *
   * @param name - The token, e.g. `brand`.
   *
   * @returns The value and the tier to charge it to, or `undefined` when the name is registered nowhere. A name registered to the empty string
   *   resolves to `''` rather than to `undefined`, so it deletes the reference instead of leaving it alone.
   */
  #resolveName(name: string): ResolvedEntity | undefined {
    // Input and external share the `external` tier: both are injected at runtime, and that is the
    // surface the limits exist to bound.
    const fromInput = ownEntity(this.#inputMap, name);
    if (fromInput !== undefined) return { value: fromInput, tier: LIMIT_TIER_EXTERNAL };

    const fromExternal = ownEntity(this.#externalMap, name);
    if (fromExternal !== undefined) return { value: fromExternal, tier: LIMIT_TIER_EXTERNAL };

    const fromBase = ownEntity(this.#baseMap, name);
    if (fromBase !== undefined) return { value: fromBase, tier: LIMIT_TIER_BASE };

    return undefined;
  }

  /**
   * @description Find the strictest action a codepoint's range requires. Checked in this order:
   *
   * 1. U+0000 — governed by `nullNCR`, already clamped to `remove` or stricter
   * 2. U+D800–U+DFFF — surrogates, always `remove`, under every policy and both XML versions
   * 3. U+0001–U+001F other than tab, newline, carriage return — XML 1.0 only, `remove` Nothing else is classified. U+007F–U+009F (C1) and the
   *    U+FFFE/U+FFFF noncharacters are not checked, even though XML 1.0 §2.2 prohibits them and the `xmlVersion` option's own documentation claims C1
   *    is only permitted under 1.1. Both gaps are upstream's and are kept.
   *
   * @param cp - The codepoint.
   *
   * @returns The minimum level from {@link NCR_LEVEL}, or {@link NO_MINIMUM_LEVEL} when the codepoint carries none.
   */
  #classifyNCR(cp: number): number {
    if (cp === 0) return this.#ncrNullLevel;

    if (cp >= 0xd800 && cp <= 0xdfff) return NCR_LEVEL.remove;

    if (this.#ncrXmlVersion === 1.0 && cp >= 0x01 && cp <= 0x1f && !XML10_ALLOWED_C0.has(cp)) {
      return NCR_LEVEL.remove;
    }

    return NO_MINIMUM_LEVEL;
  }

  /**
   * @description Turn a resolved action level into a replacement.
   *
   * @param action - A level from {@link NCR_LEVEL}. A level outside the four known ones falls through to the allow behaviour, so a bad level cannot
   *   produce a wrong string — it can only fail open.
   * @param token - The raw token, e.g. `#38`, for the error message.
   * @param cp - The codepoint, for the error message.
   *
   * @returns An effect producing the character for `allow`, `''` for `remove`, and `undefined` for `leave` — which the caller reads as "emit the
   *   original `&token;`". Fails with {@link XmlError} and the `ProhibitedCharacterReference` reason for `throw`, naming both the token and the
   *   codepoint.
   */
  #applyNCRAction(action: number, token: string, cp: number): Effect.Effect<string | undefined, XmlError> {
    return Match.value(action).pipe(
      Match.when(NCR_LEVEL.allow, () => Effect.succeed(String.fromCodePoint(cp))),
      Match.when(NCR_LEVEL.remove, () => Effect.succeed('')),
      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void
      Match.when(NCR_LEVEL.leave, () => Effect.succeed(undefined)),
      Match.when(NCR_LEVEL.throw, () =>
        Effect.fail(
          new XmlError({
            reason: { _tag: 'ProhibitedCharacterReference', token, codepoint: cp },
            message: `[EntityDecoder] Prohibited numeric character reference &${token}; ` + `(U+${cp.toString(16).toUpperCase().padStart(4, '0')})`,
          })
        )
      ),
      Match.orElse(() => Effect.succeed(String.fromCodePoint(cp)))
    );
  }

  /**
   * @description The full numeric-reference pipeline for one `#`-prefixed token.
   *
   * 1. Parse the codepoint, decimal or hex.
   * 2. Reject NaN, negatives, and anything above {@link MAX_CODE_POINT}, leaving the reference as written.
   * 3. Classify the codepoint for a minimum level.
   * 4. If `numericAllowed` is off and no minimum reaches `remove`, leave the reference as written.
   * 5. Take the stricter of the configured level and the minimum.
   * 6. Apply it. Step 4 is why `numericAllowed: false` does not neutralise `onNCR: 'throw'` for surrogates, the XML 1.0 C0 controls or null: their
   *    minimum already reaches `remove`, so they are handled no matter what the option says. It does neutralise the throw for every other codepoint.
   *    The parse is `parseInt`, which stops at the first character it cannot use. That is upstream's choice and it is permissive: a leading space or
   *    `+`, and trailing garbage, are all accepted, and a decimal token beginning `0x` parses as `0` rather than as hex.
   *
   * @param token - The raw token without `&` and `;`, e.g. `#38`, `#x26`, `#X26`.
   *
   * @returns An effect producing the replacement — the empty string meaning "delete" — or `undefined` to leave the reference as written. Fails with
   *   {@link XmlError} and the `ProhibitedCharacterReference` reason when the effective action is `throw`.
   */
  #resolveNCR(token: string): Effect.Effect<string | undefined, XmlError> {
    const second = token.charCodeAt(1);
    let cp: number;
    if (second === CODE_LOWER_X || second === CODE_UPPER_X) {
      cp = parseInt(token.slice(2), 16);
    } else {
      cp = parseInt(token.slice(1), 10);
    }

    // Out of range is `leave` rather than `remove`: an unparseable reference is text, and
    // deleting a document's characters because one of them was malformed is not a safe default.
    if (Number.isNaN(cp) || cp < 0 || cp > MAX_CODE_POINT) return Effect.succeed(undefined);

    const minimum = this.#classifyNCR(cp);

    if (!this.#numericAllowed && minimum < NCR_LEVEL.remove) return Effect.succeed(undefined);

    const effective = minimum === NO_MINIMUM_LEVEL ? this.#ncrOnLevel : Math.max(this.#ncrOnLevel, minimum);

    return this.#applyNCRAction(effective, token, cp);
  }
}
