import { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getSiteUrl();
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/ticker/', '/privacy', '/terms'],
      // API routes are machine-only. Blocking them keeps OAuth redirects and
      // personalized JSON out of the crawl: "Blocked by robots.txt" entries in
      // Search Console are the expected outcome for these URLs.
      disallow: ['/api/'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
