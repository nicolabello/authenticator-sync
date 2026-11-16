import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, base64Decode, base64Encode, toHex } from './encoding';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('base32', () => {
  // RFC 4648 §10 test vectors (unpadded).
  const RFC: [string, string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(RFC)('encodes %j as %j', (plain, encoded) => {
    expect(base32Encode(bytes(plain))).toBe(encoded);
  });

  it.each(RFC)('decodes back to %j', (plain, encoded) => {
    expect(base32Decode(encoded)).toEqual(bytes(plain));
  });

  it('covers the whole alphabet', () => {
    const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    expect(base32Encode(base32Decode(all))).toBe(all);
  });

  it('encodes all-ones bytes without leaking high bits', () => {
    expect(base32Encode(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe('77777777');
    expect(base32Encode(new Uint8Array([0xff]))).toBe('74');
  });

  it('round-trips and is lenient on case/spacing/padding', () => {
    const decoded = base32Decode('jbsw y3dp ehpk 3pxp==');
    expect(base32Encode(decoded)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('ignores dashes, tabs and newlines', () => {
    expect(base32Decode('JBSW-Y3DP\tEHPK\n3PXP')).toEqual(base32Decode('JBSWY3DPEHPK3PXP'));
  });

  it('rejects invalid characters, naming the character', () => {
    expect(() => base32Decode('ABC1')).toThrow('Invalid base32 character "1" in secret');
    expect(() => base32Decode('AB+C')).toThrow(/"\+"/);
  });

  it('treats non-canonical lengths as the same bytes', () => {
    // 33 chars → 20 bytes + 5 dropped bits; re-encodes to 32 chars but same key.
    const a = base32Decode('A'.repeat(32) + 'B');
    const b = base32Decode('A'.repeat(32));
    expect(a).toEqual(b);
    expect(a).toHaveLength(20);
  });

  it('drops a trailing partial byte', () => {
    expect(base32Decode('M')).toEqual(new Uint8Array());
    expect(base32Decode('MZX')).toEqual(bytes('f'));
  });
});

describe('base64', () => {
  it('encodes standard base64 with padding', () => {
    expect(base64Encode(bytes('foobar'))).toBe('Zm9vYmFy');
    expect(base64Encode(bytes('fo'))).toBe('Zm8=');
    expect(base64Encode(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
  });

  it('decodes standard base64', () => {
    expect(base64Decode('Zm8=')).toEqual(bytes('fo'));
    expect(base64Decode('+/8=')).toEqual(new Uint8Array([0xfb, 0xff]));
  });

  it('accepts URL-safe alphabet, missing padding and whitespace', () => {
    expect(base64Decode('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(base64Decode('Zm9v\nYmE')).toEqual(bytes('fooba'));
    expect(base64Decode('Zg')).toEqual(bytes('f'));
  });

  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64Decode(base64Encode(all))).toEqual(all);
  });
});

describe('toHex', () => {
  it('zero-pads each byte', () => {
    expect(toHex(new Uint8Array([0, 1, 0x0a, 0xab, 0xff]))).toBe('00010aabff');
    expect(toHex(new Uint8Array())).toBe('');
  });
});
