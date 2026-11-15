/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The guest gallery page (guest.html, served for /g/*) is a separate light app: it must never register the
 * member app's service worker. vite-plugin-pwa injects its register script into every HTML entry, so it is
 * taken out of guest.html here (and scripts/csp.mjs fails the build if it ever comes back).
 */
function guestWithoutServiceWorker(): Plugin {
  return {
    name: 'zephyr-guest-no-sw',
    enforce: 'post',
    // In dev, /g/* opens the guest page (the Worker does this in production).
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const r = req as unknown as { url?: string };
        if (r.url && /^\/g(\/|$|\?)/.test(r.url)) r.url = '/guest.html';
        next();
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.path.endsWith('/guest.html')) return html;
        return html
          .replace(/<script[^>]*registerSW[^>]*><\/script>\s*/g, '')
          .replace(/<link[^>]*rel="manifest"[^>]*>\s*/g, '');
      },
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // Builds run from this package's folder (pnpm --filter), so '.' is apps/web.
  const env = loadEnv(mode, '.', 'VITE_');
  // Production builds must carry the real Turnstile site key (the test key always passes).
  if (
    command === 'build' &&
    mode === 'production' &&
    !env.VITE_TURNSTILE_SITE_KEY &&
    env.VITE_ALLOW_TEST_TURNSTILE !== '1'
  ) {
    throw new Error('Set VITE_TURNSTILE_SITE_KEY (or VITE_ALLOW_TEST_TURNSTILE=1 for a local test build).');
  }
  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'script-defer',
        manifest: {
          name: 'Zephyr',
          short_name: 'Zephyr',
          description: 'AI photo editing and private galleries.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#F4F6F9',
          theme_color: '#F4F6F9',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        // Phase 8: our own service worker (src/sw.ts), with no precache and nothing served from Cache Storage.
        // Google's AdSense script runs in Free members' library pages with this origin and could rewrite any
        // cached file, which would then run as 'self' in every later document. Scripts, styles and WebAssembly
        // come from the HTTP cache (hashed, immutable), which page script can't write; the offline page is built
        // inside sw.js. scripts/csp.mjs fails the build if sw.js ever reads a cache or carries a precache list.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        injectManifest: {
          // No precache manifest at all (nothing is injected into sw.js).
          injectionPoint: undefined,
          // A classic script: no module syntax left in sw.js.
          rollupFormat: 'iife',
        },
      }),
      guestWithoutServiceWorker(),
    ],
    build: {
      sourcemap: false,
      target: 'es2022',
      rollupOptions: {
        input: {
          // Builds run from this package's folder, which is also Vite's root.
          main: 'index.html',
          guest: 'guest.html',
        },
        output: {
          // Guest-only files carry a guest- prefix so the member app's service worker can skip them.
          entryFileNames: (chunk) =>
            chunk.name === 'guest' ? 'assets/guest-[hash].js' : 'assets/[name]-[hash].js',
        },
      },
    },
    // The hashing worker is emitted as its own same-origin module file (CSP worker-src 'self').
    worker: { format: 'es' },
    server: { port: 5173, proxy: { '/api': 'http://localhost:8788' } },
    test: {
      environment: 'jsdom',
      globals: true,
      include: ['src/**/*.test.{ts,tsx}', 'worker/**/*.test.ts', 'scripts/**/*.test.ts'],
    },
  };
});
