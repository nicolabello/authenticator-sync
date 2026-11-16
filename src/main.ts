import { Store } from './core/store';
import { clearKeyCache } from './core/totp';
import { setupAccounts } from './ui/accounts';
import { setupExport } from './ui/exporter';
import { setupInputs } from './ui/inputs';

const store = new Store();
setupInputs(store);
setupAccounts(store);
setupExport(store);
store.subscribe(() => {
  if (!store.getItems().length) clearKeyCache();
});

// Secrets live only in memory; warn before an accidental reload/close wipes edits.
window.addEventListener('beforeunload', (e) => {
  if (store.getItems().length) e.preventDefault();
});
