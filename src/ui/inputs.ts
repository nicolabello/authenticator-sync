import { ingestQrText, ingestTextBlock, type IngestResult } from '../core/ingest';
import type { Store } from '../core/store';
import { SOURCE_LABEL, type SourceKind } from '../core/types';
import { $, enableLightDismiss, h, toast } from './dom';
import { decodeQrImage, WebcamScanner } from './qr';

function summarize(r: IngestResult): string {
  const parts = [`${r.accounts} account${r.accounts === 1 ? '' : 's'}`];
  if (r.batches) parts.push(`${r.batches} transfer QR${r.batches === 1 ? '' : 's'}`);
  return parts.join(' from ');
}

async function handleFiles(store: Store, source: SourceKind, files: FileList | File[]): Promise<void> {
  for (const file of Array.from(files)) {
    try {
      if (file.type.startsWith('image/')) {
        const texts = await decodeQrImage(file);
        if (!texts.length) {
          toast(`No QR code found in ${file.name}`, 'error');
          continue;
        }
        for (const text of texts) toast(`${file.name}: loaded ${summarize(ingestQrText(store, text, source))}`);
      } else {
        const r = ingestTextBlock(store, await file.text(), source, `${source}:file:${file.name}`, file.name);
        toast(`${file.name}: loaded ${summarize(r)}`);
        if (r.errors.length) toast(`${file.name}: ${r.errors.length} line(s) skipped — ${r.errors[0]}`, 'error');
      }
    } catch (err) {
      toast(`${file.name}: ${(err as Error).message}`, 'error');
    }
  }
}

function renderStatus(store: Store, card: HTMLElement, source: SourceKind): void {
  const status = card.querySelector<HTMLElement>('[data-role="status"]')!;
  const items = store.getItems(source);
  status.replaceChildren();
  if (!items.length) return;

  const list = h('ul', { class: 'loaded' });
  for (const item of items.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    list.append(
      h(
        'li',
        {},
        h('span', {}, `${item.label} — ${item.entries.length} account${item.entries.length === 1 ? '' : 's'}`),
        h('button', { type: 'button', class: 'link', onclick: () => store.removeItem(item.id), 'aria-label': `Remove ${item.label}` }, 'Remove'),
      ),
    );
  }
  status.append(list);

  // Warn about incomplete Google Authenticator exports (missing batches).
  if (source === 'ga') {
    const batches = new Map<string, { size: number; have: Set<number> }>();
    for (const item of items) {
      const m = /^ga:batch:(-?\d+):(\d+):(\d+)$/.exec(item.id);
      if (!m) continue;
      const b = batches.get(m[1]) ?? { size: Number(m[3]), have: new Set<number>() };
      b.have.add(Number(m[2]));
      batches.set(m[1], b);
    }
    for (const b of batches.values()) {
      const missing = [...Array(b.size).keys()].filter((i) => !b.have.has(i)).map((i) => i + 1);
      if (missing.length) status.append(h('p', { class: 'warn' }, `Export incomplete: still missing QR ${missing.join(', ')} of ${b.size}.`));
    }
  }

  status.append(h('button', { type: 'button', onclick: () => store.clearSource(source) }, `Clear ${SOURCE_LABEL[source]} data`));
}

function setupScanner(store: Store): (source: SourceKind) => void {
  const dialog = $('#scanner') as HTMLDialogElement;
  const video = dialog.querySelector('video')!;
  const log = dialog.querySelector<HTMLElement>('[data-role="scanner-log"]')!;
  const hint = dialog.querySelector<HTMLElement>('[data-role="scanner-hint"]')!;
  let scanner: WebcamScanner | undefined;
  let seen = new Set<string>();

  dialog.addEventListener('close', () => {
    scanner?.stop();
    scanner = undefined;
  });

  return async (source) => {
    seen = new Set();
    log.replaceChildren();
    hint.textContent =
      source === 'ga'
        ? 'Hold each Google Authenticator transfer QR code up to the camera. Keep this open until all of them are captured.'
        : 'Hold each single-account QR code up to the camera.';
    dialog.showModal();
    scanner = new WebcamScanner(video, (text) => {
      if (seen.has(text)) return;
      seen.add(text);
      let message: string;
      try {
        message = `✓ Loaded ${summarize(ingestQrText(store, text, source))}`;
      } catch (err) {
        message = `✗ Not an authenticator QR code (${(err as Error).message})`;
      }
      log.prepend(h('li', {}, message));
    });
    try {
      await scanner.start();
    } catch (err) {
      log.prepend(h('li', { class: 'warn' }, `Couldn’t open the camera: ${(err as Error).message}`));
    }
  };
}

export function setupInputs(store: Store): void {
  const openScanner = setupScanner(store);

  for (const source of ['ga', 'ext'] as const) {
    const card = $(`#source-${source}`);
    const fileInput = card.querySelector<HTMLInputElement>('[data-role="images"]')!;
    const paste = card.querySelector<HTMLTextAreaElement>('[data-role="paste"]')!;
    const dropzone = card.querySelector<HTMLElement>('.dropzone')!;

    fileInput.addEventListener('change', async () => {
      if (fileInput.files) await handleFiles(store, source, fileInput.files);
      fileInput.value = '';
    });

    card.querySelector('[data-role="webcam"]')!.addEventListener('click', () => openScanner(source));

    card.querySelector('[data-role="load-paste"]')!.addEventListener('click', () => {
      if (!paste.value.trim()) return toast('Nothing to load — paste some links first', 'error');
      const r = ingestTextBlock(store, paste.value, source, `${source}:paste`, 'Pasted text');
      toast(`Loaded ${summarize(r)}`);
      if (r.errors.length) toast(`${r.errors.length} line(s) skipped — ${r.errors[0]}`, 'error');
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

  // Stop the browser from navigating to a file dropped outside a drop zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  enableLightDismiss($('#viewer') as HTMLDialogElement);
}
