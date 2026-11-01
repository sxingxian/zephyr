import {
  type AiItemError,
  CUTOUT_SWATCHES,
  type CutoutApply,
  type CutoutSettings,
  DEFAULT_CUTOUT_APPLY,
  type DeviceJobParams,
  type EditRecipe,
  type PhotoDetail,
  type PhotoItem,
  RANGES,
} from '@zephyr/shared/client';
import { Button, Chip, Field, Icon, type IconName, Note, Spinner, Switch } from '@zephyr/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createJob, getJob, isAvailable, isOn, refreshAiStatus, useAiStatus } from '../../lib/aiClient';
import { ApiFailure, errorMessage } from '../../lib/api';
import type { EditSession } from '../../lib/editor/session';
import { getEdit } from '../../lib/edits';
import { thumbUrl } from '../../lib/library';
import { sessionUserId } from '../../lib/sessionGuard';
import type { Edit } from '../editor/Panels';
import { Slider } from '../editor/Slider';
import { AiPausedNote, CloudPausedBanner, CreditStrip, plural, WhereChip } from './AiBits';
import { ReferencePicker } from './ReferencePicker';
import '../../ai.css';

/**
 * The editor's Zephyr AI tab (phase 6). Auto-enhance, HDR and colour match run on this device through the
 * engine (lib/ai) and land on the normal sliders as one undo step. Background removal is a cloud job for this
 * one photo: the panel polls it and, when the mask arrives, takes the new edit version the server made.
 */

type Photo = Pick<PhotoItem, 'id' | 'filename' | 'fileType' | 'hasPreview'>;
export interface AiToast {
  text: string;
  undo?: () => void;
}

const ERROR_TEXT: Record<AiItemError, string> = {
  provider_timeout: 'The cutting service didn’t answer in time.',
  provider_error: 'The cutting service couldn’t process this photo.',
  bad_output: 'The cut-out didn’t pass our checks.',
  no_preview: 'This photo has no preview yet.',
  photo_deleted: 'The photo was deleted.',
  feature_off: 'Background removal was switched off.',
  device_failed: 'This photo couldn’t be processed.',
};

/** Runs device steps on the open photo and returns the new recipe (not saved: the caller commits it). */
async function runOnOpenPhoto(
  photo: Photo,
  base: EditRecipe,
  params: DeviceJobParams,
  reference: Photo | null,
  signal: AbortSignal,
): Promise<{ recipe: EditRecipe; changed: number } | null> {
  const owner = sessionUserId();
  if (!owner) throw new DOMException('Signed out.', 'AbortError');
  const { runDeviceSteps, loadReference } = await import('../../lib/ai/run');
  const ref =
    params.steps.includes('color_match') && reference ? await loadReference(reference, signal) : undefined;
  let out: EditRecipe | null = null;
  const r = await runDeviceSteps(photo, params, {
    owner,
    signal,
    reference: ref,
    deps: {
      getEdit: async () => ({ photoId: photo.id, recipe: base, version: 0, rendered: false, updatedAt: '' }),
      saveEdit: async (_id, recipe) => {
        out = recipe;
        return { photoId: photo.id, recipe, version: 0, rendered: false, updatedAt: '' };
      },
      saved: () => {},
    },
  });
  if (r.status === 'failed') throw new Error(r.error);
  if (r.status === 'unchanged' || !out) return null;
  return { recipe: out, changed: r.changed };
}

function Card({
  icon,
  title,
  desc,
  tag,
  children,
  selected,
  phone,
  open,
  onOpen,
}: {
  icon: IconName;
  title: string;
  desc: string;
  tag: ReactNode;
  children: ReactNode;
  selected?: boolean;
  phone?: boolean;
  open?: boolean;
  onOpen?: () => void;
}) {
  const head = (
    <>
      <span className="ai-card__icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="ai-card__text">
        <span className="ai-card__row">
          <span className="ai-card__title">{title}</span>
          {tag}
        </span>
        <span className="ai-card__desc">{desc}</span>
      </span>
    </>
  );
  return (
    <section className={`ai-card${selected ? ' is-selected' : ''}${phone ? ' ai-card--phone' : ''}`}>
      {phone ? (
        <button type="button" className="ai-card__head" aria-expanded={open} onClick={onOpen}>
          {head}
        </button>
      ) : (
        <div className="ai-card__head">{head}</div>
      )}
      {(!phone || open) && <div className="ai-card__body">{children}</div>}
    </section>
  );
}

function Strength({
  label = 'Strength',
  value,
  onChange,
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Slider
      label={label}
      value={value}
      min={0}
      max={100}
      step={1}
      bipolar={false}
      onInput={onChange}
      onCommit={(v) => v !== undefined && onChange(v)}
    />
  );
}

type BgState =
  | { s: 'idle' }
  | { s: 'working'; jobId: string | null }
  | { s: 'failed'; text: string }
  | { s: 'error'; text: string };

/** Polls a one-photo background-removal job until it settles. */
async function waitForJob(
  jobId: string,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: AiItemError | null }> {
  for (let i = 0; ; i++) {
    await new Promise((r, rej) => {
      const t = setTimeout(r, i < 10 ? 2000 : 5000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          rej(new DOMException('Stopped.', 'AbortError'));
        },
        {
          once: true,
        },
      );
    });
    const d = await getJob(jobId, null, signal);
    const item = d.items[0];
    if (item?.status === 'completed') return { ok: true };
    if (item?.status === 'failed' || item?.status === 'canceled') return { ok: false, error: item.error };
    if (d.job.status === 'done' || d.job.status === 'canceled')
      return { ok: false, error: item?.error ?? null };
  }
}

/** Background removal controls once a photo has a cut-out (AiCutout). */
export function CutoutPanel({
  cutout,
  edit,
  credits,
  busy,
  onRunAgain,
  phone,
}: {
  cutout: CutoutSettings;
  edit: Edit;
  credits: number;
  busy: boolean;
  onRunAgain: () => void;
  phone?: boolean;
}) {
  const set = (patch: Partial<CutoutSettings>) =>
    edit.commit({ ...edit.recipe, cutout: { ...cutout, ...patch } });
  const preview = (patch: Partial<CutoutSettings>) =>
    edit.preview({ ...edit.recipe, cutout: { ...cutout, ...patch } });
  const [hex, setHex] = useState(cutout.color ?? '#ffffff');
  useEffect(() => {
    if (cutout.color) setHex(cutout.color);
    else if (cutout.bg === 'white') setHex('#ffffff');
  }, [cutout.color, cutout.bg]);
  const flat = cutout.bg === 'white' || cutout.bg === 'color';
  const shadow = cutout.shadow ?? 'none';
  const bgs: { v: CutoutSettings['bg']; label: string; sw: string }[] = [
    { v: 'transparent', label: 'Transparent', sw: 'ai-sw--checker' },
    { v: 'white', label: 'White', sw: 'ai-sw--white' },
    { v: 'color', label: 'Colour', sw: 'ai-sw--colour' },
    { v: 'original', label: 'Original', sw: 'ai-sw--original' },
  ];
  return (
    <section className={`ai-cutout${phone ? ' ai-cutout--phone' : ''}`} aria-label="Background removed">
      <div className="ai-cutout__head">
        <span className="ai-cutout__badge">
          <Icon name="scissors" size={18} />
        </span>
        <span>
          <strong>Background removed</strong>
          <span className="ai-card__desc">{plural(credits, 'credit')} used · the original is untouched</span>
        </span>
      </div>
      <fieldset className="ai-radios ai-radios--2">
        <legend className="ai-label">Background</legend>
        {bgs.map((b) => (
          <label key={b.v} className={`ai-radio${cutout.bg === b.v ? ' is-on' : ''}`}>
            <input
              type="radio"
              className="z-sr"
              name="cutout-bg"
              checked={cutout.bg === b.v}
              onChange={() =>
                set(b.v === 'color' ? { bg: 'color', color: cutout.color ?? '#e9e1d3' } : { bg: b.v })
              }
            />
            <span className={`ai-sw ${b.sw}`} aria-hidden="true" />
            {b.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="ai-swatches">
        <legend className="z-sr">Background colour</legend>
        {CUTOUT_SWATCHES.map((c) => {
          const v = c.toLowerCase();
          const on =
            (v === '#ffffff' && cutout.bg === 'white') || (cutout.bg === 'color' && cutout.color === v);
          return (
            <button
              key={c}
              type="button"
              className={`ai-swatch${on ? ' is-on' : ''}`}
              style={{ background: c }}
              aria-label={`Background colour ${c}`}
              aria-pressed={on}
              onClick={() => set(v === '#ffffff' ? { bg: 'white' } : { bg: 'color', color: v })}
            />
          );
        })}
        <Field
          ariaLabel="Hex colour"
          mono
          size="md"
          className="ai-hex"
          value={hex}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.trim();
            setHex(v);
            if (/^#[0-9a-fA-F]{6}$/.test(v)) set({ bg: 'color', color: v.toLowerCase() });
          }}
        />
      </fieldset>
      <fieldset className="ai-radios ai-radios--3" disabled={!flat}>
        <legend className="ai-label">Shadow</legend>
        {(['none', 'soft', 'contact'] as const).map((v) => (
          <label key={v} className={`ai-radio${shadow === v ? ' is-on' : ''}`}>
            <input
              type="radio"
              className="z-sr"
              name="cutout-shadow"
              checked={shadow === v}
              onChange={() =>
                set(
                  v === 'none'
                    ? { shadow: undefined, shadowStrength: undefined }
                    : { shadow: v, shadowStrength: cutout.shadowStrength ?? 40 },
                )
              }
            />
            {v === 'none' ? 'None' : v === 'soft' ? 'Soft' : 'Contact'}
          </label>
        ))}
      </fieldset>
      {flat && shadow !== 'none' && (
        <Slider
          label="Shadow strength"
          value={cutout.shadowStrength ?? 0}
          min={0}
          max={100}
          step={1}
          bipolar={false}
          onInput={(v) => preview({ shadowStrength: v })}
          onCommit={(v) => set({ shadowStrength: v ?? edit.recipe.cutout?.shadowStrength })}
        />
      )}
      {!flat && <span className="z-hint">Shadows show on white or coloured backgrounds.</span>}
      <div className="ai-label">Edges</div>
      <Slider
        label="Softness"
        value={cutout.softness ?? 0}
        min={RANGES.cutout.softness.min}
        max={RANGES.cutout.softness.max}
        step={RANGES.cutout.softness.step}
        bipolar={false}
        suffix=" px"
        onInput={(v) => preview({ softness: v })}
        onCommit={(v) => set({ softness: v ?? edit.recipe.cutout?.softness })}
      />
      <Slider
        label="Shift"
        value={cutout.shift ?? 0}
        min={RANGES.cutout.shift.min}
        max={RANGES.cutout.shift.max}
        step={RANGES.cutout.shift.step}
        onInput={(v) => preview({ shift: v })}
        onCommit={(v) => set({ shift: v ?? edit.recipe.cutout?.shift })}
      />
      <span className="z-hint">Pull the edge in to drop a halo, out to keep fine hair.</span>
      {!phone && (
        <Note tone="neutral" icon="info">
          Transparent backgrounds export as PNG. Other backgrounds export as JPEG, like any edit.
        </Note>
      )}
      <div className="ai-cutout__foot">
        <Button
          kind="ghost"
          size="sm"
          icon="trash"
          onClick={() => {
            const { cutout: _drop, ...rest } = edit.recipe;
            edit.commit(rest as EditRecipe);
          }}
        >
          Remove cut-out
        </Button>
        <span className="editor__spacer" />
        <Button kind="ghost" size="sm" icon="refresh" busy={busy} onClick={onRunAgain}>
          Run again · {plural(credits, 'credit')}
        </Button>
      </div>
    </section>
  );
}

/** The editor's AI tab (desktop panel, or the phone tool sheet with `phone`). */
export function EditorAiPanel({
  photo,
  session,
  edit,
  phone,
  onToast,
}: {
  photo: PhotoDetail;
  session: EditSession;
  edit: Edit;
  phone?: boolean;
  onToast: (t: AiToast) => void;
}) {
  const status = useAiStatus();
  const [strength, setStrength] = useState(70);
  const [skin, setSkin] = useState(true);
  const [hdr, setHdr] = useState(50);
  const [match, setMatch] = useState(80);
  const [reference, setReference] = useState<PhotoItem | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ step: string; changed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bg, setBg] = useState<BgState>({ s: 'idle' });
  const [open, setOpen] = useState<string | null>(phone ? null : 'all');
  const ctrl = useRef<AbortController | null>(null);
  const bgCtrl = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      ctrl.current?.abort();
      bgCtrl.current?.abort();
    },
    [],
  );
  // A different photo: start fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per photo only
  useEffect(() => {
    setApplied(null);
    setError(null);
    setBg({ s: 'idle' });
  }, [photo.id]);

  if (!status) return <Spinner size={18} label="Loading Zephyr AI" />;
  if (!status.enabled) return <AiPausedNote />;

  const per = status.credits.bgCreditsPerPhoto;
  const cutout = edit.recipe.cutout ?? null;

  const runStep = async (step: 'auto_enhance' | 'hdr' | 'color_match', label: string) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(step);
    setError(null);
    const params: DeviceJobParams =
      step === 'auto_enhance'
        ? { steps: ['auto_enhance'], strength, skin }
        : step === 'hdr'
          ? { steps: ['hdr'], hdrStrength: hdr }
          : { steps: ['color_match'], reference: reference?.id, matchStrength: match };
    try {
      const out = await runOnOpenPhoto(photo, session.getSnapshot().recipe, params, reference, c.signal);
      if (c.signal.aborted) return;
      if (!out) {
        onToast({ text: `${label}: this photo already looks balanced` });
        return;
      }
      edit.commit(out.recipe);
      setApplied({ step, changed: out.changed });
      onToast({ text: `${label} changed ${plural(out.changed, 'slider')}`, undo: () => session.undo() });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof ApiFailure ? errorMessage(e) : 'That didn’t work on this photo. Try again.');
    } finally {
      if (ctrl.current === c) setBusy(null);
    }
  };

  const removeBackground = async (force: boolean) => {
    bgCtrl.current?.abort();
    const c = new AbortController();
    bgCtrl.current = c;
    setBg({ s: 'working', jobId: null });
    const apply: CutoutApply = cutout
      ? {
          bg: cutout.bg,
          ...(cutout.color ? { color: cutout.color } : {}),
          ...(cutout.shadow ? { shadow: cutout.shadow, shadowStrength: cutout.shadowStrength ?? 0 } : {}),
        }
      : DEFAULT_CUTOUT_APPLY;
    try {
      const res = await createJob({
        kind: 'bg_removal',
        photoIds: [photo.id],
        apply,
        title: photo.filename,
        ...(force ? { force: true } : {}),
      });
      void refreshAiStatus();
      if (!res.job.counts.total) {
        const why = res.skipped[0]?.reason;
        setBg({
          s: 'error',
          text:
            why === 'already_cut_out'
              ? 'This photo already has a cut-out.'
              : why === 'no_preview'
                ? 'This photo has no preview yet. Try again in a moment.'
                : 'That photo isn’t available.',
        });
        return;
      }
      setBg({ s: 'working', jobId: res.job.id });
      const done = await waitForJob(res.job.id, c.signal);
      if (c.signal.aborted) return;
      void refreshAiStatus();
      if (!done.ok) {
        setBg({
          s: 'failed',
          text: `${(done.error && ERROR_TEXT[done.error]) || 'Background removal failed.'} Your credit was refunded.`,
        });
        return;
      }
      const e = await getEdit(photo.id, c.signal);
      if (e) await session.adoptServer(e);
      setBg({ s: 'idle' });
      onToast({ text: 'Background removed', undo: () => session.undo() });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setBg({ s: 'error', text: errorMessage(e) });
    }
  };

  const toggle = (k: string) => setOpen((o) => (o === k ? null : k));
  const isOpen = (k: string) => open === 'all' || open === k;
  const working = bg.s === 'working';
  const paused = status.features.bg_removal === 'paused';
  const short = status.credits.balance < per;

  return (
    <div className={`ai-panel${phone ? ' ai-panel--phone' : ''}`}>
      <CloudPausedBanner status={status} />
      {cutout && isAvailable(status, 'bg_removal') && (
        <CutoutPanel
          cutout={cutout}
          edit={edit}
          credits={per}
          busy={working}
          onRunAgain={() => void removeBackground(true)}
          phone={phone}
        />
      )}
      {!phone && <CreditStrip status={status} />}
      {phone && (
        <div className="ai-phone-credits">
          <span>On-device tools are free</span>
          <span>
            <Icon name="breeze" size={14} /> <strong>{status.credits.balance.toLocaleString('en')}</strong>{' '}
            credits
          </span>
        </div>
      )}
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      {isOn(status, 'auto_enhance') && (
        <Card
          icon="wand"
          title="Auto-enhance"
          desc={
            applied?.step === 'auto_enhance'
              ? `Applied · changed ${plural(applied.changed, 'slider')}`
              : 'Sets exposure, white balance and contrast for this photo. Every change lands on the normal sliders, so you can fine-tune it.'
          }
          tag={<WhereChip />}
          selected={applied?.step === 'auto_enhance'}
          phone={phone}
          open={isOpen('auto')}
          onOpen={() => toggle('auto')}
        >
          <Strength value={strength} onChange={setStrength} />
          <Switch
            checked={skin}
            onChange={setSkin}
            label="Optimise skin tones"
            hint="Finds faces on this device to keep skin natural"
          />
          <div className="ai-card__actions">
            <Button
              kind="primary"
              size="sm"
              icon="wand"
              busy={busy === 'auto_enhance'}
              disabled={Boolean(busy)}
              onClick={() => void runStep('auto_enhance', 'Auto-enhance')}
            >
              {applied?.step === 'auto_enhance' ? 'Apply again' : 'Auto-enhance'}
            </Button>
          </div>
        </Card>
      )}
      {isOn(status, 'hdr') && (
        <Card
          icon="hdr"
          title="HDR & interior balance"
          desc="Lifts dark rooms and holds detail in bright windows and skies."
          tag={<WhereChip />}
          selected={applied?.step === 'hdr'}
          phone={phone}
          open={isOpen('hdr')}
          onOpen={() => toggle('hdr')}
        >
          <Strength value={hdr} onChange={setHdr} />
          <div className="ai-card__actions">
            <Button
              size="sm"
              icon="hdr"
              busy={busy === 'hdr'}
              disabled={Boolean(busy)}
              onClick={() => void runStep('hdr', 'HDR balance')}
            >
              Balance light
            </Button>
          </div>
        </Card>
      )}
      {isOn(status, 'color_match') && (
        <Card
          icon="palette"
          title="Colour match"
          desc="Matches this photo’s colour and tone to a reference photo."
          tag={<WhereChip />}
          selected={applied?.step === 'color_match'}
          phone={phone}
          open={isOpen('match')}
          onOpen={() => toggle('match')}
        >
          <button type="button" className="ai-ref" onClick={() => setPicker(true)}>
            {reference ? (
              <img src={thumbUrl(reference.id)} alt="" className="ai-ref__thumb" />
            ) : (
              <span className="ai-ref__thumb ai-ref__thumb--empty">
                <Icon name="image" size={17} />
              </span>
            )}
            <span className="ai-ref__text">
              <strong>{reference ? reference.filename : 'Pick a reference photo'}</strong>
              <span className="z-muted">{reference ? 'Reference · change' : 'From your library'}</span>
            </span>
            <Icon name="chevR" size={16} />
          </button>
          <Strength value={match} onChange={setMatch} />
          <div className="ai-card__actions">
            <Button
              size="sm"
              icon="palette"
              busy={busy === 'color_match'}
              disabled={Boolean(busy) || !reference}
              onClick={() => void runStep('color_match', 'Colour match')}
            >
              Match colour
            </Button>
          </div>
          <ReferencePicker
            open={picker}
            onClose={() => setPicker(false)}
            onPick={setReference}
            exclude={photo.id}
          />
        </Card>
      )}
      {isAvailable(status, 'bg_removal') && !cutout && (
        <Card
          icon="scissors"
          title="Studio background removal"
          desc="Cuts out the subject. Then choose transparent, white or a colour, with a soft shadow."
          tag={<WhereChip cloud text={`${plural(per, 'credit')} · cloud`} />}
          phone={phone}
          open={isOpen('bg')}
          onOpen={() => toggle('bg')}
        >
          {working ? (
            <div className="ai-working" role="status" aria-live="polite">
              <Spinner size={16} />
              <span>
                {paused
                  ? 'Waiting: cloud AI is paused. It starts on its own.'
                  : 'Removing the background… you can keep editing.'}
              </span>
            </div>
          ) : (
            <div className="ai-card__actions">
              <Button size="sm" icon="scissors" disabled={short} onClick={() => void removeBackground(false)}>
                Remove background · {plural(per, 'credit')}
              </Button>
            </div>
          )}
          {short && !working && (
            <Note tone="warn" icon="alert">
              You have {plural(status.credits.balance, 'credit')} left. New credits arrive on{' '}
              {new Date(`${status.credits.periodEnd}T00:00:00Z`).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
              })}
              .
            </Note>
          )}
          {(bg.s === 'failed' || bg.s === 'error') && (
            <Note tone="bad" icon="alert" role="alert">
              {bg.text}
            </Note>
          )}
        </Card>
      )}
      {cutout && (bg.s === 'failed' || bg.s === 'error') && (
        <Note tone="bad" icon="alert" role="alert">
          {bg.text}
        </Note>
      )}
      {cutout && working && (
        <div className="ai-working" role="status" aria-live="polite">
          <Spinner size={16} />
          <span>Cutting out again…</span>
        </div>
      )}
      {!phone && (
        <p className="ai-privacy">
          <Icon name="shield" size={15} />
          <span>
            Auto-enhance, HDR and colour match run on this device. Background removal sends a copy up to 2048
            px to our cutting service, which keeps nothing and never trains on it.
          </span>
        </p>
      )}
      {phone && <Chip size="sm">Originals are never changed</Chip>}
    </div>
  );
}
