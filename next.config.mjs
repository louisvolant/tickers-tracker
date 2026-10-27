/** @type {import('next').NextConfig} */
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

// Makes the Cloudflare bindings (KV, D1) available to `next dev`.
// It is a no-op outside the local dev server.
initOpenNextCloudflareForDev();

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['yahoo-finance2'],
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      // The ticker page renders per-user data (reference target, notes). Pin an
      // explicit private/no-store policy so no intermediary - CDN, browser
      // back/forward cache or shared proxy - may ever retain it, whatever the
      // framework defaults happen to be. `private` also forbids shared caches
      // outright. A `Vary: Cookie` header is intentionally not set here: Next
      // manages `Vary` itself and overwrites it, so it would be misleading.
      {
        source: '/ticker/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
        ],
      },
      {
        source: '/manifest.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },
      {
        // robots.txt already disallows /api/, but crawlers that ignore it (or
        // reach an endpoint directly) must not index OAuth redirects or
        // per-user JSON either.
        source: '/api/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
