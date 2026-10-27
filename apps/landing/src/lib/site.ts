export const SITE_URL = 'https://zephyr.midnightpoetry.studio';
export const APP_URL = 'https://zephyrapp.midnightpoetry.studio';

export const LINKS = {
  requestInvite: '#request-invite',
  haveInvite: `${APP_URL}/sign-up`,
  signIn: `${APP_URL}/sign-in`,
  app: APP_URL,
} as const;

export const NAV = [
  { label: 'Features', href: '#features' },
  { label: 'Use cases', href: '#use-cases' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Security', href: '#security' },
] as const;

/** Deterministic pseudo-random numbers so the scenes lay out the same on every build. */
export function seeded(seed: number) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  return { rnd, between: (a: number, b: number) => Math.round(a + rnd() * (b - a)) };
}

export const SCENE_KINDS = [
  'peaks',
  'sea',
  'couple',
  'city',
  'bloom',
  'product',
  'dunes',
  'interior',
  'portrait',
  'forest',
  'food',
  'dusk',
  'pet',
  'sneaker',
] as const;
export const kindAt = (i: number) => SCENE_KINDS[i % SCENE_KINDS.length] as (typeof SCENE_KINDS)[number];
