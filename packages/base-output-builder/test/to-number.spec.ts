/**
 * @description Specs for `toNumber`, the numeric-string conversion the value parsers sit on. The function is small but its contract is the least obvious in the
 * package, so these specs are shaped around that contract rather than around its branches. `toNumber` returns `string | number | null` on purpose: it
 * converts only what is unambiguously a number and hands everything else back untouched, which is what lets it sit in a parser chain without the
 * caller checking whether it was the parser that changed anything. The type is the answer. A reader who does not internalise that will read the
 * `infinity` block below as a set of bugs — the overflow branch is entered for _every_ value `Number()` cannot represent, `NaN` included, so a
 * non-numeric string under an `infinity: 'null'` option comes back as `null` rather than as itself. The other thing these specs are for is the option
 * set. Which strings count as numbers is a decision a document makes, not one the parser can make: `version="007"` wants 7, `id="007"` wants the
 * string, and `0b11` is a binary literal to one caller and a padded identifier to the next. So each option gets its own block, asserted in both
 * positions — what the default accepts, and what turning the option off refuses. This is a port of `strnum@2.4.2`, verified against the dependency
 * over a large differential corpus, so these specs are not the only evidence that behaviour is unchanged. They are what keeps it unchanged as the
 * code moves, and they are the place a future reader looks to find out _why_ a given string converts or does not.
 */

import { describe, expect, it } from 'vite-plus/test';

import { toNumber } from '#/index.ts';

/**
 * @description Call `toNumber` with a value its signature forbids, so the runtime guard at the top of the function can be observed rather than described.
 *
 * @param value - The value to pass in, whatever its type.
 *
 * @returns Whatever `toNumber` returns for it.
 */
const callWith = (value: unknown): string | number | null => toNumber(value as string);

// ─── The return-shape contract ───────────────────────────────────────────────────────────────────────────────

describe('the return type says whether the value was numeric', () => {
  it('gives a number back for a numeric string', () => {
    expect(toNumber('42')).toBe(42);
  });

  it('gives the very same string back for a value that is not a number', () => {
    expect(toNumber('abc')).toBe('abc');
  });

  it('tells the two apart by type, not by content', () => {
    expect(typeof toNumber('42')).toBe('number');
    expect(typeof toNumber('forty two')).toBe('string');
  });

  it('converts a zero rather than letting it read as falsy-and-therefore-text', () => {
    // Both of these are falsy, so a caller branching on truthiness would get `0` and `''` mixed up. The type is what separates them.
    expect(toNumber('0')).toBe(0);
    expect(toNumber('')).toBe('');
  });

  it('never answers with NaN, so a caller needs no NaN check after a typeof test', () => {
    const result = toNumber('not a number at all');
    expect(typeof result).toBe('string');
    expect(result).not.toBeNaN();
  });

  it('keeps a leading plus on a string it returns, so nothing is silently rewritten', () => {
    expect(toNumber('+007', { leadingZeros: false })).toBe('+007');
  });

  it('decides number-versus-string from the options, not from the input alone', () => {
    // Identical input, opposite answers. This is the whole point of the option set.
    expect(toNumber('007')).toBe(7);
    expect(toNumber('007', { leadingZeros: false })).toBe('007');
  });
});

// ─── Plain integers and decimals ────────────────────────────────────────────────────────────────────────────

describe('plain integers and decimals', () => {
  it('converts a positive, a negative and an explicitly positive integer', () => {
    expect(toNumber('42')).toBe(42);
    expect(toNumber('-42')).toBe(-42);
    expect(toNumber('+42')).toBe(42);
  });

  it('converts zero', () => {
    expect(toNumber('0')).toBe(0);
  });

  it('converts an integer too large for a 32-bit field', () => {
    expect(toNumber('1234567890123')).toBe(1234567890123);
  });

  it('converts a decimal', () => {
    expect(toNumber('3.14')).toBe(3.14);
  });

  it('accepts a bare point, reading it as zero', () => {
    expect(toNumber('.5')).toBe(0.5);
    expect(toNumber('-.5')).toBe(-0.5);
  });

  it('accepts a trailing point, reading it as an integer', () => {
    expect(toNumber('5.')).toBe(5);
    expect(toNumber('+5.')).toBe(5);
  });

  it('converts a zero written as a decimal', () => {
    expect(toNumber('0.0')).toBe(0);
  });

  it('treats trailing zeros in the fraction as insignificant', () => {
    expect(toNumber('0.50')).toBe(0.5);
  });
});

// ─── Values that are not numbers ─────────────────────────────────────────────────────────────────────────────

describe('a value that is not a number comes back untouched', () => {
  it('refuses a word', () => {
    expect(toNumber('abc')).toBe('abc');
  });

  it('refuses a thousands separator, rather than guessing at a locale', () => {
    expect(toNumber('1,000')).toBe('1,000');
  });

  it('refuses a number with a unit stuck to it', () => {
    expect(toNumber('12px')).toBe('12px');
  });

  it('refuses a digit separator it does not recognise', () => {
    expect(toNumber('1_000')).toBe('1_000');
  });

  it('refuses more than one decimal point', () => {
    expect(toNumber('1.2.3')).toBe('1.2.3');
  });

  it('returns the empty string rather than a number for it', () => {
    expect(toNumber('')).toBe('');
  });

  it('refuses an internal space, which would otherwise look like padding', () => {
    expect(toNumber('1 2')).toBe('1 2');
  });

  it('refuses a doubled sign', () => {
    expect(toNumber('--1')).toBe('--1');
    expect(toNumber('++1')).toBe('++1');
  });

  it('treats the spelled-out special values as text', () => {
    // `Number('Infinity')` is `Infinity` and `Number('NaN')` is `NaN`, so a naive coercion would produce numbers here. Neither is written in a form this
    // function accepts.
    expect(toNumber('Infinity')).toBe('Infinity');
    expect(toNumber('-Infinity')).toBe('-Infinity');
    expect(toNumber('NaN')).toBe('NaN');
  });

  it('refuses the words a boolean or null parser would take', () => {
    expect(toNumber('true')).toBe('true');
    expect(toNumber('null')).toBe('null');
  });
});

// ─── Hexadecimal ─────────────────────────────────────────────────────────────────────────────────────────────

describe('hexadecimal', () => {
  it('converts a lower-case prefix by default', () => {
    expect(toNumber('0x1f')).toBe(31);
    expect(toNumber('0xff')).toBe(255);
  });

  it('accepts either case for the digits', () => {
    expect(toNumber('0xAbCd')).toBe(43981);
  });

  it('converts a signed literal, with the sign outside the prefix', () => {
    expect(toNumber('-0x10')).toBe(-16);
    expect(toNumber('+0xff')).toBe(255);
  });

  it('comes back as a string when hex is refused', () => {
    expect(toNumber('0x1f', { hex: false })).toBe('0x1f');
    expect(toNumber('0xff', { hex: false })).toBe('0xff');
  });

  it('comes back as a string when hex is refused, sign included', () => {
    expect(toNumber('-0x10', { hex: false })).toBe('-0x10');
    expect(toNumber('+0xff', { hex: false })).toBe('+0xff');
  });

  it('is not a hex literal with no digits after the prefix', () => {
    expect(toNumber('0x')).toBe('0x');
  });

  it('is not a hex literal with no valid digits in it', () => {
    expect(toNumber('0xzz')).toBe('0xzz');
  });

  it('takes only a lower-case prefix, so `0X1F` is text', () => {
    // The dependency's pattern spells the prefix `0x`; an upper-case `X` is left as written. Preserved, because widening it would convert a value a document
    // may mean as an identifier.
    expect(toNumber('0X1F')).toBe('0X1F');
  });

  it('stops at the first digit that is not hex, the way parseInt does', () => {
    // `parseInt('1f8', 16)` is 504, not 5048 and not an error. Faithful to the dependency rather than a considered decision.
    expect(toNumber('0x1f8')).toBe(504);
  });
});

// ─── Binary and octal ───────────────────────────────────────────────────────────────────────────────────────

describe('binary and octal', () => {
  it('refuses both prefixes by default', () => {
    // A leading zero on a document field is far more likely to be a padded identifier than a radix literal, so both are opt-in.
    expect(toNumber('0b11')).toBe('0b11');
    expect(toNumber('0o17')).toBe('0o17');
  });

  it('converts binary when asked', () => {
    expect(toNumber('0b11', { binary: true })).toBe(3);
    expect(toNumber('0b1111', { binary: true })).toBe(15);
  });

  it('converts octal when asked', () => {
    expect(toNumber('0o17', { octal: true })).toBe(15);
    expect(toNumber('0o777', { octal: true })).toBe(511);
  });

  it('converts a zero in either base', () => {
    expect(toNumber('0b0', { binary: true })).toBe(0);
    expect(toNumber('0o0', { octal: true })).toBe(0);
  });

  it('never accepts an eight in an octal literal', () => {
    expect(toNumber('0o8', { octal: true })).toBe('0o8');
  });

  it('never accepts a two in a binary literal', () => {
    expect(toNumber('0b2', { binary: true })).toBe('0b2');
  });

  it('carries no sign on either prefix, even when asked', () => {
    // The binary and octal patterns are unanchored to a sign, so `-0b11` is not a binary literal even though `-0x10` is a hex one.
    expect(toNumber('-0b11', { binary: true })).toBe('-0b11');
    expect(toNumber('+0o17', { octal: true })).toBe('+0o17');
  });
});

// ─── Leading zeros ───────────────────────────────────────────────────────────────────────────────────────────

describe('leading zeros', () => {
  it('drops one or a whole run of them by default', () => {
    expect(toNumber('007')).toBe(7);
    expect(toNumber('01')).toBe(1);
    expect(toNumber('000')).toBe(0);
    expect(toNumber('000.5')).toBe(0.5);
  });

  it('keeps them when leading zeros are refused', () => {
    expect(toNumber('007', { leadingZeros: false })).toBe('007');
    expect(toNumber('07', { leadingZeros: false })).toBe('07');
    expect(toNumber('01', { leadingZeros: false })).toBe('01');
  });

  it('keeps a signed one too when leading zeros are refused', () => {
    expect(toNumber('-07', { leadingZeros: false })).toBe('-07');
  });

  it('still converts a single zero before a decimal point when leading zeros are refused', () => {
    // The subtle case. `0.5` has one leading zero, but it is the zero of the fraction rather than padding in front of an integer, so refusing it would be
    // wrong: there is no padded identifier anyone writes as `0.5`. The rule that implements this looks at whether the zero run touches the decimal point in
    // the *original* string.
    expect(toNumber('0.5', { leadingZeros: false })).toBe(0.5);
    expect(toNumber('0.50', { leadingZeros: false })).toBe(0.5);
    expect(toNumber('0.', { leadingZeros: false })).toBe(0);
  });

  it('refuses a run of two zeros before the point when leading zeros are refused', () => {
    // `00.5` is two zeros, and only the single-zero case is the fraction's own zero. A run of two is padding, so this one is text.
    expect(toNumber('00.5', { leadingZeros: false })).toBe('00.5');
    expect(toNumber('00', { leadingZeros: false })).toBe('00');
  });

  it('converts a lone zero either way, since there is nothing to strip', () => {
    expect(toNumber('0', { leadingZeros: false })).toBe(0);
    expect(toNumber('0.0', { leadingZeros: false })).toBe(0);
  });
});

// ─── Exponent notation ──────────────────────────────────────────────────────────────────────────────────────

describe('exponent notation', () => {
  it('converts either case of the exponent marker, and a negative exponent, by default', () => {
    expect(toNumber('1e3')).toBe(1000);
    expect(toNumber('1E3')).toBe(1000);
    expect(toNumber('1e-3')).toBe(0.001);
  });

  it('converts a signed or fractional mantissa by default', () => {
    expect(toNumber('+1e3')).toBe(1000);
    expect(toNumber('1.5e3')).toBe(1500);
    expect(toNumber('0.5e3')).toBe(500);
  });

  it('is not exponent notation with no digits after the marker or no mantissa', () => {
    expect(toNumber('1e')).toBe('1e');
    expect(toNumber('e3')).toBe('e3');
  });

  it('comes back as a string when exponent notation is refused', () => {
    expect(toNumber('1e3', { eNotation: false })).toBe('1e3');
    expect(toNumber('1E3', { eNotation: false })).toBe('1E3');
    expect(toNumber('1.5e3', { eNotation: false })).toBe('1.5e3');
    expect(toNumber('+1e3', { eNotation: false })).toBe('+1e3');
    expect(toNumber('1e-3', { eNotation: false })).toBe('1e-3');
  });

  it('judges a zero run by whether it touches the exponent marker', () => {
    // `0e3` is a single zero that is the value, so it converts. `00e3` is a run sitting against the marker, the shape the leading-zero rules exist to
    // protect. `03e3` and `007e3` are runs padding a mantissa that the exponent has moved away from, so those convert.
    expect(toNumber('0e3')).toBe(0);
    expect(toNumber('00e3')).toBe('00e3');
    expect(toNumber('00e3', { leadingZeros: false })).toBe('00e3');
    expect(toNumber('03e3')).toBe(3000);
    expect(toNumber('007e3')).toBe(7000);
  });

  it('refuses a long literal that JS prints back in exponent form', () => {
    // Twenty-three digits is a number a document can hold, and `String(1e23)` is `1e+23`. Turning the option off means the printed-back form is not accepted,
    // so the value stays text.
    expect(toNumber('100000000000000000000000')).toBe(1e23);
    expect(toNumber('100000000000000000000000', { eNotation: false })).toBe('100000000000000000000000');
  });
});

// ─── Values too large to represent ─────────────────────────────────────────────────────────────────────────

describe('a value too large to represent', () => {
  it('comes back as the input was written, by default', () => {
    expect(toNumber('1e1000')).toBe('1e1000');
    expect(toNumber('-1e1000')).toBe('-1e1000');
  });

  it('becomes null when the caller asks for null', () => {
    expect(toNumber('1e1000', { infinity: 'null' })).toBeNull();
    expect(toNumber('-1e1000', { infinity: 'null' })).toBeNull();
  });

  it('becomes a spelled-out string when the caller asks for one', () => {
    expect(toNumber('1e1000', { infinity: 'string' })).toBe('Infinity');
    expect(toNumber('-1e1000', { infinity: 'string' })).toBe('-Infinity');
  });

  it('becomes the numeric infinity when the caller asks for that', () => {
    expect(toNumber('1e1000', { infinity: 'infinity' })).toBe(Number.POSITIVE_INFINITY);
    expect(toNumber('-1e1000', { infinity: 'infinity' })).toBe(Number.NEGATIVE_INFINITY);
  });

  it('is the same answer for a literal that overflows without an exponent', () => {
    const huge = `1${'0'.repeat(400)}`;
    expect(toNumber(huge)).toBe(huge);
    expect(toNumber(huge, { infinity: 'null' })).toBeNull();
    expect(toNumber(huge, { infinity: 'infinity' })).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns null as a real value, which the return type admits', () => {
    // `null` is the one member of `string | number | null` that is not the input echoed back, so a caller that only tests `typeof` for `string` and `number`
    // has to handle it.
    const result = toNumber('1e1000', { infinity: 'null' });
    expect(result).toBeNull();
    expect(typeof result).toBe('object');
  });

  it('overflows the same way whether or not exponent notation is on', () => {
    // The overflow is judged before the notation option, so turning notation off does not hand back the string here — it hands back whatever the `infinity`
    // option says.
    expect(toNumber('1e1000', { infinity: 'null', eNotation: false })).toBeNull();
  });

  it('takes a non-numeric string down the same branch, because NaN is not finite either', () => {
    // The overflow check is `!Number.isFinite(Number(candidate))`, and `Number('abc')` is NaN, which is not finite. So the `infinity` option is not scoped to
    // overflow at all: under `'null'` every non-numeric string becomes `null`, and under `'string'` it becomes `'-Infinity'`. Faithful to the dependency, and
    // the reason to read this option as "what to do with a value `Number()` could not produce" rather than "what to do with an overflow".
    expect(toNumber('abc', { infinity: 'null' })).toBeNull();
    expect(toNumber('abc', { infinity: 'string' })).toBe('-Infinity');
    expect(toNumber('abc', { infinity: 'infinity' })).toBeNaN();
  });
});

// ─── skipLike ────────────────────────────────────────────────────────────────────────────────────────────────

describe('skipLike', () => {
  it('returns the input unchanged when the pattern matches, however numeric it looks', () => {
    expect(toNumber('3.14', { skipLike: /^\d+\.\d+$/ })).toBe('3.14');
  });

  it('does not fire on a value the pattern does not match', () => {
    expect(toNumber('42', { skipLike: /^\d+\.\d+$/ })).toBe(42);
    expect(toNumber('0x1f', { skipLike: /^\d+\.\d+$/ })).toBe(31);
  });

  it('tests the pattern against the trimmed value but returns the input untrimmed', () => {
    // The pattern sees `3.14`; what comes back is the string as written, spaces included.
    expect(toNumber(' 3.14 ', { skipLike: /^\d+\.\d+$/ })).toBe(' 3.14 ');
  });

  it('outranks the radix prefixes, so a pattern can catch a hex literal', () => {
    expect(toNumber('0x1f', { skipLike: /x/ })).toBe('0x1f');
  });

  it('outranks the leading-zero rule, so a pattern can protect a padded identifier', () => {
    // The intended use: a version or id field where coercion would be wrong, whatever the numeric rules would otherwise do with it.
    expect(toNumber('007', { skipLike: /^\d+$/ })).toBe('007');
    expect(toNumber('0', { skipLike: /0/ })).toBe('0');
  });
});

// ─── Unicode digits and minus signs ────────────────────────────────────────────────────────────────────────

describe('unicode digits and minus signs', () => {
  it('converts an Arabic-Indic digit when unicode is on', () => {
    // U+0663 ARABIC-INDIC DIGIT THREE.
    expect(toNumber('٣', { unicode: true })).toBe(3);
  });

  it('converts fullwidth digits when unicode is on', () => {
    // U+FF11..U+FF13 FULLWIDTH DIGIT ONE..THREE.
    expect(toNumber('１２３', { unicode: true })).toBe(123);
  });

  it('converts a longer run of Arabic-Indic digits when unicode is on', () => {
    // U+0661..U+0665 ARABIC-INDIC DIGIT ONE..FIVE.
    expect(toNumber('١٢٣٤٥', { unicode: true })).toBe(12345);
  });

  it('converts a unicode zero when unicode is on', () => {
    // U+0660 ARABIC-INDIC DIGIT ZERO. The point in `٣.٥` is already ASCII, so it needs no normalization of its own.
    expect(toNumber('٠', { unicode: true })).toBe(0);
    expect(toNumber('٣.٥', { unicode: true })).toBe(3.5);
  });

  it('converts a unicode minus sign when unicode is on', () => {
    // U+2212 MINUS SIGN — the character a formatter or a human writes for a minus.
    expect(toNumber('−5', { unicode: true })).toBe(-5);
  });

  it('converts the two hyphen-minus variants when unicode is on', () => {
    // U+FF0D FULLWIDTH HYPHEN-MINUS and U+FE63 SMALL HYPHEN-MINUS. Both are the sign in a face that is wider or shorter than ASCII, so both normalize.
    expect(toNumber('－5', { unicode: true })).toBe(-5);
    expect(toNumber('﹣5', { unicode: true })).toBe(-5);
  });

  it('converts a unicode minus surrounded by whitespace, trimming first', () => {
    expect(toNumber('  −5  ', { unicode: true })).toBe(-5);
  });

  it('refuses the typographic dashes, because a dash is punctuation and not a minus', () => {
    // U+2013 EN DASH, U+2014 EM DASH, U+2010 HYPHEN. Deliberate: rewriting any of them would mangle a range like `10–20` or a compound word, which are
    // strings and must stay strings. Only the three sign characters above are normalized.
    expect(toNumber('–5', { unicode: true })).toBe('–5');
    expect(toNumber('—5', { unicode: true })).toBe('—5');
    expect(toNumber('‐5', { unicode: true })).toBe('‐5');
  });

  it('refuses a unicode digit and a unicode minus when unicode is off', () => {
    expect(toNumber('٣')).toBe('٣');
    expect(toNumber('１２３')).toBe('１２３');
    expect(toNumber('−5')).toBe('−5');
  });

  it('refuses a partly-numeric unicode value, because the whole value has to be digits', () => {
    expect(toNumber('٣x', { unicode: true })).toBe('٣x');
    // Normalizing turns this into a bare `-`, which has no digits to it.
    expect(toNumber('−', { unicode: true })).toBe('−');
  });
});

// ─── Surrounding whitespace ───────────────────────────────────────────────────────────────────────────────

describe('surrounding whitespace', () => {
  it('converts a padded value of every shape', () => {
    expect(toNumber(' 42 ')).toBe(42);
    expect(toNumber(' 0x1f ')).toBe(31);
    expect(toNumber(' 3.14 ')).toBe(3.14);
    expect(toNumber(' 007 ')).toBe(7);
    expect(toNumber(' 1e3 ')).toBe(1000);
  });

  it('converts a value padded with tabs and a newline', () => {
    expect(toNumber('\t7\n')).toBe(7);
  });

  it('converts a value padded with a non-breaking space, which `trim` also removes', () => {
    // U+00A0 NO-BREAK SPACE is whitespace to `String.prototype.trim`, so a document laid out with typographic spacing still converts.
    expect(toNumber(' 42 ')).toBe(42);
  });

  it('returns a whitespace-only string untrimmed', () => {
    expect(toNumber('   ')).toBe('   ');
  });

  it('returns the untrimmed original when an overflow is handed back as written', () => {
    expect(toNumber(' 1e1000 ')).toBe(' 1e1000 ');
  });
});

// ─── Non-string input ───────────────────────────────────────────────────────────────────────────────────────

describe('a non-string argument comes back as it went in', () => {
  it('returns a nullish argument unchanged', () => {
    expect(callWith(undefined)).toBeUndefined();
    expect(callWith(null)).toBeNull();
  });

  it('returns a number unchanged rather than parsing it', () => {
    expect(callWith(0)).toBe(0);
    expect(callWith(42)).toBe(42);
  });

  it('returns a boolean unchanged', () => {
    expect(callWith(true)).toBe(true);
    expect(callWith(false)).toBe(false);
  });

  it('returns an object by identity, not a string of it', () => {
    // A silent `String()` here would turn a structured value into text and lose the fact that it was structured.
    const value = { a: 1 };
    expect(callWith(value)).toBe(value);
  });

  it('returns an array by identity', () => {
    const value = ['1', '2'];
    expect(callWith(value)).toBe(value);
  });

  it('does not confuse the number 0 with the string "0"', () => {
    // Both are falsy; only the type check tells them apart, and the guard has to run before anything else for that to hold.
    expect(callWith(0)).toBe(0);
    expect(toNumber('0')).toBe(0);
    expect(callWith(0)).not.toBe('0');
  });
});

// ─── Statelessness ────────────────────────────────────────────────────────────────────────────────────────

describe('the parser holds no state between calls', () => {
  it('answers the same for the same input, call after call', () => {
    expect(toNumber('0x1f')).toBe(31);
    expect(toNumber('0x1f')).toBe(31);
    expect(toNumber('0x1f')).toBe(31);
  });

  it('lets one option not persist into the next call', () => {
    expect(toNumber('0b11', { binary: true })).toBe(3);
    expect(toNumber('0b11')).toBe('0b11');
    expect(toNumber('0b11', { binary: true })).toBe(3);
  });

  it('lets one infinity mode not persist into the next call', () => {
    expect(toNumber('1e1000', { infinity: 'null' })).toBeNull();
    expect(toNumber('1e1000')).toBe('1e1000');
  });

  it('lets one skipLike pattern not persist into the next call', () => {
    expect(toNumber('3.14', { skipLike: /^\d+\.\d+$/ })).toBe('3.14');
    expect(toNumber('3.14')).toBe(3.14);
  });

  it('lets the digit map built on first use not carry over into a call without the option', () => {
    // The map is a module-level cache built on first use, so this is the one piece of state in the function. It maps only decimal digits to ASCII, so a call
    // with the option off must be unaffected by a call that built it.
    expect(toNumber('٣', { unicode: true })).toBe(3);
    expect(toNumber('٣')).toBe('٣');
    expect(toNumber('5')).toBe(5);
    expect(toNumber('٣', { unicode: true })).toBe(3);
  });

  it('leaves the options object the caller passed alone', () => {
    const options = { hex: false, leadingZeros: false };
    toNumber('0x1f', options);
    toNumber('007', options);
    expect(options).toEqual({ hex: false, leadingZeros: false });
  });
});
