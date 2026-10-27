import type { Metadata } from 'next';
import { TickerDetailsPage } from '@/app/components/TickerDetailsPage';
import { AuthProvider } from '@/context/AuthContext';
import { CurrencyProvider } from '@/context/CurrencyContext';
import { getSiteUrl } from '@/lib/site';

interface PageProps {
  params: Promise<{ symbol: string }>;
}

/**
 * Per-symbol metadata for the full-page ticker view (deep-linkable, so search
 * engines and link previews get a meaningful title).
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { symbol } = await params;
  const clean = decodeURIComponent(symbol).toUpperCase();
  return {
    title: `${clean} — Price History, P/E & Analyst Forecasts`,
    description: `Detailed view for ${clean}: live price, trailing and forward P/E multiples, 52-week range, price history chart and sell-side earnings consensus.`,
    alternates: {
      canonical: `${getSiteUrl()}/ticker/${encodeURIComponent(clean)}`,
    },
  };
}

/**
 * The page renders per-user data (reference target, personal notes, and a
 * watchlist-derived quote), so it must be produced fresh on every request.
 * `force-dynamic` + `revalidate = 0` pin this down explicitly: without them a
 * future `generateStaticParams`, ISR revalidate window or `fetchCache`
 * override could silently start serving one user's shell to another.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Full-page replacement for the old centred details modal. Rendering it as a
 * real route fixes the two-pass mobile layout (the modal painted before its
 * content arrived) and gives the browser back button, deep links and PWA
 * shortcuts for free.
 *
 * Personalization is intentionally resolved client-side (see TickerDetailsPage)
 * so the cached server shell stays user-agnostic.
 */
export default async function TickerDetailsRoute({ params }: PageProps) {
  const { symbol } = await params;
  // AuthProvider is declared per-page in this app, so the route has to supply
  // its own instance to resolve whether the symbol belongs to a signed-in
  // user's watchlist or to a guest's local store.
  return (
    <AuthProvider>
      <CurrencyProvider>
        <TickerDetailsPage symbol={decodeURIComponent(symbol).toUpperCase()} />
      </CurrencyProvider>
    </AuthProvider>
  );
}