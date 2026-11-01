import { BRAND_ACCENTS, type Branding, type PhotoItem, SHARE_API } from '@zephyr/shared/client';
import { Button, Card, CardHead, Field, Icon, Note, SelectField, useToast } from '@zephyr/ui';
import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { Segmented } from '../components/LibraryBits';
import { SettingsNav } from '../components/SettingsNav';
import { Shell } from '../components/Shell';
import { PlanBadge, ShNote } from '../components/share/ShareBits';
import { errorMessage } from '../lib/api';
import { listPhotos, previewUrl } from '../lib/library';
import { useSession } from '../lib/session';
import {
  deleteBrandingAsset,
  getBranding,
  putBrandingAsset,
  saveBranding,
  sharingLimits,
} from '../lib/share';
import { useUsage } from '../lib/usage';
import { drawTextWatermark } from '../lib/watermark';

const ACCENT_NAMES: Record<(typeof BRAND_ACCENTS)[number], string> = {
  '#2D5FD3': 'Cobalt',
  '#1F7A4D': 'Forest',
  '#A0461C': 'Rust',
  '#7A3940': 'Wine',
  '#0D1117': 'Ink',
  '#6B4FC8': 'Violet',
  '#0E6B78': 'Teal',
  '#8A5A00': 'Bronze',
};
const POSITIONS: { value: Branding['watermark']['position']; label: string }[] = [
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'centre', label: 'Centre' },
  { value: 'tiled', label: 'Tiled' },
];
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX = 2 * 1024 * 1024;

const initialsOf = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? '')
    .join('') || 'Z';

/** Settings › Sharing & branding: what guests see on a Studio member's galleries. */
export function SharingSettings() {
  const toast = useToast();
  const usage = useUsage();
  const { user } = useSession();
  const limits = sharingLimits(usage, user?.plan);
  const allowed = limits.branding || limits.watermark;
  const [b, setB] = useState<Branding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [studioName, setStudioName] = useState('');
  const [accent, setAccent] = useState<Branding['accent']>(null);
  const [wmKind, setWmKind] = useState<'text' | 'logo'>('text');
  const [wmText, setWmText] = useState('');
  const [wmPos, setWmPos] = useState<Branding['watermark']['position']>('bottom-right');
  const [wmOpacity, setWmOpacity] = useState(70);
  const [busy, setBusy] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoBroken, setLogoBroken] = useState(false);
  const [sample, setSample] = useState<PhotoItem | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const opacityId = useId();

  const apply = (x: Branding) => {
    setB(x);
    setStudioName(x.studioName ?? '');
    setAccent(x.accent);
    setWmKind(x.watermark.kind);
    setWmText(x.watermark.text ?? (x.studioName ? `© ${x.studioName}` : ''));
    setWmPos(x.watermark.position);
    setWmOpacity(x.watermark.opacity);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `apply` only sets state
  useEffect(() => {
    if (!allowed) return;
    const c = new AbortController();
    getBranding(c.signal)
      .then(apply)
      .catch((e) => (e as Error).name !== 'AbortError' && setError(errorMessage(e)));
    listPhotos({ view: 'library', limit: 1 }, c.signal)
      .then((p) => setSample(p.items[0] ?? null))
      .catch(() => undefined);
    return () => c.abort();
  }, [allowed]);
  useEffect(
    () => () => {
      if (logoUrl) URL.revokeObjectURL(logoUrl);
    },
    [logoUrl],
  );

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.show(ok, 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const onLogo = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!LOGO_TYPES.includes(f.type)) return toast.show('Choose a PNG, JPEG or WEBP image.', 'bad');
    if (f.size > LOGO_MAX) return toast.show('That logo is over 2 MB. Choose a smaller file.', 'bad');
    void run(
      'logo',
      async () => {
        await putBrandingAsset('logo', f);
        setLogoUrl(URL.createObjectURL(f));
        setLogoBroken(false);
        apply(await getBranding());
      },
      'Logo uploaded',
    );
  };
  const saveBrand = () =>
    run(
      'brand',
      async () => {
        apply(await saveBranding({ studioName: studioName.trim() || null, accent }));
      },
      'Branding saved',
    );
  const saveWatermark = () =>
    run(
      'wm',
      async () => {
        if (wmKind === 'text') {
          // The image service overlays images, not text: draw the text here and upload it as a PNG.
          const png = await drawTextWatermark(wmText);
          await putBrandingAsset('watermark', png);
        }
        apply(
          await saveBranding({
            watermark: {
              kind: wmKind,
              text: wmKind === 'text' ? wmText.trim() : null,
              position: wmPos,
              opacity: wmOpacity,
            },
          }),
        );
      },
      'Watermark saved. New guest images use it; existing ones update as guests view them.',
    );

  const shownName = studioName.trim() || user?.displayName || 'Your studio';
  const logoSrc = logoUrl ?? (b?.hasLogo && !logoBroken ? SHARE_API.brandingAsset('logo') : null);
  const wmPreview =
    wmKind === 'logo' ? (
      logoSrc ? (
        <img src={logoSrc} alt="" className="sh-wm__logo" />
      ) : (
        <span className="sh-wm__text">{initialsOf(shownName)}</span>
      )
    ) : (
      <span className="sh-wm__text">{wmText.trim() || '© Your studio'}</span>
    );

  return (
    <Shell title="Settings">
      <div className="settings">
        <SettingsNav />
        <div className="settings__body">
          <div className="sh-settings-head">
            <h2 className="sh-h2">Sharing &amp; branding</h2>
            <span className="sh-muted">Shown on your shared galleries.</span>
          </div>
          {!allowed && (
            <Note tone="acc" icon="lock">
              Your logo, colour and watermark on shared galleries are part of Studio, along with guest
              favourites and the access log. <PlanBadge plan="Studio" />
            </Note>
          )}
          {error && (
            <Note tone="bad" icon="alert" role="alert">
              {error}
            </Note>
          )}
          <div className="sh-brand">
            <Card>
              <CardHead title="Branding" />
              <fieldset className="sh-fieldset" disabled={!limits.branding}>
                <div className="sh-logo">
                  <span className="sh-logo__tile" style={accent ? { background: accent } : undefined}>
                    {logoSrc ? (
                      <img src={logoSrc} alt="Your logo" onError={() => setLogoBroken(true)} />
                    ) : (
                      initialsOf(shownName)
                    )}
                  </span>
                  <div className="sh-logo__actions">
                    <div className="sh-row">
                      <Button
                        size="sm"
                        icon="upload"
                        busy={busy === 'logo'}
                        onClick={() => fileRef.current?.click()}
                      >
                        {b?.hasLogo ? 'Replace logo' : 'Upload logo'}
                      </Button>
                      {b?.hasLogo && (
                        <Button
                          size="sm"
                          kind="ghost"
                          onClick={() =>
                            run('logo', async () => {
                              apply(await deleteBrandingAsset('logo'));
                              setLogoUrl(null);
                            })
                          }
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                    <span className="sh-hint">
                      PNG, JPEG or WEBP, up to 2 MB. We re-draw it, so it can’t carry anything but pixels.
                    </span>
                    <input ref={fileRef} type="file" accept={LOGO_TYPES.join(',')} hidden onChange={onLogo} />
                  </div>
                </div>
                <Field
                  label="Studio name"
                  value={studioName}
                  maxLength={60}
                  onChange={(e) => setStudioName(e.target.value)}
                  size="md"
                />
                <fieldset className="sh-accents">
                  <legend className="sh-label">Accent colour</legend>
                  <div className="sh-row">
                    {BRAND_ACCENTS.map((c) => (
                      <label key={c} className="sh-swatch" title={ACCENT_NAMES[c]}>
                        <input
                          type="radio"
                          name="accent"
                          className="z-sr"
                          checked={accent === c}
                          onChange={() => setAccent(c)}
                          aria-label={ACCENT_NAMES[c]}
                        />
                        <span style={{ background: c }} />
                      </label>
                    ))}
                  </div>
                  <span className="sh-hint">
                    Each colour is checked for contrast with white text on guests’ buttons.
                  </span>
                </fieldset>
                <div className="sh-actions">
                  <Button kind="primary" busy={busy === 'brand'} onClick={saveBrand}>
                    Save branding
                  </Button>
                </div>
              </fieldset>
            </Card>
            <Card>
              <CardHead title="Watermark" />
              <fieldset className="sh-fieldset" disabled={!limits.watermark}>
                <div
                  className={`sh-wm sh-wm--${wmPos}`}
                  style={{ '--wm-op': wmOpacity / 100 } as React.CSSProperties}
                >
                  {sample ? (
                    <img
                      src={previewUrl(sample.id, sample.edit?.rendered ? sample.edit.version : undefined)}
                      alt=""
                      className="sh-wm__photo"
                    />
                  ) : (
                    <span className="sh-wm__photo sh-wm__photo--blank" aria-hidden="true" />
                  )}
                  {wmPos === 'tiled' ? (
                    <span className="sh-wm__tiles" aria-hidden="true">
                      {Array.from({ length: 6 }, (_, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: decorative repeats
                        <span key={i}>{wmPreview}</span>
                      ))}
                    </span>
                  ) : (
                    <span className="sh-wm__mark" aria-hidden="true">
                      {wmPreview}
                    </span>
                  )}
                </div>
                <Segmented
                  label="Watermark type"
                  value={wmKind}
                  onChange={setWmKind}
                  options={[
                    { value: 'text', label: 'Text' },
                    { value: 'logo', label: 'Logo' },
                  ]}
                />
                {wmKind === 'text' ? (
                  <Field
                    label="Text"
                    value={wmText}
                    maxLength={60}
                    onChange={(e) => setWmText(e.target.value)}
                    size="md"
                  />
                ) : (
                  !b?.hasLogo && <ShNote>Upload a logo under Branding first.</ShNote>
                )}
                <div className="sh-two">
                  <SelectField
                    label="Position"
                    value={wmPos}
                    onChange={(e) => setWmPos(e.target.value as Branding['watermark']['position'])}
                    options={POSITIONS}
                  />
                  <div className="z-field">
                    <label htmlFor={opacityId}>Opacity · {wmOpacity}%</label>
                    <input
                      id={opacityId}
                      type="range"
                      min={10}
                      max={90}
                      step={5}
                      value={wmOpacity}
                      aria-valuetext={`${wmOpacity}%`}
                      onChange={(e) => setWmOpacity(Number(e.target.value))}
                      className="sh-range"
                    />
                  </div>
                </div>
                <ShNote icon="shield">
                  Watermarks are drawn into the images guests receive. Your originals and your own library
                  never carry them.
                </ShNote>
                <div className="sh-actions">
                  <Button
                    kind="primary"
                    busy={busy === 'wm'}
                    disabled={wmKind === 'text' ? !wmText.trim() : !b?.hasLogo}
                    onClick={saveWatermark}
                  >
                    Save watermark
                  </Button>
                </div>
              </fieldset>
            </Card>
          </div>
          <span className="sh-muted sh-small">
            <Icon name="info" size={13} /> Turn these on for each gallery in its settings.
          </span>
        </div>
      </div>
    </Shell>
  );
}
