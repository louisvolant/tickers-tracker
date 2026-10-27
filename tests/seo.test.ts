import { test, describe } from 'node:test';
import assert from 'node:assert';
import nextConfig from '../next.config.mjs';
import robots from '../src/app/robots';
import { getSiteUrl } from '../src/lib/site';
import { getCanonicalRedirectUrl } from '../src/lib/canonicalRequest';

describe('Canonical origin redirect', () => {
  test('upgrades an http request on the www host', () => {
    assert.equal(
      getCanonicalRedirectUrl('http://www.tickertracker.net/ticker/NVDA?range=1mo'),
      'https://www.tickertracker.net/ticker/NVDA?range=1mo'
    );
  });

  test('moves the apex host onto the www host', () => {
    assert.equal(
      getCanonicalRedirectUrl('https://tickertracker.net/privacy'),
      'https://www.tickertracker.net/privacy'
    );
  });

  test('leaves the canonical URL untouched', () => {
    assert.equal(getCanonicalRedirectUrl('https://www.tickertracker.net/'), null);
  });

  test('ignores local and preview hosts', () => {
    assert.equal(getCanonicalRedirectUrl('http://localhost:3000/ticker/NVDA'), null);
    assert.equal(
      getCanonicalRedirectUrl('https://tickers-tracker.example.workers.dev/'),
      null
    );
  });
});

describe('robots.txt', () => {
  test('allows the public pages and blocks the API', () => {
    const rules = robots().rules as {
      allow: string[];
      disallow: string[];
    };
    assert.deepEqual(rules.allow, ['/', '/ticker/', '/privacy', '/terms']);
    assert.deepEqual(rules.disallow, ['/api/']);
  });

  test('references the sitemap on the canonical origin', () => {
    assert.equal(robots().sitemap, `${getSiteUrl()}/sitemap.xml`);
  });
});

describe('Machine-only routes', () => {
  test('API responses carry an explicit noindex directive', async () => {
    const rules: any[] = await nextConfig.headers!();
    const api = rules.find((rule: any) => rule.source === '/api/:path*');
    assert.ok(api, 'next.config.mjs must declare headers for /api/:path*');

    const noindex = api.headers.find(
      (header: any) => header.key.toLowerCase() === 'x-robots-tag'
    );
    assert.ok(noindex, 'API routes must send X-Robots-Tag');
    assert.ok(noindex.value.includes('noindex'));
    assert.ok(noindex.value.includes('nofollow'));
  });
});
