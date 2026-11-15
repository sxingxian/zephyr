import {
  ADMIN_AI_API,
  type AdminAiSettingsResult,
  AI_FEATURES,
  type AiFeature,
  type AiSettings,
  type AiSpendToday,
  BG_PROVIDERS,
  CAP_ALERTS,
  type CapAlert,
  isRiskLowering,
} from '@zephyr/shared/client';
import { Button, Card, CardHead, Chip, Field, Icon, Note, SelectField, Spinner, useToast } from '@zephyr/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ReadOnlyChip, ResetsChip, SpendToday, WhereChip } from '../components/AiBits';
import { AdminShell } from '../components/Shell';
import {
  type AiForm,
  type AiFormErrors,
  diffAiSettings,
  FEATURE_INFO,
  PROVIDER_LABEL,
  parseForm,
  toForm,
} from '../lib/ai';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { isCancelled } from '../lib/passkey';
import { canWrite, useAdminSession } from '../lib/session';
import { useAiSettingsPatch } from '../lib/useAiSettings';

/** Message for a failed save on this page. */
export function aiSaveError(e: unknown): string {
  if (isCancelled(e)) return 'Not saved. These changes need your passkey.';
  if (e instanceof ApiFailure) {
    if (e.code === 'reauth_required') return 'Not saved. Sign in again with your passkey, then save.';
    if (e.code === 'forbidden') return 'Your role can’t change Zephyr AI settings.';
    if (e.code === 'invalid') return 'Some values weren’t accepted. Check the fields and try again.';
    if (e.code === 'conflict') return 'Someone else changed these settings. Reload to see the latest.';
  }
  return errorMessage(e);
}

function FeatureRow({
  feature,
  on,
  disabled,
  onChange,
}: {
  feature: AiFeature;
  on: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  const info = FEATURE_INFO[feature];
  return (
    <div className="feat-row">
      <label htmlFor={id} className="feat-row__text">
        <span className="feat-row__name">{info.label}</span>
        <span className="z-hint">{info.desc}</span>
      </label>
      <WhereChip cloud={info.cloud} />
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="z-switch"
        checked={on}
        aria-checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

function MoneyRow({
  label,
  hint,
  unit,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div className="money-row">
      <label htmlFor={id} className="money-row__text">
        <span>{label}</span>
        <span className="z-hint">{hint}</span>
      </label>
      <span className="money-row__input">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          className="z-input z-input--md z-mono"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="z-muted money-row__unit">{unit}</span>
      </span>
      {error && (
        <span id={errId} className="z-hint z-hint--error money-row__err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function Controls({
  base,
  spend,
  readOnly,
  onSaved,
}: {
  base: AiSettings;
  spend: AiSpendToday;
  readOnly: boolean;
  onSaved: (r: AdminAiSettingsResult) => void;
}) {
  const toast = useToast();
  const patchSettings = useAiSettingsPatch();
  const [form, setForm] = useState<AiForm>(() => toForm(base));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Follow the server only when its values really change. Not on mount (the form already starts from them, and a
  // reset there would wipe a click made before the effect ran), nor when the parent re-fetches the same values.
  const baseKey = JSON.stringify(base);
  const shownKey = useRef(baseKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the settings' content, not the object identity.
  useEffect(() => {
    if (shownKey.current === baseKey) return;
    shownKey.current = baseKey;
    setForm(toForm(base));
  }, [baseKey]);

  const parsed = useMemo(() => parseForm(form, base), [form, base]);
  const errors: AiFormErrors = parsed.errors ?? {};
  const patch = useMemo(
    () => (parsed.settings ? diffAiSettings(base, parsed.settings) : null),
    [parsed, base],
  );
  const dirty = parsed.errors !== null || (patch !== null && Object.keys(patch).length > 0);
  const lowering = patch ? isRiskLowering(base, patch) : true;
  const set = (p: Partial<AiForm>) => {
    setSaveError(null);
    setForm((f) => ({ ...f, ...p }));
  };

  const save = async () => {
    if (!patch || !Object.keys(patch).length) return;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await patchSettings(patch);
      onSaved(r);
      toast.show('Zephyr AI settings saved', 'good');
    } catch (e) {
      setSaveError(aiSaveError(e));
    } finally {
      setBusy(false);
    }
  };

  const credits = Number(form.bgCreditsPerPhoto);
  const fieldOpts = { disabled: readOnly, size: 'md' as const };
  const toggleAlert = (a: CapAlert, on: boolean) =>
    set({
      alerts: on
        ? [...new Set([...form.alerts, a])].sort((x, y) => x - y)
        : form.alerts.filter((x) => x !== a),
    });

  return (
    <>
      {!readOnly && (
        <div className="ai-savebar">
          <span className="z-hint">
            {!dirty
              ? 'No unsaved changes. Changes reach the app within 30 seconds.'
              : parsed.errors
                ? 'Fix the highlighted fields to save.'
                : lowering
                  ? 'Turning things off or lowering a cap saves at once.'
                  : 'These changes can raise spend: you’ll confirm with your passkey, and every Owner is emailed.'}
          </span>
          <span className="btn-row">
            <Button kind="ghost" size="sm" disabled={!dirty || busy} onClick={() => setForm(toForm(base))}>
              Discard
            </Button>
            <Button
              kind="primary"
              size="sm"
              icon={lowering ? undefined : 'passkey'}
              disabled={!dirty || parsed.errors !== null}
              busy={busy}
              onClick={save}
            >
              {lowering ? 'Save' : 'Save · confirm with passkey'}
            </Button>
          </span>
          {saveError && (
            <div className="ai-savebar__error">
              <Note tone="bad" icon="alert" role="alert">
                {saveError}
              </Note>
            </div>
          )}
        </div>
      )}

      <section className="ai-master" aria-labelledby="ai-master-title">
        <span className="ai-master__icon">
          <Icon name="breeze" size={22} />
        </span>
        <label htmlFor="ai-master" className="ai-master__text">
          <span id="ai-master-title" className="ai-master__title">
            Zephyr AI for everyone
          </span>
          <span className="z-hint">
            Off hides every AI button and shows “Zephyr AI is paused”. Manual editing keeps working.
          </span>
        </label>
        <Chip tone={form.enabled ? 'good' : 'bad'} dot>
          {form.enabled ? 'On' : 'Off'}
        </Chip>
        <input
          id="ai-master"
          type="checkbox"
          role="switch"
          className="z-switch"
          checked={form.enabled}
          aria-checked={form.enabled}
          disabled={readOnly}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
      </section>
      {form.cloudPaused && (
        <Note tone="warn" icon="pause">
          New cloud jobs are paused by an admin. Queued work waits and nothing is refunded. Resume it on the
          AI jobs page.
        </Note>
      )}

      <div className="ai-cols">
        <div className="ai-main">
          <Card aria-labelledby="ai-feat-title">
            <CardHead title={<span id="ai-feat-title">Features</span>}>
              <span className="z-hint">Which plans get each one: Plan limits</span>
            </CardHead>
            <div>
              {AI_FEATURES.map((f) => (
                <FeatureRow
                  key={f}
                  feature={f}
                  on={form.features[f]}
                  disabled={readOnly}
                  onChange={(v) => set({ features: { ...form.features, [f]: v } })}
                />
              ))}
            </div>
          </Card>

          <Card aria-labelledby="ai-prov-title">
            <CardHead title={<span id="ai-prov-title">Providers and models</span>}>
              <Chip tone="outline" icon="info">
                Model IDs live here, not in code
              </Chip>
            </CardHead>
            <div className="ai-fields">
              <div className="stack-tight">
                <SelectField
                  label="Background removal · provider"
                  value={form.bgProvider}
                  disabled={readOnly}
                  options={BG_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
                  onChange={(e) => set({ bgProvider: e.target.value as AiForm['bgProvider'] })}
                />
                <span className="z-hint">
                  {form.bgProvider === 'runware'
                    ? 'About US$0.0006 a photo · switch after the 50-photo bake-off'
                    : 'US$0.018 a photo · more than a credit sells for'}
                </span>
              </div>
              <div className="stack-tight">
                <SelectField
                  label="Background removal · fallback"
                  value={form.bgFallback}
                  disabled={readOnly}
                  aria-invalid={errors.bgFallback ? true : undefined}
                  options={[...BG_PROVIDERS, 'none' as const].map((p) => ({
                    value: p,
                    label: PROVIDER_LABEL[p],
                  }))}
                  onChange={(e) => set({ bgFallback: e.target.value as AiForm['bgFallback'] })}
                />
                <span
                  className={errors.bgFallback ? 'z-hint z-hint--error' : 'z-hint'}
                  role={errors.bgFallback ? 'alert' : undefined}
                >
                  {errors.bgFallback ?? 'Used after the primary fails twice'}
                </span>
              </div>
              <Field
                label="Runware model ID"
                mono
                {...fieldOpts}
                value={form.runwareModel}
                error={errors.runwareModel}
                hint="BiRefNet General is runware:112@5; set the bake-off winner"
                onChange={(e) => set({ runwareModel: e.target.value })}
              />
              <Field
                label="fal endpoint"
                mono
                {...fieldOpts}
                value={form.falModel}
                error={errors.falModel}
                hint="Bria RMBG 2.0 is fal-ai/bria/background/remove"
                onChange={(e) => set({ falModel: e.target.value })}
              />
              <Field
                label="Scene tags · Workers AI model ID"
                mono
                {...fieldOpts}
                value={form.sceneModel}
                error={errors.sceneModel}
                hint="Cloudflare retires models; update here if one goes away"
                onChange={(e) => set({ sceneModel: e.target.value })}
              />
              <Field
                label="Credits per photo · background removal"
                mono
                inputMode="numeric"
                {...fieldOpts}
                value={form.bgCreditsPerPhoto}
                error={errors.bgCreditsPerPhoto}
                hint={`What members pay${Number.isFinite(credits) && credits > 0 ? ` (≈ US$${(credits * 0.01).toFixed(2)} at the top-up price)` : ''}. Bria costs more than a credit sells for.`}
                onChange={(e) => set({ bgCreditsPerPhoto: e.target.value })}
              />
            </div>
            <div>
              <h3 className="ai-subhead">Cost estimates</h3>
              <p className="z-hint">Used for the caps when a provider doesn’t report its own cost.</p>
              <MoneyRow
                label="Runware"
                hint="Per photo; Runware usually reports the real cost"
                unit="USD / photo"
                value={form.costs.runware}
                error={errors['costs.runware']}
                disabled={readOnly}
                onChange={(v) => set({ costs: { ...form.costs, runware: v } })}
              />
              <MoneyRow
                label="fal"
                hint="Per photo"
                unit="USD / photo"
                value={form.costs.fal}
                error={errors['costs.fal']}
                disabled={readOnly}
                onChange={(v) => set({ costs: { ...form.costs, fal: v } })}
              />
              <MoneyRow
                label="Scene tags"
                hint="Per photo; measure in the first week"
                unit="USD / photo"
                value={form.costs.scene}
                error={errors['costs.scene']}
                disabled={readOnly}
                onChange={(v) => set({ costs: { ...form.costs, scene: v } })}
              />
              <MoneyRow
                label="Cloud jobs per member"
                hint="Job requests a member can make in a minute"
                unit="a minute"
                value={form.memberJobsPerMinute}
                error={errors.memberJobsPerMinute}
                disabled={readOnly}
                onChange={(v) => set({ memberJobsPerMinute: v })}
              />
            </div>
          </Card>
        </div>

        <aside className="ai-aside" aria-label="Spending">
          <Card aria-labelledby="ai-spend-title">
            <CardHead title={<span id="ai-spend-title">Today’s cloud spend</span>}>
              <ResetsChip />
            </CardHead>
            <SpendToday spend={spend} caps={base.caps} />
          </Card>
          <Card aria-labelledby="ai-cap-title">
            <CardHead title={<span id="ai-cap-title">Daily spend cap</span>} />
            <div>
              <MoneyRow
                label="All cloud AI"
                hint="Starting value; change any time"
                unit="USD / day"
                value={form.caps.total}
                error={errors['caps.total']}
                disabled={readOnly}
                onChange={(v) => set({ caps: { ...form.caps, total: v } })}
              />
              <MoneyRow
                label="Background removal"
                hint="Its own cap inside the total"
                unit="USD / day"
                value={form.caps.bgRemoval}
                error={errors['caps.bgRemoval']}
                disabled={readOnly}
                onChange={(v) => set({ caps: { ...form.caps, bgRemoval: v } })}
              />
              <MoneyRow
                label="Scene tags"
                hint="Beyond the 10,000 free Neurons a day"
                unit="USD / day"
                value={form.caps.sceneTags}
                error={errors['caps.sceneTags']}
                disabled={readOnly}
                onChange={(v) => set({ caps: { ...form.caps, sceneTags: v } })}
              />
              <MoneyRow
                label="Per user, per day"
                hint="Stops one account draining the budget"
                unit="USD"
                value={form.caps.perUser}
                error={errors['caps.perUser']}
                disabled={readOnly}
                onChange={(v) => set({ caps: { ...form.caps, perUser: v } })}
              />
            </div>
            <fieldset className="ai-alerts">
              <legend className="ai-subhead">Alerts</legend>
              <div className="btn-row">
                {CAP_ALERTS.map((a) => (
                  <label key={a} className="ai-pill">
                    <input
                      type="checkbox"
                      checked={form.alerts.includes(a)}
                      disabled={readOnly}
                      onChange={(e) => toggleAlert(a, e.target.checked)}
                    />
                    {a}%
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="stack-tight">
              <SelectField
                label="When the cap is reached"
                value={form.atCap}
                disabled={readOnly}
                options={[
                  { value: 'pause', label: 'Pause cloud AI until 00:00 UTC' },
                  { value: 'alert_only', label: 'Keep running, alert only' },
                ]}
                onChange={(e) => set({ atCap: e.target.value as AiForm['atCap'] })}
              />
              <span className="z-hint">Device-side AI keeps working either way</span>
            </div>
            <SelectField
              label="Send alerts to"
              value={form.alertTo}
              disabled={readOnly}
              options={[
                { value: 'owners_finance', label: 'Owners and Finance admins' },
                { value: 'owners', label: 'Owners only' },
              ]}
              onChange={(e) => set({ alertTo: e.target.value as AiForm['alertTo'] })}
            />
          </Card>
          <p className="z-hint">
            Last changed{' '}
            {new Date(base.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.
          </p>
        </aside>
      </div>
    </>
  );
}

export function AiControls() {
  const { staff } = useAdminSession();
  const writable = canWrite(staff?.role);
  const [data, setData] = useState<AdminAiSettingsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminAiSettingsResult>(ADMIN_AI_API.settings));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AdminShell
      title="Zephyr AI controls"
      sub="Switch AI on or off for everyone, per feature or per provider, and cap what the cloud can spend. Turning things off or lowering a cap saves at once; anything that can raise spend needs your passkey and emails every Owner."
      actions={!writable && <ReadOnlyChip />}
    >
      {err && (
        <Note tone="bad" icon="alert" role="alert">
          {err}{' '}
          <button type="button" className="linkish" onClick={() => void load()}>
            Try again
          </button>
        </Note>
      )}
      {!data && !err && <Spinner size={22} label="Loading Zephyr AI settings" />}
      {data && <Controls base={data.settings} spend={data.spend} readOnly={!writable} onSaved={setData} />}
    </AdminShell>
  );
}
