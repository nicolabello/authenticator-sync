type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

/**
 * Tiny element builder. Keys that exist as element properties (value, checked, hidden…) are
 * assigned as properties; `on*` functions become listeners; everything else is an attribute.
 * Text is always inserted as text nodes, never HTML.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && !k.includes('-')) (el as unknown as Props)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

let toastTimer = 0;
/** Announce a short status message (aria-live region). */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === 'error' ? 7000 : 3500);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — your browser blocked clipboard access', 'error');
  }
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Light-dismiss for modal dialogs where `closedby="any"` isn't supported yet. */
export function enableLightDismiss(dialog: HTMLDialogElement): void {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = r.top <= event.clientY && event.clientY <= r.bottom && r.left <= event.clientX && event.clientX <= r.right;
    if (!inside) dialog.close();
  });
}
