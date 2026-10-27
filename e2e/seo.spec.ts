import { test, expect } from '@playwright/test';

test.describe('Search engine signals', () => {
  test('robots.txt allows public pages, blocks the API and points at the sitemap', async ({
    request,
  }) => {
    const res = await request.get('/robots.txt');
    expect(res.ok()).toBeTruthy();

    const body = await res.text();
    const origin = new URL(res.url()).origin;
    expect(body).toContain('Allow: /ticker/');
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain(`Sitemap: ${origin}/sitemap.xml`);
  });

  test('homepage declares the canonical URL', async ({ page }) => {
    await page.goto('/');
    const origin = new URL(page.url()).origin;

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      origin
    );
  });

  test('ticker page declares its own canonical URL', async ({ page }) => {
    await page.goto('/ticker/NVDA');
    const origin = new URL(page.url()).origin;

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `${origin}/ticker/NVDA`
    );
  });

  test('API responses are marked noindex for crawlers that ignore robots.txt', async ({
    request,
  }) => {
    const res = await request.get('/api/rates');
    expect(res.ok()).toBeTruthy();
    expect(res.headers()['x-robots-tag']).toContain('noindex');
  });
});
