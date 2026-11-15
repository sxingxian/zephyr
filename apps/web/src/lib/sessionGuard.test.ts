import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLeavingForTest,
  BEFORE_FULL_LOAD_MAX_MS,
  browser,
  isLeaving,
  LEAVING_RESET_MS,
  reloadWhenRestored,
  setBeforeFullLoad,
} from './sessionGuard';
import * as swCoreForTest from './swCore';

const original = window.location;
let assign: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  assign = vi.fn();
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, assign, reload, pathname: '/' },
  });
  __resetLeavingForTest();
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: original });
  __resetLeavingForTest();
});

describe('full page loads (phase 8)', () => {
  it('a cancelled navigation ("Leave site?" → Stay) releases the latch, so later reloads still work', () => {
    browser.assign('/photo/abc', { keepStorage: true });
    expect(assign).toHaveBeenCalledWith('/photo/abc');
    expect(isLeaving()).toBe(true);
    browser.reload();
    expect(reload).not.toHaveBeenCalled();
    // Still here after the reset time: the navigation didn't happen.
    vi.advanceTimersByTime(LEAVING_RESET_MS);
    expect(isLeaving()).toBe(false);
    browser.reload();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a tab in the background keeps the latch until it is shown again', () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    browser.assign('/x');
    vi.advanceTimersByTime(LEAVING_RESET_MS);
    expect(isLeaving()).toBe(true);
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isLeaving()).toBe(false);
  });

  it('runs the before-full-load clean-up first (bounded), except when the storage is kept', async () => {
    let resolve: () => void = () => {};
    const hook = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    setBeforeFullLoad(hook);
    browser.assign('/sign-in');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(assign).toHaveBeenCalledWith('/sign-in');
    __resetLeavingForTest();
    // A clean-up that never answers can't hold the page.
    setBeforeFullLoad(() => new Promise<void>(() => {}));
    browser.reload();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BEFORE_FULL_LOAD_MAX_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    __resetLeavingForTest();
    const skipped = vi.fn(() => Promise.resolve());
    setBeforeFullLoad(skipped);
    browser.assign('/edit/abc', { keepStorage: true });
    expect(skipped).not.toHaveBeenCalled();
    expect(assign).toHaveBeenLastCalledWith('/edit/abc');
  });

  it('a page restored from the back/forward cache reloads, even after a full navigation set the latch', () => {
    const off = reloadWhenRestored();
    browser.assign('/sign-in', { keepStorage: true });
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reload).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('service worker (phase 8)', () => {
  it('answers page loads only, and serves the offline page from code with a no-script policy', async () => {
    const { handlesNavigation, offlineResponse, OFFLINE_CSP, OLD_CACHE } = swCoreForTest;
    const nav = (url: string, mode: RequestMode = 'navigate', method = 'GET') =>
      ({ url, mode, method }) as unknown as Request;
    const o = 'https://zephyrapp.midnightpoetry.studio';
    expect(handlesNavigation(nav(`${o}/`), o)).toBe(true);
    expect(handlesNavigation(nav(`${o}/settings`), o)).toBe(true);
    expect(handlesNavigation(nav(`${o}/api/v1/ads`), o)).toBe(false);
    expect(handlesNavigation(nav(`${o}/g/abc`), o)).toBe(false);
    expect(handlesNavigation(nav(`${o}/assets/main.js`, 'no-cors'), o)).toBe(false);
    expect(handlesNavigation(nav(`${o}/`, 'navigate', 'POST'), o)).toBe(false);
    expect(handlesNavigation(nav('https://evil.example/'), o)).toBe(false);
    const res = offlineResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Security-Policy')).toBe(OFFLINE_CSP);
    expect(OFFLINE_CSP).toContain("default-src 'none'");
    expect(OFFLINE_CSP).not.toMatch(/script-src/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('You’re offline');
    expect(OLD_CACHE.test('workbox-precache-v2-https://x/')).toBe(true);
    expect(OLD_CACHE.test('zephyr-models-v1')).toBe(false);
  });
});
