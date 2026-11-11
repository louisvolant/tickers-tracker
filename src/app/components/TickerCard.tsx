'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import { ArrowUp, ArrowDown, ChevronUp, ChevronDown } from 'lucide-react';
import { UserTicker } from '@/lib/types';
import { formatCurrency, formatPercent, formatMultiple, getForwardPeBadgeClass, getCurrentPeBadgeClass, flashMovedElement } from '@/lib/utils';
import { resolveTracking } from '@/lib/tracking';
import { useI18n } from '@/context/I18nContext';
import { useCurrencyRates } from '@/context/CurrencyContext';
import { MarketStatusBadge } from './MarketStatusBadge';
import { ExtendedSessionBadge } from './ExtendedSessionBadge';

interface TickerCardProps {
  ticker: UserTicker;
  index: number;
  totalCount: number;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onClick: (ticker: UserTicker) => void;
  onEdit: (ticker: UserTicker) => void;
  onDelete: (ticker: UserTicker) => void;
  isReorderMode?: boolean;
  /** Changes whenever this card has just been moved, to replay the highlight. */
  flashKey?: number;
}

export function TickerCard({
  ticker,
  index,
  totalCount,
  onMoveUp,
  onMoveDown,
  onClick,
  onEdit,
  onDelete,
  isReorderMode = false,
  flashKey,
}: TickerCardProps) {
  const { t } = useI18n();
  const { rates } = useCurrencyRates();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!flashKey) return;
    const animation = flashMovedElement(cardRef.current);
    return () => animation?.cancel();
  }, [flashKey]);
  const quote = ticker.quote;
  const isPositiveToday = (quote?.changePercent ?? 0) >= 0;

  const tracking = useMemo(() => resolveTracking(ticker, quote, rates), [ticker, quote, rates]);
  const hasDiff = tracking.hasTracking && tracking.conversionAvailable && tracking.diffPercent !== null;
  const isPositiveDiff = (tracking.diffPercent ?? 0) >= 0;

  // Extended session (Pre-market 🌅 / After-hours 🌙 / Futures)

  return (
    <div
      ref={cardRef}
      data-symbol={ticker.symbol}
      onClick={() => {
        if (!isReorderMode) {
          onClick(ticker);
        }
      }}
      className={`px-3.5 py-2 rounded-xl bg-slate-900/90 border transition select-none flex items-center justify-between gap-3 shadow-sm ${
        isReorderMode
          ? 'border-purple-500/30 hover:border-purple-500/50 cursor-default'
          : 'border-slate-800 hover:border-slate-700 active:scale-[0.99] cursor-pointer'
      }`}
    >
      {/* Left side:
          Line 1: Label/title in bold followed by ticker symbol (non-bold)
          Line 2: Exchange ("PAR", "NMS", etc.) followed by Current PE and Forward PE */}
      <div className="min-w-0 flex-1">
        {/* Line 1: Label in bold + Ticker symbol non-bold */}
        <div className="flex items-center gap-1.5 sm:gap-2 truncate">
          <span className="font-bold text-sm sm:text-base text-white tracking-tight truncate max-w-[160px] sm:max-w-[260px]">
            {quote?.name || ticker.name}
          </span>
          <span className="text-xs text-slate-400 font-normal shrink-0">
            {ticker.symbol}
          </span>
        </div>

        {/* Line 2: Exchange ("PAR", "NMS", etc.) + Current P/E + Forward P/E */}
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-slate-800 text-slate-400 border border-slate-700/50">
            {quote?.exchange || 'Stock'}
          </span>

          <MarketStatusBadge quote={quote} />

          {/* Current PE on line 2 */}
          {quote?.trailingPE ? (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border font-mono ${getCurrentPeBadgeClass(quote.trailingPE)}`}>
              PE {formatMultiple(quote.trailingPE)}
            </span>
          ) : null}

          {/* Forward PE on line 2 */}
          {quote?.forwardPE ? (
            <span
              title={`Forward P/E: ${formatMultiple(quote.forwardPE)}`}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold border font-mono ${getForwardPeBadgeClass(
                quote.forwardPE
              )}`}
            >
              Fwd {formatMultiple(quote.forwardPE)}
            </span>
          ) : null}

          {/* Reference target % diff (mobile parity with desktop table) */}
          {hasDiff ? (
            <span
              data-testid={`tracking-diff-${ticker.symbol}`}
              title={`${formatCurrency(tracking.originalValue!, tracking.originalCurrency)} ${t('watchlist.colDiff')}`}
              className={`px-1.5 py-0.5 rounded text-[10px] font-black border font-mono ${
                isPositiveDiff
                  ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25'
                  : 'text-rose-400 bg-rose-500/10 border-rose-500/25'
              }`}
            >
              {formatPercent(tracking.diffPercent)}
            </span>
          ) : null}
        </div>
      </div>

      {/* Right side: in Reorder mode, display Up/Down reorder arrows; otherwise display live price & day change */}
      {isReorderMode ? (
        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onMoveUp(index)}
            disabled={index === 0}
            className="p-1.5 sm:p-2 rounded-xl bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white hover:bg-slate-700 hover:border-slate-600 disabled:opacity-20 disabled:pointer-events-none transition cursor-pointer active:scale-95 shadow-sm"
            title={t('details.moveUp')}
            aria-label={t('details.moveUp')}
            data-testid={`move-up-${ticker.symbol}`}
          >
            <ChevronUp className="w-4 h-4 stroke-[2.5]" />
          </button>
          <button
            type="button"
            onClick={() => onMoveDown(index)}
            disabled={index === totalCount - 1}
            className="p-1.5 sm:p-2 rounded-xl bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white hover:bg-slate-700 hover:border-slate-600 disabled:opacity-20 disabled:pointer-events-none transition cursor-pointer active:scale-95 shadow-sm"
            title={t('details.moveDown')}
            aria-label={t('details.moveDown')}
            data-testid={`move-down-${ticker.symbol}`}
          >
            <ChevronDown className="w-4 h-4 stroke-[2.5]" />
          </button>
        </div>
      ) : (
        <div className="text-right shrink-0">
          <div className="text-base font-black text-white leading-tight">
            {formatCurrency(quote?.price, quote?.currency)}
          </div>
          <div
            className={`flex items-center justify-end gap-1 text-xs font-semibold leading-tight mt-0.5 ${
              isPositiveToday ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            <span className="flex items-center gap-0.5">
              {isPositiveToday ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
              <span>{formatPercent(quote?.changePercent)}</span>
            </span>

            {/* Extended session indicator: live during the session, greyed once over */}
            <ExtendedSessionBadge quote={quote} variant="card" />
          </div>
        </div>
      )}
    </div>
  );
}
