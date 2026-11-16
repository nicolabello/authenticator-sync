import { toHex } from './encoding';
import { gaIncompatibility } from './migration';
import type { Algorithm, OtpEntry, SourceKind } from './types';

/**
 * One loaded input (a text file, a pasted block, a Google Authenticator batch QR, a single QR).
 * Items are keyed by `id`, so loading the same thing twice replaces rather than duplicates it.
 */
export interface SourceItem {
  id: string;
  source: SourceKind;
  label: string;
  entries: OtpEntry[];
}

/** User edits, keyed by account key. */
export interface Override {
  issuer?: string;
  name?: string;
  algorithm?: Algorithm;
  digits?: number;
  period?: number;
  excluded?: boolean;
}

export interface Account {
  /** Identity: hex of the secret bytes. Same secret ⇒ same account, whatever the labels say. */
  key: string;
  /** Current values (first-seen values with user overrides applied). */
  entry: OtpEntry;
  /** First-seen values, before edits. */
  original: OtpEntry;
  occurrences: Record<SourceKind, OtpEntry[]>;
  edited: boolean;
  excluded: boolean;
  warnings: string[];
}

export type Scope = 'all' | 'missing-ga' | 'missing-ext';

export const SCOPE_LABEL: Record<Scope, string> = {
  all: 'All accounts',
  'missing-ga': 'Only missing from Google Authenticator',
  'missing-ext': 'Only missing from Chrome extension',
};

export function accountKey(e: OtpEntry): string {
  return toHex(e.secret);
}

function labelOf(e: OtpEntry): string {
  return e.issuer ? `${e.issuer}: ${e.name}` : e.name;
}

function settingsOf(e: OtpEntry): string {
  return `${e.type} ${e.algorithm} ${e.digits} digits${e.type === 'totp' ? ` ${e.period}s` : ''}`;
}

export class Store {
  private items = new Map<string, SourceItem>();
  private overrides = new Map<string, Override>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  upsertItem(item: SourceItem): void {
    this.items.set(item.id, item);
    this.emit();
  }

  removeItem(id: string): void {
    this.items.delete(id);
    this.emit();
  }

  clearSource(source: SourceKind): void {
    for (const [id, item] of this.items) if (item.source === source) this.items.delete(id);
    this.emit();
  }

  getItems(source?: SourceKind): SourceItem[] {
    return [...this.items.values()].filter((i) => !source || i.source === source);
  }

  hasSource(source: SourceKind): boolean {
    return this.getItems(source).some((i) => i.entries.length > 0);
  }

  setOverride(key: string, patch: Override): void {
    const next = { ...this.overrides.get(key), ...patch };
    this.overrides.set(key, next);
    this.emit();
  }

  resetOverride(key: string): void {
    const excluded = this.overrides.get(key)?.excluded;
    this.overrides.set(key, excluded ? { excluded } : {});
    this.emit();
  }

  accounts(): Account[] {
    const byKey = new Map<string, Account>();
    for (const item of this.items.values()) {
      for (const e of item.entries) {
        const key = accountKey(e);
        let acc = byKey.get(key);
        if (!acc) {
          acc = {
            key,
            entry: e,
            original: e,
            occurrences: { ga: [], ext: [] },
            edited: false,
            excluded: false,
            warnings: [],
          };
          byKey.set(key, acc);
        }
        acc.occurrences[item.source].push(e);
      }
    }

    const accounts = [...byKey.values()];
    for (const acc of accounts) {
      // Prefer the extension's view as the base: it can carry the period, GA's cannot.
      acc.original = acc.occurrences.ext[0] ?? acc.occurrences.ga[0];
      const o = this.overrides.get(acc.key) ?? {};
      const { excluded, ...fields } = o;
      acc.entry = { ...acc.original, ...stripUndefined(fields) };
      acc.excluded = !!excluded;
      acc.edited = (Object.keys(fields) as (keyof typeof fields)[]).some(
        (k) => fields[k] !== undefined && fields[k] !== acc.original[k],
      );
      acc.warnings = computeWarnings(acc);
    }

    // Same label, different secret: probably a stale or re-enrolled account.
    const byLabel = new Map<string, Account[]>();
    for (const acc of accounts) {
      const l = labelOf(acc.entry).toLowerCase();
      byLabel.set(l, [...(byLabel.get(l) ?? []), acc]);
    }
    for (const group of byLabel.values()) {
      if (group.length > 1) {
        for (const acc of group) {
          acc.warnings.push(
            `Same issuer/account as ${group.length - 1} other entr${group.length > 2 ? 'ies' : 'y'} with a different secret — one is probably stale. Compare live codes with the real site/app.`,
          );
        }
      }
    }
    return accounts;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function computeWarnings(acc: Account): string[] {
  const w: string[] = [];
  for (const source of ['ga', 'ext'] as const) {
    const n = acc.occurrences[source].length;
    if (n > 1) w.push(`Appears ${n}× in the ${source === 'ga' ? 'Google Authenticator' : 'Chrome extension'} data (duplicate).`);
  }
  const all = [...acc.occurrences.ga, ...acc.occurrences.ext];
  const labels = new Set(all.map((e) => labelOf(e)));
  if (labels.size > 1) w.push(`Labelled differently across sources: ${[...labels].map((l) => `“${l}”`).join(', ')}.`);
  // GA can't carry a period, so only compare settings it does carry.
  const settings = new Set(all.map((e) => `${e.type} ${e.algorithm} ${e.digits}`));
  if (settings.size > 1) w.push(`Settings differ across sources: ${[...new Set(all.map(settingsOf))].join(' vs ')}.`);
  const ga = gaIncompatibility(acc.entry);
  if (ga) w.push(`Can’t be transferred to Google Authenticator: ${ga}.`);
  if (acc.entry.algorithm !== 'SHA1')
    w.push(`Uses ${acc.entry.algorithm}; some apps (notably Google Authenticator) may silently use SHA1 instead.`);
  return w;
}

/** Accounts that should go into an export for the given scope. */
export function selectForScope(accounts: Account[], scope: Scope): Account[] {
  return accounts.filter((a) => {
    if (a.excluded) return false;
    if (scope === 'missing-ga') return a.occurrences.ga.length === 0;
    if (scope === 'missing-ext') return a.occurrences.ext.length === 0;
    return true;
  });
}
