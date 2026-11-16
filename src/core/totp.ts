import type { OtpEntry } from './types';

const SUBTLE_HASH = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' } as const;

/** Seconds left in the current TOTP step. */
export function secondsRemaining(period: number, now = Date.now()): number {
  return period - (Math.floor(now / 1000) % period);
}

/** RFC 4226 / 6238 code generation using WebCrypto. Throws for MD5 (not supported by WebCrypto). */
export async function generateCode(e: OtpEntry, now = Date.now()): Promise<string> {
  if (e.algorithm === 'MD5') throw new Error('MD5 is not supported for preview');
  const counter = e.type === 'totp' ? Math.floor(now / 1000 / e.period) : e.counter;
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(e.secret),
    { name: 'HMAC', hash: SUBTLE_HASH[e.algorithm] },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return (bin % 10 ** e.digits).toString().padStart(e.digits, '0');
}
