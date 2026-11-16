/**
 * Google Authenticator "Transfer accounts" format:
 *   otpauth-migration://offline?data=<base64 protobuf MigrationPayload>
 *
 * message MigrationPayload {
 *   repeated OtpParameters otp_parameters = 1;
 *   int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5;
 * }
 * message OtpParameters {
 *   bytes secret = 1; string name = 2; string issuer = 3;
 *   Algorithm algorithm = 4;   // 0 unspecified, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5
 *   DigitCount digits = 5;     // 0 unspecified, 1 SIX, 2 EIGHT
 *   OtpType type = 6;          // 0 unspecified, 1 HOTP, 2 TOTP
 *   int64 counter = 7;
 * }
 * There is no period field: Google Authenticator always uses 30 seconds.
 */
import { base64Decode, base64Encode } from './encoding';
import { splitLabel } from './otpauth';
import { ProtoReader, ProtoWriter } from './protobuf';
import type { Algorithm, OtpEntry } from './types';

const ALG_FROM_PB: Record<number, Algorithm> = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const ALG_TO_PB: Record<Algorithm, number> = { SHA1: 1, SHA256: 2, SHA512: 3, MD5: 4 };

export interface MigrationBatch {
  entries: OtpEntry[];
  version: number;
  batchSize: number;
  batchIndex: number;
  batchId: number;
}

function parseOtpParameters(buf: Uint8Array): OtpEntry {
  const r = new ProtoReader(buf);
  let secret: Uint8Array = new Uint8Array();
  let name = '';
  let issuer = '';
  let algorithm: Algorithm = 'SHA1';
  let digits = 6;
  let type: 'totp' | 'hotp' = 'totp';
  let counter = 0;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: secret = r.bytes(); break;
      case 2: name = r.string(); break;
      case 3: issuer = r.string(); break;
      case 4: algorithm = ALG_FROM_PB[r.int()] ?? 'SHA1'; break;
      case 5: digits = r.int() === 2 ? 8 : 6; break;
      case 6: type = r.int() === 1 ? 'hotp' : 'totp'; break;
      case 7: counter = r.int(); break;
      default: r.skip(wire);
    }
  }
  // Google Authenticator often stores the name as "Issuer:account".
  const split = splitLabel(name);
  if (split.prefix && (!issuer || split.prefix.toLowerCase() === issuer.toLowerCase())) {
    issuer = issuer || split.prefix;
    name = split.name;
  }
  return { secret, name: name.trim(), issuer: issuer.trim(), algorithm, digits, period: 30, type, counter };
}

export function decodeMigrationPayload(buf: Uint8Array): MigrationBatch {
  const r = new ProtoReader(buf);
  const batch: MigrationBatch = { entries: [], version: 0, batchSize: 1, batchIndex: 0, batchId: 0 };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: batch.entries.push(parseOtpParameters(r.bytes())); break;
      case 2: batch.version = r.int(); break;
      case 3: batch.batchSize = r.int(); break;
      case 4: batch.batchIndex = r.int(); break;
      case 5: batch.batchId = r.int(); break;
      default: r.skip(wire);
    }
  }
  return batch;
}

export function isMigrationUri(s: string): boolean {
  return /^otpauth-migration:\/\//i.test(s.trim());
}

export function parseMigrationUri(uri: string): MigrationBatch {
  const m = /^otpauth-migration:\/\/offline\?(.*)$/i.exec(uri.trim());
  if (!m) throw new Error('Not an otpauth-migration:// URI');
  const dataParam = m[1].split('&').find((p) => p.toLowerCase().startsWith('data='));
  if (!dataParam) throw new Error('Missing data parameter');
  // decodeURIComponent, but keep "+" (base64) intact — some scanners don't escape it.
  const b64 = decodeURIComponent(dataParam.slice(5)).replace(/ /g, '+');
  return decodeMigrationPayload(base64Decode(b64));
}

function encodeOtpParameters(e: OtpEntry): ProtoWriter {
  return new ProtoWriter()
    .bytes(1, e.secret)
    .string(2, e.name)
    .string(3, e.issuer)
    .int(4, ALG_TO_PB[e.algorithm])
    .int(5, e.digits === 8 ? 2 : 1)
    .int(6, e.type === 'hotp' ? 1 : 2)
    .int(7, e.type === 'hotp' ? e.counter : 0);
}

export function encodeMigrationPayload(batch: Omit<MigrationBatch, 'version'>): Uint8Array {
  const w = new ProtoWriter();
  for (const e of batch.entries) w.message(1, encodeOtpParameters(e));
  return w.int(2, 1).int(3, batch.batchSize).int(4, batch.batchIndex).int(5, batch.batchId).finish();
}

/** Why an entry cannot be faithfully transferred into Google Authenticator, or null if it can. */
export function gaIncompatibility(e: OtpEntry): string | null {
  if (e.type === 'totp' && e.period !== 30) return `period is ${e.period}s (Google Authenticator only supports 30s)`;
  if (e.digits !== 6 && e.digits !== 8) return `${e.digits} digits (Google Authenticator supports 6 or 8)`;
  return null;
}

/**
 * Split entries into Google Authenticator transfer QR payloads.
 * Smaller batches give less dense QR codes that phones scan more reliably.
 */
export function toMigrationUris(entries: OtpEntry[], perBatch = 10, batchId = randomBatchId()): string[] {
  const size = Math.max(1, Math.floor(perBatch));
  const chunks: OtpEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) chunks.push(entries.slice(i, i + size));
  return chunks.map((chunk, batchIndex) => {
    const payload = encodeMigrationPayload({ entries: chunk, batchSize: chunks.length, batchIndex, batchId });
    return `otpauth-migration://offline?data=${encodeURIComponent(base64Encode(payload))}`;
  });
}

function randomBatchId(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] & 0x7fffffff;
}
