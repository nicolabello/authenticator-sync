import { isMigrationUri, parseMigrationUri } from './migration';
import { parseOtpauthUri } from './otpauth';
import { accountKey, type Store } from './store';
import type { OtpEntry, SourceKind } from './types';

export interface IngestResult {
  accounts: number;
  batches: number;
  errors: string[];
}

function labelOf(e: OtpEntry): string {
  return e.issuer ? `${e.issuer}: ${e.name}` : e.name;
}

/** Add one Google Authenticator transfer QR payload. Re-scanning the same batch replaces it. */
export function ingestMigration(store: Store, uri: string): IngestResult {
  const batch = parseMigrationUri(uri);
  store.upsertItem({
    id: `ga:batch:${batch.batchId}:${batch.batchIndex}:${batch.batchSize}`,
    source: 'ga',
    label: `Transfer QR ${batch.batchIndex + 1} of ${batch.batchSize}`,
    entries: batch.entries,
  });
  return { accounts: batch.entries.length, batches: 1, errors: [] };
}

/**
 * Handle one decoded QR text. Transfer QRs always count as Google Authenticator;
 * single-account otpauth:// QRs count for whichever source the user dropped them on.
 */
export function ingestQrText(store: Store, text: string, source: SourceKind): IngestResult {
  if (isMigrationUri(text)) return ingestMigration(store, text);
  const entry = parseOtpauthUri(text);
  store.upsertItem({ id: `${source}:qr:${accountKey(entry)}`, source, label: `QR: ${labelOf(entry)}`, entries: [entry] });
  return { accounts: 1, batches: 0, errors: [] };
}

/**
 * Handle a block of text: otpauth:// lines become one item for `source` (replacing any
 * previous item with the same id); otpauth-migration:// lines are treated as GA batches.
 */
export function ingestTextBlock(store: Store, text: string, source: SourceKind, id: string, label: string): IngestResult {
  const result: IngestResult = { accounts: 0, batches: 0, errors: [] };
  const entries: OtpEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    try {
      if (isMigrationUri(line)) {
        const r = ingestMigration(store, line);
        result.accounts += r.accounts;
        result.batches += 1;
      } else {
        entries.push(parseOtpauthUri(line));
      }
    } catch (err) {
      result.errors.push(`Line ${i + 1}: ${(err as Error).message}`);
    }
  });
  if (entries.length || result.batches === 0) {
    store.upsertItem({ id, source, label, entries });
    result.accounts += entries.length;
  }
  return result;
}
