import { initMotion } from './motion';

initMotion();

// The three.js hero loads after the page is idle, and only where it can run smoothly.
const canvas = document.querySelector<HTMLCanvasElement>('[data-hero-canvas]');
const hero = canvas?.closest<HTMLElement>('section');
if (canvas && hero) {
  const idle = (cb: () => void) =>
    'requestIdleCallback' in window
      ? window.requestIdleCallback(cb, { timeout: 2500 })
      : setTimeout(cb, 1200);
  idle(async () => {
    const mod = await import('./hero3d');
    if (!mod.canRunHero3d()) return;
    mod.startHero3d(canvas, hero).catch(() => {
      /* Keep the CSS poster if WebGL fails. */
    });
  });
}
