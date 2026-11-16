# Authenticator Sync

A local, offline web app that compares and merges 2FA accounts between **Google Authenticator** and the **Chrome Authenticator extension** (authenticator.cc).

Everything runs in the browser tab. There's no backend and no network access (the production build enforces `connect-src 'none'`), and nothing is written to storage.

## Use

```sh
npm install
npm run dev        # http://localhost:5173
# or a production build with the strict CSP:
npm run build && npm run preview
```

1. **Load** one or both sources.
   - **Google Authenticator:** Transfer accounts → Export accounts. Screenshot every QR code and drop the images in, or scan them with the webcam. You can also paste `otpauth-migration://` links.
   - **Chrome extension:** the plain-text backup (one `otpauth://` link per line), or single-account QR images.
   - Loading the same file or QR twice replaces it rather than duplicating it.
2. **Review.** Accounts are merged by secret, so the same secret means the same account, whatever the label says. The app flags:
   - duplicates within a source
   - different labels for the same secret
   - the same label with different secrets (probably stale)
   - settings Google Authenticator can't carry
   Live codes let you check which entry is current. Issuer and account name are editable. Algorithm, digits and period can be changed too, under a warning. Untick an account to leave it out of exports.
3. **Export.**
   - Formats: extension text file, one QR code per account, or Google Authenticator transfer QR codes (batched, scanned one at a time in a full-screen viewer).
   - Accounts: all, only those missing from Google Authenticator, or only those missing from the extension.

## Limitations

- Google Authenticator's transfer format has no period field (it's always 30s). Accounts with another period are left out of the Google Authenticator export.
- "Missing" means missing from the data you loaded. Renaming an account that already exists in the target won't rename it there; re-importing it would create a second copy.
- Still to verify by hand: whether each app deduplicates on import. Test with a throwaway account by importing it twice.

## Develop

```sh
npm test           # parsers, protobuf round-trip, TOTP RFC vectors, merge logic
npm run typecheck
```

- `src/core/` holds the format logic, with no DOM dependencies:
  - `otpauth.ts`, `migration.ts` (Google Authenticator protobuf), `store.ts` (merge and dedupe), `totp.ts`, `ingest.ts`
- `src/ui/` holds the DOM UI.
