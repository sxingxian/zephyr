import {
  type CutoutApply,
  DEFAULT_CUTOUT_APPLY,
  type DeviceStep,
  type PhotoItem,
} from '@zephyr/shared/client';
import { Button, Dialog, Icon, type IconName, Note, useToast } from '@zephyr/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { createJob, deviceLabel, isAvailable, isOn, refreshAiStatus, useAiStatus } from '../../lib/aiClient';
import { ApiFailure, errorMessage } from '../../lib/api';
import { plural, WhereChip } from './AiBits';
import { ReferencePicker } from './ReferencePicker';
import '../../ai.css';

/**
 * "Zephyr AI for N photos" (phase 6, AiBatch): pick device steps (auto-enhance, HDR, colour match) and/or the
 * cloud background removal for a selection. Device steps become a device job this tab claims and runs; the
 * background removal becomes a cloud job charged up front (failures are refunded).
 */

/** Seconds on the device: about 1.2 s a photo for the first step, 0.4 s for each extra one. */
export function deviceSeconds(photos: number, steps: number): number {
  if (!photos || !steps) return 0;
  return Math.round(photos * (1.2 + 0.4 * (steps - 1)));
}
export function aboutTime(s: number): string {
  if (s < 60) return `about ${Math.max(5, Math.round(s / 5) * 5)} s`;
  const m = Math.round(s / 60);
  return `about ${m} min`;
}

function Step({
  on,
  onChange,
  icon,
  name,
  desc,
  tag,
  children,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  icon: IconName;
  name: string;
  desc: string;
  tag: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`ai-step${on ? ' is-on' : ''}`}>
      <label className="ai-step__label">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span className="ai-step__text">
          <span className="ai-step__row">
            <span className="ai-step__name">
              <Icon name={icon} size={16} />
              {name}
            </span>
            {tag}
          </span>
          <span className="ai-step__desc">{desc}</span>
        </span>
      </label>
      {on && children && <div className="ai-step__extra">{children}</div>}
    </div>
  );
}

const BG_LABEL: Record<CutoutApply['bg'], string> = {
  white: 'White',
  transparent: 'Transparent',
  color: 'Colour',
  original: 'Original',
};

export function BatchDialog({
  open,
  photoIds,
  title,
  onClose,
  onStarted,
}: {
  open: boolean;
  photoIds: string[];
  /** Shown under the heading, e.g. the album name. */
  title?: string;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const status = useAiStatus();
  const toast = useToast();
  const [steps, setSteps] = useState<Record<DeviceStep, boolean>>({
    auto_enhance: true,
    hdr: false,
    color_match: false,
  });
  const [bg, setBg] = useState(false);
  const [apply, setApply] = useState<CutoutApply>(DEFAULT_CUTOUT_APPLY);
  const [changing, setChanging] = useState(false);
  const [reference, setReference] = useState<PhotoItem | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setChanging(false);
  }, [open]);

  if (!status) return null;
  const n = photoIds.length;
  const deviceSteps = (Object.keys(steps) as DeviceStep[]).filter((k) => steps[k] && isOn(status, k));
  const bgOn = bg && isAvailable(status, 'bg_removal');
  const per = status.credits.bgCreditsPerPhoto;
  const credits = bgOn ? n * per : 0;
  const balance = status.credits.balance;
  const over = n > status.batchSize;
  const short = credits > balance;
  const needsRef = deviceSteps.includes('color_match') && !reference;
  const nothing = !deviceSteps.length && !bgOn;
  const label = title ? `${title}` : `${plural(n, 'photo')}`;

  const start = async () => {
    setBusy(true);
    setError(null);
    const jobTitle = (
      title
        ? `${title}`
        : `${plural(n, 'photo')} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    ).slice(0, 80);
    const started: string[] = [];
    try {
      if (bgOn) {
        const r = await createJob({ kind: 'bg_removal', photoIds, apply, title: jobTitle });
        const skipped = r.skipped.length;
        started.push(
          skipped
            ? `background removal (${plural(skipped, 'photo')} already cut out, skipped)`
            : 'background removal',
        );
      }
      if (deviceSteps.length) {
        const device = deviceLabel();
        // The job's first lease is this tab's (its runner token), so this tab claims it straight away and no
        // other tab of the same sign-in can.
        const { deviceRunner, tabRunnerToken } = await import('../../lib/deviceRunner');
        const r = await createJob({
          kind: 'device',
          photoIds,
          title: jobTitle,
          device,
          runner: tabRunnerToken(),
          params: {
            steps: deviceSteps,
            ...(steps.auto_enhance ? { strength: 70, skin: true } : {}),
            ...(steps.hdr ? { hdrStrength: 50 } : {}),
            ...(steps.color_match && reference ? { reference: reference.id, matchStrength: 80 } : {}),
          },
        });
        void deviceRunner.start(r.job);
        started.push('on-device steps');
      }
      void refreshAiStatus();
      toast.show(`Started ${started.join(' and ')}. Follow it in the AI queue.`, 'good');
      onStarted?.();
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiFailure && e.code === 'too_large'
          ? `Up to ${status.batchSize} photos at a time on your plan.`
          : errorMessage(e),
      );
      void refreshAiStatus();
    } finally {
      setBusy(false);
    }
  };

  const shadowText =
    apply.shadow && apply.shadow !== 'none'
      ? apply.shadow === 'soft'
        ? 'Soft shadow'
        : 'Contact shadow'
      : 'No shadow';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="edlg-title">
          <span className="ai-dlg-icon">
            <Icon name="breeze" size={20} />
          </span>
          <span>
            Zephyr AI for {plural(n, 'photo')}
            {title && <span className="edlg-title__sub">{title}</span>}
          </span>
        </span>
      }
      footer={
        <>
          <span className="edlg-foot__note">
            Up to {status.batchSize.toLocaleString('en')} photos at a time on your plan
          </span>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            icon="breeze"
            busy={busy}
            disabled={nothing || over || short || needsRef}
            onClick={start}
          >
            {credits ? `Start · ${plural(credits, 'credit')}` : 'Start'}
          </Button>
        </>
      }
    >
      <fieldset className="ai-steps">
        <legend className="z-sr">Steps for {label}</legend>
        {isOn(status, 'auto_enhance') && (
          <Step
            on={steps.auto_enhance}
            onChange={(v) => setSteps({ ...steps, auto_enhance: v })}
            icon="wand"
            name="Auto-enhance"
            desc="Exposure, white balance, contrast and skin tones, set per photo"
            tag={<WhereChip />}
          />
        )}
        {isOn(status, 'hdr') && (
          <Step
            on={steps.hdr}
            onChange={(v) => setSteps({ ...steps, hdr: v })}
            icon="hdr"
            name="HDR & interior balance"
            desc="For dark interiors with bright windows"
            tag={<WhereChip />}
          />
        )}
        {isOn(status, 'color_match') && (
          <Step
            on={steps.color_match}
            onChange={(v) => setSteps({ ...steps, color_match: v })}
            icon="palette"
            name="Colour match"
            desc="Match every photo to one reference"
            tag={<WhereChip />}
          >
            <Button size="sm" kind="ghost" icon="image" onClick={() => setPicker(true)}>
              {reference ? `Reference: ${reference.filename}` : 'Pick a reference photo'}
            </Button>
          </Step>
        )}
        {isAvailable(status, 'bg_removal') && (
          <Step
            on={bg}
            onChange={setBg}
            icon="scissors"
            name="Studio background removal"
            desc={`Then: ${BG_LABEL[apply.bg].toLowerCase()} background, ${shadowText.toLowerCase()}`}
            tag={<WhereChip cloud text={`${plural(n * per, 'credit')} · cloud`} />}
          >
            {changing ? (
              <div className="ai-apply">
                <fieldset className="ai-radios ai-radios--3">
                  <legend className="ai-label">Background</legend>
                  {(['white', 'transparent', 'color'] as const).map((v) => (
                    <label key={v} className={`ai-radio${apply.bg === v ? ' is-on' : ''}`}>
                      <input
                        type="radio"
                        className="z-sr"
                        name="batch-bg"
                        checked={apply.bg === v}
                        onChange={() =>
                          setApply(
                            v === 'transparent'
                              ? { bg: 'transparent' }
                              : {
                                  ...apply,
                                  bg: v,
                                  ...(v === 'color' ? { color: apply.color ?? '#e9e1d3' } : {}),
                                },
                          )
                        }
                      />
                      {BG_LABEL[v]}
                    </label>
                  ))}
                </fieldset>
                {apply.bg !== 'transparent' && (
                  <fieldset className="ai-radios ai-radios--3">
                    <legend className="ai-label">Shadow</legend>
                    {(['none', 'soft', 'contact'] as const).map((v) => (
                      <label key={v} className={`ai-radio${(apply.shadow ?? 'none') === v ? ' is-on' : ''}`}>
                        <input
                          type="radio"
                          className="z-sr"
                          name="batch-shadow"
                          checked={(apply.shadow ?? 'none') === v}
                          onChange={() =>
                            setApply({
                              ...apply,
                              shadow: v,
                              shadowStrength: v === 'none' ? undefined : (apply.shadowStrength ?? 40),
                            })
                          }
                        />
                        {v === 'none' ? 'None' : v === 'soft' ? 'Soft' : 'Contact'}
                      </label>
                    ))}
                  </fieldset>
                )}
                <Button size="sm" kind="ghost" onClick={() => setChanging(false)}>
                  Done
                </Button>
              </div>
            ) : (
              <span className="ai-chips">
                <span className="ai-chip-o">{BG_LABEL[apply.bg]}</span>
                {apply.bg !== 'transparent' && <span className="ai-chip-o">{shadowText}</span>}
                <Button size="sm" kind="ghost" onClick={() => setChanging(true)}>
                  Change
                </Button>
              </span>
            )}
          </Step>
        )}
      </fieldset>
      <div className="ai-estimates">
        <div className="ai-est">
          <span className="ai-est__k">On this device</span>
          <span className="ai-est__v">
            {deviceSteps.length
              ? `${plural(n, 'photo')} · ${aboutTime(deviceSeconds(n, deviceSteps.length))}`
              : 'Nothing'}
          </span>
          <span className="ai-est__s">Free · keep a Zephyr tab open</span>
        </div>
        <div className="ai-est">
          <span className="ai-est__k">In the cloud</span>
          <span className="ai-est__v ai-est__v--mono" data-testid="batch-credits">
            {plural(credits, 'credit')}
          </span>
          <span className="ai-est__s">
            {balance.toLocaleString('en')} → {Math.max(0, balance - credits).toLocaleString('en')} left ·
            failures are refunded
          </span>
        </div>
      </div>
      <Note tone="neutral" icon="info">
        Each step is saved as a normal edit you can undo. Photos already cut out are skipped, so they aren’t
        charged twice.
      </Note>
      {over && (
        <Note tone="warn" icon="alert">
          Select up to {status.batchSize.toLocaleString('en')} photos at a time on your plan.
        </Note>
      )}
      {short && !over && (
        <Note tone="warn" icon="alert">
          That needs {plural(credits, 'credit')} and you have {balance.toLocaleString('en')}.
        </Note>
      )}
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <ReferencePicker open={picker} onClose={() => setPicker(false)} onPick={setReference} />
    </Dialog>
  );
}
