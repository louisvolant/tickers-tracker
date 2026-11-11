'use client';

import React from 'react';
import { Moon, Sunrise } from 'lucide-react';
import { TickerQuote } from '@/lib/types';
import {
  formatExtendedTimestamp,
  formatPercent,
  getExtendedSessionBadgeClass,
} from '@/lib/utils';
import { useI18n } from '@/context/I18nContext';

type Variant = 'row' | 'card' | 'page';

interface ExtendedSessionBadgeProps {
  quote: TickerQuote | null | undefined;
  variant?: Variant;
}

/**
 * Pre-market 🌅 / after-hours 🌙 badge.
 *
 * Only a figure the server flagged as live (`extendedLive`) is painted as the
 * current session. Anything else is the last extended session - Friday's
 * after-hours tick is still the newest one on a Sunday - so it is greyed out and
 * dated instead of pretending to be current. Rendering that stale figure as live
 * is what made the percentage look frozen for hours.
 */
export function ExtendedSessionBadge({ quote, variant = 'row' }: ExtendedSessionBadgeProps) {
  const { t, locale } = useI18n();

  const percent = quote?.extendedChangePercent;
  const live = quote?.extendedLive === true;
  const isPreMarket = quote?.extendedType === 'pre';
  const label = isPreMarket ? t('watchlist.preMarket') : t('watchlist.afterHours');

  const asOf = live ? '' : formatExtendedTimestamp(quote?.extendedAsOf, locale);
  const asOfLabel = asOf ? t('watchlist.extendedAsOf', { time: asOf }) : '';

  if (percent === null || percent === undefined) return null;

  const title = asOfLabel
    ? `${label}: ${formatPercent(percent)} (${asOfLabel})`
    : `${label}: ${formatPercent(percent)}`;

  const tone = live
    ? getExtendedSessionBadgeClass(percent)
    : 'text-slate-400 bg-slate-800/60 border-slate-700/60';

  const size = variant === 'page' ? 'gap-1 px-2 py-0.5 text-[11px]' : 'gap-0.5 px-1 py-0.2 text-[10px]';
  const iconSize = variant === 'page' ? 'w-3 h-3' : 'w-2.5 h-2.5';

  return (
    <>
      <span
        data-testid={`extended-badge-${quote?.symbol}`}
        data-live={live ? 'true' : 'false'}
        title={title}
        className={`inline-flex items-center font-bold rounded border ${size} ${tone}`}
      >
        {isPreMarket ? (
          <Sunrise className={`${iconSize} shrink-0`} />
        ) : (
          <Moon className={`${iconSize} shrink-0`} />
        )}
        {variant === 'page' && <span>{label}</span>}
        <span>{formatPercent(percent)}</span>
        {variant === 'page' && asOfLabel && (
          <span className="font-medium opacity-80">· {asOfLabel}</span>
        )}
      </span>
      {/* The desktop table has room for the timestamp next to the badge. */}
      {variant === 'row' && asOf && (
        <span className="text-[9px] font-medium text-slate-500 whitespace-nowrap">{asOf}</span>
      )}
    </>
  );
}
