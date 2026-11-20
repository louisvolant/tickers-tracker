import { test, expect } from '@playwright/test';

/**
 * Regression coverage for the "price history is empty when the details view is
 * opened" bug.
 *
 * The details request is served cold (no KV entry) the first time a symbol is
 * opened, which is exactly when Yahoo Finance is most likely to answer with a
 * transient error. Previously a single failed response was rendered as
 * "No historical chart points available for this period." and the empty series
 * was then cached in KV, so only switching range (a different cache key) ever
 * recovered.
 */
test.describe('Ticker details chart resilience', () => {
  test('recovers silently when the details request fails once then succeeds', async ({ page }) => {
    let attempts = 0;

    await page.route('**/api/tickers/details**', async (route) => {
      attempts++;
      // First cold attempt fails, as it would on a transient upstream error.
      if (attempts === 1) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'upstream unavailable' }),
        });
      }
      return route.continue();
    });

    await page.goto('/');
    await expect(page.locator('[data-symbol]').first()).toBeVisible({ timeout: 20000 });

    await page.locator('[data-symbol]').first().click();

    // The chart must render without the user having to touch the range filter.
    await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 30000 });

    // The client is expected to have retried the failed call.
    expect(attempts).toBeGreaterThan(1);

    // And it must not be showing the misleading empty-state message.
    await expect(
      page.getByText('No historical chart points available for this period.')
    ).toHaveCount(0);
  });

  test('never shows the empty-state message while the chart is still loading', async ({ page }) => {
    // Delay the response so we can observe the loading state.
    await page.route('**/api/tickers/details**', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      return route.continue();
    });

    await page.goto('/');
    await expect(page.locator('[data-symbol]').first()).toBeVisible({ timeout: 20000 });
    await page.locator('[data-symbol]').first().click();

    // Immediately after opening, a loading indicator must be shown instead of
    // the "no data" placeholder.
    await expect(page.locator('.animate-spin').first()).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText('No historical chart points available for this period.')
    ).toHaveCount(0);

    await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 30000 });
  });

  test('renders the 1MO range with real points on first open', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-symbol]').first()).toBeVisible({ timeout: 20000 });
    await page.locator('[data-symbol]').first().click();

    // Default range is 1MO and must not be empty on the very first load.
    await expect(page.getByRole('button', { name: '1mo', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 30000 });

    const points = await page.evaluate(() => {
      const ticks = document.querySelectorAll('.recharts-surface .recharts-area-curve');
      return ticks.length;
    });
    expect(points).toBeGreaterThan(0);

    // Hover the chart surface to verify the Recharts Tooltip renders data cleanly.
    const chartSurface = page.locator('.recharts-surface').first();
    const box = await chartSurface.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.locator('.recharts-tooltip-wrapper')).toBeVisible({ timeout: 5000 });
  });

  test('does not leak the previously opened ticker chart into the next one', async ({ page }) => {
    await page.goto('/');
    const cards = page.locator('[data-symbol]');
    await expect(cards.first()).toBeVisible({ timeout: 20000 });
    if ((await cards.count()) < 2) test.skip(true, 'needs at least two tickers');

    const second = (await cards.nth(1).getAttribute('data-symbol'))!;

    await cards.nth(0).click();
    await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 30000 });
    await page.locator('button[aria-label="Back to Dashboard"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.recharts-surface')).toHaveCount(0);

    await page.locator(`[data-symbol="${second}"]`).first().click();
    // The heading must match the newly opened symbol, and the chart must be
    // loading rather than showing the previous symbol's series.
    await expect(page.getByRole('heading', { name: second })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 30000 });
  });
});