export interface TickerQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  trailingPE: number | null;
  forwardPE: number | null;
  marketCap: number | null;
  dividendYield: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  /** Intraday high of the current regular session, in listing currency. */
  dayHigh?: number | null;
  /** Intraday low of the current regular session, in listing currency. */
  dayLow?: number | null;
  epsTrailingTwelveMonths: number | null;
  beta: number | null;
  volume: number | null;
  avgVolume: number | null;
  exchange: string;
  quoteType: string;
  updatedAt: number;
  marketState?: string | null;
  preMarketPrice?: number | null;
  preMarketChange?: number | null;
  preMarketChangePercent?: number | null;
  postMarketPrice?: number | null;
  postMarketChange?: number | null;
  postMarketChangePercent?: number | null;
  extendedType?: 'pre' | 'post' | null;
  extendedPrice?: number | null;
  extendedChangePercent?: number | null;
  /** IANA timezone of the venue, e.g. Europe/Paris. */
  exchangeTimezone?: string | null;
  /** Upcoming regular sessions (absolute times). Null when no calendar is known. */
  marketSessions?: MarketSession[] | null;
}

/** One regular trading session of a venue, as absolute epoch-millisecond timestamps. */
export interface MarketSession {
  opensAt: number;
  closesAt: number;
}

export interface UserTicker {
  id: string;
  symbol: string;
  name: string;
  trackingValue: number | null; // Optional personal reference or purchase price to compute % diff
  trackingCurrency?: string | null; // Currency the reference value is expressed in (null = listing currency)
  notes?: string;
  order: number;
  createdAt: number;
  quote?: TickerQuote | null;
  /** Upper price-alert threshold, expressed in `alertCurrency` (absent = disabled). */
  alertHigh?: number | null;
  /** Lower price-alert threshold, expressed in `alertCurrency` (absent = disabled). */
  alertLow?: number | null;
  /** Currency the thresholds are expressed in (null = listing currency). */
  alertCurrency?: string | null;
  /** How the upper threshold was seeded when alerts were enabled. */
  alertHighSource?: 'ath' | 'custom';
  /** How the lower threshold was seeded when alerts were enabled. */
  alertLowSource?: 'atl' | 'custom';
  /** Epoch ms of the last threshold save, shown next to the ATH/ATL labels. */
  alertSetAt?: number;
  /** IANA venue timezone, so the scanner can skip closed markets without a call. */
  exchangeTimezone?: string | null;
}

/** Per-ticker arming state for the two price-alert thresholds. */
export interface AlertStateEntry {
  /** True while the upper threshold may fire; cleared on trigger, set on pullback. */
  highArmed: boolean;
  /** True while the lower threshold may fire; cleared on trigger, set on rebound. */
  lowArmed: boolean;
  /** Epoch ms of the last upper trigger, kept across re-arms for the UI. */
  highTriggeredAt: number | null;
  /** Epoch ms of the last lower trigger, kept across re-arms for the UI. */
  lowTriggeredAt: number | null;
}

/** Alert state for a whole user, stored under a single KV key. */
export type AlertStateMap = Record<string, AlertStateEntry>;


export interface TickerSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  quoteType: string;
  sector?: string;
  industry?: string;
}

export interface ChartPoint {
  date: string;
  timestamp: number;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

export interface EarningsEstimatePeriod {
  period: string; // e.g. "0y", "+1y", "0q", "+1q"
  periodLabel: string; // e.g. "Fiscal Year 2026 (FY0)", "Fiscal Year 2027 (FY+1)"
  endDate?: string;
  year?: number;
  avgEps: number | null;
  lowEps: number | null;
  highEps: number | null;
  numberOfAnalysts: number | null;
  growth: number | null;
  currency?: string;
  impliedForwardPE: number | null;
  upRevisions30d?: number | null;
  downRevisions30d?: number | null;
}

export interface ForwardConsensusData {
  forwardEps: number | null;
  forwardPE: number | null;
  primaryHorizon: string;
  sourceDescription: string;
  estimates: EarningsEstimatePeriod[];
}

export interface TickerDetails {
  quote: TickerQuote;
  chart: ChartPoint[];
  summary?: {
    description?: string;
    sector?: string;
    industry?: string;
    website?: string;
  };
  forwardConsensus?: ForwardConsensusData;
}

export interface UserRecord {
  id: string;
  email: string;
  username: string;
  hashedPassword?: string;
  googleId?: string;
  createdAt: number;
  lastLoginAt?: number; // Unix epoch in milliseconds, same unit as createdAt
  preferredCurrency?: string; // User's own reference currency (e.g. 'EUR')
}

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  preferredCurrency?: string;
}
