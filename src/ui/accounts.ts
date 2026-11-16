import { base32Encode } from '../core/encoding';
import type { Account, Override, Store } from '../core/store';
import { generateCode, secondsRemaining } from '../core/totp';
import type { Algorithm, OtpEntry } from '../core/types';
import { $, copyText, h } from './dom';

type Filter = 'all' | 'issues' | 'both' | 'missing-ga' | 'missing-ext';

const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  issues: 'Needs attention',
  both: 'In both apps',
  'missing-ga': 'Not in Google Authenticator',
  'missing-ext': 'Not in extension',
};

const ui = {
  filter: 'all' as Filter,
  search: '',
  revealed: new Set<string>(),
  expanded: new Set<string>(),
};

/**
 * Rows are created once per account and then patched in place, so a re-render never
 * destroys the element the user is typing in, tabbing to, or clicking.
 */
interface RowEls {
  tr: HTMLTableRowElement;
  include: HTMLInputElement;
  issuer: HTMLInputElement;
  name: HTMLInputElement;
  code: HTMLElement;
  ttl: HTMLElement;
  pills: HTMLElement;
  notes: HTMLElement;
  more: HTMLButtonElement;
  details?: HTMLTableRowElement;
  detailsSig?: string;
}

const rowCache = new Map<string, RowEls>();
let current: Account[] = [];
let byKey = new Map<string, Account>();

let els: {
  empty: HTMLElement;
  content: HTMLElement;
  summary: HTMLElement;
  batchWarning: HTMLElement;
  filters: HTMLElement;
  tbody: HTMLTableSectionElement;
  noMatch: HTMLTableRowElement;
};

function matches(a: Account, filter: Filter, search: string): boolean {
  const inGa = a.occurrences.ga.length > 0;
  const inExt = a.occurrences.ext.length > 0;
  if (filter === 'issues' && !a.warnings.length) return false;
  if (filter === 'both' && !(inGa && inExt)) return false;
  if (filter === 'missing-ga' && inGa) return false;
  if (filter === 'missing-ext' && inExt) return false;
  const q = search.trim().toLowerCase();
  return !q || `${a.entry.issuer} ${a.entry.name}`.toLowerCase().includes(q);
}

function presence(a: Account, source: 'ga' | 'ext'): HTMLElement {
  const n = a.copies[source];
  const short = source === 'ga' ? 'GA' : 'Ext';
  const long = source === 'ga' ? 'Google Authenticator' : 'the extension';
  if (!n) return h('span', { class: 'pill absent', title: `Not in ${long}` }, short);
  if (n > 1) return h('span', { class: 'pill dup', title: `${n} copies in ${long}` }, `${short} ×${n}`);
  return h('span', { class: 'pill present', title: `In ${long}` }, short);
}

function isDefaultSettings(e: OtpEntry): boolean {
  return e.type === 'totp' && e.algorithm === 'SHA1' && e.digits === 6 && e.period === 30;
}

function settingsSummary(e: OtpEntry): string {
  return `${e.type.toUpperCase()} · ${e.algorithm} · ${e.digits} digits · ${e.type === 'totp' ? `every ${e.period}s` : `counter ${e.counter}`}`;
}

function createRow(store: Store, key: string): RowEls {
  const textInput = (field: 'issuer' | 'name') =>
    h('input', {
      type: 'text',
      class: 'cell-input',
      placeholder: field === 'issuer' ? '(no issuer)' : '(no name)',
      'data-focus': `${key}:${field}`,
      onchange: (ev: Event) => store.setOverride(key, { [field]: (ev.target as HTMLInputElement).value.trim() }),
    });
  const r: RowEls = {
    tr: h('tr', {}),
    include: h('input', {
      type: 'checkbox',
      'data-focus': `${key}:include`,
      onchange: (ev: Event) => store.setOverride(key, { excluded: !(ev.target as HTMLInputElement).checked }),
    }),
    issuer: textInput('issuer'),
    name: textInput('name'),
    code: h('span', { class: 'code-value' }, '··· ···'),
    ttl: h('span', { class: 'ttl' }),
    pills: h('td', { class: 'pills' }),
    notes: h('td', { class: 'notes' }),
    more: h('button', {
      type: 'button',
      class: 'link',
      'data-focus': `${key}:more`,
      onclick: () => {
        if (ui.expanded.has(key)) ui.expanded.delete(key);
        else ui.expanded.add(key);
        render(store);
      },
    }),
  };
  r.code.dataset.code = key;
  r.tr.append(
    h('td', { class: 'center' }, r.include),
    h('td', {}, r.issuer),
    h('td', {}, r.name),
    h('td', { class: 'code' }, r.code, r.ttl),
    r.pills,
    r.notes,
    h('td', {}, r.more),
  );
  return r;
}

function updateRow(store: Store, r: RowEls, a: Account): void {
  const label = `${a.entry.issuer} ${a.entry.name}`.trim();
  r.tr.className = [a.excluded && 'excluded', a.warnings.length && 'has-warnings'].filter(Boolean).join(' ');
  r.include.checked = !a.excluded;
  r.include.setAttribute('aria-label', `Include ${label} in exports`);
  // Never overwrite what the user is typing.
  if (document.activeElement !== r.issuer) r.issuer.value = a.entry.issuer;
  if (document.activeElement !== r.name) r.name.value = a.entry.name;
  r.issuer.setAttribute('aria-label', `Issuer for ${label}`);
  r.name.setAttribute('aria-label', `Account name for ${label}`);
  r.pills.replaceChildren(presence(a, 'ga'), presence(a, 'ext'));
  r.notes.replaceChildren(
    a.edited ? h('span', { class: 'pill edited' }, 'Edited') : '',
    a.warnings.length ? h('ul', { class: 'warnings' }, a.warnings.map((w) => h('li', {}, w))) : '',
    isDefaultSettings(a.entry) ? '' : h('span', { class: 'hint' }, settingsSummary(a.entry)),
  );
  const expanded = ui.expanded.has(a.key);
  r.more.textContent = expanded ? 'Less' : 'More';
  r.more.setAttribute('aria-expanded', String(expanded));
  r.more.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} secret and settings for ${label}`);

  if (!expanded) {
    r.details = undefined;
    r.detailsSig = undefined;
    return;
  }
  const sig = JSON.stringify([a.entry.algorithm, a.entry.digits, a.entry.period, a.edited, ui.revealed.has(a.key)]);
  if (r.detailsSig !== sig) {
    r.details = detailsRow(store, a);
    r.detailsSig = sig;
  }
}

/** Second row, shown on demand: the secret and the rarely-needed code settings. */
function detailsRow(store: Store, a: Account): HTMLTableRowElement {
  const e = a.entry;
  const key = a.key;
  const secret = base32Encode(e.secret);
  const revealed = ui.revealed.has(key);
  const set = (patch: Override) => store.setOverride(key, patch);
  return h(
    'tr',
    { class: 'details-row' },
    h(
      'td',
      { colspan: 7 },
      h(
        'div',
        { class: 'details' },
        h(
          'section',
          {},
          h('h4', {}, 'Secret key'),
          h('code', { class: 'secret' }, revealed ? secret.replace(/(.{4})/g, '$1 ').trim() : '•••• •••• •••• ••••'),
          h(
            'div',
            { class: 'row' },
            h('button', {
              type: 'button',
              'data-focus': `${key}:reveal`,
              onclick: () => {
                if (revealed) ui.revealed.delete(key);
                else ui.revealed.add(key);
                render(store);
              },
            }, revealed ? 'Hide' : 'Show'),
            h('button', { type: 'button', onclick: () => copyText(secret) }, 'Copy'),
          ),
        ),
        h(
          'section',
          {},
          h('h4', {}, 'Code settings'),
          h('p', { class: 'hint' }, 'Chosen by the website. Only change them if the codes are wrong.'),
          h(
            'div',
            { class: 'row' },
            h('label', {}, 'Algorithm ', h(
              'select',
              { 'data-focus': `${key}:algorithm`, onchange: (ev: Event) => set({ algorithm: (ev.target as HTMLSelectElement).value as Algorithm }) },
              (['SHA1', 'SHA256', 'SHA512', 'MD5'] as const).map((alg) => h('option', { value: alg, selected: alg === e.algorithm }, alg)),
            )),
            h('label', {}, 'Digits ', h(
              'select',
              { 'data-focus': `${key}:digits`, onchange: (ev: Event) => set({ digits: Number((ev.target as HTMLSelectElement).value) }) },
              [...new Set([6, 7, 8, e.digits])].sort((x, y) => x - y).map((d) => h('option', { value: String(d), selected: d === e.digits }, String(d))),
            )),
            e.type === 'totp' &&
              h('label', {}, 'Every ', h('input', {
                type: 'number', min: 1, step: 1, value: String(e.period), 'data-focus': `${key}:period`,
                onchange: (ev: Event) => {
                  const input = ev.target as HTMLInputElement;
                  const v = Number(input.value);
                  if (Number.isInteger(v) && v >= 1) set({ period: v });
                  else input.value = String(e.period);
                },
              }), ' seconds'),
          ),
        ),
        a.edited
          ? h('section', {}, h('h4', {}, 'Your edits'), h('button', { type: 'button', onclick: () => store.resetOverride(key) }, 'Undo all edits to this account'))
          : '',
      ),
    ),
  );
}

function summaryText(accounts: Account[], hasGa: boolean, hasExt: boolean): string {
  const parts = [`${accounts.length} unique account${accounts.length === 1 ? '' : 's'}`];
  if (hasGa) parts.push(`${accounts.filter((a) => a.occurrences.ga.length).length} in Google Authenticator`);
  if (hasExt) parts.push(`${accounts.filter((a) => a.occurrences.ext.length).length} in the extension`);
  const issues = accounts.filter((a) => a.warnings.length).length;
  if (issues) parts.push(`${issues} need${issues === 1 ? 's' : ''} attention`);
  return parts.join(' · ');
}

function render(store: Store): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  current = store.accounts();
  byKey = new Map(current.map((a) => [a.key, a]));
  for (const key of rowCache.keys()) if (!byKey.has(key)) rowCache.delete(key);

  els.empty.hidden = current.length > 0;
  els.content.hidden = current.length === 0;
  if (!current.length) return;

  const hasGa = store.hasSource('ga');
  const hasExt = store.hasSource('ext');
  els.summary.textContent = summaryText(current, hasGa, hasExt);
  const missing = store.missingGaBatches();
  els.batchWarning.hidden = !missing.length;
  els.batchWarning.textContent = `Google Authenticator transfer QR ${missing.join(', ')} not loaded — the accounts on it are missing from this list.`;

  const filters: Filter[] = ['all', 'issues', ...(hasGa && hasExt ? (['both', 'missing-ga', 'missing-ext'] as const) : [])];
  if (!filters.includes(ui.filter)) ui.filter = 'all';
  els.filters.replaceChildren(
    ...filters.map((f) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(ui.filter === f),
        'data-focus': `filter:${f}`,
        onclick: () => {
          ui.filter = f;
          render(store);
        },
      }, `${FILTER_LABEL[f]} (${current.filter((a) => matches(a, f, '')).length})`),
    ),
  );

  const visible = current.filter((a) => matches(a, ui.filter, ui.search));
  const desired: HTMLTableRowElement[] = [];
  for (const a of visible) {
    let r = rowCache.get(a.key);
    if (!r) rowCache.set(a.key, (r = createRow(store, a.key)));
    updateRow(store, r, a);
    desired.push(r.tr);
    if (r.details) desired.push(r.details);
  }
  if (!desired.length) desired.push(els.noMatch);

  // Only touch the DOM order when it actually changed (moving a focused node would blur it).
  const children = els.tbody.children;
  const same = children.length === desired.length && desired.every((row, i) => children[i] === row);
  if (!same) els.tbody.replaceChildren(...desired);
  if (focused && !document.activeElement?.closest('#accounts')) {
    document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }
  void tickCodes();
}

let ticking = false;
/** Refresh visible codes and countdowns. Skips a tick rather than letting runs overlap. */
async function tickCodes(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    await Promise.all(
      [...rowCache.entries()].map(async ([key, r]) => {
        const a = byKey.get(key);
        if (!a || !r.tr.isConnected) return;
        try {
          const code = await generateCode(a.entry, now);
          r.code.textContent = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
          r.code.title = '';
          if (a.entry.type === 'totp') {
            const left = secondsRemaining(a.entry.period, now);
            r.ttl.textContent = `${left}s`;
            r.ttl.classList.toggle('soon', left <= 5);
          } else {
            r.ttl.textContent = '';
          }
        } catch {
          r.code.textContent = 'n/a';
          r.code.title = 'Preview not available for this algorithm';
          r.ttl.textContent = '';
        }
      }),
    );
  } finally {
    ticking = false;
  }
}

export function setupAccounts(store: Store): void {
  const search = h('input', {
    type: 'search',
    placeholder: 'Search',
    'aria-label': 'Search issuer or account',
    oninput: (ev: Event) => {
      ui.search = (ev.target as HTMLInputElement).value;
      render(store);
    },
  });
  els = {
    empty: h('p', { class: 'empty' }, 'Nothing here yet — load at least one source above.'),
    content: h('div', {}),
    summary: h('p', { class: 'summary' }),
    batchWarning: h('p', { class: 'warn', hidden: true }),
    filters: h('div', { class: 'filters', role: 'group', 'aria-label': 'Show' }),
    tbody: h('tbody', {}),
    noMatch: h('tr', {}, h('td', { colspan: 7, class: 'empty' }, 'No accounts match.')),
  };
  els.content.append(
    els.summary,
    els.batchWarning,
    h('div', { class: 'toolbar' }, els.filters, search),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col', title: 'Include in exports' }, 'Export'),
            h('th', { scope: 'col' }, 'Issuer'),
            h('th', { scope: 'col' }, 'Account'),
            h('th', { scope: 'col' }, 'Code'),
            h('th', { scope: 'col' }, 'Found in'),
            h('th', { scope: 'col' }, 'Notes'),
            h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Details')),
          ),
        ),
        els.tbody,
      ),
    ),
  );
  $('#accounts').replaceChildren(els.empty, els.content);
  store.subscribe(() => render(store));
  render(store);
  setInterval(() => void tickCodes(), 1000);
}
