/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
        includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
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
        workbox: {
          // Precache the app shell only. Nothing under /api is ever cached by the service worker.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Latin fonts only; other scripts load on demand if a page ever needs them.
          globIgnores: ['**/*cyrillic*', '**/*vietnamese*', '**/*greek*', '**/*symbols*'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
        },
      }),
    ],
    build: { sourcemap: false, target: 'es2022' },
    // The hashing worker is emitted as its own same-origin module file (CSP worker-src 'self').
    worker: { format: 'es' },
    server: { port: 5173, proxy: { '/api': 'http://localhost:8788' } },
    test: { environment: 'jsdom', globals: true, include: ['src/**/*.test.{ts,tsx}'] },
  };
});
