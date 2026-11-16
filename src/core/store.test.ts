import { describe, expect, it, vi } from 'vitest';
import { entry, parseLines, SAMPLE } from './fixtures';
import { ingestTextBlock } from './ingest';
import { toMigrationUris } from './migration';
import { parseOtpauthUri } from './otpauth';
import { accountKey, SCOPE_LABEL, selectForScope, Store, type SourceItem } from './store';

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

const SECRET_A = new Uint8Array([1]);
const SECRET_B = new Uint8Array([2]);
const SECRET_C = new Uint8Array([3]);

function storeWith(...items: Omit<SourceItem, 'label'>[]): Store {
  const s = new Store();
  for (const i of items) s.upsertItem({ label: '', ...i });
  return s;
}

describe('accountKey', () => {
  it('is the hex of the secret', () => {
    expect(accountKey(entry({ secret: new Uint8Array([0, 0xab]) }))).toBe('00ab');
  });
});

describe('SCOPE_LABEL', () => {
  it('has a label for every scope', () => {
    expect(SCOPE_LABEL).toEqual({
      all: 'All accounts',
      'missing-ga': 'Only missing from Google Authenticator',
      'missing-ext': 'Only missing from Chrome extension',
    });
  });
});

describe('Store items', () => {
  it('notifies subscribers on every change until they unsubscribe', () => {
    const s = new Store();
    const fn = vi.fn();
    const unsubscribe = s.subscribe(fn);
    s.upsertItem({ id: 'a', source: 'ga', label: '', entries: [] });
    s.removeItem('a');
    s.clearSource('ga');
    s.setOverride('k', { name: 'x' });
    s.resetOverride('k');
    expect(fn).toHaveBeenCalledTimes(5);
    unsubscribe();
    s.removeItem('a');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('filters items by source', () => {
    const s = makeStore();
    expect(s.getItems().map((i) => i.id)).toEqual(['ext', 'ga:1:0']);
    expect(s.getItems('ga').map((i) => i.id)).toEqual(['ga:1:0']);
    expect(s.getItems('ext').map((i) => i.id)).toEqual(['ext']);
  });

  it('removes one item', () => {
    const s = makeStore();
    s.removeItem('ext');
    expect(s.getItems().map((i) => i.id)).toEqual(['ga:1:0']);
  });

  it('clears only the given source', () => {
    const s = makeStore();
    s.upsertItem({ id: 'ext2', source: 'ext', label: '', entries: [] });
    s.clearSource('ext');
    expect(s.getItems().map((i) => i.id)).toEqual(['ga:1:0']);
  });

  it('only counts a source as loaded when it has entries', () => {
    const s = storeWith({ id: 'a', source: 'ga', entries: [] });
    expect(s.hasSource('ga')).toBe(false);
    s.upsertItem({ id: 'b', source: 'ga', label: '', entries: [entry()] });
    expect(s.hasSource('ga')).toBe(true);
    expect(s.hasSource('ext')).toBe(false);
  });
});

describe('missingGaBatches', () => {
  it('reports transfer QRs that have not been loaded', () => {
    const s = new Store();
    const uris = toMigrationUris(ext, 1, 7);
    ingestTextBlock(s, [uris[0], uris[2]].join('\n'), 'ga', 'x', 'x');
    expect(s.missingGaBatches()).toEqual(['2 of 4', '4 of 4']);
  });

  it('tracks each export separately and ignores non-batch items', () => {
    const s = storeWith(
      { id: 'a', source: 'ga', entries: [], batch: { id: 1, index: 0, size: 2 } },
      { id: 'b', source: 'ga', entries: [], batch: { id: 1, index: 1, size: 2 } },
      { id: 'c', source: 'ga', entries: [], batch: { id: 2, index: 1, size: 3 } },
      { id: 'd', source: 'ext', entries: [entry()] },
    );
    expect(s.missingGaBatches()).toEqual(['1 of 3', '3 of 3']);
  });

  it('is empty when nothing is loaded', () => {
    expect(new Store().missingGaBatches()).toEqual([]);
  });
});

describe('accounts', () => {
  it('merges by secret and records presence per source', () => {
    const accounts = makeStore().accounts();
    expect(accounts).toHaveLength(5);
    const alice = accounts.find((a) => a.entry.issuer === 'ExampleCo')!;
    expect(alice.key).toBe(accountKey(ext[0]));
    expect(alice.occurrences.ga).toHaveLength(1);
    expect(alice.occurrences.ext).toHaveLength(1);
    expect(alice.copies).toEqual({ ga: 1, ext: 1 });
    expect(alice.warnings).toEqual(['Named differently in each app: “ExampleCo: Alice” / “ExampleCo: alice@example.com”.']);
    const carol = accounts.find((a) => a.entry.name === 'carol')!;
    expect(carol.copies).toEqual({ ga: 2, ext: 1 });
    expect(carol.warnings).toEqual(['2 copies in Google Authenticator — delete the extra one there.']);
  });

  it('starts every account clean', () => {
    const [acc] = storeWith({ id: 'a', source: 'ga', entries: [entry()] }).accounts();
    expect(acc).toEqual({
      key: '0102030405',
      entry: entry(),
      original: entry(),
      occurrences: { ga: [entry()], ext: [] },
      copies: { ga: 1, ext: 0 },
      edited: false,
      excluded: false,
      warnings: [],
    });
  });

  it('reports duplicates in the extension too', () => {
    const e = entry();
    const [acc] = storeWith({ id: 'a', source: 'ext', entries: [e, e, e] }).accounts();
    expect(acc.copies.ext).toBe(3);
    expect(acc.warnings).toEqual(['3 copies in the extension — delete the extra one there.']);
  });

  it('is idempotent when the same item is loaded twice', () => {
    const s = makeStore();
    s.upsertItem({ id: 'ext', source: 'ext', label: 'text', entries: ext });
    expect(s.accounts()).toHaveLength(5);
  });

  it('does not treat a second GA export of the same account as a duplicate', () => {
    const s = new Store();
    const [first] = toMigrationUris([ext[0]], 10, 1);
    const [second] = toMigrationUris([ext[0]], 10, 2);
    ingestTextBlock(s, `${first}\n${second}`, 'ga', 'x', 'x');
    const [acc] = s.accounts();
    expect(acc.occurrences.ga).toHaveLength(2);
    expect(acc.copies.ga).toBe(1);
    expect(acc.warnings).toEqual([]);
  });

  it('counts copies across batches of one GA export as one export', () => {
    const e = entry();
    const s = storeWith(
      { id: 'b0', source: 'ga', entries: [e], batch: { id: 1, index: 0, size: 2 } },
      { id: 'b1', source: 'ga', entries: [e], batch: { id: 1, index: 1, size: 2 } },
    );
    expect(s.accounts()[0].copies.ga).toBe(2);
  });

  it('does not count two text files as duplicates', () => {
    const e = entry();
    const s = storeWith({ id: 'f1', source: 'ext', entries: [e] }, { id: 'f2', source: 'ext', entries: [e] });
    expect(s.accounts()[0].copies.ext).toBe(1);
  });

  it('prefers the extension copy as the original, since it carries the period', () => {
    const gaCopy = entry({ issuer: 'GA', period: 30 });
    const extCopy = entry({ issuer: 'EXT', period: 60 });
    const [acc] = storeWith({ id: 'g', source: 'ga', entries: [gaCopy] }, { id: 'e', source: 'ext', entries: [extCopy] }).accounts();
    expect(acc.original).toBe(extCopy);
    expect(acc.entry).toEqual(extCopy);
  });

  it('flags settings that differ between apps, ignoring the period GA cannot carry', () => {
    const s = storeWith(
      { id: 'g', source: 'ga', entries: [entry({ period: 30 })] },
      { id: 'e', source: 'ext', entries: [entry({ period: 60 })] },
    );
    expect(s.accounts()[0].warnings).toEqual([
      'Can’t go into Google Authenticator: period is 60s (Google Authenticator only supports 30s).',
    ]);
    const t = storeWith(
      { id: 'g', source: 'ga', entries: [entry({ digits: 8 })] },
      { id: 'e', source: 'ext', entries: [entry({ type: 'hotp', counter: 4 })] },
    );
    expect(t.accounts()[0].warnings).toEqual(['Settings differ between apps: totp SHA1 8 digits 30s vs hotp SHA1 6 digits.']);
  });

  it('warns about non-SHA1 algorithms', () => {
    const [acc] = storeWith({ id: 'e', source: 'ext', entries: [entry({ algorithm: 'SHA256' })] }).accounts();
    expect(acc.warnings).toEqual(['Uses SHA256 — Google Authenticator may ignore this and produce wrong codes.']);
  });

  describe('same label, different secret', () => {
    it('flags each account in the group', () => {
      const a = parseOtpauthUri('otpauth://totp/X:me?secret=JBSWY3DPEHPK3PXP&issuer=X');
      const b = parseOtpauthUri('otpauth://totp/X:me?secret=MFRGGZDFMZTWQ2LK&issuer=X');
      const s = storeWith({ id: 'a', source: 'ga', entries: [a] }, { id: 'b', source: 'ext', entries: [b] });
      for (const acc of s.accounts()) {
        expect(acc.warnings).toEqual([
          'Same name as 1 other entry with a different secret — probably one is outdated. Check which code the site accepts and untick the other.',
        ]);
      }
    });

    it('pluralises for larger groups and matches case-insensitively', () => {
      const s = storeWith({
        id: 'a',
        source: 'ga',
        entries: [entry({ secret: SECRET_A }), entry({ secret: SECRET_B, name: 'ME' }), entry({ secret: SECRET_C, issuer: 'iss' })],
      });
      for (const acc of s.accounts()) expect(acc.warnings.join()).toMatch(/^Same name as 2 other entries with/);
    });

    it('does not flag different labels', () => {
      const s = storeWith({ id: 'a', source: 'ga', entries: [entry({ secret: SECRET_A }), entry({ secret: SECRET_B, name: 'you' })] });
      expect(s.accounts().flatMap((a) => a.warnings)).toEqual([]);
    });

    it('clears the warning once the stale entry is unticked', () => {
      const s = storeWith({ id: 'a', source: 'ga', entries: [entry({ secret: SECRET_A }), entry({ secret: SECRET_B })] });
      s.setOverride(s.accounts()[1].key, { excluded: true });
      expect(s.accounts().map((a) => a.warnings)).toEqual([[], []]);
    });

    it('uses edited labels', () => {
      const s = storeWith({ id: 'a', source: 'ga', entries: [entry({ secret: SECRET_A }), entry({ secret: SECRET_B, name: 'other' })] });
      s.setOverride('02', { name: 'me' });
      expect(s.accounts().every((a) => a.warnings.length === 1)).toBe(true);
    });
  });
});

describe('overrides', () => {
  it('applies edits and exclusions', () => {
    const s = makeStore();
    const erin = s.accounts().find((a) => a.entry.name === 'erin')!;
    s.setOverride(erin.key, { name: 'Erin' });
    const edited = s.accounts().find((a) => a.key === erin.key)!;
    expect(edited.entry.name).toBe('Erin');
    expect(edited.original.name).toBe('erin');
    expect(edited.edited).toBe(true);
    expect(edited.excluded).toBe(false);
    s.setOverride(erin.key, { excluded: true });
    const excluded = s.accounts().find((a) => a.key === erin.key)!;
    expect(excluded.excluded).toBe(true);
    expect(excluded.entry.name).toBe('Erin');
    expect(selectForScope(s.accounts(), 'missing-ext')).toHaveLength(0);
  });

  it('merges successive patches', () => {
    const s = storeWith({ id: 'a', source: 'ext', entries: [entry()] });
    s.setOverride('0102030405', { name: 'n' });
    s.setOverride('0102030405', { issuer: 'i' });
    expect(s.accounts()[0].entry).toMatchObject({ name: 'n', issuer: 'i' });
  });

  it('ignores undefined fields in a patch', () => {
    const s = storeWith({ id: 'a', source: 'ext', entries: [entry()] });
    s.setOverride('0102030405', { name: undefined, digits: 8 });
    const [acc] = s.accounts();
    expect(acc.entry.name).toBe('me');
    expect(acc.entry.digits).toBe(8);
    expect(acc.edited).toBe(true);
  });

  it('is not "edited" when the patch only has undefined fields', () => {
    const s = storeWith({ id: 'a', source: 'ext', entries: [entry()] });
    s.setOverride('0102030405', { name: undefined });
    expect(s.accounts()[0].edited).toBe(false);
  });

  it('is not "edited" when the override matches the original', () => {
    const s = storeWith({ id: 'a', source: 'ext', entries: [entry()] });
    s.setOverride('0102030405', { name: 'me', excluded: true });
    const [acc] = s.accounts();
    expect(acc.edited).toBe(false);
    expect(acc.excluded).toBe(true);
  });

  it('applies edits before computing warnings', () => {
    const s = storeWith({ id: 'a', source: 'ext', entries: [entry()] });
    s.setOverride('0102030405', { digits: 7 });
    expect(s.accounts()[0].warnings).toEqual(['Can’t go into Google Authenticator: 7 digits (Google Authenticator supports 6 or 8).']);
  });

  it('resets an account that was never overridden', () => {
    const s = storeWith({ id: 'a', source: 'ext', entries: [entry()] });
    expect(() => s.resetOverride('0102030405')).not.toThrow();
    expect(s.accounts()[0]).toMatchObject({ edited: false, excluded: false });
  });

  it('resets edits but keeps the exclusion', () => {
    const s = storeWith({ id: 'a', source: 'ext', entries: [entry()] });
    s.setOverride('0102030405', { name: 'x', excluded: true });
    s.resetOverride('0102030405');
    expect(s.accounts()[0]).toMatchObject({ edited: false, excluded: true, entry: entry() });
    s.setOverride('0102030405', { name: 'y', excluded: false });
    s.resetOverride('0102030405');
    expect(s.accounts()[0]).toMatchObject({ edited: false, excluded: false, entry: entry() });
  });
});

describe('selectForScope', () => {
  it('selects missing accounts per target', () => {
    const accounts = makeStore().accounts();
    expect(selectForScope(accounts, 'missing-ga').map((a) => a.entry.name).sort()).toEqual(['bob@example.com', 'dave']);
    expect(selectForScope(accounts, 'missing-ext').map((a) => a.entry.name)).toEqual(['erin']);
    expect(selectForScope(accounts, 'all')).toHaveLength(5);
  });

  it('leaves excluded accounts out of every scope', () => {
    const s = makeStore();
    for (const a of s.accounts()) if (a.entry.name !== 'dave') s.setOverride(a.key, { excluded: true });
    const accounts = s.accounts();
    expect(selectForScope(accounts, 'all').map((a) => a.entry.name)).toEqual(['dave']);
    expect(selectForScope(accounts, 'missing-ga').map((a) => a.entry.name)).toEqual(['dave']);
    expect(selectForScope(accounts, 'missing-ext')).toEqual([]);
  });
});
