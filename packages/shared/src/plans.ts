/**
 * Starting plan limits. The live values are rows in the versioned `plan_limits` table, edited in
 * Admin › Plan limits (Option 1). These defaults seed the database and render the landing pricing
 * section at build time. Prices in brackets are placeholders until Stripe Prices exist.
 */
export type PlanId = 'free' | 'pro' | 'studio';

export interface PlanLimits {
  storageGb: number;
  cloudCreditsPerMonth: number;
  batchSize: number;
  fileTypes: string[];
  galleries: number | null;
  maxLinkDays: number | null;
  guestFullRes: boolean;
  peopleGrouping: boolean;
  branding: boolean;
  seats: number;
  ads: boolean;
  priorityQueue: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: string;
  priceYearly: string | null;
  blurb: string;
  limits: PlanLimits;
}

/** Hard ceiling set by the GPU queue; Admin can't raise batch size past it. */
export const SYSTEM_MAX_BATCH = 2000;
export const CREDIT_TOP_UP = { credits: 500, price: '[$5]' } as const;

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: '$0',
    priceYearly: null,
    blurb: 'For trying Zephyr and keeping personal albums tidy.',
    limits: {
      storageGb: 5,
      cloudCreditsPerMonth: 30,
      batchSize: 25,
      fileTypes: ['jpeg', 'png', 'webp'],
      galleries: 3,
      maxLinkDays: 7,
      guestFullRes: false,
      peopleGrouping: false,
      branding: false,
      seats: 1,
      ads: true,
      priorityQueue: false,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: '[$9.99]',
    priceYearly: '[$99]',
    blurb: 'For photographers who deliver to clients every week.',
    limits: {
      storageGb: 250,
      cloudCreditsPerMonth: 1000,
      batchSize: 500,
      fileTypes: ['jpeg', 'png', 'webp', 'cr2', 'nef', 'arw'],
      galleries: null,
      maxLinkDays: null,
      guestFullRes: true,
      peopleGrouping: true,
      branding: false,
      seats: 1,
      ads: false,
      priorityQueue: false,
    },
  },
  {
    id: 'studio',
    name: 'Studio',
    priceMonthly: '[$24.99]',
    priceYearly: '[$249]',
    blurb: 'For small teams and studios with client proofing.',
    limits: {
      storageGb: 1000,
      cloudCreditsPerMonth: 5000,
      batchSize: 500,
      fileTypes: ['jpeg', 'png', 'webp', 'cr2', 'nef', 'arw'],
      galleries: null,
      maxLinkDays: null,
      guestFullRes: true,
      peopleGrouping: true,
      branding: true,
      seats: 3,
      ads: false,
      priorityQueue: true,
    },
  },
];
