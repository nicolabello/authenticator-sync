import { afterEach, describe, expect, it, vi } from 'vitest';
import { entry } from './fixtures';
import { clearKeyCache, generateCode, secondsRemaining } from './totp';
import type { OtpEntry } from './types';

const ascii = (s: string) => new TextEncoder().encode(s);

// RFC 6238 appendix B seeds.
const SHA1_KEY = ascii('12345678901234567890');
const SHA256_KEY = ascii('12345678901234567890123456789012');
const SHA512_KEY = ascii('1234567890123456789012345678901234567890123456789012345678901234');

const totp = (secret: Uint8Array, algorithm: OtpEntry['algorithm'], digits = 8): OtpEntry =>
  entry({ secret, algorithm, digits, period: 30, type: 'totp' });

afterEach(() => {
  vi.restoreAllMocks();
  clearKeyCache();
});

describe('generateCode: TOTP', () => {
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ])('matches RFC 6238 vectors at t=%i', async (t, sha1, sha256, sha512) => {
    expect(await generateCode(totp(SHA1_KEY, 'SHA1'), t * 1000)).toBe(sha1);
    expect(await generateCode(totp(SHA256_KEY, 'SHA256'), t * 1000)).toBe(sha256);
    expect(await generateCode(totp(SHA512_KEY, 'SHA512'), t * 1000)).toBe(sha512);
  });

  it('truncates to the requested digits, keeping leading zeros', async () => {
    expect(await generateCode(totp(SHA1_KEY, 'SHA1', 6), 59_000)).toBe('287082');
    expect(await generateCode(totp(SHA1_KEY, 'SHA1', 6), 1111111109_000)).toBe('081804');
  });

  it('uses the entry period', async () => {
    const e = { ...totp(SHA1_KEY, 'SHA1'), period: 60 };
    // t=59s with a 60s period is step 0, which is RFC 4226 counter 0 (8 digits: 84755224).
    expect(await generateCode(e, 59_000)).toBe('84755224');
    expect(await generateCode(e, 119_000)).toBe('94287082');
  });

  it('defaults to the current time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(59_000);
    expect(await generateCode(totp(SHA1_KEY, 'SHA1'))).toBe('94287082');
  });

  it('refuses MD5', async () => {
    await expect(generateCode(totp(SHA1_KEY, 'MD5'), 0)).rejects.toThrow('MD5 is not supported for preview');
  });
});

describe('generateCode: HOTP', () => {
  const hotp = (counter: number): OtpEntry => entry({ secret: SHA1_KEY, type: 'hotp', counter, period: 30 });

  it('matches RFC 4226 vectors and ignores the clock', async () => {
    expect(await generateCode(hotp(0), 1e12)).toBe('755224');
    expect(await generateCode(hotp(1), 0)).toBe('287082');
    expect(await generateCode(hotp(9), 0)).toBe('520489');
  });

  it('handles counters above 2^32', async () => {
    // Computed independently with Node's crypto.createHmac.
    expect(await generateCode(hotp(2 ** 32 + 5), 0)).toBe('250721');
  });
});

describe('key cache', () => {
  it('does not confuse different secrets or algorithms', async () => {
    const other = ascii('abcdefghijabcdefghij');
    expect(await generateCode(totp(SHA1_KEY, 'SHA1'), 59_000)).toBe('94287082');
    // Computed independently with Node's crypto.createHmac (SHA1, counter 1, 8 digits).
    expect(await generateCode(totp(other, 'SHA1'), 59_000)).toBe('00326399');
    // Same secret under SHA256 must not reuse the SHA1 key.
    const padded = { ...totp(SHA256_KEY, 'SHA1') };
    const sha1Code = await generateCode(padded, 59_000);
    expect(await generateCode({ ...padded, algorithm: 'SHA256' }, 59_000)).toBe('46119246');
    expect(sha1Code).not.toBe('46119246');
  });

  it('imports each key once, non-extractable, until cleared', async () => {
    const spy = vi.spyOn(crypto.subtle, 'importKey');
    const e = totp(SHA1_KEY, 'SHA1');
    await generateCode(e, 0);
    await generateCode(e, 30_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][3]).toBe(false);
    expect(spy.mock.calls[0][4]).toEqual(['sign']);
    clearKeyCache();
    await generateCode(e, 0);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('secondsRemaining', () => {
  it('counts down within the step', () => {
    expect(secondsRemaining(30, 0)).toBe(30);
    expect(secondsRemaining(30, 999)).toBe(30);
    expect(secondsRemaining(30, 1_000)).toBe(29);
    expect(secondsRemaining(30, 29_999)).toBe(1);
    expect(secondsRemaining(30, 30_000)).toBe(30);
    expect(secondsRemaining(60, 45_000)).toBe(15);
  });
  it('defaults to the current time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    expect(secondsRemaining(30)).toBe(20);
  });
});
