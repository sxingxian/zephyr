import { formatPrice, PRICING_ENDPOINT, parsePricing, smallestPack, yearlyLabel } from '../lib/pricing';

/**
 * Replaces the build-time prices with the live ones set in Admin › Plans & billing. The markup already
 * shows the fallback, so no JS, a slow network or an error simply leaves it as built.
 */
export async function initPricing(root: HTMLElement): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(PRICING_ENDPOINT, {
      headers: { accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return;
    const data = parsePricing(await res.json());
    if (!data) return;
    for (const p of data.prices) {
      for (const el of root.querySelectorAll<HTMLElement>(`[data-price="${p.plan}:${p.interval}"]`))
        el.textContent = formatPrice(p.amount);
    }
    const label = root.querySelector<HTMLElement>('[data-yearly-label]');
    if (label && data.prices.length) label.textContent = yearlyLabel(data.prices);
    const pack = smallestPack(data.packs);
    const packEl = root.querySelector<HTMLElement>('[data-pack]');
    if (packEl && pack)
      packEl.textContent = `${pack.credits.toLocaleString('en')} credits for ${formatPrice(pack.amount)}`;
  } catch {
    /* Keep the prices the page was built with. */
  } finally {
    clearTimeout(timer);
  }
}
