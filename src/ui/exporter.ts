import { gaIncompatibility, toMigrationUris } from '../core/migration';
import { toOtpauthText, toOtpauthUri } from '../core/otpauth';
import { SCOPE_LABEL, selectForScope, type Account, type Scope, type Store } from '../core/store';
import { $, copyText, downloadBlob, h } from './dom';
import { qrDataUrl } from './qr';

type Format = 'ext-text' | 'single-qr' | 'ga-qr';

const FORMAT_LABEL: Record<Format, string> = {
  'ext-text': 'Text file for the Chrome extension',
  'single-qr': 'One QR code per account (works with either app)',
  'ga-qr': 'Google Authenticator transfer QR codes',
};

const state = {
  format: 'ga-qr' as Format,
  scope: 'missing-ga' as Scope,
  perBatch: 8,
  scopeTouched: false,
};

interface Slide {
  title: string;
  detail: string;
  dataUrl: string;
}
let slides: Slide[] = [];
let slideIndex = 0;

function labelOf(a: Account): string {
  return a.entry.issuer ? `${a.entry.issuer}: ${a.entry.name}` : a.entry.name;
}

function slug(a: Account): string {
  return labelOf(a).replace(/[^\w@.-]+/g, '_').slice(0, 60) || 'account';
}

/** Sensible default: export to a target only what it doesn't already have. */
function defaultScope(store: Store): Scope {
  if (state.format === 'ga-qr' && store.hasSource('ga')) return 'missing-ga';
  if (state.format === 'ext-text' && store.hasSource('ext')) return 'missing-ext';
  return 'all';
}

function render(store: Store): void {
  const root = $('#export');
  const accounts = store.accounts();
  if (!accounts.length) {
    root.replaceChildren(h('p', { class: 'empty' }, 'Load some accounts first.'));
    return;
  }
  if (!state.scopeTouched) state.scope = defaultScope(store);
  const bothLoaded = store.hasSource('ga') && store.hasSource('ext');
  const scopes: Scope[] = bothLoaded ? ['all', 'missing-ga', 'missing-ext'] : ['all'];
  if (!scopes.includes(state.scope)) state.scope = 'all';

  const fieldset = (legend: string, ...children: (Node | false | null)[]) => h('fieldset', {}, h('legend', {}, legend), ...children);
  const radio = <T extends string>(name: string, value: T, current: T, text: string, onPick: (v: T) => void) =>
    h('label', { class: 'radio' }, h('input', { type: 'radio', name, value, checked: value === current, onchange: () => onPick(value) }), ' ', text);

  const controls = h(
    'div',
    { class: 'export-controls' },
    fieldset(
      'Format',
      ...(Object.keys(FORMAT_LABEL) as Format[]).map((f) =>
        radio('format', f, state.format, FORMAT_LABEL[f], (v) => { state.format = v; state.scopeTouched = false; render(store); }),
      ),
    ),
    fieldset(
      'Which accounts',
      ...scopes.map((s) =>
        radio('scope', s, state.scope, `${SCOPE_LABEL[s]} (${selectForScope(accounts, s).length})`, (v) => { state.scope = v; state.scopeTouched = true; render(store); }),
      ),
      !bothLoaded && h('p', { class: 'hint' }, 'Load both sources to export only the missing accounts.'),
    ),
    state.format === 'ga-qr' &&
      fieldset(
        'QR density',
        h('label', {}, 'Accounts per QR code ', h('input', {
          type: 'number', min: 1, max: 20, value: String(state.perBatch),
          onchange: (ev: Event) => { state.perBatch = Math.min(20, Math.max(1, Number((ev.target as HTMLInputElement).value) || 8)); render(store); },
        })),
        h('p', { class: 'hint' }, 'Fewer accounts per code makes each QR easier for the phone to scan.'),
      ),
  );

  const selected = selectForScope(accounts, state.scope);
  const notes: (Node | string)[] = [];
  let exportable = selected;
  if (state.format === 'ga-qr') {
    const bad = selected.filter((a) => gaIncompatibility(a.entry));
    exportable = selected.filter((a) => !gaIncompatibility(a.entry));
    if (bad.length) notes.push(h('p', { class: 'warn' }, `Skipped ${bad.length} account(s) Google Authenticator can’t represent: ${bad.map(labelOf).join(', ')}. Use “One QR code per account” instead (GA may still ignore a non-30s period).`));
  }
  const excluded = accounts.filter((a) => a.excluded).length;
  if (excluded) notes.push(h('p', { class: 'hint' }, `${excluded} unticked account(s) left out.`));
  if (state.scope !== 'all') {
    const target = state.scope === 'missing-ga' ? 'ga' : 'ext';
    const editedPresent = accounts.filter((a) => !a.excluded && a.edited && a.occurrences[target].length);
    if (editedPresent.length) {
      notes.push(h('p', { class: 'hint' }, `${editedPresent.length} edited account(s) already exist in the target, so they aren’t included (re-importing would create a second copy). Rename them in the app instead: ${editedPresent.map(labelOf).join(', ')}.`));
    }
  }

  const output = h('div', { class: 'export-output' });
  root.replaceChildren(
    controls,
    ...notes,
    h('button', { type: 'button', class: 'primary', disabled: !exportable.length, onclick: () => generate(exportable, output) },
      exportable.length ? `Generate (${exportable.length} account${exportable.length === 1 ? '' : 's'})` : 'Nothing to export'),
    output,
  );
}

async function generate(accounts: Account[], output: HTMLElement): Promise<void> {
  output.replaceChildren(h('p', { class: 'hint' }, 'Generating…'));
  const entries = accounts.map((a) => a.entry);

  if (state.format === 'ext-text') {
    const text = toOtpauthText(entries);
    const name = `authenticator-${state.scope}-${new Date().toISOString().slice(0, 10)}.txt`;
    output.replaceChildren(
      h('p', { class: 'warn' }, 'This text contains your secrets. Delete the file once you’ve imported it.'),
      h('textarea', { readOnly: true, rows: Math.min(12, entries.length + 1), value: text, spellcheck: false, 'aria-label': 'Export text' }),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => downloadBlob(name, new Blob([text], { type: 'text/plain' })) }, `Download ${name}`),
        h('button', { type: 'button', onclick: () => copyText(text) }, 'Copy'),
      ),
      h('p', { class: 'hint' }, 'Import in the extension: Settings → Backup → Import backups → Import text backup.'),
    );
    return;
  }

  if (state.format === 'single-qr') {
    slides = await Promise.all(
      accounts.map(async (a) => ({ title: labelOf(a), detail: 'Scan with either app (“Scan a QR code”).', dataUrl: await qrDataUrl(toOtpauthUri(a.entry)) })),
    );
  } else {
    const uris = toMigrationUris(entries, state.perBatch);
    slides = await Promise.all(
      uris.map(async (uri, i) => {
        const chunk = accounts.slice(i * state.perBatch, (i + 1) * state.perBatch);
        return { title: `Transfer QR ${i + 1} of ${uris.length}`, detail: chunk.map(labelOf).join(' · '), dataUrl: await qrDataUrl(uri, 640) };
      }),
    );
  }

  const grid = h(
    'div',
    { class: 'qr-grid' },
    slides.map((s, i) =>
      h(
        'figure',
        {},
        h('button', { type: 'button', class: 'qr-thumb', onclick: () => openViewer(i), 'aria-label': `Show ${s.title} full size` }, h('img', { src: s.dataUrl, alt: '' })),
        h('figcaption', {}, h('strong', {}, s.title), h('br'), h('span', { class: 'hint' }, s.detail)),
        h('a', { href: s.dataUrl, download: state.format === 'single-qr' ? `${slug(accounts[i])}.png` : `ga-transfer-${i + 1}-of-${slides.length}.png` }, 'Download PNG'),
      ),
    ),
  );
  output.replaceChildren(
    h('p', { class: 'warn' }, 'These QR codes contain your secrets. Don’t screenshot or share them unless you have to.'),
    state.format === 'ga-qr'
      ? h('p', { class: 'hint' }, 'In Google Authenticator: + → Scan a QR code (or Transfer accounts → Import accounts), then scan each code in order.')
      : '',
    h('button', { type: 'button', class: 'primary', onclick: () => openViewer(0) }, 'Show full size, one at a time'),
    grid,
  );
}

function showSlide(): void {
  const dialog = $('#viewer');
  const s = slides[slideIndex];
  dialog.querySelector('#viewer-title')!.textContent = s.title;
  (dialog.querySelector('[data-role="viewer-img"]') as HTMLImageElement).src = s.dataUrl;
  dialog.querySelector('[data-role="viewer-detail"]')!.textContent = s.detail;
  dialog.querySelector('[data-role="viewer-count"]')!.textContent = `${slideIndex + 1} / ${slides.length}`;
  (dialog.querySelector('[data-role="prev"]') as HTMLButtonElement).disabled = slideIndex === 0;
  (dialog.querySelector('[data-role="next"]') as HTMLButtonElement).disabled = slideIndex === slides.length - 1;
}

function openViewer(i: number): void {
  slideIndex = i;
  showSlide();
  ($('#viewer') as HTMLDialogElement).showModal();
}

export function setupExport(store: Store): void {
  const dialog = $('#viewer') as HTMLDialogElement;
  const step = (d: number) => {
    slideIndex = Math.min(slides.length - 1, Math.max(0, slideIndex + d));
    showSlide();
  };
  dialog.querySelector('[data-role="prev"]')!.addEventListener('click', () => step(-1));
  dialog.querySelector('[data-role="next"]')!.addEventListener('click', () => step(1));
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
  // Any change to the data invalidates generated output (it's re-rendered without it).
  store.subscribe(() => render(store));
  render(store);
}
