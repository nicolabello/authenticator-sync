import { describe, expect, it } from 'vitest';
import { entry, parseLines, SAMPLE } from './fixtures';
import { ingestMigration, ingestQrText, ingestTextBlock } from './ingest';
import { toMigrationUris } from './migration';
import { toOtpauthUri } from './otpauth';
import { Store } from './store';

const ext = parseLines(SAMPLE);

describe('ingestMigration', () => {
  it('adds one GA item per batch, keyed by export and position', () => {
    const s = new Store();
    const uris = toMigrationUris(ext, 3, 42);
    expect(ingestMigration(s, uris[1])).toEqual({ accounts: 1, batches: 1, errors: [] });
    expect(s.getItems()).toEqual([
      {
        id: 'ga:batch:42:1:2',
        source: 'ga',
        label: 'Transfer QR 2 of 2',
        entries: [expect.objectContaining({ name: 'dave' })],
        batch: { id: 42, index: 1, size: 2 },
      },
    ]);
  });

  it('replaces a re-scanned batch', () => {
    const s = new Store();
    const [uri] = toMigrationUris(ext, 10, 1);
    ingestMigration(s, uri);
    ingestMigration(s, uri);
    expect(s.getItems()).toHaveLength(1);
  });

  it('propagates parse errors', () => {
    expect(() => ingestMigration(new Store(), 'otpauth-migration://offline?x=1')).toThrow('Missing data parameter');
  });
});

describe('ingestQrText', () => {
  it('treats transfer QRs as Google Authenticator regardless of the drop target', () => {
    const s = new Store();
    const [uri] = toMigrationUris(ext, 10, 5);
    expect(ingestQrText(s, uri, 'ext')).toEqual({ accounts: 4, batches: 1, errors: [] });
    expect(s.getItems('ga')).toHaveLength(1);
    expect(s.getItems('ext')).toHaveLength(0);
  });

  it('adds a single-account QR to the given source, keyed by secret', () => {
    const s = new Store();
    const e = entry();
    expect(ingestQrText(s, toOtpauthUri(e), 'ext')).toEqual({ accounts: 1, batches: 0, errors: [] });
    expect(s.getItems()).toEqual([{ id: 'ext:qr:0102030405', source: 'ext', label: 'QR: Iss: me', entries: [e] }]);
    ingestQrText(s, toOtpauthUri(e), 'ga');
    expect(s.getItems().map((i) => i.id)).toEqual(['ext:qr:0102030405', 'ga:qr:0102030405']);
  });

  it('throws on non-OTP text', () => {
    expect(() => ingestQrText(new Store(), 'https://example.com', 'ext')).toThrow('Not an otpauth:// URI');
  });
});

describe('ingestTextBlock', () => {
  it('loads a text block, skipping bad lines and creating no empty items', () => {
    const s = new Store();
    const r = ingestTextBlock(s, SAMPLE + '\n\nnot a uri\n', 'ext', 'f', 'file');
    expect(r).toEqual({ accounts: 4, batches: 0, errors: ['Line 6: Not an otpauth:// URI'] });
    expect(s.getItems()).toEqual([{ id: 'f', source: 'ext', label: 'file', entries: ext }]);
    expect(ingestTextBlock(s, 'garbage', 'ext', 'g', 'bad')).toEqual({ accounts: 0, batches: 0, errors: ['Line 1: Not an otpauth:// URI'] });
    expect(s.getItems()).toHaveLength(1);
  });

  it('handles CRLF line endings and surrounding whitespace', () => {
    const s = new Store();
    const r = ingestTextBlock(s, SAMPLE.split('\n').map((l) => `  ${l}\t`).join('\r\n'), 'ga', 'id', 'label');
    expect(r).toEqual({ accounts: 4, batches: 0, errors: [] });
    expect(s.getItems('ga')[0].entries).toEqual(ext);
  });

  it('routes transfer links to GA batches and counts them', () => {
    const s = new Store();
    const uris = toMigrationUris(ext, 2, 9);
    const text = [uris[0], SAMPLE.split('\n')[0], uris[1]].join('\n');
    expect(ingestTextBlock(s, text, 'ext', 'pasted', 'Pasted')).toEqual({ accounts: 5, batches: 2, errors: [] });
    expect(s.getItems().map((i) => i.id).sort()).toEqual(['ga:batch:9:0:2', 'ga:batch:9:1:2', 'pasted']);
  });

  it('reports broken transfer links with their line number', () => {
    const r = ingestTextBlock(new Store(), '\notpauth-migration://offline?nodata', 'ga', 'x', 'x');
    expect(r).toEqual({ accounts: 0, batches: 0, errors: ['Line 2: Missing data parameter'] });
  });

  it('does nothing for empty text', () => {
    const s = new Store();
    expect(ingestTextBlock(s, '\n  \n', 'ext', 'x', 'x')).toEqual({ accounts: 0, batches: 0, errors: [] });
    expect(s.getItems()).toEqual([]);
  });
});
