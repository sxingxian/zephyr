import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminBillingResult, AdminPricePreviewBody } from '@zephyr/shared/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { centsToInput, dollarsToCents, formatCents, priceError } from './lib/billing';

vi.mock('./lib/passkey', async (orig) => ({
  ...(await orig<typeof import('./lib/passkey')>()),
  getPasskeyAssertion: vi.fn(async () => ({ id: 'cred', type: 'public-key' })),
}));

const now = Date.now();
const DATA: AdminBillingResult = {
  ok: true,
  configured: true,
  kpis: { mrr: 2_784_000, paying: 1769, pastDue: 23, cancelling: 41, topUpCreditsSold30d: 182_500 },
  prices: [
    {
      lookupKey: 'zephyr_pro_monthly',
      plan: 'pro',
      interval: 'month',
      credits: null,
      amount: 999,
      active: true,
      subscribers: 1204,
      updatedAt: '2026-11-01T00:00:00Z',
    },
    {
      lookupKey: 'zephyr_pro_yearly',
      plan: 'pro',
      interval: 'year',
      credits: null,
      amount: 9900,
      active: true,
      subscribers: 386,
      updatedAt: '2026-11-01T00:00:00Z',
    },
    {
      lookupKey: 'zephyr_topup_2500',
      plan: null,
      interval: null,
      credits: 2500,
      amount: 2500,
      active: false,
      subscribers: 0,
      updatedAt: '2026-11-01T00:00:00Z',
    },
  ],
  changes: [
    {
      id: 'chg1',
      lookupKey: 'zephyr_pro_yearly',
      from: 9900,
      to: 10900,
      status: 'notifying',
      createdAt: '2026-11-10T00:00:00Z',
      createdBy: 'Farah K.',
      reason: 'Costs',
      counts: { pending: 10, notified: 300, moved: 12, skipped: 0 },
      lastMoveAt: '2027-11-10T00:00:00Z',
    },
  ],
  paymentDue: [
    {
      ownerId: 'o1',
      email: 'mei@example.com',
      plan: 'pro',
      amount: 999,
      since: '2026-11-12T00:00:00Z',
      attempts: 2,
    },
  ],
  events: [
    {
      id: 'evt_1',
      type: 'invoice.paid',
      at: new Date(now - 12 * 60_000).toISOString(),
      status: 'processed',
      error: null,
    },
    {
      id: 'evt_2',
      type: 'customer.subscription.updated',
      at: new Date(now - 30 * 60_000).toISOString(),
      status: 'failed',
      error: 'owner_mismatch',
    },
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
function mock(role: string, extra?: (c: Call) => Response | undefined, data: AdminBillingResult = DATA) {
  calls = [];
  const staff = { id: 's1', email: 'farah@midnightpoetry.studio', role, displayName: 'Farah K.' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const c = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(c);
      const r = extra?.(c);
      if (r) return r;
      if (url.endsWith('/auth/session')) return json(200, { ok: true, staff, enrolOnly: false });
      if (url.endsWith('/admin/api/v1/billing') && c.method === 'GET') return json(200, data);
      if (url.endsWith('/billing/prices/preview')) {
        const b = c.body as AdminPricePreviewBody;
        return json(200, {
          ok: true,
          from: 999,
          to: b.amount,
          subscribers: 1204,
          firstMoveAt: '2026-12-14T00:00:00Z',
          lastMoveAt: '2027-01-12T00:00:00Z',
          raise: b.amount > 999,
        });
      }
      if (url.endsWith('/billing/prices') && c.method === 'POST') return json(200, data);
      if (url.includes('/billing/packs/') || url.includes('/billing/price-changes/')) return json(200, data);
      if (url.endsWith('/auth/passkey/options'))
        return json(200, { ok: true, challengeId: 'ch1', options: { challenge: 'x', allowCredentials: [] } });
      if (url.endsWith('/auth/passkey/verify')) return json(200, { ok: true, staff, enrolOnly: false });
      return json(404, { ok: false, error: 'not_found' });
    }),
  );
}
const renderAt = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
};
const writes = (part: string) => calls.filter((c) => c.method !== 'GET' && c.url.includes(part));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('money helpers', () => {
  it('parses dollars into integer cents without float errors', () => {
    expect(dollarsToCents('10.99')).toBe(1099);
    expect(dollarsToCents('0.29')).toBe(29);
    expect(dollarsToCents('1.15')).toBe(115);
    expect(dollarsToCents('19.9')).toBe(1990);
    expect(dollarsToCents(' US$1,000 ')).toBe(100000);
    expect(dollarsToCents('$24.99')).toBe(2499);
    for (const bad of ['10.999', 'abc', '-1', '1e3', '', '10.', '.5'])
      expect(dollarsToCents(bad), bad).toBeNull();
  });
  it('formats and bounds cents', () => {
    expect(formatCents(1099)).toBe('US$10.99');
    expect(formatCents(100000)).toBe('US$1,000.00');
    expect(centsToInput(9900)).toBe('99.00');
    expect(priceError(99)).toMatch(/Between/);
    expect(priceError(1099)).toBeNull();
  });
});

describe('Plans & billing', () => {
  it('shows KPIs, prices, the open change, payment due and events', async () => {
    mock('owner');
    renderAt('/billing');
    expect(await screen.findByText('US$27,840.00', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('zephyr_pro_monthly')).toBeTruthy();
    expect(screen.getByText('Changing')).toBeTruthy();
    expect(screen.getByText(/Pro yearly: US\$99.00 → US\$109.00/)).toBeTruthy();
    expect(screen.getByText('mei@example.com')).toBeTruthy();
    expect(screen.getByText(/Failed · owner_mismatch/)).toBeTruthy();
    expect(screen.getByText('12 min ago')).toBeTruthy();
  });

  it('raises a price: previews in cents, then confirms with the passkey on reauth_required and retries once', async () => {
    let first = true;
    mock('owner', (c) => {
      if (c.url.endsWith('/billing/prices') && c.method === 'POST' && first) {
        first = false;
        return json(403, { ok: false, error: 'reauth_required' });
      }
      return undefined;
    });
    renderAt('/billing');
    const open = await screen.findByRole('button', { name: 'Change price: Pro monthly' }, { timeout: 4000 });
    await act(async () => open.click());
    fireEvent.change(screen.getByLabelText('New price (USD)'), { target: { value: '10.99' } });
    await waitFor(
      () =>
        expect(writes('/prices/preview').at(-1)?.body).toEqual({
          lookupKey: 'zephyr_pro_monthly',
          amount: 1099,
        }),
      {
        timeout: 4000,
      },
    );
    expect(await screen.findByText('1,204 existing subscribers', {}, { timeout: 4000 })).toBeTruthy();
    const confirm = screen.getByRole('button', {
      name: /Confirm with passkey/,
      hidden: true,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // no reason yet
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Storage costs went up' } });
    await act(async () => confirm.click());
    await waitFor(
      () => expect(writes('/billing/prices').filter((c) => !c.url.endsWith('preview'))).toHaveLength(2),
      {
        timeout: 4000,
      },
    );
    const posts = writes('/billing/prices').filter((c) => !c.url.endsWith('preview'));
    expect(posts[1]?.body).toEqual({
      lookupKey: 'zephyr_pro_monthly',
      amount: 1099,
      reason: 'Storage costs went up',
    });
    expect(calls.some((c) => c.url.endsWith('/auth/passkey/verify'))).toBe(true);
  });

  it('rejects amounts out of bounds or unchanged, without a preview', async () => {
    mock('finance');
    renderAt('/billing');
    const open = await screen.findByRole('button', { name: 'Change price: Pro monthly' }, { timeout: 4000 });
    await act(async () => open.click());
    const input = screen.getByLabelText('New price (USD)');
    fireEvent.change(input, { target: { value: '0.50' } });
    expect(screen.getByText(/Between US\$1.00/)).toBeTruthy();
    fireEvent.change(input, { target: { value: '9.99' } });
    expect(screen.getByText('That’s the current price.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 450));
    expect(writes('/prices/preview')).toHaveLength(0);
  });

  it('turns a top-up pack on', async () => {
    mock('owner');
    renderAt('/billing');
    const btn = await screen.findByRole(
      'button',
      { name: 'Put on sale: 2,500 top-up credits' },
      { timeout: 4000 },
    );
    await act(async () => btn.click());
    await waitFor(() => expect(writes('/billing/packs/')[0]?.body).toEqual({ active: true }), {
      timeout: 4000,
    });
    expect(writes('/billing/packs/')[0]?.url).toMatch(/\/billing\/packs\/zephyr_topup_2500$/);
  });

  it('stops a price change after confirming', async () => {
    mock('finance');
    renderAt('/billing');
    const stop = await screen.findByRole(
      'button',
      { name: 'Stop the change: Pro yearly' },
      { timeout: 4000 },
    );
    await act(async () => stop.click());
    expect(writes('/price-changes/')).toHaveLength(0);
    await act(async () => screen.getByRole('button', { name: 'Stop the change', hidden: true }).click());
    await waitFor(() => expect(writes('/price-changes/chg1')[0]?.method).toBe('DELETE'), { timeout: 4000 });
  });

  it('is read-only for Admins', async () => {
    mock('admin');
    renderAt('/billing');
    expect(await screen.findByText('Read-only for your role', {}, { timeout: 4000 })).toBeTruthy();
    await screen.findByText('zephyr_pro_monthly');
    expect(screen.queryByRole('button', { name: /Change price/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop the change/ })).toBeNull();
  });

  it('is hidden from Support and Safety', async () => {
    mock('support');
    renderAt('/billing');
    expect(await screen.findByText(/for Owners, Admins and Finance/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText('Plans & billing', { selector: '.anav__item span' })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/admin/api/v1/billing'))).toBe(false);
  });

  it('shows setup steps and no buttons until Stripe is configured', async () => {
    mock('owner', undefined, { ...DATA, configured: false });
    renderAt('/billing');
    expect(await screen.findByText(/Stripe isn’t connected yet/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Change price/ })).toBeNull();
  });
});
