import { gaIncompatibility, toMigrationUris } from '../core/migration';
import { accountLabel, toOtpauthText, toOtpauthUri } from '../core/otpauth';
import { SCOPE_LABEL, selectForScope, type Account, type Scope, type Store } from '../core/store';
import { $, copyText, downloadBlob, enableLightDismiss, h } from './dom';
import { qrDataUrl } from './qr';

type Format = 'ext-text' | 'single-qr' | 'ga-qr';

const FORMAT_LABEL: Record<Format, string> = {
  'ga-qr': 'Google Authenticator transfer QR codes',
  'ext-text': 'Text file for the Chrome extension',
  'single-qr': 'One QR code per account (either app)',
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
  filename: string;
}

/** What the full-size viewer is showing. Cleared whenever the data changes (it holds secrets). */
let slides: Slide[] = [];
let slideIndex = 0;
/** Bumped on every generate/render so a slow, outdated generation can't overwrite a newer one. */
let generation = 0;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function slug(a: Account): string {
  return accountLabel(a.entry).replace(/[^\w@.-]+/g, '_').slice(0, 60) || 'account';
}

/** Sensible default: export to a target only what it doesn't already have. */
function defaultScope(store: Store): Scope {
  const both = store.hasSource('ga') && store.hasSource('ext');
  if (both && state.format === 'ga-qr') return 'missing-ga';
  if (both && state.format === 'ext-text') return 'missing-ext';
  return 'all';
}

function closeViewer(): void {
  slides = [];
  const dialog = $('#viewer') as HTMLDialogElement;
  dialog.close();
  (dialog.querySelector('[data-role="viewer-img"]') as HTMLImageElement).removeAttribute('src');
}

function render(store: Store): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  generation++;
  closeViewer();

  const root = $('#export');
  const accounts = store.accounts();
  if (!accounts.length) {
    root.replaceChildren(h('p', { class: 'empty' }, 'Nothing to export yet.'));
    return;
  }
  const bothLoaded = store.hasSource('ga') && store.hasSource('ext');
  if (!state.scopeTouched) state.scope = defaultScope(store);
  const scopes: Scope[] = bothLoaded ? ['all', 'missing-ga', 'missing-ext'] : ['all'];
  if (!scopes.includes(state.scope)) state.scope = 'all';

  const radio = <T extends string>(name: string, value: T, checked: boolean, text: string, onPick: () => void) =>
    h('label', { class: 'radio' }, h('input', { type: 'radio', name, value, checked, 'data-focus': `${name}:${value}`, onchange: onPick }), ' ', text);

  const controls = h(
    'div',
    { class: 'export-controls' },
    h(
      'fieldset',
      {},
      h('legend', {}, 'Export as'),
      (Object.keys(FORMAT_LABEL) as Format[]).map((f) =>
        radio('format', f, f === state.format, FORMAT_LABEL[f], () => {
          state.format = f;
          state.scopeTouched = false;
          render(store);
        }),
      ),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Which accounts'),
      scopes.map((s) =>
        radio('scope', s, s === state.scope, `${SCOPE_LABEL[s]} (${selectForScope(accounts, s).length})`, () => {
          state.scope = s;
          state.scopeTouched = true;
          render(store);
        }),
      ),
      bothLoaded ? '' : h('p', { class: 'hint' }, 'Load both apps above to export only what one of them is missing.'),
    ),
    state.format === 'ga-qr'
      ? h(
          'fieldset',
          {},
          h('legend', {}, 'QR size'),
          h('label', {}, 'Accounts per QR code ', h('input', {
            type: 'number', min: 1, max: 20, step: 1, value: String(state.perBatch), 'data-focus': 'perBatch',
            onchange: (ev: Event) => {
              const v = Math.floor(Number((ev.target as HTMLInputElement).value));
              state.perBatch = Number.isFinite(v) ? Math.min(20, Math.max(1, v)) : 8;
              render(store);
            },
          })),
          h('p', { class: 'hint' }, 'Lower it if your phone struggles to scan the codes.'),
        )
      : '',
  );

  const selected = selectForScope(accounts, state.scope);
  const notes: Node[] = [];
  let exportable = selected;

  const missingBatches = store.missingGaBatches();
  if (state.scope === 'missing-ga' && missingBatches.length) {
    notes.push(h('p', { class: 'warn' }, `Google Authenticator transfer QR ${missingBatches.join(', ')} isn’t loaded, so some of these accounts may already be in Google Authenticator. Load it first to avoid creating duplicates.`));
  }
  if (state.format === 'ga-qr') {
    const bad = selected.filter((a) => gaIncompatibility(a.entry));
    exportable = selected.filter((a) => !gaIncompatibility(a.entry));
    if (bad.length) {
      notes.push(h('p', { class: 'warn' }, `Left out ${plural(bad.length, 'account')} Google Authenticator can’t handle: ${bad.map((a) => accountLabel(a.entry)).join(', ')}.`));
    }
  }
  const excluded = accounts.filter((a) => a.excluded).length;
  if (excluded) notes.push(h('p', { class: 'hint' }, `${plural(excluded, 'unticked account')} left out.`));
  if (state.scope !== 'all') {
    const target = state.scope === 'missing-ga' ? 'ga' : 'ext';
    const renamed = accounts.filter((a) => !a.excluded && a.edited && a.occurrences[target].length);
    if (renamed.length) {
      notes.push(h('p', { class: 'hint' }, `Already in the app, so not exported: ${renamed.map((a) => accountLabel(a.entry)).join(', ')}. Apply your edits to them in the app itself (importing again would add a second copy).`));
    }
  }

  const output = h('div', { class: 'export-output' });
  root.replaceChildren(
    controls,
    ...notes,
    h('button', {
      type: 'button',
      class: 'primary',
      disabled: !exportable.length,
      'data-focus': 'generate',
      onclick: () => void generate(exportable, output),
    }, exportable.length ? `Create export (${plural(exportable.length, 'account')})` : 'Nothing to export'),
    output,
  );
  if (focused) root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

async function generate(accounts: Account[], output: HTMLElement): Promise<void> {
  const mine = ++generation;
  closeViewer();
  const format = state.format;
  output.replaceChildren(h('p', { class: 'hint' }, 'Creating…'));

  if (format === 'ext-text') {
    const text = toOtpauthText(accounts.map((a) => a.entry));
    const name = `authenticator-${state.scope === 'all' ? 'all' : 'missing'}-${new Date().toISOString().slice(0, 10)}.txt`;
    output.replaceChildren(
      h('p', { class: 'warn' }, 'This contains your secret keys. Delete the file once it’s imported.'),
      h('textarea', { readOnly: true, rows: Math.min(10, accounts.length + 1), value: text, spellcheck: false, autocomplete: 'off', 'aria-label': 'Export text' }),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => downloadBlob(name, new Blob([text], { type: 'text/plain' })) }, 'Download .txt'),
        h('button', { type: 'button', onclick: () => copyText(text) }, 'Copy'),
      ),
      h('p', { class: 'hint' }, 'In the extension: open the menu → Backup → Import backups → choose the file.'),
    );
    output.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  let built: Slide[];
  if (format === 'single-qr') {
    built = await Promise.all(
      accounts.map(async (a) => ({
        title: accountLabel(a.entry),
        detail: 'Scan with “Scan a QR code” in either app.',
        dataUrl: await qrDataUrl(toOtpauthUri(a.entry)),
        filename: `${slug(a)}.png`,
      })),
    );
  } else {
    const per = state.perBatch;
    const uris = toMigrationUris(accounts.map((a) => a.entry), per);
    built = await Promise.all(
      uris.map(async (uri, i) => ({
        title: `Transfer QR ${i + 1} of ${uris.length}`,
        detail: accounts.slice(i * per, (i + 1) * per).map((a) => accountLabel(a.entry)).join(' · '),
        dataUrl: await qrDataUrl(uri, 640),
        filename: `google-authenticator-${i + 1}-of-${uris.length}.png`,
      })),
    );
  }
  if (mine !== generation) return; // Something changed while we were busy; this result is stale.
  slides = built;

  output.replaceChildren(
    h('p', { class: 'warn' }, 'These QR codes contain your secret keys. Avoid screenshotting or sharing them.'),
    h(
      'p',
      { class: 'hint' },
      format === 'ga-qr'
        ? 'On your phone, in Google Authenticator: + → Scan a QR code, then scan each code in order.'
        : 'On your phone, in either app: + → Scan a QR code, then scan each code.',
    ),
    h('button', { type: 'button', class: 'primary', onclick: () => openViewer(0) }, 'Show full size, one at a time'),
    h(
      'div',
      { class: 'qr-grid' },
      built.map((s, i) =>
        h(
          'figure',
          {},
          h('button', { type: 'button', class: 'qr-thumb', onclick: () => openViewer(i), 'aria-label': `Show ${s.title} full size` }, h('img', { src: s.dataUrl, alt: '' })),
          h('figcaption', {}, h('strong', {}, s.title), h('br'), h('span', { class: 'hint' }, s.detail)),
          h('a', { href: s.dataUrl, download: s.filename }, 'Download image'),
        ),
      ),
    ),
  );
  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showSlide(): void {
  const dialog = $('#viewer');
  const s = slides[slideIndex];
  if (!s) return;
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
  enableLightDismiss(dialog);
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
  // Any data change invalidates (and discards) generated output, which holds secrets.
  store.subscribe(() => render(store));
  render(store);
}
