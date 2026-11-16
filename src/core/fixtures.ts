// Shared test data. All secrets are fake test values.
import { parseOtpauthUri } from './otpauth';
import type { OtpEntry } from './types';

export const SAMPLE = [
  'otpauth://totp/ExampleCo:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ExampleCo',
  'otpauth://totp/Other:bob%40example.com?secret=kvkfkrcpnzqueqcbgjzheqrsgm&issuer=Other',
  'otpauth://totp/NoIssuerParam:carol?secret=GEZDGNBVGY3TQOJQ',
  'otpauth://totp/Fast:dave?secret=MFRGGZDFMZTWQ2LK&issuer=Fast&period=60&digits=8&algorithm=SHA256',
].join('\n');

export const parseLines = (text: string): OtpEntry[] => text.split('\n').filter(Boolean).map(parseOtpauthUri);

export function entry(overrides: Partial<OtpEntry> = {}): OtpEntry {
  return {
    secret: new Uint8Array([1, 2, 3, 4, 5]),
    issuer: 'Iss',
    name: 'me',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    type: 'totp',
    counter: 0,
    ...overrides,
  };
}
