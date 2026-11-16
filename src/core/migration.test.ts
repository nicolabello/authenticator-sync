import { describe, expect, it, vi } from 'vitest';
import { base32Decode, base32Encode, base64Decode, base64Encode } from './encoding';
import { entry, parseLines, SAMPLE } from './fixtures';
import {
  decodeMigrationPayload,
  encodeMigrationPayload,
  gaIncompatibility,
  isMigrationUri,
  parseMigrationUri,
  toMigrationUris,
} from './migration';
import { ProtoReader, ProtoWriter } from './protobuf';

const SECRET = base32Decode('JBSWY3DPEHPK3PXP');

/** Encode a single OtpParameters message with the given raw fields, wrapped in a payload. */
function payloadWith(fields: (w: ProtoWriter) => ProtoWriter, extra: (w: ProtoWriter) => ProtoWriter = (w) => w): Uint8Array {
  const p = fields(new ProtoWriter().bytes(1, SECRET));
  return extra(new ProtoWriter().message(1, p)).finish();
}
const decodeOne = (fields: (w: ProtoWriter) => ProtoWriter) => decodeMigrationPayload(payloadWith(fields)).entries[0];

/** All top-level varint fields of a payload, by field number. */
function topLevelInts(buf: Uint8Array): Record<number, number> {
  const r = new ProtoReader(buf);
  const out: Record<number, number> = {};
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (wire === 0) out[field] = r.int();
    else r.skip(wire);
  }
  return out;
}

describe('decodeMigrationPayload', () => {
  it('decodes a payload built by an independent encoder', () => {
    // Built with a separate Python script: secret JBSWY3DPEHPK3PXP, name "test", issuer "Iss",
    // SHA1, 6 digits, TOTP, version 1, batch_size 1, batch_id 2000000000.
    const b64 = 'Ch0KCkhlbGxvId6tvu8SBHRlc3QaA0lzcyABKAEwAhABGAEogKjWuQc=';
    const batch = decodeMigrationPayload(base64Decode(b64));
    expect(batch).toEqual({
      batchId: 2000000000,
      batchSize: 1,
      batchIndex: 0,
      entries: [
        { secret: SECRET, name: 'test', issuer: 'Iss', algorithm: 'SHA1', digits: 6, period: 30, type: 'totp', counter: 0 },
      ],
    });
  });

  it('uses defaults for an empty payload and an entry with only a secret', () => {
    expect(decodeMigrationPayload(new Uint8Array())).toEqual({ entries: [], batchSize: 1, batchIndex: 0, batchId: 0 });
    expect(decodeOne((w) => w)).toEqual({
      secret: SECRET, name: '', issuer: '', algorithm: 'SHA1', digits: 6, period: 30, type: 'totp', counter: 0,
    });
  });

  it('reads batch fields, including a negative batch id', () => {
    const payload = new ProtoWriter().int(2, 1).int(3, 4).int(4, 2).int(5, -12345).finish();
    expect(decodeMigrationPayload(payload)).toMatchObject({ batchSize: 4, batchIndex: 2, batchId: -12345 });
  });

  it.each([
    [0, 'SHA1'],
    [1, 'SHA1'],
    [2, 'SHA256'],
    [3, 'SHA512'],
    [4, 'MD5'],
    [99, 'SHA1'],
  ])('maps algorithm %i to %s', (pb, alg) => {
    expect(decodeOne((w) => w.int(4, pb)).algorithm).toBe(alg);
  });

  it('maps an explicit UNSPECIFIED (0) algorithm to SHA1', () => {
    // ProtoWriter omits zeros, so write the field by hand: tag (4, varint), value 0.
    const inner = [0x0a, SECRET.length, ...SECRET, 0x20, 0x00];
    const payload = new Uint8Array([0x0a, inner.length, ...inner]);
    expect(decodeMigrationPayload(payload).entries[0].algorithm).toBe('SHA1');
  });

  it('maps digit counts', () => {
    expect(decodeOne((w) => w.int(5, 1)).digits).toBe(6);
    expect(decodeOne((w) => w.int(5, 2)).digits).toBe(8);
    expect(decodeOne((w) => w.int(5, 3)).digits).toBe(6);
  });

  it('maps OTP types', () => {
    expect(decodeOne((w) => w.int(6, 1)).type).toBe('hotp');
    expect(decodeOne((w) => w.int(6, 2)).type).toBe('totp');
    expect(decodeOne((w) => w.int(6, 0)).type).toBe('totp');
  });

  it('reads the HOTP counter', () => {
    expect(decodeOne((w) => w.int(6, 1).int(7, 99))).toMatchObject({ type: 'hotp', counter: 99 });
  });

  it('skips unknown fields in both messages', () => {
    const payload = payloadWith(
      // The unknown fields' contents look like real fields, so failing to skip them would show.
      (w) => w.string(2, 'me').int(8, 5).string(9, '\x12\x01X'),
      (w) => w.int(5, 9).int(6, 7).string(7, '\x28\x05'),
    );
    const batch = decodeMigrationPayload(payload);
    expect(batch.batchId).toBe(9);
    expect(batch.entries[0].name).toBe('me');
  });

  it('decodes several entries in order', () => {
    const payload = new ProtoWriter()
      .message(1, new ProtoWriter().bytes(1, SECRET).string(2, 'one'))
      .message(1, new ProtoWriter().bytes(1, SECRET).string(2, 'two'))
      .finish();
    expect(decodeMigrationPayload(payload).entries.map((e) => e.name)).toEqual(['one', 'two']);
  });

  it('strips an "Issuer:" prefix from the name, as GA often exports it', () => {
    const e = decodeOne((w) => w.string(2, 'Example:alice@example.com').string(3, 'Example').int(4, 1).int(5, 1).int(6, 2));
    expect(e).toMatchObject({ issuer: 'Example', name: 'alice@example.com', type: 'totp' });
  });

  it('matches the prefix to the issuer case-insensitively', () => {
    expect(decodeOne((w) => w.string(2, 'EXAMPLE: me').string(3, 'example'))).toMatchObject({ issuer: 'example', name: 'me' });
  });

  it('takes the issuer from the prefix when there is none', () => {
    expect(decodeOne((w) => w.string(2, ' Pre : me '))).toMatchObject({ issuer: 'Pre', name: 'me' });
  });

  it('keeps the colon when the prefix is not the issuer', () => {
    expect(decodeOne((w) => w.string(2, 'Other:me').string(3, 'Iss'))).toMatchObject({ issuer: 'Iss', name: 'Other:me' });
  });

  it('trims name and issuer', () => {
    expect(decodeOne((w) => w.string(2, ' me ').string(3, ' Iss '))).toMatchObject({ issuer: 'Iss', name: 'me' });
  });

  it('rejects accounts without a secret', () => {
    const p = new ProtoWriter().message(1, new ProtoWriter().string(2, 'nosecret')).finish();
    expect(() => decodeMigrationPayload(p)).toThrow('Transfer QR contains an account without a secret');
  });

  it('rejects truncated protobuf fixed-width fields', () => {
    // field 9, wire type 1 (fixed64), then only 2 bytes.
    expect(() => decodeMigrationPayload(new Uint8Array([(9 << 3) | 1, 0, 0]))).toThrow(/Truncated/);
  });
});

describe('encodeMigrationPayload', () => {
  it('writes version 1 and the batch fields', () => {
    const buf = encodeMigrationPayload({ entries: [], batchSize: 3, batchIndex: 2, batchId: 77 });
    expect(topLevelInts(buf)).toEqual({ 2: 1, 3: 3, 4: 2, 5: 77 });
  });

  it('writes every entry field', () => {
    const e = entry({ algorithm: 'SHA512', digits: 8, type: 'hotp', counter: 5 });
    const [decoded] = decodeMigrationPayload(encodeMigrationPayload({ entries: [e], batchSize: 1, batchIndex: 0, batchId: 1 })).entries;
    expect(decoded).toEqual(e);
  });

  it.each(['SHA1', 'SHA256', 'SHA512', 'MD5'] as const)('round-trips algorithm %s', (algorithm) => {
    const e = entry({ algorithm });
    const [decoded] = decodeMigrationPayload(encodeMigrationPayload({ entries: [e], batchSize: 1, batchIndex: 0, batchId: 1 })).entries;
    expect(decoded.algorithm).toBe(algorithm);
  });

  it('writes explicit enum values GA expects (SHA1=1, SIX=1, TOTP=2)', () => {
    const buf = encodeMigrationPayload({ entries: [entry()], batchSize: 1, batchIndex: 0, batchId: 1 });
    const outer = new ProtoReader(buf);
    expect(outer.tag()).toEqual({ field: 1, wire: 2 });
    expect(topLevelInts(outer.bytes())).toEqual({ 4: 1, 5: 1, 6: 2 });
  });

  it('writes 8 digits as EIGHT=2 and HOTP as 1 with its counter', () => {
    const buf = encodeMigrationPayload({ entries: [entry({ digits: 8, type: 'hotp', counter: 3 })], batchSize: 1, batchIndex: 0, batchId: 1 });
    const outer = new ProtoReader(buf);
    outer.tag();
    expect(topLevelInts(outer.bytes())).toEqual({ 4: 1, 5: 2, 6: 1, 7: 3 });
  });

  it('drops the counter for TOTP entries', () => {
    const e = entry({ counter: 9 });
    const [decoded] = decodeMigrationPayload(encodeMigrationPayload({ entries: [e], batchSize: 1, batchIndex: 0, batchId: 1 })).entries;
    expect(decoded.counter).toBe(0);
  });
});

describe('isMigrationUri', () => {
  it('recognises the scheme case-insensitively, ignoring surrounding whitespace', () => {
    expect(isMigrationUri('otpauth-migration://offline?data=x')).toBe(true);
    expect(isMigrationUri('  OTPAUTH-MIGRATION://offline')).toBe(true);
    expect(isMigrationUri('otpauth://totp/x')).toBe(false);
    expect(isMigrationUri('see otpauth-migration://offline')).toBe(false);
  });
});

describe('parseMigrationUri', () => {
  const b64 = base64Encode(payloadWith((w) => w.string(2, 'me'), (w) => w.int(5, 3)));

  it('rejects other URIs', () => {
    expect(() => parseMigrationUri('otpauth://totp/x?secret=AA')).toThrow('Not an otpauth-migration:// URI');
    expect(() => parseMigrationUri('otpauth-migration://online?data=AA')).toThrow('Not an otpauth-migration:// URI');
    expect(() => parseMigrationUri('xotpauth-migration://offline?data=AA')).toThrow('Not an otpauth-migration:// URI');
    expect(() => parseMigrationUri('otpauth-migration://offline?data=AA\nmore')).toThrow('Not an otpauth-migration:// URI');
  });

  it('requires a data parameter', () => {
    expect(() => parseMigrationUri('otpauth-migration://offline?foo=1')).toThrow('Missing data parameter');
    expect(() => parseMigrationUri('otpauth-migration://offline?')).toThrow('Missing data parameter');
  });

  it('finds data anywhere in the query, case-insensitively', () => {
    expect(parseMigrationUri(`  OTPAUTH-MIGRATION://OFFLINE?x=1&DATA=${encodeURIComponent(b64)}  `).batchId).toBe(3);
  });

  it('accepts percent-encoded, raw and space-mangled "+"', () => {
    // A payload whose base64 contains both "+" and "/".
    const tricky = new ProtoWriter().message(1, new ProtoWriter().bytes(1, new Uint8Array([0xf0, 0xf0, 0xf8]))).int(5, 1).finish();
    const enc = base64Encode(tricky);
    expect(enc).toMatch(/\+/);
    expect(enc).toMatch(/\//);
    for (const data of [encodeURIComponent(enc), enc, enc.replace(/\+/g, ' '), enc.replace(/\+/g, '%20')]) {
      expect(parseMigrationUri(`otpauth-migration://offline?data=${data}`).entries[0].secret).toEqual(new Uint8Array([0xf0, 0xf0, 0xf8]));
    }
  });
});

describe('gaIncompatibility', () => {
  it('accepts 30s TOTP with 6 or 8 digits', () => {
    expect(gaIncompatibility(entry())).toBeNull();
    expect(gaIncompatibility(entry({ digits: 8 }))).toBeNull();
  });
  it('rejects other periods for TOTP only', () => {
    expect(gaIncompatibility(entry({ period: 60 }))).toBe('period is 60s (Google Authenticator only supports 30s)');
    expect(gaIncompatibility(entry({ type: 'hotp', period: 60 }))).toBeNull();
  });
  it('rejects other digit counts', () => {
    expect(gaIncompatibility(entry({ digits: 7 }))).toBe('7 digits (Google Authenticator supports 6 or 8)');
    expect(gaIncompatibility(entry({ type: 'hotp', digits: 10 }))).toBe('10 digits (Google Authenticator supports 6 or 8)');
  });
});

describe('toMigrationUris', () => {
  const entries = parseLines(SAMPLE);

  it('round-trips through otpauth-migration URIs in batches', () => {
    const uris = toMigrationUris(entries, 3, 42);
    expect(uris).toHaveLength(2);
    const batches = uris.map(parseMigrationUri);
    expect(batches.map((b) => [b.batchIndex, b.batchSize, b.batchId])).toEqual([
      [0, 2, 42],
      [1, 2, 42],
    ]);
    expect(batches.map((b) => b.entries.length)).toEqual([3, 1]);
    const decoded = batches.flatMap((b) => b.entries);
    // Period is not carried by the format, everything else is.
    expect(decoded.map((e) => ({ ...e, period: 0 }))).toEqual(entries.map((e) => ({ ...e, period: 0 })));
    expect(decoded.every((e) => e.period === 30)).toBe(true);
  });

  it('defaults to 10 accounts per batch', () => {
    const many = Array.from({ length: 21 }, (_, i) => entry({ name: `n${i}` }));
    expect(toMigrationUris(many, undefined, 1).map((u) => parseMigrationUri(u).entries.length)).toEqual([10, 10, 1]);
  });

  it('clamps the batch size to a whole number of at least 1', () => {
    expect(toMigrationUris(entries, 0, 1)).toHaveLength(4);
    expect(toMigrationUris(entries, -5, 1)).toHaveLength(4);
    expect(toMigrationUris(entries, 2.9, 1)).toHaveLength(2);
    expect(toMigrationUris(entries, 4, 1)).toHaveLength(1);
  });

  it('returns nothing for no entries', () => {
    expect(toMigrationUris([], 10, 1)).toEqual([]);
  });

  it('percent-encodes the base64 payload', () => {
    for (const u of toMigrationUris(entries, 1, 1)) {
      expect(u).toMatch(/^otpauth-migration:\/\/offline\?data=[A-Za-z0-9%]+$/);
    }
  });

  it('picks one random non-negative 31-bit batch id for the whole export', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      (arr as unknown as Uint32Array)[0] = 0xffffffff;
      return arr;
    });
    try {
      const ids = toMigrationUris(entries, 2).map((u) => parseMigrationUri(u).batchId);
      expect(ids).toEqual([0x7fffffff, 0x7fffffff]);
    } finally {
      spy.mockRestore();
    }
    const id = parseMigrationUri(toMigrationUris(entries)[0]).batchId;
    expect(id).toBeGreaterThanOrEqual(0);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
  });

  it('keeps secrets intact', () => {
    const [u] = toMigrationUris([entry({ secret: SECRET })], 1, 1);
    expect(base32Encode(parseMigrationUri(u).entries[0].secret)).toBe('JBSWY3DPEHPK3PXP');
  });
});
