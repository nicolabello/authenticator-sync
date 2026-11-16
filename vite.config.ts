import { defineConfig } from 'vitest/config';

// Strict Content-Security-Policy for the production build: the app never talks to
// the network, so connect-src is 'none'. (Not applied in dev, where Vite's HMR
// needs a websocket.)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'inject-csp',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        );
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
