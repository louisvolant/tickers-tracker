import { SITE_DOMAIN } from '@/lib/site';

// The deployed site answers on these hosts. Anything else (localhost, a
// workers.dev preview, a custom staging domain) is left untouched so local and
// preview environments keep their own origin.
const PRODUCTION_HOSTS = new Set([SITE_DOMAIN, 'tickertracker.net']);

/**
 * Absolute URL a production request must be redirected to so that crawlers only
 * ever discover one origin: https on the www host.
 *
 * Returns null when the request is already canonical or is not served on a
 * production host.
 */
export function getCanonicalRedirectUrl(requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (!PRODUCTION_HOSTS.has(url.hostname)) return null;
  if (url.protocol === 'https:' && url.hostname === SITE_DOMAIN) return null;

  const canonical = new URL(`${url.pathname}${url.search}`, `https://${SITE_DOMAIN}`);
  return canonical.toString();
}
