import { base32Encode } from '../core/encoding';
import type { Account, Store } from '../core/store';
import { generateCode, secondsRemaining } from '../core/totp';
import type { Algorithm } from '../core/types';
import { $, copyText, h } from './dom';

type Filter = 'all' | 'issues' | 'missing-ga' | 'missing-ext' | 'both';

const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  issues: 'With warnings',
  both: 'In both',
  'missing-ga': 'Missing from Google Authenticator',
  'missing-ext': 'Missing from extension',
};

const ui = {
  filter: 'all' as Filter,
  search: '',
  revealed: new Set<string>(),
  openSettings: new Set<string>(),
};

let current: Account[] = [];

function matches(a: Account, filter: Filter = ui.filter, search: string = ui.search): boolean {
  const inGa = a.occurrences.ga.length > 0;
  const inExt = a.occurrences.ext.length > 0;
  switch (filter) {
    case 'issues': if (!a.warnings.length) return false; break;
    case 'both': if (!(inGa && inExt)) return false; break;
    case 'missing-ga': if (inGa) return false; break;
    case 'missing-ext': if (inExt) return false; break;
  }
  const q = search.trim().toLowerCase();
  return !q || `${a.entry.issuer} ${a.entry.name}`.toLowerCase().includes(q);
}

function groupSecret(s: string): string {
  return s.replace(/(.{4})/g, '$1 ').trim();
}

function presence(a: Account, source: 'ga' | 'ext'): HTMLElement {
  const n = a.occurrences[source].length;
  const label = source === 'ga' ? 'Google Authenticator' : 'extension';
  if (!n) return h('span', { class: 'badge missing', title: `Not in ${label}` }, '—');
  return h('span', { class: `badge ${n > 1 ? 'dup' : 'present'}`, title: n > 1 ? `${n} copies in ${label}` : `In ${label}` }, n > 1 ? `✓ ×${n}` : '✓');
}

function settingsEditor(store: Store, a: Account): HTMLElement {
  const e = a.entry;
  const set = (patch: Parameters<Store['setOverride']>[1]) => store.setOverride(a.key, patch);
  const details = h(
    'details',
    { open: ui.openSettings.has(a.key) },
    h('summary', {}, `${e.type.toUpperCase()} · ${e.algorithm} · ${e.digits} digits${e.type === 'totp' ? ` · ${e.period}s` : ''}`),
    h(
      'div',
      { class: 'settings' },
      h('p', { class: 'warn' }, 'Only change these if they are wrong — the site decides them, and a mismatch produces invalid codes.'),
      h(
        'label',
        {},
        'Algorithm ',
        h(
          'select',
          { onchange: (ev: Event) => set({ algorithm: (ev.target as HTMLSelectElement).value as Algorithm }) },
          (['SHA1', 'SHA256', 'SHA512', 'MD5'] as const).map((alg) => h('option', { value: alg, selected: alg === e.algorithm }, alg)),
        ),
      ),
      h(
        'label',
        {},
        'Digits ',
        h('input', {
          type: 'number', min: 6, max: 8, value: String(e.digits),
          onchange: (ev: Event) => set({ digits: Number((ev.target as HTMLInputElement).value) || 6 }),
        }),
      ),
      e.type === 'totp' &&
        h(
          'label',
          {},
          'Period (s) ',
          h('input', {
            type: 'number', min: 1, value: String(e.period),
            onchange: (ev: Event) => set({ period: Number((ev.target as HTMLInputElement).value) || 30 }),
          }),
        ),
    ),
  );
  details.addEventListener('toggle', () => {
    if (details.open) ui.openSettings.add(a.key);
    else ui.openSettings.delete(a.key);
  });
  return details;
}

function row(store: Store, a: Account): HTMLTableRowElement {
  const secret = base32Encode(a.entry.secret);
  const revealed = ui.revealed.has(a.key);
  const label = `${a.entry.issuer || '(no issuer)'} ${a.entry.name}`;
  return h(
    'tr',
    { class: [a.excluded && 'excluded', a.warnings.length && 'has-warnings'].filter(Boolean).join(' ') },
    h(
      'td',
      {},
      h('input', {
        type: 'checkbox', checked: !a.excluded, 'aria-label': `Include ${label} in exports`,
        onchange: (ev: Event) => store.setOverride(a.key, { excluded: !(ev.target as HTMLInputElement).checked }),
      }),
    ),
    h(
      'td',
      {},
      h('input', {
        type: 'text', value: a.entry.issuer, 'aria-label': 'Issuer', placeholder: 'Issuer', class: 'cell-input', 'data-focus': `${a.key}:issuer`,
        onchange: (ev: Event) => store.setOverride(a.key, { issuer: (ev.target as HTMLInputElement).value.trim() }),
      }),
    ),
    h(
      'td',
      {},
      h('input', {
        type: 'text', value: a.entry.name, 'aria-label': 'Account name', placeholder: 'Account', class: 'cell-input', 'data-focus': `${a.key}:name`,
        onchange: (ev: Event) => store.setOverride(a.key, { name: (ev.target as HTMLInputElement).value.trim() }),
      }),
    ),
    h('td', { class: 'code' }, h('span', { 'data-code': a.key }, '······')),
    h('td', { class: 'center' }, presence(a, 'ga')),
    h('td', { class: 'center' }, presence(a, 'ext')),
    h(
      'td',
      { class: 'secret' },
      h('code', {}, revealed ? groupSecret(secret) : '•••• •••• ••••'),
      h('button', {
        type: 'button', class: 'link',
        onclick: () => { if (revealed) ui.revealed.delete(a.key); else ui.revealed.add(a.key); render(store); },
      }, revealed ? 'Hide' : 'Show'),
      h('button', { type: 'button', class: 'link', onclick: () => copyText(secret) }, 'Copy'),
    ),
    h('td', {}, settingsEditor(store, a)),
    h(
      'td',
      { class: 'notes' },
      a.edited && h('p', {}, h('span', { class: 'badge edited' }, 'Edited'), ' ', h('button', { type: 'button', class: 'link', onclick: () => store.resetOverride(a.key) }, 'Undo edits')),
      a.warnings.length ? h('ul', { class: 'warnings' }, a.warnings.map((w) => h('li', {}, w))) : null,
    ),
  );
}

/** Re-rendering replaces the table; put keyboard focus back where it was (e.g. after Tab). */
function render(store: Store): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  renderInner(store);
  if (focused) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

function renderInner(store: Store): void {
  const root = $('#accounts');
  current = store.accounts();
  if (!current.length) {
    root.replaceChildren(h('p', { class: 'empty' }, 'No accounts loaded yet.'));
    return;
  }
  const count = (f: Filter) => current.filter((a) => matches(a, f, '')).length;

  const hasGa = store.hasSource('ga');
  const hasExt = store.hasSource('ext');
  const filters: Filter[] = ['all', 'issues', ...(hasGa && hasExt ? (['both', 'missing-ga', 'missing-ext'] as Filter[]) : [])];
  if (!filters.includes(ui.filter)) ui.filter = 'all';

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'filters', role: 'group', 'aria-label': 'Filter accounts' },
      filters.map((f) =>
        h('button', { type: 'button', 'aria-pressed': String(ui.filter === f), onclick: () => { ui.filter = f; render(store); } }, `${FILTER_LABEL[f]} (${count(f)})`),
      ),
    ),
    h('input', {
      type: 'search', placeholder: 'Search issuer or account', value: ui.search, 'aria-label': 'Search accounts',
      oninput: (ev: Event) => { ui.search = (ev.target as HTMLInputElement).value; renderBody(store); },
    }),
  );

  const table = h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Include')),
        h('th', { scope: 'col' }, 'Issuer'),
        h('th', { scope: 'col' }, 'Account'),
        h('th', { scope: 'col' }, 'Code'),
        h('th', { scope: 'col', title: 'Google Authenticator' }, 'GA'),
        h('th', { scope: 'col', title: 'Chrome extension' }, 'Ext'),
        h('th', { scope: 'col' }, 'Secret'),
        h('th', { scope: 'col' }, 'Settings'),
        h('th', { scope: 'col' }, 'Notes'),
      ),
    ),
    h('tbody', {}),
  );
  root.replaceChildren(
    h('p', { class: 'summary' }, summaryText(current, hasGa, hasExt)),
    toolbar,
    h('div', { class: 'table-wrap' }, table),
  );
  renderBody(store);
}

function renderBody(store: Store): void {
  const tbody = $('#accounts tbody');
  const rows = current.filter((a) => matches(a)).map((a) => row(store, a));
  tbody.replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 9, class: 'empty' }, 'No accounts match.'))]));
  void tickCodes();
}

function summaryText(accounts: Account[], hasGa: boolean, hasExt: boolean): string {
  const parts = [`${accounts.length} unique account${accounts.length === 1 ? '' : 's'}`];
  if (hasGa) parts.push(`${accounts.filter((a) => a.occurrences.ga.length).length} in Google Authenticator`);
  if (hasExt) parts.push(`${accounts.filter((a) => a.occurrences.ext.length).length} in the extension`);
  const dupes = accounts.filter((a) => a.occurrences.ga.length > 1 || a.occurrences.ext.length > 1).length;
  if (dupes) parts.push(`${dupes} duplicated within a source`);
  return parts.join(' · ') + '.';
}

async function tickCodes(): Promise<void> {
  const now = Date.now();
  const byKey = new Map(current.map((a) => [a.key, a]));
  for (const el of document.querySelectorAll<HTMLElement>('[data-code]')) {
    const a = byKey.get(el.dataset.code!);
    if (!a) continue;
    try {
      const code = await generateCode(a.entry, now);
      el.textContent = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
      el.title = a.entry.type === 'totp' ? `${secondsRemaining(a.entry.period, now)}s left` : `HOTP counter ${a.entry.counter}`;
    } catch {
      el.textContent = 'n/a';
      el.title = 'Preview not available for this algorithm';
    }
  }
}

export function setupAccounts(store: Store): void {
  store.subscribe(() => render(store));
  render(store);
  setInterval(() => void tickCodes(), 1000);
}
