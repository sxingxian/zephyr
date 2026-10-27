// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://zephyr.midnightpoetry.studio',
  output: 'static',
  trailingSlash: 'never',
  build: {
    format: 'file',
    // Keep CSS in files so the Content-Security-Policy needs no style hashes.
    inlineStylesheets: 'never',
    assets: '_astro',
  },
  compressHTML: true,
  devToolbar: { enabled: false },
  vite: {
    build: { sourcemap: false },
  },
});
