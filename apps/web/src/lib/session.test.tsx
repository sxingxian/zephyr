import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { createUploads, EXPECTED_USER_HEADER, putBytes } from './library';
import { SessionProvider, useSession } from './session';
import { browser, endSession, onSessionEnd, sessionUserId } from './sessionGuard';
import { uploads } from './uploads';

const A = {
  id: 'u1',
  email: 'a@example.com',
  displayName: 'A',
  plan: 'free',
  passkeyCount: 1,
  createdAt: 'x',
};
const B = { ...A, id: 'u2', email: 'b@example.com' };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let log: string[] = [];
let session: ReturnType<typeof useSession> | null = null;
function Probe() {
  session = useSession();
  return null;
}
function mount(user: unknown, onUnauthenticated = () => {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      log.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/auth/session')) return json(200, { ok: true, user });
      if (url.endsWith('/auth/sign-out')) return json(200, { ok: true });
      if (url.endsWith('/needs-auth')) return json(401, { ok: false, error: 'unauthenticated' });
      if (url.includes('/uploads')) {
        const h = new Headers(init?.headers);
        log.push(`expected ${h.get(EXPECTED_USER_HEADER)}`);
        return json(409, { ok: false, error: 'session_changed' });
      }
      return json(200, { ok: true });
    }),
  );
  render(
    <SessionProvider onUnauthenticated={onUnauthenticated}>
      <Probe />
    </SessionProvider>,
  );
}

let off: (() => void) | null = null;
beforeEach(() => {
  log = [];
  session = null;
  vi.spyOn(browser, 'assign').mockImplementation((p) => {
    log.push(`assign ${p}`);
  });
  off = onSessionEnd(({ reason, server }) => {
    log.push(`end ${reason} server=${server}`);
  });
});
afterEach(() => {
  off?.();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('session end clean-up', () => {
  it('sign-out stops uploads (dropping them server-side) before the sign-out request, then reloads at sign-in', async () => {
    const reset = vi.spyOn(uploads, 'reset');
    mount(A);
    await waitFor(() => expect(session?.user?.id).toBe('u1'));
    expect(sessionUserId()).toBe('u1');
    await act(async () => {
      await session?.signOut();
    });
    expect(reset).toHaveBeenCalledWith({ server: true });
    const end = log.indexOf('end sign-out server=true');
    const post = log.findIndex((l) => l.startsWith('POST') && l.endsWith('/auth/sign-out'));
    expect(end).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThan(end);
    expect(log.at(-1)).toBe('assign /sign-in');
    expect(sessionUserId()).toBeNull();
  });

  it('a different member, or none, resets the queue without contacting the server', async () => {
    const reset = vi.spyOn(uploads, 'reset');
    mount(A);
    await waitFor(() => expect(session?.user?.id).toBe('u1'));
    log = [];
    act(() => session?.setUser(B as never));
    expect(log).toContain('end switched server=false');
    expect(reset).toHaveBeenLastCalledWith({ server: false });
    expect(sessionUserId()).toBe('u2');
    log = [];
    act(() => session?.setUser(B as never));
    expect(log).toEqual([]); // same member: nothing to stop
  });

  it('a 401 from any call resets the queue', async () => {
    const onUnauthenticated = vi.fn();
    mount(A, onUnauthenticated);
    await waitFor(() => expect(session?.user?.id).toBe('u1'));
    log = [];
    await act(async () => {
      await api('/api/v1/needs-auth').catch(() => {});
    });
    expect(log).toContain('end unauthenticated server=false');
    expect(onUnauthenticated).toHaveBeenCalled();
    expect(sessionUserId()).toBeNull();
  });

  it('a session found ended by a later check leaves like a 401; the first check doesn’t', async () => {
    const onUnauthenticated = vi.fn();
    let user: unknown = A;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/session') && user
          ? json(200, { ok: true, user })
          : json(401, { ok: false, error: 'unauthenticated' }),
      ),
    );
    render(
      <SessionProvider onUnauthenticated={onUnauthenticated}>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(session?.user?.id).toBe('u1'));
    user = null;
    await act(async () => {
      await session?.refresh();
    });
    expect(session?.user).toBeNull();
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    cleanup();
    const first = vi.fn();
    render(
      <SessionProvider onUnauthenticated={first}>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(session?.user).toBeNull());
    expect(first).not.toHaveBeenCalled();
  });

  it('another tab signing in as someone else stops this tab and reloads it', async () => {
    mount(A);
    await waitFor(() => expect(session?.user?.id).toBe('u1'));
    log = [];
    const other = new BroadcastChannel('zephyr-session');
    other.postMessage({ type: 'session-user', id: 'u2' });
    await waitFor(() => expect(log).toContain('assign /'));
    expect(log).toContain('end switched server=false');
    // The same member in another tab is not a change.
    log = [];
    other.postMessage({ type: 'session-user', id: 'u1' });
    other.postMessage({ type: 'nonsense', id: 'u3' });
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual([]);
    other.close();
  });

  it('never waits on server clean-up for longer than the limit', async () => {
    const slow = onSessionEnd(() => new Promise<void>(() => {}));
    const t = Date.now();
    await endSession('sign-out', true, 50);
    expect(Date.now() - t).toBeLessThan(1000);
    slow();
  });

  it('upload calls name the expected member, and session_changed stops everything and reloads', async () => {
    mount(A);
    await waitFor(() => expect(session?.user?.id).toBe('u1'));
    await expect(createUploads({ files: [] } as never)).rejects.toMatchObject({ code: 'session_changed' });
    expect(log).toContain('expected u1');
    await waitFor(() => expect(log).toContain('end switched server=false'));
    expect(log.at(-1)).toBe('assign /');
  });

  it('byte uploads carry the expected member header too', async () => {
    const sent: Record<string, string> = {};
    class FakeXHR {
      status = 409;
      responseText = JSON.stringify({ ok: false, error: 'session_changed' });
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      open() {}
      setRequestHeader(k: string, v: string) {
        sent[k] = v;
      }
      getResponseHeader() {
        return null;
      }
      send() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    mount(A);
    await waitFor(() => expect(session?.user?.id).toBe('u1'));
    await expect(
      putBytes('/api/v1/uploads/x/parts/1', new Blob(['a']), { contentType: 'application/octet-stream' }),
    ).rejects.toMatchObject({
      code: 'session_changed',
    });
    expect(sent[EXPECTED_USER_HEADER]).toBe('u1');
  });
});
