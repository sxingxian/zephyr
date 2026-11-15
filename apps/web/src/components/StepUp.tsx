import {
  MEMBER8_API,
  STEP_UP_CODE_LENGTH,
  STEP_UP_CODE_MINUTES,
  STEP_UP_HEADER,
  type StepUpOp,
  type StepUpResult,
} from '@zephyr/shared/client';
import { Button, Dialog, Field } from '@zephyr/ui';
import { type FormEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { NoAdsSurface } from './ads/NoAdsSurface';

/**
 * Phase 8 (review round 3): account-level changes (adding or removing a passkey, deleting the account) by a member
 * who may be shown AdSense need a one-time code emailed to their account, as well as a recent sign-in: Google's
 * script runs with the member's session, but can't read their email. The API answers `step_up_required`; this
 * asks for a code (POST /me/step-up), shows a dialog to enter it, and runs the change again with the code in
 * STEP_UP_HEADER. Members who don't need a code never see any of it.
 *
 * `run(op, fn)`: `fn` gets the extra headers to send (none at first). Resolves with `fn`'s result, or undefined
 * when the member cancels. Other failures are thrown as usual.
 */
const WHAT: Record<StepUpOp, string> = {
  passkey_add: 'add a passkey',
  passkey_remove: 'remove this passkey',
  account_delete: 'delete your account',
};
const CODE = new RegExp(`^\\d{${STEP_UP_CODE_LENGTH}}$`);

type Headers = Record<string, string>;
interface Pending {
  op: StepUpOp;
  submit: (code: string) => Promise<'done' | 'invalid'>;
  cancel: () => void;
}

export function useStepUp(): {
  run: <T>(op: StepUpOp, fn: (headers: Headers) => Promise<T>) => Promise<T | undefined>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const pendingRef = useRef<Pending | null>(null);

  const send = useCallback(async (op: StepUpOp): Promise<boolean> => {
    const r = await api<StepUpResult>(MEMBER8_API.stepUp, { method: 'POST', body: { op } });
    return r.needed;
  }, []);

  const run = useCallback(
    async <T,>(op: StepUpOp, fn: (headers: Headers) => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn({});
      } catch (e) {
        if (!(e instanceof ApiFailure && e.code === 'step_up_required')) throw e;
      }
      // A code is needed: email one, then wait for the member to enter it.
      if (!(await send(op))) return await fn({});
      return await new Promise<T | undefined>((resolve, reject) => {
        const p: Pending = {
          op,
          submit: async (entered) => {
            try {
              const out = await fn({ [STEP_UP_HEADER]: entered });
              pendingRef.current = null;
              setPending(null);
              resolve(out);
              return 'done';
            } catch (e) {
              if (e instanceof ApiFailure && (e.code === 'step_up_invalid' || e.code === 'step_up_required'))
                return 'invalid';
              pendingRef.current = null;
              setPending(null);
              reject(e);
              return 'done';
            }
          },
          cancel: () => {
            pendingRef.current = null;
            setPending(null);
            resolve(undefined);
          },
        };
        pendingRef.current = p;
        setCode('');
        setError(null);
        setResent(false);
        setPending(p);
      });
    },
    [send],
  );

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const p = pendingRef.current;
    const entered = code.trim();
    if (!p || busy) return;
    if (!CODE.test(entered)) {
      setError(`Enter the ${STEP_UP_CODE_LENGTH}-digit code from the email.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if ((await p.submit(entered)) === 'invalid') {
        setError('That code didn’t work. It may have expired or been used. Check it, or send a new one.');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    const p = pendingRef.current;
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    try {
      await send(p.op);
      setResent(true);
      setCode('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <NoAdsSurface>
      <Dialog
        open={Boolean(pending)}
        onClose={() => {
          if (!busy) pendingRef.current?.cancel();
        }}
        title="Confirm it’s you"
        footer={
          <>
            <Button kind="ghost" onClick={resend} disabled={busy}>
              Send a new code
            </Button>
            <Button kind="ghost" onClick={() => pendingRef.current?.cancel()} disabled={busy}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" form="step-up-form" busy={busy}>
              Confirm
            </Button>
          </>
        }
      >
        <form id="step-up-form" onSubmit={onSubmit} className="stack">
          <p>
            We emailed you a {STEP_UP_CODE_LENGTH}-digit code to {pending ? WHAT[pending.op] : 'continue'}. It
            works once, for {STEP_UP_CODE_MINUTES} minutes.
          </p>
          <Field
            label="Code"
            name="step-up-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={STEP_UP_CODE_LENGTH}
            mono
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            error={error}
            hint={resent ? 'A new code is on its way. Earlier codes no longer work.' : undefined}
          />
        </form>
      </Dialog>
    </NoAdsSurface>
  );
  return { run, dialog };
}
