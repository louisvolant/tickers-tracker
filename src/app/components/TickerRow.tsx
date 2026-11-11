'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import { ArrowUp, ArrowDown, ChevronUp, ChevronDown, BarChart2, Edit2, Trash2 } from 'lucide-react';
import { UserTicker } from '@/lib/types';
import { formatCurrency, formatPercent, formatMultiple, getForwardPeBadgeClass, getCurrentPeBadgeClass, flashMovedElement } from '@/lib/utils';
import { resolveTracking } from '@/lib/tracking';
import { useI18n } from '@/context/I18nContext';
import { useCurrencyRates } from '@/context/CurrencyContext';
import { ExtendedSessionBadge } from './ExtendedSessionBadge';

interface TickerRowProps {
  ticker: UserTicker;
  index: number;
  totalCount: number;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onClick: (ticker: UserTicker) => void;
  onEdit: (ticker: UserTicker) => void;
  onDelete: (ticker: UserTicker) => void;
  /** Changes whenever this row has just been moved, to replay the highlight. */
  flashKey?: number;
}

export function TickerRow({
  ticker,
  index,
  totalCount,
  onMoveUp,
  onMoveDown,
  onClick,
  onEdit,
  onDelete,
  flashKey,
}: TickerRowProps) {
  const { t } = useI18n();
  const { rates } = useCurrencyRates();
  const rowRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (!flashKey) return;
    const animation = flashMovedElement(rowRef.current);
    return () => animation?.cancel();
  }, [flashKey]);
  const quote = ticker.quote;
  const currentPrice = quote?.price ?? 0;
  const tracking = useMemo(() => resolveTracking(ticker, quote, rates), [ticker, quote, rates]);
  const hasTracking = tracking.hasTracking;
  const hasDiff = hasTracking && tracking.conversionAvailable && tracking.diffPercent !== null;
  const diffPercent = tracking.diffPercent ?? 0;
  const isPositiveDiff = diffPercent >= 0;
  const isPositiveToday = (quote?.changePercent ?? 0) >= 0;

  // Extended session (Pre-market 🌅 / After-hours 🌙 / Futures) is rendered by
  // ExtendedSessionBadge, which greys out a session that is already over.

  return (
    <tr
      ref={rowRef}
      data-symbol={ticker.symbol}
      onClick={() => onClick(ticker)}
      className="group border-b border-slate-800/60 hover:bg-slate-900/60 transition cursor-pointer"
    >
      {/* Reorder handles */}
      <td className="py-1.5 px-2.5 w-12" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-center justify-center gap-0">
          <button
            onClick={() => onMoveUp(index)}
            disabled={index === 0}
            className="p-0.5 rounded text-slate-500 hover:text-white hover:bg-slate-800 disabled:opacity-20 disabled:hover:bg-transparent transition cursor-pointer"
            title={t('details.moveUp')}
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onMoveDown(index)}
            disabled={index === totalCount - 1}
            className="p-0.5 rounded text-slate-500 hover:text-white hover:bg-slate-800 disabled:opacity-20 disabled:hover:bg-transparent transition cursor-pointer"
            title={t('details.moveDown')}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>

      {/* Label (bold) followed by Ticker Symbol (regular, non-bold) & Exchange underneath */}
      <td className="py-1.5 px-3">
        <div className="flex items-center gap-1.5 truncate max-w-[220px]">
          <span className="font-bold text-sm text-white truncate group-hover:text-emerald-400 transition">
            {quote?.name || ticker.name}
          </span>
          <span className="text-xs text-slate-400 font-normal shrink-0">
            {ticker.symbol}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-slate-800/80 text-slate-400 border border-slate-700/50">
            {quote?.exchange || 'Stock'}
          </span>
        </div>
      </td>

      {/* Live Market Price & Day Change */}
      <td className="py-1.5 px-3 text-right">
        <div className="text-sm font-bold text-white">
          {formatCurrency(currentPrice, quote?.currency)}
        </div>
        <div
          className={`flex items-center justify-end gap-1 text-[11px] font-semibold ${
            isPositiveToday ? 'text-emerald-400' : 'text-rose-400'
          }`}
        >
          <span className="flex items-center gap-0.5">
            {isPositiveToday ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
            <span>{formatPercent(quote?.changePercent)}</span>
          </span>

          {/* Extended session indicator: live during the session, greyed and dated
              once it is over. */}
          <ExtendedSessionBadge quote={quote} />
        </div>
      </td>

      {/* Tracking Value (Baseline / Cost Basis) */}
      <td className="py-1.5 px-3 text-right">
        {hasTracking ? (
          <>
            <div
              data-testid={`tracking-value-${ticker.symbol}`}
              className="text-sm font-semibold text-slate-300"
            >
              {formatCurrency(tracking.originalValue!, tracking.originalCurrency)}
            </div>
            {tracking.converted && tracking.comparisonValue !== null ? (
              <span
                data-testid={`tracking-converted-${ticker.symbol}`}
                className="text-[10px] text-cyan-400/80 block"
                title={`${tracking.originalCurrency} → ${tracking.comparisonCurrency}`}
              >
                ≈ {formatCurrency(tracking.comparisonValue, tracking.comparisonCurrency)}
              </span>
            ) : (
              <span className="text-[10px] text-slate-500 block">{t('watchlist.baseline')}</span>
            )}
          </>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        )}
      </td>

      {/* % Diff vs Tracking Value */}
      <td className="py-1.5 px-3 text-center">
        {hasDiff ? (
          <span
            data-testid={`tracking-diff-${ticker.symbol}`}
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black tracking-wide border ${
              isPositiveDiff
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                : 'bg-rose-500/15 text-rose-400 border-rose-500/30'
            }`}
          >
            {formatPercent(diffPercent)}
          </span>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        )}
      </td>

      {/* Current P/E (Trailing) — only shown when available */}
      <td className="py-1.5 px-3 text-center">
        {quote?.trailingPE ? (
          <span className={`inline-block px-2 py-0.5 rounded-lg text-xs font-bold border font-mono transition ${getCurrentPeBadgeClass(quote.trailingPE)}`}>
            {formatMultiple(quote.trailingPE)}
          </span>
        ) : (
          <span className="text-xs text-slate-500 font-mono">—</span>
        )}
      </td>

      {/* Forward P/E with custom valuation color tiers */}
      <td className="py-1.5 px-3 text-center">
        {quote?.forwardPE ? (
          <span
            title={`Forward P/E: ${formatMultiple(quote.forwardPE)}`}
            className={`inline-block px-2 py-0.5 rounded-lg text-xs font-bold border font-mono transition ${getForwardPeBadgeClass(
              quote.forwardPE
            )}`}
          >
            {formatMultiple(quote.forwardPE)}
          </span>
        ) : (
          <span className="text-xs text-slate-500 font-mono">—</span>
        )}
      </td>

      {/* Actions */}
      <td className="py-1.5 px-2.5 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => onClick(ticker)}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
            title="View chart & statistics"
          >
            <BarChart2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onEdit(ticker)}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
            title={t('details.editTracking')}
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(ticker)}
            className="p-1 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition cursor-pointer"
            title={t('details.deleteTicker')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}
