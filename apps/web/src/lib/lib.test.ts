import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, api, errorMessage, setUnauthenticatedHandler, toFailure } from './api';
import { safeReturnPath } from './returnPath';

describe('safeReturnPath', () => {
  it.each([
    ['/settings/security', '/settings/security'],
    ['/settings?tab=1#x', '/settings?tab=1#x'],
    [null, '/'],
    ['', '/'],
    ['https://evil.example/x', '/'],
    ['//evil.example/x', '/'],
    ['/\\evil.example', '/'],
    ['\\\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/%0d%0aSet-Cookie', '/%0d%0aSet-Cookie'],
    ['/a\u0000b', '/'],
    ['/sign-in', '/'],
    ['/sign-in/code', '/'],
    ['/join', '/'],
    ['/api/v1/auth/session', '/'],
    [`/${'a'.repeat(600)}`, '/'],
  ])('%s → %s', (input, out) => {
    expect(safeReturnPath(input as string | null)).toBe(out);
  });
});

describe('toFailure', () => {
  it('uses the contract code when present', () => {
    expect(toFailure(400, { ok: false, error: 'invalid_code' }, null).code).toBe('invalid_code');
  });
  it('falls back on the status for unknown bodies', () => {
    expect(toFailure(401, '<html>', null).code).toBe('unauthenticated');
    expect(toFailure(404, null, null).code).toBe('not_found');
    expect(toFailure(503, null, null).code).toBe('server');
    expect(toFailure(400, { error: 'weird' }, null).code).toBe('invalid');
  });
  it('reads Retry-After for rate limits, header first', () => {
    expect(toFailure(429, { ok: false, error: 'rate_limited', retryAfter: 30 }, '900').retryAfter).toBe(900);
    expect(toFailure(429, { ok: false, error: 'rate_limited', retryAfter: 30 }, null).retryAfter).toBe(30);
    expect(toFailure(429, null, null).retryAfter).toBe(60);
  });
  it('words a rate limit in minutes', () => {
    expect(errorMessage(new ApiFailure('rate_limited', 429, 900))).toContain('15 minutes');
    expect(errorMessage(new ApiFailure('rate_limited', 429, 30))).toContain('1 minute');
  });
});

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthenticatedHandler(null);
  });
  it('sends JSON with same-origin credentials', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    await api('/api/v1/x', { method: 'POST', body: { a: 1 } });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });
  it('calls the sign-in handler on 401 unless quiet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), { status: 401 }),
      ),
    );
    const h = vi.fn();
    setUnauthenticatedHandler(h);
    await expect(api('/api/v1/me/passkeys')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(h).toHaveBeenCalledTimes(1);
    await expect(api('/api/v1/auth/session', { quiet401: true })).rejects.toBeInstanceOf(ApiFailure);
    expect(h).toHaveBeenCalledTimes(1);
  });
  it('maps network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    await expect(api('/api/v1/x')).rejects.toMatchObject({ code: 'network' });
  });
});
