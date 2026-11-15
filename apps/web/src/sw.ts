/// <reference lib="webworker" />
/**
 * The member app's service worker (phase 8). It never serves anything from Cache Storage.
 *
 * Google's AdSense script runs inside Free members' library pages (AdSense forbids frames), with the page's
 * origin. Cache Storage is writable by any script in that origin, so a precached file could be replaced and then
 * run as 'self' in every later document, on every account on the device. That's why nothing executable or
 * HTML is ever served from it:
 *   - scripts, styles, WebAssembly and fonts come from the network and the HTTP cache (hashed files, immutable),
 *     which page script can't write;
 *   - pages come from the network (the app Worker sets their CSP); when the network is down, the offline page
 *     below is built here, in this file, with a policy that allows no script at all;
 *   - caches left by the earlier Workbox service worker (its precache) are deleted on activation.
 * The cost: the app no longer opens offline, it shows the offline page instead.
 */
import { handlesNavigation, OLD_CACHE, offlineResponse } from './lib/swCore';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => OLD_CACHE.test(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  // Everything but page loads goes to the network and the HTTP cache as if there were no service worker.
  if (!handlesNavigation(event.request, self.location.origin)) return;
  event.respondWith(fetch(event.request).catch(() => offlineResponse()));
});
