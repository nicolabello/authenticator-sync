export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512' | 'MD5';
export type OtpType = 'totp' | 'hotp';

/** One OTP account as described by a single source (a line, a QR code, a migration entry). */
export interface OtpEntry {
  /** Raw secret bytes (decoded from base32). Used as the identity of an account. */
  secret: Uint8Array;
  issuer: string;
  /** Account name, without the "Issuer:" prefix. */
  name: string;
  algorithm: Algorithm;
  digits: number;
  /** TOTP step in seconds. Google Authenticator's transfer format cannot carry it (always 30). */
  period: number;
  type: OtpType;
  /** HOTP counter (ignored for TOTP). */
  counter: number;
}

/** Where an entry came from. */
export type SourceKind = 'ga' | 'ext';

export const SOURCE_LABEL: Record<SourceKind, string> = {
  ga: 'Google Authenticator',
  ext: 'Chrome extension',
};
