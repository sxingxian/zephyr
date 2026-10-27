/**
 * Scroll motion for the landing page: Lenis smooth scrolling plus GSAP ScrollTrigger timelines built from
 * the data attributes written by src/lib/motion.ts. Skipped entirely when the visitor prefers reduced
 * motion; the markup is already the final layout, so nothing is lost.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

type Vars = Record<string, number | string>;
type Tween = { from?: gsap.TweenVars; to: gsap.TweenVars };

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : Number(v ?? d) || d);

/** Each preset returns the tween for one element; `f` holds the per-element values from data-from. */
const PRESETS: Record<string, (f: Vars) => Tween> = {
  flyIn: (f) => ({
    from: {
      autoAlpha: 0,
      x: num(f.x),
      y: num(f.y),
      z: num(f.z),
      rotationX: num(f.rotationX),
      rotationY: num(f.rotationY),
      rotation: num(f.rotation),
      scale: num(f.scale, 1),
      filter: `blur(${num(f.blur)}px)`,
    },
    to: {
      autoAlpha: 1,
      x: 0,
      y: 0,
      z: 0,
      rotationX: 0,
      rotationY: 0,
      rotation: 0,
      scale: 1,
      filter: 'blur(0px)',
    },
  }),
  tagIn: () => ({ from: { autoAlpha: 0, y: 6, scale: 0.9 }, to: { autoAlpha: 1, y: 0, scale: 1 } }),
  grow: () => ({ from: { scaleY: 0 }, to: { scaleY: 1 } }),
  dimOut: () => ({ to: { opacity: 0.38, filter: 'grayscale(1)' } }),
  grade: () => ({
    from: { filter: 'brightness(0.72) saturate(0.55) contrast(0.9)' },
    to: { filter: 'brightness(1) saturate(1) contrast(1)' },
  }),
  sweep: () => ({ from: { left: '-6%', opacity: 1 }, to: { left: '104%', opacity: 1 } }),
  draw: () => ({ from: { strokeDashoffset: 1200 }, to: { strokeDashoffset: 0 } }),
  dimBoard: () => ({ to: { filter: 'blur(6px)', opacity: 0.3 } }),
  popIn: () => ({ from: { autoAlpha: 0, y: 24, scale: 0.86 }, to: { autoAlpha: 1, y: 0, scale: 1 } }),
  digitIn: () => ({ from: { autoAlpha: 0, y: 14, scale: 0.6 }, to: { autoAlpha: 1, y: 0, scale: 1 } }),
  develop: () => ({
    from: { filter: 'blur(16px) brightness(1.8) saturate(0)', y: 40 },
    to: { filter: 'blur(0px) brightness(1) saturate(1)', y: 0 },
  }),
};

/** "Gust": three keyframes, blown in from off-screen, overshooting, then settling. */
function gust(tl: gsap.core.Timeline, el: Element, f: Vars, at: number, len: number) {
  gsap.set(el, { autoAlpha: 0, x: num(f.g1x), y: num(f.g1y), rotation: num(f.g1r), scale: 0.62 });
  tl.to(
    el,
    {
      autoAlpha: 1,
      x: num(f.g2x),
      y: num(f.g2y),
      rotation: num(f.g2r),
      scale: 0.86,
      duration: len * 0.38,
      ease: 'none',
    },
    at,
  )
    .to(
      el,
      {
        x: num(f.g3x),
        y: num(f.g3y),
        rotation: num(f.g3r),
        scale: 1.02,
        duration: len * 0.34,
        ease: 'sine.out',
      },
      at + len * 0.38,
    )
    .to(el, { x: 0, y: 0, rotation: 0, scale: 1, duration: len * 0.28, ease: 'sine.out' }, at + len * 0.72);
}

function addTween(tl: gsap.core.Timeline, el: Element, preset: string, at: number, len: number, f: Vars) {
  if (preset === 'gust') return gust(tl, el, f, at, len);
  const make = PRESETS[preset];
  if (!make) return;
  const { from, to } = make(f);
  // Elements that start hidden must hide immediately; the loupe stays at its CSS start until its turn.
  const opts = { ...to, duration: len, ease: 'power2.out', immediateRender: preset !== 'sweep' };
  if (from) tl.fromTo(el, from, opts, at);
  else tl.to(el, { ...to, duration: len, ease: 'power1.inOut' }, at);
}

function parse(el: Element): { preset: string; at: number; len: number; f: Vars }[] {
  const presets = (el.getAttribute('data-anim') ?? '').split('|');
  const ranges = (el.getAttribute('data-range') ?? '').split('|');
  const froms = (el.getAttribute('data-from') ?? '').split('|');
  return presets.map((preset, i) => {
    const [a = 0, b = 1] = (ranges[i] ?? '0 1').split(' ').map(Number);
    let f: Vars = {};
    try {
      f = froms[i] ? (JSON.parse(froms[i] as string) as Vars) : {};
    } catch {
      f = {};
    }
    return { preset, at: a, len: Math.max(0.001, b - a), f };
  });
}

function buildScene(section: HTMLElement, pinned: boolean) {
  const tl = gsap.timeline({ paused: true, defaults: { ease: 'power2.out' } });
  tl.set({}, {}, 1); // normalise duration to 1 so ranges map to scroll progress
  for (const el of section.querySelectorAll('[data-anim]')) {
    for (const p of parse(el)) addTween(tl, el, p.preset, p.at, p.len, p.f);
  }
  for (const step of section.querySelectorAll<HTMLElement>('[data-step-in]')) {
    const [a = 0, b = 0.05] = (step.dataset.stepIn ?? '').split(' ').map(Number);
    // On narrow screens the steps stack and stay visible; they only take turns when the scene is pinned.
    if (pinned && a > 0) {
      tl.fromTo(
        step,
        { autoAlpha: 0, y: 28, filter: 'blur(6px)' },
        { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: Math.max(0.001, b - a), immediateRender: true },
        a,
      );
    }
    if (pinned && step.dataset.stepOut) {
      const [c = 0.9, d = 1] = step.dataset.stepOut.split(' ').map(Number);
      tl.to(
        step,
        { autoAlpha: 0, y: -28, filter: 'blur(6px)', duration: Math.max(0.001, d - c), ease: 'power2.in' },
        c,
      );
    }
  }
  ScrollTrigger.create({
    trigger: section,
    start: pinned ? 'top top' : 'top 85%',
    end: pinned ? 'bottom bottom' : 'bottom 45%',
    scrub: 0.6,
    animation: tl,
  });
}

function buildViewAnims() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-view-anim]')) {
    const preset = el.dataset.viewAnim ?? '';
    let f: Vars = {};
    try {
      f = el.dataset.from ? (JSON.parse(el.dataset.from) as Vars) : {};
    } catch {
      f = {};
    }
    const tl = gsap.timeline({ paused: true });
    tl.set({}, {}, 1);
    const delay = num(f.delay);
    addTween(tl, el, preset, delay, 1 - delay, f);
    ScrollTrigger.create({ trigger: el, start: 'top bottom', end: 'top 45%', scrub: 0.6, animation: tl });
  }
}

export function initMotion(): void {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return;
  gsap.registerPlugin(ScrollTrigger);
  document.documentElement.classList.add('motion');

  const lenis = new Lenis({ autoRaf: false, anchors: { offset: -88 }, lerp: 0.12 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);

  const mm = gsap.matchMedia();
  mm.add({ wide: '(min-width: 861px)', narrow: '(max-width: 860px)' }, (ctx) => {
    const pinned = Boolean(ctx.conditions?.wide);
    for (const s of document.querySelectorAll<HTMLElement>('[data-scene]')) buildScene(s, pinned);
    buildViewAnims();
  });

  // If the visitor turns on reduced motion mid-visit, put everything back to its final layout.
  reduce.addEventListener('change', () => {
    if (!reduce.matches) return;
    mm.revert();
    lenis.destroy();
    document.documentElement.classList.remove('motion');
  });
  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
}
