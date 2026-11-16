import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, base64Decode } from './encoding';
import { decodeMigrationPayload, parseMigrationUri, toMigrationUris } from './migration';
import { ingestTextBlock } from './ingest';
import { parseOtpauthUri, toOtpauthUri } from './otpauth';
import { ProtoWriter } from './protobuf';
import { Store, selectForScope } from './store';
import { generateCode } from './totp';
import type { OtpEntry } from './types';

// All secrets below are fake test values.
const SAMPLE = [
  'otpauth://totp/ExampleCo:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ExampleCo',
  'otpauth://totp/Other:bob%40example.com?secret=kvkfkrcpnzqueqcbgjzheqrsgm&issuer=Other',
  'otpauth://totp/NoIssuerParam:carol?secret=GEZDGNBVGY3TQOJQ',
  'otpauth://totp/Fast:dave?secret=MFRGGZDFMZTWQ2LK&issuer=Fast&period=60&digits=8&algorithm=SHA256',
].join('\n');

const parseLines = (text: string) => text.split('\n').filter(Boolean).map(parseOtpauthUri);

describe('base32', () => {
  it('round-trips and is lenient on case/spacing/padding', () => {
    const bytes = base32Decode('jbsw y3dp ehpk 3pxp==');
    expect(base32Encode(bytes)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('rejects invalid characters', () => {
    expect(() => base32Decode('ABC1')).toThrow(/Invalid base32/);
  });
  it('treats non-canonical lengths as the same bytes', () => {
    // 33 chars → 20 bytes + 5 dropped bits; re-encodes to 32 chars but same key.
    const a = base32Decode('A'.repeat(32) + 'B');
    const b = base32Decode('A'.repeat(32));
    expect(a).toEqual(b);
  });
});

describe('otpauth text', () => {
  it('parses the extension format', () => {
    const [a, b, c, d] = parseLines(SAMPLE);
    expect(a).toMatchObject({ issuer: 'ExampleCo', name: 'alice@example.com', digits: 6, period: 30, algorithm: 'SHA1' });
    expect(base32Encode(b.secret)).toBe('KVKFKRCPNZQUEQCBGJZHEQRSGM');
    expect(c).toMatchObject({ issuer: 'NoIssuerParam', name: 'carol' });
    expect(d).toMatchObject({ period: 60, digits: 8, algorithm: 'SHA256' });
  });
  it('reads "+" in the issuer as a space', () => {
    expect(parseOtpauthUri('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=My+Bank').issuer).toBe('My Bank');
  });
  it('rejects Steam accounts', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Steam:me?secret=JBSWY3DPEHPK3PXP&issuer=Steam&encoder=steam')).toThrow(/Steam/);
  });
  it('loads a text block, skipping bad lines and creating no empty items', () => {
    const s = new Store();
    const r = ingestTextBlock(s, SAMPLE + '\n\nnot a uri\n', 'ext', 'f', 'file');
    expect(r.accounts).toBe(4);
    expect(r.errors).toEqual(['Line 6: Not an otpauth:// URI']);
    expect(ingestTextBlock(s, 'garbage', 'ext', 'g', 'bad').accounts).toBe(0);
    expect(s.getItems()).toHaveLength(1);
  });
  it('serializes back to the same shape', () => {
    const uri = SAMPLE.split('\n')[0];
    expect(toOtpauthUri(parseOtpauthUri(uri))).toBe(uri);
    const fast = SAMPLE.split('\n')[3];
    expect(parseOtpauthUri(toOtpauthUri(parseOtpauthUri(fast)))).toEqual(parseOtpauthUri(fast));
  });
});

describe('Google Authenticator migration', () => {
  const entries = parseLines(SAMPLE);

  it('round-trips through otpauth-migration URIs in batches', () => {
    const uris = toMigrationUris(entries, 3, 42);
    expect(uris).toHaveLength(2);
    const batches = uris.map(parseMigrationUri);
    expect(batches.map((b) => [b.batchIndex, b.batchSize, b.batchId])).toEqual([
      [0, 2, 42],
      [1, 2, 42],
    ]);
    const decoded = batches.flatMap((b) => b.entries);
    // Period is not carried by the format, everything else is.
    expect(decoded.map((e) => ({ ...e, period: 0 }))).toEqual(entries.map((e) => ({ ...e, period: 0 })));
    expect(decoded.every((e) => e.period === 30)).toBe(true);
  });

  it('strips an "Issuer:" prefix from the name, as GA often exports it', () => {
    const p = new ProtoWriter()
      .bytes(1, base32Decode('JBSWY3DPEHPK3PXP'))
      .string(2, 'Example:alice@example.com')
      .string(3, 'Example')
      .int(4, 1)
      .int(5, 1)
      .int(6, 2);
    const payload = new ProtoWriter().message(1, p).int(2, 1).int(3, 1).int(5, -12345).finish();
    const batch = decodeMigrationPayload(payload);
    expect(batch.batchId).toBe(-12345);
    expect(batch.entries[0]).toMatchObject({ issuer: 'Example', name: 'alice@example.com', type: 'totp' });
  });

  it('decodes a payload built by an independent encoder', () => {
    // Built with a separate Python script: secret JBSWY3DPEHPK3PXP, name "test", issuer "Iss",
    // SHA1, 6 digits, TOTP, version 1, batch_size 1, batch_id 2000000000.
    const b64 = 'Ch0KCkhlbGxvId6tvu8SBHRlc3QaA0lzcyABKAEwAhABGAEogKjWuQc=';
    const batch = decodeMigrationPayload(base64Decode(b64));
    expect(batch.batchId).toBe(2000000000);
    expect(batch.entries[0]).toMatchObject({ name: 'test', issuer: 'Iss', type: 'totp', digits: 6 });
    expect(base32Encode(batch.entries[0].secret)).toBe('JBSWY3DPEHPK3PXP');
  });
});

describe('TOTP', () => {
  // RFC 6238 test vector, SHA1, secret "12345678901234567890".
  const rfc: OtpEntry = {
    secret: new TextEncoder().encode('12345678901234567890'),
    issuer: '',
    name: 'rfc',
    algorithm: 'SHA1',
    digits: 8,
    period: 30,
    type: 'totp',
    counter: 0,
  };
  it('matches RFC 6238 vectors', async () => {
    expect(await generateCode(rfc, 59_000)).toBe('94287082');
    expect(await generateCode(rfc, 1111111109_000)).toBe('07081804');
    expect(await generateCode(rfc, 20000000000_000)).toBe('65353130');
  });
});

describe('Store', () => {
  const ext = parseLines(SAMPLE);
  // GA has alice (relabelled), carol twice, and an extra account.
  const extra = parseOtpauthUri('otpauth://totp/Extra:erin?secret=ONSWG4TFOQ&issuer=Extra');
  const gaEntries = [{ ...ext[0], name: 'Alice' }, ext[2], ext[2], extra];

  function makeStore() {
    const s = new Store();
    s.upsertItem({ id: 'ext', source: 'ext', label: 'text', entries: ext });
    s.upsertItem({ id: 'ga:1:0', source: 'ga', label: 'batch', entries: gaEntries });
    return s;
  }

  it('merges by secret and records presence per source', () => {
    const accounts = makeStore().accounts();
    expect(accounts).toHaveLength(5);
    const alice = accounts.find((a) => a.entry.issuer === 'ExampleCo')!;
    expect(alice.occurrences.ga).toHaveLength(1);
    expect(alice.occurrences.ext).toHaveLength(1);
    expect(alice.warnings.join()).toMatch(/Named differently/);
    const carol = accounts.find((a) => a.entry.name === 'carol')!;
    expect(carol.warnings.join()).toMatch(/2 copies in Google Authenticator/);
  });

  it('is idempotent when the same item is loaded twice', () => {
    const s = makeStore();
    s.upsertItem({ id: 'ext', source: 'ext', label: 'text', entries: ext });
    expect(s.accounts()).toHaveLength(5);
  });

  it('selects missing accounts per target', () => {
    const accounts = makeStore().accounts();
    expect(selectForScope(accounts, 'missing-ga').map((a) => a.entry.name).sort()).toEqual(['bob@example.com', 'dave']);
    expect(selectForScope(accounts, 'missing-ext').map((a) => a.entry.name)).toEqual(['erin']);
    expect(selectForScope(accounts, 'all')).toHaveLength(5);
  });

  it('applies edits and exclusions', () => {
    const s = makeStore();
    const erin = s.accounts().find((a) => a.entry.name === 'erin')!;
    s.setOverride(erin.key, { name: 'Erin' });
    const edited = s.accounts().find((a) => a.key === erin.key)!;
    expect(edited.entry.name).toBe('Erin');
    expect(edited.edited).toBe(true);
    s.setOverride(erin.key, { excluded: true });
    expect(selectForScope(s.accounts(), 'missing-ext')).toHaveLength(0);
  });

  it('flags same label with different secrets', () => {
    const s = new Store();
    const a = parseOtpauthUri('otpauth://totp/X:me?secret=JBSWY3DPEHPK3PXP&issuer=X');
    const b = parseOtpauthUri('otpauth://totp/X:me?secret=MFRGGZDFMZTWQ2LK&issuer=X');
    s.upsertItem({ id: 'a', source: 'ga', label: '', entries: [a] });
    s.upsertItem({ id: 'b', source: 'ext', label: '', entries: [b] });
    expect(s.accounts().every((acc) => acc.warnings.some((w) => /probably one is outdated/.test(w)))).toBe(true);
  });

  it('does not treat a second GA export of the same account as a duplicate', () => {
    const s = new Store();
    const [first] = toMigrationUris([ext[0]], 10, 1);
    const [second] = toMigrationUris([ext[0]], 10, 2);
    ingestTextBlock(s, `${first}\n${second}`, 'ga', 'x', 'x');
    const [acc] = s.accounts();
    expect(acc.copies.ga).toBe(1);
    expect(acc.warnings).toEqual([]);
  });

  it('reports transfer QRs that have not been loaded', () => {
    const s = new Store();
    const uris = toMigrationUris(ext, 1, 7);
    ingestTextBlock(s, [uris[0], uris[2]].join('\n'), 'ga', 'x', 'x');
    expect(s.missingGaBatches()).toEqual(['2 of 4', '4 of 4']);
  });

  it('clears the "same name" warning once the stale entry is unticked', () => {
    const s = new Store();
    const a = parseOtpauthUri('otpauth://totp/X:me?secret=JBSWY3DPEHPK3PXP&issuer=X');
    const b = parseOtpauthUri('otpauth://totp/X:me?secret=MFRGGZDFMZTWQ2LK&issuer=X');
    s.upsertItem({ id: 'a', source: 'ga', label: '', entries: [a, b] });
    s.setOverride(s.accounts()[1].key, { excluded: true });
    expect(s.accounts()[0].warnings).toEqual([]);
  });
});

describe('robustness', () => {
  it('rejects transfer QR accounts without a secret', () => {
    const p = new ProtoWriter().message(1, new ProtoWriter().string(2, 'nosecret')).finish();
    expect(() => decodeMigrationPayload(p)).toThrow(/without a secret/);
  });
  it('rejects truncated protobuf fixed-width fields', () => {
    // field 9, wire type 1 (fixed64), then only 2 bytes.
    expect(() => decodeMigrationPayload(new Uint8Array([(9 << 3) | 1, 0, 0]))).toThrow(/Truncated/);
  });
});
