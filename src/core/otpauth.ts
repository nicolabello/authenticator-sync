import { base32Decode, base32Encode } from './encoding';
import type { Algorithm, OtpEntry, OtpType } from './types';

const ALGORITHMS: Algorithm[] = ['SHA1', 'SHA256', 'SHA512', 'MD5'];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Display label, e.g. "Google: me@example.com". */
export function accountLabel(e: Pick<OtpEntry, 'issuer' | 'name'>): string {
  return e.issuer ? `${e.issuer}: ${e.name}` : e.name;
}

function parseQuery(q: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of q.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    // Form-style "+" means space (e.g. issuer=My+Bank); base32 secrets never contain "+".
    const value = eq < 0 ? '' : safeDecode(part.slice(eq + 1).replace(/\+/g, ' '));
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

/** Split "Issuer:account" labels. Returns the issuer prefix (possibly empty) and the account name. */
export function splitLabel(label: string): { prefix: string; name: string } {
  const idx = label.indexOf(':');
  if (idx < 0) return { prefix: '', name: label.trim() };
  return { prefix: label.slice(0, idx).trim(), name: label.slice(idx + 1).trim() };
}

/** Parse a single `otpauth://totp/...` or `otpauth://hotp/...` URI. */
export function parseOtpauthUri(uri: string): OtpEntry {
  const m = /^otpauth:\/\/(totp|hotp)\/([^?]*)(?:\?(.*))?$/i.exec(uri.trim());
  if (!m) throw new Error('Not an otpauth:// URI');
  const type = m[1].toLowerCase() as OtpType;
  // The issuer/name separator may be a literal or an encoded colon. Prefer a literal one, so an
  // encoded colon inside the issuer (as toOtpauthUri writes it) stays part of the issuer.
  const rawLabel = m[2];
  const sep = rawLabel.indexOf(':');
  const { prefix, name } =
    sep < 0
      ? splitLabel(safeDecode(rawLabel))
      : { prefix: safeDecode(rawLabel.slice(0, sep)).trim(), name: safeDecode(rawLabel.slice(sep + 1)).trim() };
  const params = parseQuery(m[3] ?? '');
  // authenticator.cc marks Steam Guard accounts this way; their codes aren't standard TOTP.
  const encoder = params.get('encoder');
  if (encoder) throw new Error(`Unsupported account type "${encoder}" (e.g. Steam) — not standard TOTP`);

  const secretStr = params.get('secret');
  if (!secretStr) throw new Error('Missing secret');
  const secret = base32Decode(secretStr);
  if (secret.length === 0) throw new Error('Empty secret');

  const algorithm = (params.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '') as Algorithm;
  if (!ALGORITHMS.includes(algorithm)) throw new Error(`Unsupported algorithm "${algorithm}"`);

  const digits = params.has('digits') ? Number(params.get('digits')) : 6;
  const period = params.has('period') ? Number(params.get('period')) : 30;
  const counter = params.has('counter') ? Number(params.get('counter')) : 0;
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) throw new Error('Invalid digits');
  if (!Number.isInteger(period) || period < 1) throw new Error('Invalid period');
  if (!Number.isInteger(counter) || counter < 0) throw new Error('Invalid counter');

  return {
    secret,
    issuer: params.get('issuer')?.trim() || prefix,
    name,
    algorithm,
    digits,
    period,
    type,
    counter,
  };
}

/** Build an `otpauth://` URI in the same shape the Chrome Authenticator extension exports. */
export function toOtpauthUri(e: OtpEntry): string {
  const enc = encodeURIComponent;
  const label = e.issuer ? `${enc(e.issuer)}:${enc(e.name)}` : enc(e.name);
  const params = [`secret=${base32Encode(e.secret)}`];
  if (e.issuer) params.push(`issuer=${enc(e.issuer)}`);
  if (e.algorithm !== 'SHA1') params.push(`algorithm=${e.algorithm}`);
  if (e.digits !== 6) params.push(`digits=${e.digits}`);
  if (e.type === 'totp' && e.period !== 30) params.push(`period=${e.period}`);
  if (e.type === 'hotp') params.push(`counter=${e.counter}`);
  return `otpauth://${e.type}/${label}?${params.join('&')}`;
}

export function toOtpauthText(entries: OtpEntry[]): string {
  return entries.map(toOtpauthUri).join('\n') + (entries.length ? '\n' : '');
}
