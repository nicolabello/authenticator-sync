import { ingestQrText, ingestTextBlock, type IngestResult } from '../core/ingest';
import type { Store } from '../core/store';
import { SOURCE_LABEL, type SourceKind } from '../core/types';
import { $, h, toast } from './dom';
import { decodeQrImage, WebcamScanner } from './qr';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Load dropped/picked files, then report once (a toast per file would overwrite each other). */
async function handleFiles(store: Store, source: SourceKind, files: FileList | File[]): Promise<void> {
  let accounts = 0;
  let loaded = 0;
  const problems: string[] = [];
  for (const file of Array.from(files)) {
    try {
      const results: IngestResult[] = [];
      if (file.type.startsWith('image/')) {
        const texts = await decodeQrImage(file);
        if (!texts.length) {
          problems.push(`${file.name}: no QR code found`);
          continue;
        }
        for (const text of texts) results.push(ingestQrText(store, text, source));
      } else {
        const r = ingestTextBlock(store, await file.text(), source, `${source}:file:${file.name}`, file.name);
        if (!r.accounts) problems.push(`${file.name}: no accounts found${r.errors[0] ? ` (${r.errors[0]})` : ''}`);
        else if (r.errors.length) problems.push(`${file.name}: skipped ${plural(r.errors.length, 'line')} — ${r.errors[0]}`);
        results.push(r);
      }
      const n = results.reduce((sum, r) => sum + r.accounts, 0);
      accounts += n;
      if (n) loaded++;
    } catch (err) {
      problems.push(`${file.name}: ${(err as Error).message}`);
    }
  }
  if (problems.length) {
    toast([loaded ? `Loaded ${plural(accounts, 'account')} from ${plural(loaded, 'file')}.` : '', ...problems].filter(Boolean).join(' '), 'error');
  } else {
    toast(`Loaded ${plural(accounts, 'account')} from ${plural(loaded, 'file')}.`);
  }
}

function renderStatus(store: Store, card: HTMLElement, source: SourceKind): void {
  const status = card.querySelector<HTMLElement>('[data-role="status"]')!;
  const items = store.getItems(source).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (!items.length) {
    status.replaceChildren();
    return;
  }
  const missing = source === 'ga' ? store.missingGaBatches() : [];
  status.replaceChildren(
    h(
      'ul',
      { class: 'loaded' },
      items.map((item) =>
        h(
          'li',
          {},
          h('span', {}, `✓ ${item.label} — ${plural(item.entries.length, 'account')}`),
          h('button', { type: 'button', class: 'link', onclick: () => store.removeItem(item.id), 'aria-label': `Remove ${item.label}` }, 'Remove'),
        ),
      ),
    ),
    missing.length
      ? h('p', { class: 'warn' }, `Still missing transfer QR ${missing.join(', ')}. Load it too, or accounts on it will look “missing from Google Authenticator”.`)
      : '',
    h('button', { type: 'button', class: 'link', onclick: () => store.clearSource(source) }, `Clear all ${SOURCE_LABEL[source]} data`),
  );
}

function setupScanner(store: Store): (source: SourceKind) => void {
  const dialog = $('#scanner') as HTMLDialogElement;
  const video = dialog.querySelector('video')!;
  const log = dialog.querySelector<HTMLElement>('[data-role="scanner-log"]')!;
  const hint = dialog.querySelector<HTMLElement>('[data-role="scanner-hint"]')!;
  let scanner: WebcamScanner | undefined;

  dialog.addEventListener('close', () => {
    scanner?.stop();
    scanner = undefined;
  });

  return async (source) => {
    const seen = new Set<string>();
    log.replaceChildren();
    hint.textContent =
      source === 'ga'
        ? 'Hold your phone up to the camera showing each transfer QR code in turn. Keep this open until every code has a ✓ below.'
        : 'Hold each QR code up to the camera.';
    dialog.showModal();
    const current = new WebcamScanner(video, (text) => {
      if (seen.has(text)) return;
      seen.add(text);
      let message: string;
      try {
        const r = ingestQrText(store, text, source);
        const batch = /^otpauth-migration:/i.test(text) ? ' (transfer QR)' : '';
        message = `✓ ${plural(r.accounts, 'account')} loaded${batch}`;
      } catch (err) {
        message = `✗ Not an authenticator QR code (${(err as Error).message})`;
      }
      log.prepend(h('li', {}, message));
    });
    scanner = current;
    try {
      await current.start();
    } catch (err) {
      log.prepend(h('li', { class: 'warn' }, `Couldn’t open the camera: ${(err as Error).message}`));
    }
  };
}

export function setupInputs(store: Store): void {
  const openScanner = setupScanner(store);

  for (const source of ['ga', 'ext'] as const) {
    const card = $(`#source-${source}`);
    const fileInput = card.querySelector<HTMLInputElement>('[data-role="files"]')!;
    const paste = card.querySelector<HTMLTextAreaElement>('[data-role="paste"]')!;
    const dropzone = card.querySelector<HTMLElement>('.dropzone')!;

    fileInput.addEventListener('change', async () => {
      if (fileInput.files) await handleFiles(store, source, fileInput.files);
      fileInput.value = '';
    });

    card.querySelector('[data-role="webcam"]')!.addEventListener('click', () => openScanner(source));

    card.querySelector('[data-role="load-paste"]')!.addEventListener('click', () => {
      if (!paste.value.trim()) return toast('Nothing to load — paste something first.', 'error');
      const r = ingestTextBlock(store, paste.value, source, `${source}:paste`, 'Pasted text');
      if (!r.accounts) return toast(`No accounts found${r.errors[0] ? ` — ${r.errors[0]}` : ''}.`, 'error');
      toast(`Loaded ${plural(r.accounts, 'account')}.${r.errors.length ? ` Skipped ${plural(r.errors.length, 'line')} — ${r.errors[0]}` : ''}`, r.errors.length ? 'error' : 'info');
      paste.value = '';
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragging');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragging');
      if (e.dataTransfer?.files.length) await handleFiles(store, source, e.dataTransfer.files);
    });

    store.subscribe(() => renderStatus(store, card, source));
  }

  // Stop the browser from opening a file dropped outside a drop zone (and losing everything).
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
