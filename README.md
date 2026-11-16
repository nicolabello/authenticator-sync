# Authenticator Sync

A local, offline web app that compares and merges 2FA accounts between **Google Authenticator** and the **Chrome Authenticator extension** (authenticator.cc).

Everything runs in the browser tab. There's no backend and no network access (the production build enforces `connect-src 'none'`), and nothing is written to storage.

## Run it

```sh
npm install
npm start
```

`npm start` builds the app and serves it at http://127.0.0.1:4173 with the full security headers, then opens it in your browser. It only listens on this computer, so other devices on your network can't reach it. Stop it with Ctrl+C.

Running it locally like this is the recommended way to use it. See [Security](#security).

## Use

1. **Load** one or both sources.
   - **Google Authenticator:** Transfer accounts → Export accounts. Screenshot every QR code and drop the images in, or scan them with the webcam. You can also paste `otpauth-migration://` links.
   - **Chrome extension:** the plain-text backup (one `otpauth://` link per line), or single-account QR images.
   - Loading the same file or QR twice replaces it rather than duplicating it. Loading a second export of the same app isn't counted as duplicates either; only copies inside a single export are.
   - Steam accounts (`encoder=steam`) aren't standard TOTP and are skipped with a message.
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

## Security

### What the app does and doesn't do

- **Nothing is stored.** No cookies, `localStorage`, IndexedDB, Cache Storage or service worker. Secrets live only in the tab's memory, and reloading or closing the tab clears them.
- **Nothing is sent.** There's no backend. The production build's Content-Security-Policy includes `connect-src 'none'`, so the page can't make network requests even if a bug tried to. The bundle contains no `fetch` calls.
- **Nothing ends up in HTTP caches or server logs.** Only the static HTML, JS and CSS are ever requested. Secrets never appear in a URL or a request.
- **Text fields** have spellcheck off, so Chrome's enhanced spellcheck doesn't send their contents to Google, and autocomplete off.

### Where secrets can still leak (on your own computer)

These apply wherever you run the app:

- **Browser extensions** with access to all sites can read the page. Use a separate browser profile or a window with extensions disabled.
- **The clipboard.** The Copy buttons put secrets on the clipboard, which can reach clipboard history (Windows Win+V, clipboard managers) and sync to your phone via Universal Clipboard. Copy something else afterwards.
- **Downloaded files.** The `.txt` export and QR images land in your Downloads folder, which may sync to iCloud or OneDrive. Delete them once imported.
- **Screenshots** of Google Authenticator's transfer QR codes contain every secret. Delete them afterwards.
- **Session restore.** After a crash, a browser may save what's in the paste fields to disk so it can restore the tab. Clear the fields when you're done.

### Running locally vs. deploying

Whoever serves the page controls the code you run. A compromised host or deploy account could serve a modified page without the security policy, which could read everything. Running locally with `npm start` from code you've reviewed removes that risk, and for a one-off migration hosting gains you very little.

If you do host it:

- **Use a host that supports custom headers.** The build writes `dist/_headers`, which Cloudflare Pages and Netlify apply automatically. It sends the CSP as a real HTTP header, plus `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Those two stop other sites from embedding the page, and they only work as headers.
- **GitHub Pages can't set headers.** The CSP still applies there via a `<meta>` tag, but without the anti-embedding protection.
- **Turn on 2FA** for the hosting and Git accounts.

The same headers are defined once in `vite.config.ts` (`SECURITY_HEADERS`). They're used for the `<meta>` tag, `dist/_headers` and the local preview server.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Builds, then serves the build locally with the security headers and opens the browser. Use this to run the app. |
| `npm run dev` | Development server with hot reload at http://localhost:5173. It has no CSP (hot reload needs a websocket), so use it for development, not with real secrets. |
| `npm run build` | Typechecks, then writes the production build to `dist/`. |
| `npm run preview` | Serves an existing `dist/` locally with the security headers, without rebuilding. |
| `npm test` | Runs the unit tests once. |
| `npm run test:coverage` | Runs the tests and reports line and branch coverage of `src/core`. |
| `npm run test:mutation` | Mutation testing of `src/core` with StrykerJS (about 30s). HTML report in `reports/mutation/`. |
| `npm run typecheck` | Type-checks without building. |

## Develop

- Tests live next to each module in `src/core/` (`*.test.ts`), with shared data in `fixtures.ts`.
- Mutation testing fails below a 95% score. The dozen surviving mutants are equivalent: no test can tell them apart from the original, e.g. `toLowerCase` vs `toUpperCase` in a case-insensitive comparison. When a new mutant survives, add a test, unless it's equivalent too.

- `src/core/` holds the format logic, with no DOM dependencies:
  - `otpauth.ts`, `migration.ts` (Google Authenticator protobuf), `store.ts` (merge and dedupe), `totp.ts`, `ingest.ts`
- `src/ui/` holds the DOM UI.
