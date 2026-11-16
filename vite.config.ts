import { defineConfig } from 'vitest/config';

// Strict Content-Security-Policy for the production build: the app never talks to
// the network, so connect-src is 'none'. (Not applied in dev, where Vite's HMR
// needs a websocket.)
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** For the <meta> tag. Browsers ignore frame-ancestors there, so it only goes in the header. */
const CSP_META = CSP_DIRECTIVES.join('; ');

/**
 * HTTP response headers for wherever the build is served: `npm start` / `npm run preview`
 * locally, and hosts that read a `_headers` file (Cloudflare Pages, Netlify).
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
};

export default defineConfig({
  base: './',
  build: {
    // Vite's preload polyfill is the only fetch() in the bundle; modern browsers don't need it.
    modulePreload: { polyfill: false },
  },
  preview: {
    // Local only: not reachable from other devices on the network.
    host: '127.0.0.1',
    headers: SECURITY_HEADERS,
  },
  plugins: [
    {
      name: 'security-headers',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP_META}" />`);
      },
      generateBundle() {
        const lines = Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`);
        this.emitFile({ type: 'asset', fileName: '_headers', source: `/*\n${lines.join('\n')}\n` });
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.test.ts', 'src/core/fixtures.ts', 'src/core/types.ts'],
    },
  },
});
