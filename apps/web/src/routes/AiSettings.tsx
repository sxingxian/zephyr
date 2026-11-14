import type { CreditEntry, CreditHistoryPage } from '@zephyr/shared/client';
import { Button, Chip, Note, Spinner, useToast } from '@zephyr/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  AiPausedNote,
  CloudPausedBanner,
  ConfirmDialog,
  ConsentDialog,
  plural,
  UpgradeHint,
} from '../components/ai/AiBits';
import { SettingsNav } from '../components/SettingsNav';
import { Shell } from '../components/Shell';
import {
  fetchCredits,
  patchAiSettings,
  setAiStatus,
  turnOffFaceGrouping,
  useAiStatus,
} from '../lib/aiClient';
import { errorMessage } from '../lib/api';
import { useCan } from '../lib/libraryContext';
import { useSession } from '../lib/session';
import '../ai.css';

/** Settings › Zephyr AI (phase 6): face grouping, scene tags, cleanup, and cloud credits with history. */

const REASON: Record<CreditEntry['reason'], string> = {
  monthly_grant: 'Monthly credits',
  period_expiry: 'Unused credits expired',
  job_charge: 'Background removal',
  job_refund: 'Refund',
  admin_adjust: 'Adjustment by Zephyr',
  top_up: 'Credit top-up',
  plan_change: 'Plan upgrade',
  top_up_expiry: 'Top-up credits expired',
  top_up_refund: 'Top-up refunded',
};
const PLAN = { free: 'Free', pro: 'Pro', studio: 'Studio' } as const;

function Row({ title, hint, children }: { title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="ai-set-row">
      <div className="ai-set-row__text">
        <span className="ai-set-row__title">{title}</span>
        <span className="z-muted">{hint}</span>
      </div>
      <div className="ai-set-row__ctl">{children}</div>
    </div>
  );
}

/** A switch without its own visible label (the row carries it). */
function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="z-switch"
      aria-label={label}
      checked={checked}
      aria-checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function Credits() {
  const { user } = useSession();
  const canBuy = useCan('billing');
  const [page, setPage] = useState<CreditHistoryPage | null>(null);
  const [entries, setEntries] = useState<CreditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    fetchCredits(null, c.signal)
      .then((p) => {
        setPage(p);
        setEntries(p.entries);
      })
      .catch((e) => (e as Error).name !== 'AbortError' && setError(errorMessage(e)));
    return () => c.abort();
  }, []);
  const loadMore = async () => {
    if (!page?.nextCursor) return;
    setMore(true);
    try {
      const p = await fetchCredits(page.nextCursor);
      setPage(p);
      setEntries((e) => [...e, ...p.entries]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMore(false);
    }
  };
  const b = page?.balance;
  const pct = b?.monthly ? Math.max(0, Math.min(100, Math.round((b.balance / b.monthly) * 100))) : 0;
  const day = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? 'Today'
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  return (
    <aside className="ai-credits-card" aria-labelledby="credits-h">
      <div className="ai-credits-card__head">
        <h2 id="credits-h">Cloud credits</h2>
        {user && <Chip tone="ink">{PLAN[user.plan]}</Chip>}
      </div>
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      {!b ? (
        <Spinner size={18} label="Loading credits" />
      ) : (
        <>
          <div className="ai-credits-card__num">
            <span className="mono">{b.balance.toLocaleString('en')}</span>
            <span className="z-muted">of {b.monthly.toLocaleString('en')} this month</span>
          </div>
          <div
            className="meter__bar meter__bar--good"
            role="progressbar"
            aria-label="Cloud credits left"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="z-hint">
            {plural(b.bgCreditsPerPhoto, 'credit')} = 1 background removal. New credits on{' '}
            {new Date(`${b.periodEnd}T00:00:00Z`).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
            })}
            ; {b.rollover ? 'unused credits carry over.' : 'unused credits don’t carry over.'}
          </span>
          {canBuy ? (
            <Link to="/settings/billing" className="z-btn z-btn--secondary z-btn--sm">
              <span>Buy more credits</span>
            </Link>
          ) : (
            <span className="z-hint">The library’s owner buys more credits.</span>
          )}
          {(b.topUps?.length ?? 0) > 0 && (
            <span className="z-hint">
              Plus {b.topUps.reduce((n, t) => n + t.credits, 0).toLocaleString('en')} top-up credits, used
              after the month’s.
            </span>
          )}
          <h3 className="ai-credits-card__h3">History</h3>
          {entries.length === 0 ? (
            <span className="z-muted">No credit changes yet.</span>
          ) : (
            <ul className="ai-ledger">
              {entries.map((e) => (
                <li key={e.id}>
                  <span className="ai-ledger__day">{day(e.at)}</span>
                  <span className="ai-ledger__what">
                    {REASON[e.reason]}
                    {e.label ? ` · ${e.label}` : ''}
                  </span>
                  <span className={`ai-ledger__n mono${e.delta > 0 ? ' is-plus' : ''}`}>
                    {e.delta > 0 ? '+' : '−'}
                    {Math.abs(e.delta).toLocaleString('en')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {page?.nextCursor && (
            <Button size="sm" kind="ghost" busy={more} onClick={loadMore}>
              Show more
            </Button>
          )}
        </>
      )}
    </aside>
  );
}

export function AiSettingsPage() {
  const status = useAiStatus();
  const toast = useToast();
  const [consent, setConsent] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const patch = async (key: string, body: Parameters<typeof patchAiSettings>[0], ok: string) => {
    setBusy(key);
    try {
      setAiStatus(await patchAiSettings(body));
      toast.show(ok, 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const deleteFaces = async () => {
    await turnOffFaceGrouping();
    toast.show('Face grouping is off and all face data was deleted.', 'good');
  };

  const f = status?.features;
  const faceOn = Boolean(status?.member.faceGrouping);
  // Phase 7: in a team library only its owner changes these (face data is the owner's to consent to).
  const owner = useCan('aiSettings');
  return (
    <Shell title="Settings">
      <div className="settings">
        <SettingsNav />
        <div className="settings__body">
          {!status ? (
            <Spinner size={20} label="Loading Zephyr AI settings" />
          ) : !status.enabled ? (
            <AiPausedNote />
          ) : (
            <>
              <CloudPausedBanner status={status} />
              <div className="ai-settings">
                <section className="ai-settings__main" aria-labelledby="ai-set-h">
                  <h2 id="ai-set-h" className="sh-h2">
                    Zephyr AI
                  </h2>
                  {!owner && (
                    <Note tone="neutral" icon="lock">
                      Only the library’s owner can change these settings.
                    </Note>
                  )}
                  {f?.face_grouping === 'off_plan' ? (
                    <UpgradeHint what="Face grouping" icon="people" />
                  ) : (
                    <>
                      <Row
                        title="Face grouping"
                        hint="Groups photos by face on your devices. Saves face codes (biometric data) in your account."
                      >
                        {faceOn && (
                          <Chip tone="good" dot size="sm">
                            On
                          </Chip>
                        )}
                        <Toggle
                          label="Face grouping"
                          checked={faceOn}
                          disabled={!owner || busy !== null || f?.face_grouping === 'off_admin'}
                          onChange={(v) => (v ? setConsent(true) : setConfirmOff(true))}
                        />
                      </Row>
                      {faceOn && owner && (
                        <Row
                          title="Delete face data"
                          hint="Turns face grouping off and deletes every face code and name now. Photos aren’t affected."
                        >
                          <Button size="sm" icon="trash" onClick={() => setConfirmOff(true)}>
                            Turn off and delete
                          </Button>
                        </Row>
                      )}
                    </>
                  )}
                  <Row
                    title="Scene tags"
                    hint="Sends a 512 px preview of new uploads to Cloudflare’s image recogniser, which doesn’t keep it."
                  >
                    <Toggle
                      label="Scene tags"
                      checked={status.member.sceneTags}
                      disabled={!owner || busy !== null || f?.scene_tags === 'off_admin'}
                      onChange={(v) =>
                        void patch(
                          'scene',
                          { sceneTags: v },
                          v ? 'Scene tags are on.' : 'Scene tags are off and existing tags were removed.',
                        )
                      }
                    />
                  </Row>
                  {f?.cleanup !== 'off_plan' && (
                    <Row
                      title="Find duplicates and blurry photos"
                      hint="Checks previews on your devices after each upload."
                    >
                      <Toggle
                        label="Find duplicates and blurry photos"
                        checked={status.member.cleanup}
                        disabled={!owner || busy !== null || f?.cleanup === 'off_admin'}
                        onChange={(v) =>
                          void patch('cleanup', { cleanup: v }, v ? 'Cleanup is on.' : 'Cleanup is off.')
                        }
                      />
                    </Row>
                  )}
                  <Row
                    title="Background removal service"
                    hint="A copy up to 2048 px is sent to our cutting service. It’s deleted when the job ends and never used for training."
                  >
                    <Chip size="sm">
                      {f?.bg_removal === 'on' || f?.bg_removal === 'paused' ? 'Available' : 'Off'}
                    </Chip>
                  </Row>
                </section>
                <Credits />
              </div>
            </>
          )}
        </div>
      </div>
      <ConsentDialog
        open={consent}
        onClose={() => setConsent(false)}
        onConfirm={async (faceConsent) => {
          setAiStatus(await patchAiSettings({ faceGrouping: true, faceConsent }));
          toast.show('Face grouping is on.', 'good');
        }}
      />
      <ConfirmDialog
        open={confirmOff}
        title="Turn off face grouping?"
        confirm="Turn off and delete"
        danger
        onClose={() => setConfirmOff(false)}
        onConfirm={deleteFaces}
      >
        <p>Every face code, person and name is deleted now. Your photos aren’t affected.</p>
        <p>You can turn it on again later; faces will be found again from scratch.</p>
      </ConfirmDialog>
    </Shell>
  );
}
