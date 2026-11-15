import type { GallerySummary } from '@zephyr/shared/client';
import { Button, Chip, type ChipTone, Icon, type IconName, useToast } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { expiryLabel } from '../../lib/share';
import { useSecretsAllowed } from '../ads/NoAdsSurface';

/** Copies text to the clipboard; falls back to a hidden textarea where the async API isn't allowed. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what: string }) {
  const toast = useToast();
  // Phase 8: what's copied is a secret (a link, a passcode): never in a document holding Google's AdSense script.
  if (!useSecretsAllowed()) return null;
  return (
    <Button
      size="sm"
      icon="copy"
      onClick={async () => {
        const ok = await copyText(text);
        toast.show(
          ok ? `${what} copied` : `Couldn’t copy. Select the ${what.toLowerCase()} and copy it.`,
          ok ? 'good' : 'bad',
        );
      }}
    >
      {label}
    </Button>
  );
}

/** The 6 digits, large and readable, announced as separate digits. */
export function PasscodeDigits({ code }: { code: string }) {
  return (
    <div className="sh-digits" role="img" aria-label={`Passcode ${code.split('').join(' ')}`}>
      {code.split('').map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed six positions
        <span key={i} className="sh-digits__d" aria-hidden="true">
          {d}
        </span>
      ))}
    </div>
  );
}

/** Passcode shown once, with copy and the advice to send it separately. */
export function PasscodeReveal({ code }: { code: string }) {
  // Phase 8: never in a document holding Google's AdSense script.
  if (!useSecretsAllowed()) return null;
  return (
    <div className="sh-field">
      <span className="sh-label">Passcode</span>
      <div className="sh-digits-row">
        <PasscodeDigits code={code} />
        <span className="sh-grow" />
        <CopyButton text={code} what="Passcode" />
      </div>
      <span className="sh-hint">
        <Icon name="info" size={14} />
        Shown only now. Zephyr keeps a scrambled copy it can check against, never the code itself. Send it
        separately from the link, for example by text.
      </span>
    </div>
  );
}

export function statusChip(g: Pick<GallerySummary, 'status' | 'passcode' | 'expiresAt' | 'pausedUntil'>): {
  tone: ChipTone;
  label: string;
  /** Compact label for narrow rows (phone list). */
  short: string;
  icon?: IconName;
  dot?: boolean;
} {
  switch (g.status) {
    case 'live':
      return g.passcode
        ? { tone: 'good', label: `Live · ${expiryLabel(g.expiresAt)}`, short: 'Live', dot: true }
        : { tone: 'acc', label: 'Live · link only', short: 'Live', icon: 'link' };
    case 'paused':
      return { tone: 'warn', label: 'Paused · too many wrong passcodes', short: 'Paused', icon: 'alert' };
    case 'expired':
      return { tone: 'neutral', label: expiryLabel(g.expiresAt) || 'Expired', short: 'Ended' };
    default:
      return { tone: 'bad', label: 'Revoked', short: 'Revoked' };
  }
}
export function StatusChip({
  g,
  compact = false,
}: {
  g: Parameters<typeof statusChip>[0];
  compact?: boolean;
}) {
  const s = statusChip(g);
  return (
    <Chip tone={s.tone} icon={s.icon} dot={s.dot}>
      {compact ? (
        <>
          <span className="sh-chip-long">{s.label}</span>
          <span className="sh-chip-short" aria-hidden="true">
            {s.short}
          </span>
        </>
      ) : (
        s.label
      )}
    </Chip>
  );
}

/** "Studio" / "Pro" badge on a locked option. */
export function PlanBadge({ plan }: { plan: 'Pro' | 'Studio' }) {
  return (
    <Chip tone={plan === 'Pro' ? 'ink' : 'outline'} size="sm">
      {plan}
    </Chip>
  );
}

export function ShNote({
  icon = 'info',
  tone = 'muted',
  children,
}: {
  icon?: IconName;
  tone?: 'muted' | 'warn' | 'good';
  children: ReactNode;
}) {
  return (
    <p className={`sh-note sh-note--${tone}`} role={tone === 'warn' ? 'status' : undefined}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </p>
  );
}

/** "48 photos" */
export const photosLabel = (n: number) => `${n.toLocaleString('en')} photo${n === 1 ? '' : 's'}`;
