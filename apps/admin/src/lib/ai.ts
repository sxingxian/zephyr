import {
  AI_FEATURES,
  type AiFeature,
  type AiSettings,
  type AiSettingsPatch,
  type BgProvider,
  CAP_ALERTS,
  type CapAlert,
} from '@zephyr/shared/client';

/** Labels, descriptions and where each Zephyr AI feature runs (Admin › Zephyr AI). */
export const FEATURE_INFO: Record<AiFeature, { label: string; desc: string; cloud: boolean }> = {
  auto_enhance: {
    label: 'Auto-enhance',
    desc: 'Exposure, white balance, contrast and skin tones',
    cloud: false,
  },
  hdr: { label: 'HDR and interior balance', desc: 'Lifts dark rooms, holds bright windows', cloud: false },
  color_match: { label: 'Colour match', desc: 'Matches a reference photo’s colour and tone', cloud: false },
  cleanup: {
    label: 'Duplicates and blur cleanup',
    desc: 'Perceptual hash and sharpness score',
    cloud: false,
  },
  face_grouping: { label: 'Face grouping', desc: 'YuNet + SFace · each member still opts in', cloud: false },
  scene_tags: {
    label: 'Scene tags',
    desc: 'On upload, from the 512 px thumbnail · members can opt out',
    cloud: true,
  },
  bg_removal: { label: 'Studio background removal', desc: 'Credits per photo set below', cloud: true },
};
export const PROVIDER_LABEL: Record<BgProvider | 'workers_ai' | 'none', string> = {
  runware: 'Runware · BiRefNet',
  fal_bria: 'fal · Bria RMBG 2.0',
  workers_ai: 'Workers AI',
  none: 'None, fail and refund',
};

// ---------------------------------------------------------------- the form
/** Number fields are edited as text, so a half-typed value can be shown with an error instead of jumping. */
export interface AiForm {
  enabled: boolean;
  cloudPaused: boolean;
  features: Record<AiFeature, boolean>;
  bgProvider: BgProvider;
  bgFallback: BgProvider | 'none';
  runwareModel: string;
  falModel: string;
  sceneModel: string;
  bgCreditsPerPhoto: string;
  /** USD per call. */
  costs: { runware: string; fal: string; scene: string };
  /** USD per day. */
  caps: { total: string; bgRemoval: string; sceneTags: string; perUser: string };
  alerts: CapAlert[];
  atCap: AiSettings['atCap'];
  alertTo: AiSettings['alertTo'];
  memberJobsPerMinute: string;
}
export type AiFormErrors = Partial<Record<string, string>>;

const usd = (n: number, digits = 2) => n.toFixed(digits);
/** Micro-dollars → a short USD string (keeps significant decimals for tiny per-call costs). */
export function microsToUsd(m: number): string {
  if (m === 0) return '0';
  const s = (m / 1_000_000).toFixed(6);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}
export const formatUsd = (n: number) => `US$${usd(n)}`;
export const formatPerPhoto = (micros: number) => `US$${microsToUsd(micros)} a photo`;

export function toForm(s: AiSettings): AiForm {
  return {
    enabled: s.enabled,
    cloudPaused: s.cloudPaused,
    features: { ...s.features },
    bgProvider: s.bgProvider,
    bgFallback: s.bgFallback,
    runwareModel: s.runwareModel,
    falModel: s.falModel,
    sceneModel: s.sceneModel,
    bgCreditsPerPhoto: String(s.bgCreditsPerPhoto),
    costs: {
      runware: microsToUsd(s.costs.runwareMicros),
      fal: microsToUsd(s.costs.falMicros),
      scene: microsToUsd(s.costs.sceneMicros),
    },
    caps: {
      total: usd(s.caps.total),
      bgRemoval: usd(s.caps.bgRemoval),
      sceneTags: usd(s.caps.sceneTags),
      perUser: usd(s.caps.perUser),
    },
    alerts: [...s.alerts].sort((a, b) => a - b),
    atCap: s.atCap,
    alertTo: s.alertTo,
    memberJobsPerMinute: String(s.memberJobsPerMinute),
  };
}

// The same rules as aiSettingsPatchSchema (packages/shared/src/ai-schemas.ts).
const RUNWARE_RE = /^runware:\d{1,6}@\d{1,4}$/;
const FAL_RE = /^fal-ai\/[a-z0-9][a-z0-9/_.-]{1,100}$/;
const SCENE_RE = /^@cf\/[a-z0-9][a-z0-9/_.-]{1,100}$/i;
const DECIMAL_RE = /^\d+(\.\d+)?$/;

function intIn(v: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : null;
}
function capUsd(v: string): number | null {
  const t = v.trim();
  if (!DECIMAL_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? Math.round(n * 100) / 100 : null;
}
/** USD per call → micro-dollars, 0…1,000,000 (at most US$1 a call). */
function costMicros(v: string): number | null {
  const t = v.trim();
  if (!DECIMAL_RE.test(t)) return null;
  const m = Math.round(Number(t) * 1_000_000);
  return Number.isFinite(m) && m >= 0 && m <= 1_000_000 ? m : null;
}

/** Checks the form and builds full settings from it, or returns field errors keyed by field name. */
export function parseForm(
  f: AiForm,
  base: AiSettings,
): { settings: AiSettings; errors: null } | { settings: null; errors: AiFormErrors } {
  const errors: AiFormErrors = {};
  const credits = intIn(f.bgCreditsPerPhoto, 1, 20);
  if (credits === null) errors.bgCreditsPerPhoto = 'A whole number from 1 to 20.';
  const perMin = intIn(f.memberJobsPerMinute, 1, 600);
  if (perMin === null) errors.memberJobsPerMinute = 'A whole number from 1 to 600.';
  if (!RUNWARE_RE.test(f.runwareModel.trim()))
    errors.runwareModel = 'Use a Runware model id like runware:112@5.';
  if (!FAL_RE.test(f.falModel.trim())) errors.falModel = 'Use a fal path like fal-ai/bria/background/remove.';
  if (!SCENE_RE.test(f.sceneModel.trim()))
    errors.sceneModel = 'Use a Workers AI id like @cf/microsoft/resnet-50.';
  if (f.bgFallback === f.bgProvider) errors.bgFallback = 'The fallback must be a different provider.';
  const costs = {
    runware: costMicros(f.costs.runware),
    fal: costMicros(f.costs.fal),
    scene: costMicros(f.costs.scene),
  };
  for (const [k, v] of Object.entries(costs)) {
    if (v === null) errors[`costs.${k}`] = 'US$0 to US$1 a call.';
  }
  const caps = {
    total: capUsd(f.caps.total),
    bgRemoval: capUsd(f.caps.bgRemoval),
    sceneTags: capUsd(f.caps.sceneTags),
    perUser: capUsd(f.caps.perUser),
  };
  for (const [k, v] of Object.entries(caps)) {
    if (v === null) errors[`caps.${k}`] = 'US$0 to US$10,000.';
  }
  if (Object.keys(errors).length) return { settings: null, errors };
  return {
    errors: null,
    settings: {
      ...base,
      enabled: f.enabled,
      cloudPaused: f.cloudPaused,
      features: { ...f.features },
      bgProvider: f.bgProvider,
      bgFallback: f.bgFallback,
      runwareModel: f.runwareModel.trim(),
      falModel: f.falModel.trim(),
      sceneModel: f.sceneModel.trim(),
      bgCreditsPerPhoto: credits as number,
      costs: {
        runwareMicros: costs.runware as number,
        falMicros: costs.fal as number,
        sceneMicros: costs.scene as number,
      },
      caps: {
        total: caps.total as number,
        bgRemoval: caps.bgRemoval as number,
        sceneTags: caps.sceneTags as number,
        perUser: caps.perUser as number,
      },
      alerts: CAP_ALERTS.filter((a) => f.alerts.includes(a)),
      atCap: f.atCap,
      alertTo: f.alertTo,
      memberJobsPerMinute: perMin as number,
    },
  };
}

/** Only what changed: nested features, costs and caps are compared key by key. */
export function diffAiSettings(base: AiSettings, next: AiSettings): AiSettingsPatch {
  const out: AiSettingsPatch = {};
  const flat = [
    'enabled',
    'cloudPaused',
    'bgProvider',
    'bgFallback',
    'runwareModel',
    'falModel',
    'sceneModel',
    'bgCreditsPerPhoto',
    'atCap',
    'alertTo',
    'memberJobsPerMinute',
  ] as const;
  for (const k of flat) {
    if (next[k] !== base[k]) (out as Record<string, unknown>)[k] = next[k];
  }
  const features: Partial<Record<AiFeature, boolean>> = {};
  for (const f of AI_FEATURES) if (next.features[f] !== base.features[f]) features[f] = next.features[f];
  if (Object.keys(features).length) out.features = features;
  const costs: AiSettingsPatch['costs'] = {};
  for (const k of ['runwareMicros', 'falMicros', 'sceneMicros'] as const) {
    if (next.costs[k] !== base.costs[k]) costs[k] = next.costs[k];
  }
  if (Object.keys(costs).length) out.costs = costs;
  const caps: AiSettingsPatch['caps'] = {};
  for (const k of ['total', 'bgRemoval', 'sceneTags', 'perUser'] as const) {
    if (next.caps[k] !== base.caps[k]) caps[k] = next.caps[k];
  }
  if (Object.keys(caps).length) out.caps = caps;
  const a = [...base.alerts].sort((x, y) => x - y).join(',');
  const b = [...next.alerts].sort((x, y) => x - y).join(',');
  if (a !== b) out.alerts = [...next.alerts].sort((x, y) => x - y);
  return out;
}

/** Spend as a share of its cap (0 when the cap is 0 and nothing was spent; capped display at 100). */
export function spendPct(spent: number, cap: number): number {
  if (cap <= 0) return spent > 0 ? 100 : 0;
  return Math.min(100, Math.round((spent / cap) * 100));
}
export const spendTone = (pct: number) => (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'good');

/** "6 min ago" style relative time. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
