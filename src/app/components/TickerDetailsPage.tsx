'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Loader2,
  Activity,
  Edit2,
  Trash2,
  ChevronUp,
  ChevronDown,
  Info,
  TrendingUp,
  Calculator,
  AlertTriangle,
  Users,
  Layers,
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { UserTicker, TickerDetails } from '@/lib/types';
import {
  formatCurrency,
  formatPercent,
  formatMultiple,
  formatCompactNumber,
  getForwardPeBadgeClass,
  getForwardPeCardClass,
  getCurrentPeCardClass,
  fetchJsonWithRetry,
  MOVED_TICKER_STORAGE_KEY,
} from '@/lib/utils';
import { getLocalTickers, saveLocalTickers, reorderLocalTickers } from '@/lib/indexedDb';
import { resolveTracking } from '@/lib/tracking';
import { useI18n } from '@/context/I18nContext';
import { useAuth } from '@/context/AuthContext';
import { useCurrencyRates } from '@/context/CurrencyContext';
import { EditTrackingModal } from './EditTrackingModal';
import { MarketStatusBadge } from './MarketStatusBadge';
import { ExtendedSessionBadge } from './ExtendedSessionBadge';
import { PriceAlertsSection } from './PriceAlertsSection';

type TimeRange = '1d' | '5d' | '1mo' | '6mo' | '1y' | '5y';

/**
 * Resolve the watchlist entry backing a symbol.
 *
 * The page is reachable by URL (deep link, refresh, PWA shortcut), so it cannot
 * rely on the dashboard passing state down: the tracking value and notes have
 * to be re-read from the server for authenticated users, or from IndexedDB for
 * guests. Returns null when the symbol is not part of the watchlist at all, in
 * which case the page still renders live market data.
 */
async function resolveWatchlistEntry(symbol: string, isAuthenticated: boolean): Promise<UserTicker | null> {
  const target = symbol.trim().toUpperCase();

  if (isAuthenticated) {
    try {
      const res = await fetch('/api/tickers', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const tickers: UserTicker[] = Array.isArray(data.tickers) ? data.tickers : [];
        const found = tickers.find((t) => t.symbol.toUpperCase() === target);
        if (found) return found;
      }
    } catch {
      // Fall through to the local store, then to a bare symbol-only entry.
    }
  }

  try {
    const locals = await getLocalTickers();
    const found = (locals || []).find((t) => t.symbol.toUpperCase() === target);
    if (found) return found;
  } catch {
    // Ignore: the page can still render without a watchlist entry.
  }

  return null;
}

export function TickerDetailsPage({ symbol }: { symbol: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const { rates } = useCurrencyRates();
  const router = useRouter();

  const [range, setRange] = useState<TimeRange>('1mo');
  const [details, setDetails] = useState<TickerDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<UserTicker | null>(null);
  const [editing, setEditing] = useState(false);

  // Resolve the watchlist entry (tracking value / notes) for this symbol.
  useEffect(() => {
    let isMounted = true;
    resolveWatchlistEntry(symbol, !!user).then((found) => {
      if (isMounted) setEntry(found);
    });
    return () => {
      isMounted = false;
    };
  }, [symbol, user]);

  // Fetch market data + price history. Retried transparently upstream because
  // a cold (uncached) request is the one most likely to fail transiently.
  useEffect(() => {
    let isMounted = true;
    setLoading(true);

    fetchJsonWithRetry(
      `/api/tickers/details?symbol=${encodeURIComponent(symbol)}&range=${range}`
    )
      .then((data) => {
        if (isMounted) setDetails(data);
      })
      .catch((err) => {
        console.error('Failed to load ticker details:', err);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [symbol, range]);

  /**
   * Explicit navigation to the dashboard rather than history.back(): the page
   * can be entered directly from a shared link or a PWA launch, in which case
   * going back would leave the site entirely.
   */
  const goHome = useCallback(() => router.push('/'), [router]);

  /**
   * Persist a new reference target / notes, locally and server-side.
   */
  const handleSaveTracking = async (
    id: string,
    trackingValue: number | null,
    trackingCurrency: string | null,
    notes?: string
  ) => {
    if (entry) {
      const updated = { ...entry, trackingValue, trackingCurrency, notes };
      setEntry(updated);
      const locals = await getLocalTickers();
      await saveLocalTickers(
        (locals || []).map((x) =>
          x.id === id ? { ...x, trackingValue, trackingCurrency, notes } : x
        )
      );
    }

    if (user && entry) {
      await fetch('/api/tickers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id, trackingValue, trackingCurrency, notes }),
      });
    }
  };

  /**
   * Remove the ticker from the watchlist, then return to the dashboard where
   * the updated list is visible.
   */
  const handleDelete = async () => {
    if (!window.confirm(`Remove ${symbol} from your watchlist?`)) return;

    if (entry) {
      const locals = await getLocalTickers();
      await saveLocalTickers((locals || []).filter((x) => x.id !== entry.id));
    }

    if (user && entry) {
      await fetch(`/api/tickers?id=${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
    }

    goHome();
  };

  /**
   * Reorder the watchlist in place, then go back to the dashboard so the user
   * actually sees the new position.
   */
  const handleMove = async (direction: 'up' | 'down') => {
    const locals = (await getLocalTickers()) || [];
    const orderedIds = [...locals]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((x) => x.id);

    const index = orderedIds.indexOf(entry?.id ?? '');
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index === -1 || target < 0 || target >= orderedIds.length) return;

    const [moved] = orderedIds.splice(index, 1);
    orderedIds.splice(target, 0, moved);

    await reorderLocalTickers(orderedIds);

    if (user) {
      try {
        await fetch('/api/tickers/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderedIds }),
        });
      } catch (err) {
        console.error('Failed to sync reorder to server:', err);
      }
    }

    try {
      sessionStorage.setItem(MOVED_TICKER_STORAGE_KEY, moved);
    } catch {}
    goHome();
  };

  const quote = details?.quote || entry?.quote;
  const currentPrice = quote?.price ?? 0;
  const tracking = resolveTracking(
    entry ?? { trackingValue: null, trackingCurrency: null },
    quote,
    rates
  );
  const hasTracking = tracking.hasTracking;
  const hasDiff = hasTracking && tracking.conversionAvailable && tracking.diffPercent !== null;
  const diffPercent = tracking.diffPercent ?? 0;
  const isPositiveDiff = diffPercent >= 0;

  // Extended session (Pre-market 🌅 / After-hours 🌙 / Futures)

  // 52-week position calculation
  let rangePercent = 50;
  if (quote?.fiftyTwoWeekHigh && quote?.fiftyTwoWeekLow && quote.fiftyTwoWeekHigh > quote.fiftyTwoWeekLow) {
    rangePercent = Math.min(
      100,
      Math.max(0, ((currentPrice - quote.fiftyTwoWeekLow) / (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow)) * 100)
    );
  }

  const chartData = details?.chart || [];
  const minClose = chartData.length > 0 ? Math.min(...chartData.map((d) => d.close)) * 0.98 : 0;
  const maxClose = chartData.length > 0 ? Math.max(...chartData.map((d) => d.close)) * 1.02 : 100;

  return (
    // The content background is the old card colour, extended edge to edge, so
    // the page no longer wastes space on a dark frame around a box.
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {/* Back to dashboard bar (keeps its darker treatment to stay distinct) */}
      <div className="sticky top-0 z-40 bg-[#090d16]/95 backdrop-blur border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3">
          <button
            type="button"
            onClick={goHome}
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-300 hover:text-white transition cursor-pointer"
            aria-label={t('details.backToDashboard')}
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{t('details.backToDashboard')}</span>
          </button>
        </div>
      </div>

      {/* Full-bleed content area: no card, no rounded corners and no outer
          margin, so the space previously eaten by the frame is recovered. The
          horizontal padding is kept so content never touches the screen edge. */}
      <main className="w-full">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
          {/* Header */}
          <div className="flex items-start justify-between pb-4 border-b border-slate-800">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-black text-white tracking-wide">{symbol}</h1>
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-800 text-slate-300 border border-slate-700/60">
                  {quote?.exchange || 'Stock'}
                </span>
                <MarketStatusBadge quote={quote} />

                <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-slate-800/60 text-slate-400 uppercase">
                  {quote?.quoteType || 'Equity'}
                </span>
                {/* Personal tracking ref & diff badge */}
                {hasTracking && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-bold border transition cursor-pointer hover:opacity-90 ${
                      isPositiveDiff
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                    }`}
                    title={`${t('details.editTracking')}: ${formatCurrency(tracking.originalValue!, tracking.originalCurrency)}`}
                  >
                    <span>Ref: {formatCurrency(tracking.originalValue!, tracking.originalCurrency)}</span>
                    {hasDiff && <span>({formatPercent(diffPercent)})</span>}
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1 font-medium">{quote?.name || entry?.name || symbol}</p>
            </div>

            {/* Quick Action Buttons */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleMove('up')}
                className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
                title={t('details.moveUp')}
                aria-label={t('details.moveUp')}
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleMove('down')}
                className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
                title={t('details.moveDown')}
                aria-label={t('details.moveDown')}
              >
                <ChevronDown className="w-4 h-4" />
              </button>
              <button
                onClick={() => setEditing(true)}
                className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
                title={t('details.editTracking')}
                aria-label={t('details.editTracking')}
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                onClick={handleDelete}
                className="p-2 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                title={t('details.deleteTicker')}
                aria-label={t('details.deleteTicker')}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Highlight Banner: Price, Target Diff, Current P/E, Forward P/E */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
            {/* Live Price */}
            <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
              <span className="text-[11px] font-medium text-slate-400 block mb-1">{t('details.currentPrice')}</span>
              <div className="text-lg sm:text-xl font-bold text-white">
                {formatCurrency(quote?.price, quote?.currency)}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                <span
                  className={`text-[11px] font-semibold ${
                    (quote?.changePercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {formatPercent(quote?.changePercent)} {t('watchlist.today')}
                </span>

                {/* Extended session indicator: live during the session, otherwise
                    greyed and dated with the tick it comes from. */}
                <ExtendedSessionBadge quote={quote} variant="page" />
              </div>
            </div>

            {/* Reference Target & Diff (Clickable to edit/add anytime) */}
            <div
              onClick={() => setEditing(true)}
              className="p-3 bg-slate-950/60 border border-slate-800/80 hover:border-emerald-500/50 rounded-xl cursor-pointer transition group"
              title={t('details.editTracking')}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-medium text-slate-400">{t('details.trackingTarget')}</span>
                <Edit2 className="w-3 h-3 text-slate-500 group-hover:text-emerald-400 transition" />
              </div>
              <div className="text-lg sm:text-xl font-bold text-slate-200">
                {hasTracking ? formatCurrency(tracking.originalValue!, tracking.originalCurrency) : '—'}
              </div>
              {hasTracking && tracking.converted && tracking.comparisonValue !== null && (
                <div
                  data-testid={`tracking-converted-${symbol}`}
                  className="text-[10px] text-cyan-400/90 mt-0.5"
                >
                  {t('currency.convertedHint', {
                    value: formatCurrency(tracking.comparisonValue, tracking.comparisonCurrency),
                  })}
                </div>
              )}
              {hasDiff ? (
                <span
                  data-testid={`tracking-diff-${symbol}`}
                  className={`inline-block px-1.5 py-0.2 rounded text-[10px] font-bold mt-1 ${
                    isPositiveDiff ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                  }`}
                >
                  {formatPercent(diffPercent)} {t('details.vsTarget')}
                </span>
              ) : (
                <span className="text-[10px] text-emerald-400/90 group-hover:text-emerald-300 block mt-1 underline">
                  + {t('details.setTarget')}
                </span>
              )}
            </div>

            {/* Current P/E — color-tiered */}
            {quote?.trailingPE ? (
              <div className={`p-3 rounded-xl border transition ${getCurrentPeCardClass(quote.trailingPE)}`}>
                <span className="text-[11px] font-medium block mb-1 opacity-90">{t('details.currentPe')}</span>
                <div className="text-lg sm:text-xl font-black">{formatMultiple(quote.trailingPE)}</div>
                <span className="text-[10px] block mt-0.5 opacity-80">{t('details.currentPeDesc')}</span>
              </div>
            ) : null}

            {/* Forward P/E with custom valuation color tiers — hidden when unavailable */}
            {quote?.forwardPE ? (
              <div className={`p-3 rounded-xl border transition ${getForwardPeCardClass(quote.forwardPE)}`}>
                <span className="text-[11px] font-medium block mb-1 opacity-90">{t('details.forwardPe')}</span>
                <div className="text-lg sm:text-xl font-black">{formatMultiple(quote.forwardPE)}</div>
                <span className="text-[10px] block mt-0.5 opacity-80">{t('details.forwardPeDesc')}</span>
              </div>
            ) : null}
          </div>

          {/* Price alerts: opt-in per ticker, seeded from a frozen ATH/ATL. */}
          <PriceAlertsSection
            entry={entry}
            isAuthenticated={!!user}
            symbol={symbol}
            onSaved={(updated) => setEntry(updated)}
          />

          {/* Historical Price Chart */}
          <div className="p-4 bg-slate-950/60 border border-slate-800/80 rounded-xl mb-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-emerald-400" />
                {t('details.priceHistory')}
              </span>

              {/* Range Toggle */}
              <div className="flex bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-[11px] font-semibold">
                {(['1d', '5d', '1mo', '6mo', '1y', '5y'] as TimeRange[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRange(r)}
                    className={`px-2.5 py-1 rounded-md transition cursor-pointer uppercase ${
                      range === r
                        ? 'bg-emerald-500 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="h-44 flex items-center justify-center text-xs text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin text-emerald-400 mr-2" />
                {t('details.loadingChart')}
              </div>
            ) : chartData.length > 0 ? (
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      stroke="#475569"
                      fontSize={10}
                      tickLine={false}
                      axisLine={{ stroke: '#334155' }}
                    />
                    <YAxis
                      domain={[minClose, maxClose]}
                      stroke="#475569"
                      fontSize={10}
                      tickLine={false}
                      axisLine={{ stroke: '#334155' }}
                      tickFormatter={(val) => val.toFixed(0)}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const pt = payload[0].payload;
                          return (
                            <div className="bg-slate-900 border border-slate-700 p-2 rounded-lg shadow-xl text-xs">
                              <p className="text-slate-400">{pt.date}</p>
                              <p className="text-emerald-400 font-bold">
                                {formatCurrency(pt.close, quote?.currency)}
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="close"
                      stroke="#10b981"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#chartGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-32 flex items-center justify-center text-xs text-slate-500">
                {t('details.noChartPoints')}
              </div>
            )}
          </div>

          {/* 52-Week Range Bar */}
          {quote?.fiftyTwoWeekLow && quote?.fiftyTwoWeekHigh && (
            <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl mb-4">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-slate-400 font-medium">{t('details.range52w')}</span>
                <span className="text-slate-300 font-semibold">
                  {formatCurrency(quote.fiftyTwoWeekLow, quote.currency)} —{' '}
                  {formatCurrency(quote.fiftyTwoWeekHigh, quote.currency)}
                </span>
              </div>
              <div className="relative w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-emerald-500 to-cyan-400 rounded-full"
                  style={{ width: `${rangePercent}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                <span>{t('details.low52w')}</span>
                <span className="text-emerald-400 font-medium">{rangePercent.toFixed(0)}%</span>
                <span>{t('details.high52w')}</span>
              </div>
            </div>
          )}

          {/* Key Statistics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs mb-4">
            <div className="p-2.5 bg-slate-950/40 border border-slate-800/60 rounded-xl">
              <span className="text-slate-400 block text-[10px]">{t('details.marketCap')}</span>
              <span className="font-semibold text-slate-200">
                {quote?.marketCap ? formatCompactNumber(quote.marketCap) : '—'}
              </span>
            </div>

            <div className="p-2.5 bg-slate-950/40 border border-slate-800/60 rounded-xl">
              <span className="text-slate-400 block text-[10px]">{t('details.dividendYield')}</span>
              <span className="font-semibold text-slate-200">
                {quote?.dividendYield ? `${quote.dividendYield}%` : '0.00%'}
              </span>
            </div>

            <div className="p-2.5 bg-slate-950/40 border border-slate-800/60 rounded-xl">
              <span className="text-slate-400 block text-[10px]">{t('details.trailingEps')}</span>
              <span className="font-semibold text-slate-200">
                {quote?.epsTrailingTwelveMonths
                  ? formatCurrency(quote.epsTrailingTwelveMonths, quote.currency)
                  : '—'}
              </span>
            </div>

            <div className="p-2.5 bg-slate-950/40 border border-slate-800/60 rounded-xl">
              <span className="text-slate-400 block text-[10px]">{t('details.beta')}</span>
              <span className="font-semibold text-slate-200">
                {quote?.beta ? quote.beta.toFixed(2) : '—'}
              </span>
            </div>

            <div className="p-2.5 bg-slate-950/40 border border-slate-800/60 rounded-xl">
              <span className="text-slate-400 block text-[10px]">{t('details.volume')}</span>
              <span className="font-semibold text-slate-200">
                {quote?.volume ? formatCompactNumber(quote.volume) : '—'}
              </span>
            </div>

            <div className="p-2.5 bg-slate-950/40 border border-slate-800/60 rounded-xl">
              <span className="text-slate-400 block text-[10px]">{t('details.avgVolume')}</span>
              <span className="font-semibold text-slate-200">
                {quote?.avgVolume ? formatCompactNumber(quote.avgVolume) : '—'}
              </span>
            </div>
          </div>

          {entry?.notes && (
            <div className="p-3 bg-slate-950/40 border border-slate-800 rounded-xl text-xs mb-4">
              <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider block mb-1">
                {t('details.personalNotes')}
              </span>
              <p className="text-slate-300">{entry.notes}</p>
            </div>
          )}

          {/* FORWARD EARNINGS CONSENSUS & EDUCATIONAL SECTION */}
          <div className="mt-5 pt-4 border-t border-slate-800/80">
            <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-br from-slate-950/90 via-slate-900/70 to-cyan-950/20 border border-cyan-800/30 space-y-4 text-xs text-slate-300 leading-relaxed">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
                  <Info className="w-4 h-4 shrink-0" />
                  <span>{t('details.consensusTableTitle')}</span>
                </div>
                {details?.forwardConsensus?.forwardEps && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                    Consensus Forward EPS:{' '}
                    {formatCurrency(details.forwardConsensus.forwardEps, quote?.currency || 'USD')}
                  </span>
                )}
              </div>
              <p className="text-slate-400 text-[11px] -mt-2">{t('details.consensusTableSubtitle')}</p>

              {/* Live Consensus Projections Table if available */}
              {details?.forwardConsensus?.estimates && details.forwardConsensus.estimates.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800/80 bg-slate-900/60 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                        <th className="py-2.5 px-3">{t('details.horizonCol')}</th>
                        <th className="py-2.5 px-3 text-right">{t('details.epsConsensusCol')}</th>
                        <th className="py-2.5 px-3 text-center">{t('details.rangeCol')}</th>
                        <th className="py-2.5 px-3 text-center">{t('details.analystsCol')}</th>
                        <th className="py-2.5 px-3 text-right">{t('details.impliedPeCol')}</th>
                        <th className="py-2.5 px-3 text-right">{t('details.growthCol')}</th>
                        <th className="py-2.5 px-3 text-center">{t('details.revisionsCol')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {details.forwardConsensus.estimates.map((est, i) => (
                        <tr key={est.period || i} className="hover:bg-slate-900/40">
                          <td className="py-2.5 px-3 font-semibold text-white whitespace-nowrap">
                            {est.periodLabel}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-emerald-400 font-bold whitespace-nowrap">
                            {est.avgEps !== null
                              ? formatCurrency(est.avgEps, est.currency || quote?.currency || 'USD')
                              : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono text-[11px] text-slate-400 whitespace-nowrap">
                            {est.lowEps !== null && est.highEps !== null
                              ? `${formatCurrency(est.lowEps, est.currency || quote?.currency || 'USD')} – ${formatCurrency(
                                  est.highEps,
                                  est.currency || quote?.currency || 'USD'
                                )}`
                              : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-center text-slate-300 whitespace-nowrap">
                            {est.numberOfAnalysts ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-medium">
                                <Users className="w-3 h-3 text-cyan-400" />
                                {t('details.analystsCount', { count: est.numberOfAnalysts })}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold whitespace-nowrap">
                            {est.impliedForwardPE ? (
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-bold border font-mono ${getForwardPeBadgeClass(
                                  est.impliedForwardPE
                                )}`}
                              >
                                {est.impliedForwardPE.toFixed(1)}x
                              </span>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-medium whitespace-nowrap">
                            {est.growth !== null ? (
                              <span
                                className={
                                  est.growth >= 0 ? 'text-emerald-400' : 'text-red-400'
                                }
                              >
                                {est.growth > 0 ? `+${est.growth}%` : `${est.growth}%`}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-center text-[10px] font-mono whitespace-nowrap">
                            {est.upRevisions30d !== null || est.downRevisions30d !== null ? (
                              <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800">
                                <span className="text-emerald-400">+{est.upRevisions30d ?? 0}</span>
                                <span className="text-slate-500"> / </span>
                                <span className="text-red-400">-{est.downRevisions30d ?? 0}</span>
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs text-slate-400">
                  {t('details.etfConsensusNote')}
                </div>
              )}

              {/* Deep Educational Breakdown */}
              <div className="space-y-3 pt-2">
                <div>
                  <h4 className="font-bold text-white flex items-center gap-1.5 mb-1">
                    <Calculator className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{t('details.eduWhat')}</span>
                  </h4>
                  <p className="text-slate-400">{t('details.eduWhatDesc')}</p>
                  <div className="mt-1.5 p-2 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-emerald-400 font-semibold">
                    {t('details.eduFormula')}
                  </div>
                </div>

                <div>
                  <h4 className="font-bold text-white flex items-center gap-1.5 mb-1">
                    <Users className="w-3.5 h-3.5 text-cyan-400" />
                    <span>{t('details.whoAreAnalysts')}</span>
                  </h4>
                  <p className="text-slate-400">{t('details.whoAreAnalystsDesc')}</p>
                </div>

                <div>
                  <h4 className="font-bold text-white flex items-center gap-1.5 mb-1">
                    <Layers className="w-3.5 h-3.5 text-purple-400" />
                    <span>{t('details.multipleHorizons')}</span>
                  </h4>
                  <p className="text-slate-400">{t('details.multipleHorizonsDesc')}</p>
                </div>

                <div>
                  <h4 className="font-bold text-white flex items-center gap-1.5 mb-1">
                    <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                    <span>{t('details.dispersionTitle')}</span>
                  </h4>
                  <p className="text-slate-400">{t('details.dispersionDesc')}</p>
                </div>

                <div>
                  <h4 className="font-bold text-white mb-1">{t('details.eduComparison')}</h4>
                  <p className="text-slate-400">{t('details.eduComparisonDesc')}</p>
                </div>

                <div className="p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-amber-300/90 text-[11px]">
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <strong className="text-amber-300">{t('details.eduCaveat')}: </strong>
                      <span>{t('details.eduCaveatDesc')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Reference target / notes editor, layered over the full page */}
      <EditTrackingModal
        ticker={entry}
        isOpen={editing}
        onClose={() => setEditing(false)}
        onSave={handleSaveTracking}
      />
    </div>
  );
}