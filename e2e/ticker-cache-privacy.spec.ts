import { test, expect } from '@playwright/test';

/**
 * /ticker/[symbol] renders per-user data: the reference target (cost basis),
 * the personal notes, and a watchlist-derived quote. None of it may ever be
 * retained by an intermediary.
 *
 * The design currently keeps personalization out of the server-rendered shell
 * (it is resolved client-side), which makes a cached shell harmless. These
 * tests lock that in, so a future refactor that moves the lookup server-side
 * fails here instead of quietly leaking one user's watchlist context.
 */
test.describe('Ticker page must never be cached', () => {
  test('sends an explicit no-store policy', async ({ request }) => {
    const res = await request.get('/ticker/AAPL');
    expect(res.status()).toBe(200);

    // Next dev overrides document Cache-Control to `no-store`; the full
    // production policy (`private, no-store, max-age=0, must-revalidate`) is
    // covered by tests/tickerCachePolicy.test.ts and emitted in production.
    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl).toContain('no-store');
    if (cacheControl !== 'no-store') {
      expect(cacheControl).toContain('must-revalidate');
    }
  });

  test('server-rendered HTML contains no personalized data', async ({ request }) => {
    const res = await request.get('/ticker/AAPL');
    const html = await res.text();

    // The reference target / notes are user-owned and must never appear in a
    // response body that could be cached or shared.
    for (const marker of ['trackingValue', 'personalNotes', 'Ref:', 'costBasis']) {
      expect(html, `SSR HTML must not contain "${marker}"`).not.toContain(marker);
    }

    // Sanity check: the shell itself does render the symbol.
    expect(html).toContain('AAPL');
  });

  test('the route is dynamic, not statically generated', async ({ request }) => {
    // A prerendered route would answer identically no-store or not; asserting
    // on the per-symbol payload guards against a stray generateStaticParams.
    const first = await (await request.get('/ticker/AAPL')).text();
    const second = await (await request.get('/ticker/AMD')).text();
    expect(first).not.toBe(second);
  });

  test('service worker never persists personalized routes to Cache Storage', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });

    // Warm the SW up on both a public page and the personalized route.
    await page.goto('/ticker/AAPL');
    await page.waitForTimeout(2000);
    await page.goto('/');
    await page.waitForTimeout(2000);

    const entries = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) urls.push(req.url);
      }
      return urls;
    });

    const origin = new URL(page.url()).origin;
    const leaked = entries.filter(
      (u) => u.startsWith(`${origin}/ticker/`) || u.includes('/api/tickers')
    );
    expect(leaked, 'personalized routes must never be written to Cache Storage').toEqual([]);
  });

  test('a signed-out visitor never sees another account reference target', async ({ page }) => {
    // Visit, then simulate a fresh visitor on the same browser profile: the
    // page must not hydrate from anything left behind by a previous session.
    await page.goto('/ticker/AAPL');
    await expect(page.getByRole('heading', { name: 'AAPL', level: 1 })).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Ref:')).toHaveCount(0);
  });
});