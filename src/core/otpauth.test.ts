import { describe, expect, it } from 'vitest';
import { base32Encode } from './encoding';
import { entry, parseLines, SAMPLE } from './fixtures';
import { accountLabel, parseOtpauthUri, splitLabel, toOtpauthText, toOtpauthUri } from './otpauth';

const SECRET = 'JBSWY3DPEHPK3PXP';
const uri = (query: string, label = 'Iss:me', type = 'totp') => `otpauth://${type}/${label}?secret=${SECRET}${query}`;

describe('accountLabel', () => {
  it('prefixes the issuer when there is one', () => {
    expect(accountLabel({ issuer: 'Google', name: 'me@example.com' })).toBe('Google: me@example.com');
    expect(accountLabel({ issuer: '', name: 'me' })).toBe('me');
  });
});

describe('splitLabel', () => {
  it('splits on the first colon and trims both halves', () => {
    expect(splitLabel(' Iss : me ')).toEqual({ prefix: 'Iss', name: 'me' });
    expect(splitLabel('a:b:c')).toEqual({ prefix: 'a', name: 'b:c' });
  });
  it('returns an empty prefix and trimmed name without a colon', () => {
    expect(splitLabel('  me  ')).toEqual({ prefix: '', name: 'me' });
    expect(splitLabel(':me')).toEqual({ prefix: '', name: 'me' });
  });
});

describe('parseOtpauthUri', () => {
  it('parses the extension format', () => {
    const [a, b, c, d] = parseLines(SAMPLE);
    expect(a).toMatchObject({ issuer: 'ExampleCo', name: 'alice@example.com', digits: 6, period: 30, algorithm: 'SHA1' });
    expect(base32Encode(b.secret)).toBe('KVKFKRCPNZQUEQCBGJZHEQRSGM');
    expect(c).toMatchObject({ issuer: 'NoIssuerParam', name: 'carol' });
    expect(d).toMatchObject({ period: 60, digits: 8, algorithm: 'SHA256' });
  });

  it('returns the full default entry', () => {
    expect(parseOtpauthUri(uri(''))).toEqual({
      secret: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]),
      issuer: 'Iss',
      name: 'me',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      type: 'totp',
      counter: 0,
    });
  });

  it('is case-insensitive on scheme, type and parameter names, and trims the URI', () => {
    const e = parseOtpauthUri(`  OTPAUTH://TOTP/Iss:me?SECRET=${SECRET}&Issuer=Iss&DIGITS=8  `);
    expect(e).toMatchObject({ type: 'totp', issuer: 'Iss', name: 'me', digits: 8 });
  });

  it('parses HOTP with a counter', () => {
    const e = parseOtpauthUri(uri('&counter=42', 'Iss:me', 'hotp'));
    expect(e).toMatchObject({ type: 'hotp', counter: 42 });
    expect(parseOtpauthUri(uri('', 'Iss:me', 'HOTP')).type).toBe('hotp');
  });

  it('rejects anything that is not an otpauth totp/hotp URI', () => {
    for (const bad of [`otpauth://totp/a?secret=${SECRET}\nmore`, 'not a uri', 'otpauth://steam/x?secret=AA', 'http://totp/x', `x otpauth://totp/a?secret=${SECRET}`]) {
      expect(() => parseOtpauthUri(bad)).toThrow('Not an otpauth:// URI');
    }
  });

  it('accepts a URI with no query part only to report the missing secret', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Iss:me')).toThrow('Missing secret');
    expect(() => parseOtpauthUri('otpauth://totp/Iss:me?issuer=Iss')).toThrow('Missing secret');
    expect(() => parseOtpauthUri('otpauth://totp/Iss:me?secret=')).toThrow('Missing secret');
    expect(() => parseOtpauthUri('otpauth://totp/Iss:me?secret')).toThrow('Missing secret');
  });

  it('rejects a secret that decodes to nothing', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Iss:me?secret=====')).toThrow('Empty secret');
    expect(() => parseOtpauthUri('otpauth://totp/Iss:me?secret=A')).toThrow('Empty secret');
  });

  it('rejects an invalid secret', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Iss:me?secret=ABC1')).toThrow(/Invalid base32/);
  });

  it('reads "+" in the issuer as a space', () => {
    expect(parseOtpauthUri(`otpauth://totp/x?secret=${SECRET}&issuer=My+Bank`).issuer).toBe('My Bank');
  });

  it('percent-decodes label and values, keeping malformed escapes as-is', () => {
    expect(parseOtpauthUri(uri('&issuer=A%26B', 'A%26B:a%20b')).issuer).toBe('A&B');
    expect(parseOtpauthUri(uri('', 'A%26B:a%20b')).name).toBe('a b');
    expect(parseOtpauthUri(uri('&issuer=100%', 'bad%E0%A4')).issuer).toBe('100%');
    expect(parseOtpauthUri(uri('', 'bad%E0%A4')).name).toBe('bad%E0%A4');
  });

  it('splits the label on a literal colon first, else on an encoded one', () => {
    expect(parseOtpauthUri(uri('', 'A%3AB:me'))).toMatchObject({ issuer: 'A:B', name: 'me' });
    expect(parseOtpauthUri(uri('', ' Iss%3A%20me '))).toMatchObject({ issuer: 'Iss', name: 'me' });
    expect(parseOtpauthUri(uri('', 'Iss%20:%20me'))).toMatchObject({ issuer: 'Iss', name: 'me' });
    expect(parseOtpauthUri(uri('', 'bad%E0:x%E0'))).toMatchObject({ issuer: 'bad%E0', name: 'x%E0' });
  });

  it('prefers the issuer parameter but falls back to the label prefix', () => {
    expect(parseOtpauthUri(uri('&issuer=Param', 'Prefix:me')).issuer).toBe('Param');
    expect(parseOtpauthUri(uri('&issuer=%20%20', 'Prefix:me')).issuer).toBe('Prefix');
    expect(parseOtpauthUri(uri('&issuer=%20Param%20', 'me')).issuer).toBe('Param');
    expect(parseOtpauthUri(uri('', 'me'))).toMatchObject({ issuer: '', name: 'me' });
  });

  it('uses the first occurrence of a repeated parameter and ignores empty parts', () => {
    const e = parseOtpauthUri(`otpauth://totp/me?&&secret=${SECRET}&digits=8&digits=7&flag&`);
    expect(e.digits).toBe(8);
    expect(base32Encode(e.secret)).toBe(SECRET);
  });

  it('does not match a valueless parameter against a shorter name', () => {
    expect(parseOtpauthUri(uri('&digitsx')).digits).toBe(6);
  });

  it('rejects Steam accounts, naming the encoder', () => {
    expect(() => parseOtpauthUri(uri('&issuer=Steam&encoder=steam'))).toThrow('Unsupported account type "steam" (e.g. Steam) — not standard TOTP');
  });

  it('ignores an empty encoder parameter', () => {
    expect(parseOtpauthUri(uri('&encoder=')).type).toBe('totp');
  });

  it.each([
    ['sha1', 'SHA1'],
    ['SHA256', 'SHA256'],
    ['sha-256', 'SHA256'],
    ['SHA512', 'SHA512'],
    ['md5', 'MD5'],
  ])('accepts algorithm %s', (input, expected) => {
    expect(parseOtpauthUri(uri(`&algorithm=${input}`)).algorithm).toBe(expected);
  });

  it('rejects unknown algorithms', () => {
    expect(() => parseOtpauthUri(uri('&algorithm=SHA3'))).toThrow('Unsupported algorithm "SHA3"');
    expect(() => parseOtpauthUri(uri('&algorithm='))).toThrow('Unsupported algorithm ""');
  });

  it('accepts digits from 1 to 10', () => {
    expect(parseOtpauthUri(uri('&digits=1')).digits).toBe(1);
    expect(parseOtpauthUri(uri('&digits=10')).digits).toBe(10);
  });

  it.each(['0', '11', '6.5', 'six', '-6'])('rejects digits=%s', (v) => {
    expect(() => parseOtpauthUri(uri(`&digits=${v}`))).toThrow('Invalid digits');
  });

  it('accepts any positive integer period', () => {
    expect(parseOtpauthUri(uri('&period=1')).period).toBe(1);
    expect(parseOtpauthUri(uri('&period=90')).period).toBe(90);
  });

  it.each(['0', '-30', '1.5', 'x'])('rejects period=%s', (v) => {
    expect(() => parseOtpauthUri(uri(`&period=${v}`))).toThrow('Invalid period');
  });

  it('accepts a zero counter and rejects negative or fractional ones', () => {
    expect(parseOtpauthUri(uri('&counter=0', 'me', 'hotp')).counter).toBe(0);
    expect(() => parseOtpauthUri(uri('&counter=-1', 'me', 'hotp'))).toThrow('Invalid counter');
    expect(() => parseOtpauthUri(uri('&counter=1.5', 'me', 'hotp'))).toThrow('Invalid counter');
  });
});

describe('toOtpauthUri', () => {
  it('serializes back to the same shape', () => {
    const first = SAMPLE.split('\n')[0];
    expect(toOtpauthUri(parseOtpauthUri(first))).toBe(first);
    const fast = SAMPLE.split('\n')[3];
    expect(parseOtpauthUri(toOtpauthUri(parseOtpauthUri(fast)))).toEqual(parseOtpauthUri(fast));
  });

  it('writes only non-default settings', () => {
    expect(toOtpauthUri(entry())).toBe('otpauth://totp/Iss:me?secret=AEBAGBAF&issuer=Iss');
    expect(toOtpauthUri(entry({ algorithm: 'SHA512', digits: 8, period: 60 }))).toBe(
      'otpauth://totp/Iss:me?secret=AEBAGBAF&issuer=Iss&algorithm=SHA512&digits=8&period=60',
    );
  });

  it('omits the issuer when empty', () => {
    expect(toOtpauthUri(entry({ issuer: '' }))).toBe('otpauth://totp/me?secret=AEBAGBAF');
  });

  it('writes HOTP with its counter and without a period', () => {
    expect(toOtpauthUri(entry({ type: 'hotp', counter: 0, period: 60 }))).toBe(
      'otpauth://hotp/Iss:me?secret=AEBAGBAF&issuer=Iss&counter=0',
    );
  });

  it('percent-encodes label parts and issuer', () => {
    const e = entry({ issuer: 'A&B: C', name: 'x/y?z' });
    expect(toOtpauthUri(e)).toBe('otpauth://totp/A%26B%3A%20C:x%2Fy%3Fz?secret=AEBAGBAF&issuer=A%26B%3A%20C');
    expect(parseOtpauthUri(toOtpauthUri(e))).toEqual(e);
  });
});

describe('toOtpauthText', () => {
  it('writes one URI per line with a trailing newline', () => {
    const entries = [entry(), entry({ issuer: '' })];
    expect(toOtpauthText(entries)).toBe(`${toOtpauthUri(entries[0])}\n${toOtpauthUri(entries[1])}\n`);
  });
  it('is empty for no entries', () => {
    expect(toOtpauthText([])).toBe('');
  });
});
