# Ticker-Tracker 📈

A modern, lightning-fast stock and valuation multiples tracker built with Next.js (App Router), Tailwind CSS, Lucide icons, Yahoo Finance integration, IndexedDB local caching, PWA capabilities, and Cloudflare Workers KV support.

## Key Features

- **Real-Time & 30s Cached Market Quotes**: Powered by Yahoo Finance (`yahoo-finance2`), covering US stocks, European equities (e.g. `MC.PA`, `AIR.PA`), and index futures (e.g. `NQ=F`, `ES=F`) with an optimized 30-second KV server cache for rapid sync.
- **Valuation Multiples with Color Tiers**: Instantly displays **Current P/E** (`trailingPE`) and **Forward P/E** (`forwardPE`) on both mobile cards and desktop tables. Forward P/E is dynamically colored by valuation tier:
  - Deep value (< 15x): emerald green
  - Moderate value (15x - 20x): teal
  - **Sweet Spot (20x - 30x)**: prominent cyan highlight
  - Elevated (30x - 40x): warm amber
  - High (40x - 60x): orange
  - Stretched (> 60x): deep red / rose
- **Ultra-Compact Mobile Cards & Clear Hierarchy**:
  - **Line 1 (Top)**: Company/asset **label displayed in bold**, immediately followed by the ticker **symbol in regular font** (e.g. **Apple Inc.** `AAPL`).
  - **Line 2 (Bottom)**: Exchange badge (e.g. `PAR`, `NMS`, `Stock`) followed by **Current P/E** (`PE 32.4x`) and **Forward P/E** (`Fwd 28.1x`).
  - **Right side**: Current price and daily change (% evolution) with extended session indicators (`🌅` / `🌙`).
  - **Details Modal**: Personal cost basis / target price is streamlined away from collapsed cards into the opened details modal right next to the "Equity" pill.
- **Pre-Market, After-Hours & Sunday Futures Indicator**: Displays real-time extended session percentage indicators directly beside daily change (e.g. `▼ -0.41% (🌅 +0.03%)` or `(🌙 -0.12%)`). Essential for monitoring after-hours earnings reports, early morning pre-market trading, and Sunday evening futures pre-trends before Monday market open. Drops below **-0.20%** are highlighted in deep red / rose.
- **Market Status (Open / Just Closed / Opens Soon)**: Mobile cards and the ticker page show whether the venue is open (with its closing time), closed for less than 30 minutes, opening within 60 minutes (with a countdown), or closed until its next session (today, tomorrow or the weekday). Times and day labels use the viewer's local timezone, and the badge tooltip names the exchange timezone. Sessions are computed server-side from the venue timezone, weekends and exchange holidays; the holiday dates are pre-generated into `marketHolidays.json` so the runtime does no holiday computation and carries no holiday library (see [Market holiday table](#market-holiday-table)). Futures are not shown: their values are only displayed while they trade.
- **Reliable Reorganization Mode (Flèches Haut / Bas)**: Select "Reorganize" (`Réorganisation`) from the display dropdown to enter ordering mode:
  - The right-hand price block on each mobile card is dynamically replaced with intuitive **Up / Down arrow buttons** (`ChevronUp` / `ChevronDown`).
  - Tapping up/down immediately reorders tickers without any touch gesture conflicts between scrolling, tapping, and long-presses.
  - Position changes are saved instantly in local IndexedDB and synchronized to Cloudflare KV for registered accounts.
  - An inline banner provides single-tap confirmation (`OK`) to return to standard pricing view.
- **1-Click Instant Ticker Addition & Bottom Add Button**: Adding tickers from search is immediate with a single click. In addition to the quick search `+` button, an explicit "+ Add Ticker" button is conveniently placed at the bottom of the watchlist right above the privacy notice.
- **Batch Add (Multiple Tickers at Once)**: A "Batch add" button sits next to the bottom "Add Ticker" button, and the single-search modal links to the same flow. Paste symbols separated by commas, semicolons, spaces or new lines (up to 25); already-tracked symbols are skipped, unknown symbols are reported individually, and authenticated users are validated with a single batched Yahoo quote request. Guests get the same result locally through IndexedDB.
- **100% Private & Zero User Tracking**: No user tracking or behavioral telemetry. The "tracking value" is strictly an optional personal cost basis or target purchase price chosen and entered solely by the user (or left completely empty).
- **Streamlined Watchlist Controls**:
  - **Title Row**: `Ma liste de tickers (X tickers)` on the left with the **Display Mode Selector** docked right.
  - **Action Row**: A real **live watchlist search input** docked left filters the tickers below by symbol, company name or ETF label as you type (case- and accent-insensitive; `⌘K` / `Ctrl+K` focuses it, `Esc` clears it). The `+ Add Ticker` button next to it still opens the add/search modal, while the manual **Refresh button** stays docked right.
  - **Market Filters**: A scrollable chip row sits directly below the search bar on desktop and mobile. Chips are derived from the markets actually present in the watchlist (`Paris`, `NASDAQ`, `NYSE`, `XETRA`, ...) and show their ticker count. Several markets can be combined, `All markets` clears the selection, and the filter applies to every display mode and combines with the live search.
- **Comprehensive Forward P/E Educational Guide**: Integrated breakdown detailing how Forward P/E is calculated, Wall Street & European analyst consensus mechanisms, forecast horizons (NTM / next FY), Trailing vs. Forward comparisons, and key analytical limitations.
- **Optional Reference Target & % Diff (Multi-Currency)**: Add or update your cost basis anytime directly from the ticker row, the mobile card details, or the ticker page. Enter the reference value either in the ticker's **listing currency** (default) or in **your own reference currency** (configured in Account Settings), and Ticker-Tracker converts it on the fly using live EUR-based rates to compute an FX-inclusive `% Diff` on desktop and mobile. Ticker-Tracker automatically highlights the percentage variance (`% Diff`) in real time, or displays clean pricing without any target requirements.
- **Zero-Latency Mobile & Desktop Startup (IndexedDB)**: Saved tickers and quotes are stored locally in IndexedDB, rendering your dashboard instantly upon opening your phone, with background stale-while-revalidate reloads.
- **Progressive Web App (PWA)**: Installable on iOS, Android, and Desktop with offline caching via Service Worker and web app manifest.
- **Multimodal Search (Ticker, Label & ISIN)**: Search stocks by symbol (e.g. `PUST`, `WPEA`), company name / ETF label (e.g. `LVMH`, `AIRBUS`, `SCHNEIDER`), or official ISIN codes (e.g. `FR0011871110`, `FR001400Q9V2`), supplemented by live Yahoo Finance search.
- **Interactive Financial Stats & Charts**: Full-page ticker view at `/ticker/[symbol]` with historical price trends, 52-week ranges, dividend yields, EPS, market capitalization, and beta. Deep-linkable, browser-back friendly, and stable on mobile (no two-pass reflow).
- **Flexible Display & Sorting Modes (Custom, Reorganize, Alphabetical, By Trading Exchange)**: Switch seamlessly with the dropdown button docked right on the title bar:
  - **Custom Order (Liste ordonnée)**: User-defined sequence saved to IndexedDB and Cloudflare KV.
  - **Reorganize (Réorganisation)**: Tactile up/down reorder buttons on each ticker card.
  - **Alphabetical (A → Z)**: Global alphabetical sorting by ticker symbol.
  - **By Trading Market (Par place de cotation)**: Intelligently groups tickers by exchange system (`Euronext Paris`, `NASDAQ`, `NYSE`, `Deutsche Börse XETRA`, `London Stock Exchange`, etc.) with stylish header badges, and sorts tickers alphabetically inside each exchange.
  - Choice is remembered locally across browser sessions.
- **Interactive Table Column Sorting**: Click any table column header on desktop to sort dynamically (`Ticker & Name`, `Current Price`, `Reference Target`, `% Diff`, `Current P/E`, `Forward P/E`):
  - **1st click**: sorts descending (`desc`) with an active green downward arrow (`ArrowDown`).
  - **2nd click**: sorts ascending (`asc`) with an active green upward arrow (`ArrowUp`).
  - **3rd click**: clears the column sort and restores the base order.
  - Clicking another column clears the previous column sort and initiates descending sort on the new column. Applies across custom, alphabetical, and grouped market views.
- **Magic Demo Playground (Interactive Animated Showcase)**: An interactive landing component that eliminates signup friction by showing the core product magic in under 3 seconds:
  - **Typewriter Terminal Simulation**: Simulates pasting raw or unstructured notes with fluid ~26ms character typing, line numbers, and macOS-style traffic lights.
  - **Cascading Live Financial Cards**: Staggered cards reveal live quotes, exchange pills, and color-coded Forward P/E valuation tiers as lines are parsed.
  - **Dual Responsive Architecture**: Split-screen side-by-side mode on desktop (`md:`), and an automatic morphing view with tactile comparison tabs (`Raw input` ⇄ `Enriched cards`) on mobile.
  - **3 Realistic 1-Click Presets**: Preloaded with Broker notes (`AAPL, MSFT...`), PEA & US mix (`MC.PA, AIR.PA, TSLA...`), and unstructured forum discussions.
  - **Zero-Friction CTAs & Replay**: One-click replay (`↺`) plus direct access to the live batch-add importer.
- **Account Lifecycle & Security**: Registration, login, Google OAuth 2.0 integration, password updates (`/api/auth/changepassword`), and complete account deletion (`/api/auth/delete_my_account`). Custom mutation and cache-warming routes enforce a same-origin Origin/Referer check (the session cookie is `SameSite=Lax`), and registration rejects reserved, test-only and disposable email domains.
- **Multilingual Support (i18n)**: Full localization across 6 languages: English (`en`), French (`fr`), German (`de`), Spanish (`es`), Italian (`it`), and Portuguese (`pt`), with an active language selector.
- **SEO & Legal**: Canonical URLs on the homepage, ticker pages and legal pages, a 301 redirect from `http://` and the apex host to `https://www.tickertracker.net`, dynamic `sitemap.xml`, `robots.txt` (public pages allowed, `/api/` blocked and marked `noindex`), Privacy Policy (`/privacy`), Terms of Service (`/terms`), and footer links to [Personal Page](https://www.louisvolant.com) and [Portfolio](https://www.louisvolant.com/portfolio).
- **Privacy-Safe Caching**: Personalized routes (`/ticker/`, `/api/`) are forced dynamic, sent with `Cache-Control: private, no-store`, and excluded from Service Worker Cache Storage — your reference target and personal notes are never retained by a CDN, proxy or offline cache.
- **Cloudflare Workers Ready**: Compatible with Cloudflare Workers / OpenNext with KV storage bindings (`KV`, `ticker_tracker_kv`), `keep_vars = true` preservation, and local development fallback.

---

## Curated Equities & ETFs Catalog

The app includes built-in multimodal search indexing for key French, European, and US equities and UCITS ETFs:

| ISIN | Ticker | Label | Yahoo Symbol |
| :--- | :--- | :--- | :--- |
| `FR0011871110` | PUST | AMUNDI PEA NASDAQ-100 UCITS ETF ACC | `PUST.PA` |
| `IE0002XZSHO1` | WPEA | ISHARES MSCI WORLD SWAP PEA UCITS ETF EUR (ACC) | `WPEA.PA` |
| `FR0011550185` | ESE | BNP PARIBAS EASY S&P 500 UCITS ETF EUR CAPITALISATION | `ESE.PA` |
| `DE000A2QP372` | EXX1 | ISHARES EURO STOXX BANKS 30-15 UCITS ETF (DE) EUR (ACC) | `EXX1.DE` |
| `FR0000121014` | MC | LVMH | `MC.PA` |
| `FR0000120073` | AI | AIR LIQUIDE | `AI.PA` |
| `FR0011869312` | PAASI | AMUNDI PEA ASIE PACIFIQUE UCITS ETF ACC | `PAASI.PA` |
| `NL0000235190` | AIR | AIRBUS | `AIR.PA` |
| `FR0000121972` | SU | SCHNEIDER ELECTRIC | `SU.PA` |
| `FR0010307819` | LR | LEGRAND | `LR.PA` |
| `FR001400Q9V2` | EXENS | EXOSENS | `EXENS.PA` |
| `US0231351067` | AMZN | AMAZON.COM | `AMZN` |
| `US5949181045` | MSFT | MICROSOFT | `MSFT` |
| `US67066G1040` | NVDA | NVIDIA | `NVDA` |
| `US30303M1027` | META | META PLATFORMS | `META` |
| `US02079K3059` | GOOGL | ALPHABET-A | `GOOGL` |
| `IE00B6R52036` | IAUP | ISHARES GOLD PRODUCERS UCITS ETF USD (ACC) | `IAUP.L` |
| `US0494681010` | TEAM | ATLASSIAN RG-A | `TEAM` |
| `US0378331005` | AAPL | APPLE | `AAPL` |
| `IE00B3ZW0K18` | IUSE | ISHARES S&P 500 EUR HEDGED UCITS ETF (ACC) | `IUSE.L` |
| `IE000U9ODG19` | DFND | ISHARES GLOBAL AEROSPACE & DEFENCE UCITS ETF USD ACCU | `DFND.L` |
| `LU1681044480` | AASI | AMUNDI MSCI EM ASIA UCITS ETF - EUR | `AASI.PA` |
| `DE000A0H0728` | EXXY | ISHARES DIVERSIFIED COMMODITY SWAP UCITS ETF (DE) | `EXXY.DE` |
| `DE000A2QP380` | EXX5 | ISHARES EURO STOXX SELECT DIVIDEND 30 UCITS ETF (DE) | `EXX5.DE` |
| `LU1834987973` | INSU | AMUNDI STOXX EUROPE 600 INSURANCE UCITS ETF ACC | `LIRU.PA` |
| `US23804L1035` | DDOG | DATADOG RG-A | `DDOG` |

---

## Getting Started

### 1. Installation

```bash
npm install
```

### 2. Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

### 3. Build & Deploy

For local production Next.js build:
```bash
npm run build:next
npm start
```

For Cloudflare Workers build and deployment:
```bash
npm run build    # holiday-table check, then OpenNext build
npm run deploy   # runs the build itself, then wrangler deploy
```

---

## Environment Variables & Cloudflare Configuration

Set the following environment variables in your `.env.local` for local development or in Cloudflare Workers settings:

```ini
# Session cookie secret (32+ chars generated via: openssl rand -base64 32)
SESSION_SECRET="your-secure-session-secret"

# Google OAuth 2.0 Credentials
GOOGLE_CLIENT_ID="your-google-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

# Optional explicit public application URL (e.g. for OAuth redirects behind reverse proxies)
NEXT_PUBLIC_APP_URL="https://www.tickertracker.net"

# Shared secret for the optional manual alert-scan endpoint (openssl rand -hex 32).
# The scheduled scan runs in-process and does not use it.
CRON_SECRET="your-cron-secret"

# Web Push (VAPID). Generate with: node scripts/generate-vapid-keys.mjs
VAPID_PUBLIC_KEY="your-vapid-public-key"
VAPID_PRIVATE_KEY="your-vapid-private-key"
VAPID_SUBJECT="mailto:contact@your-domain.example"

# Optional build-time max age (days) of the generated market-holiday table
# before `npm run build` regenerates it. Defaults to 30.
MARKET_HOLIDAYS_MAX_AGE_DAYS="30"

# Account storage backend: kv | dual | d1 (see "Account storage (D1)").
# d1 is the production default; dual is only for the transition.
AUTH_BACKEND="d1"
```

### Cloudflare Workers KV & Wrangler Setup

The application is configured in `wrangler.toml` with:
- `keep_vars = true` (to preserve dashboard environment variables upon CLI deployment)
- KV namespace bindings `KV` and `ticker_tracker_kv` pointing to ID `d6b4aa8e710d442d97e6c52b1027f92c`:

```toml
name = "ticker-tracker"
main = "custom-worker.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]
keep_vars = true

[assets]
directory = ".open-next/assets"
binding = "ASSETS"

[[kv_namespaces]]
binding = "KV"
id = "d6b4aa8e710d442d97e6c52b1027f92c"

[[kv_namespaces]]
binding = "ticker_tracker_kv"
id = "d6b4aa8e710d442d97e6c52b1027f92c"

[[d1_databases]]
binding = "DB"
database_name = "tickertracker-d1"
database_id = "4ff69e7d-4a6f-4c5c-ad2e-5bc97f788a66"
```

`main` points at `custom-worker.ts` so the scheduled alert scan can run
in-process (see [Scheduled scan](#scheduled-scan)).

### Google OAuth Configuration

In your Google Cloud Console OAuth Client configuration:
- **Authorized JavaScript origins**:
  - `https://your-domain.com`
  - `https://localhost:3000`
- **Authorized redirect URIs**:
  - `https://your-domain.com/api/auth/callback/google`
  - `https://localhost:3000/api/auth/callback/google`

---

## Test Suite

The project includes unit tests and an end-to-end Playwright test suite:

### Run Unit Tests (Node Test Runner + tsx)
```bash
npm run test:unit
```
Covers:
- Auth crypto utilities (PBKDF2 hashing, token signing and verification)
- KV storage adapter (get, put, list, delete with fallbacks)
- Stock catalog multimodal search by ticker, company label, and ISIN code
- Watchlist tickers ordering and `% diff` variance computation
- Account management (password update and account deletion)
- Yahoo Finance service and quote normalization
- `fetchJsonWithRetry()` retry policy (transient vs. deterministic failures, backoff, give-up behaviour)
- Cache policy for personalized routes: `next.config.mjs` header rules for `/ticker/:path*` (`private` + `no-store`, no `s-maxage`) and that static PWA assets stay cacheable
- Yahoo Finance client lifecycle: no module-scope instantiation, a single factory, exactly one client per batch, and a fresh client per single-quote call (guards the Workers cross-request promise race)
- Market status: session-derived open / just-closed / opens-soon / closed states, viewer-timezone clock formatting, and opening-day labels that follow the rendered timezone
- SEO crawl hygiene: canonical redirects for `http://` and the apex host, `robots.txt` rules, and the `noindex` header on `/api/` responses
- Request security: same-origin Origin/Referer enforcement (site, apex/www, preview, localhost; cross-site and malformed origins rejected) and the registration email-domain policy (reserved RFC 2606 domains, test artefacts and disposable providers)
- Registration route: reserved domain rejected without an account, real domain accepted, duplicate still 409, cross-site origin rejected, and the E2E bypass for `@example.com`

### Run End-to-End Tests (Playwright)
```bash
npm run test:e2e
```
Covers:
- Full user journey: registration, login, adding tickers by symbol and company label, tracking cost basis configuration, reordering tickers, viewing details and price history charts, password change, logout, re-authentication, and account deletion.
- Registration policy: the Playwright server sets `E2E=1`, so the existing `@example.com` accounts still pass while a real deployment enforces the email-domain policy.
- Multimodal search across tickers (`PUST`), company labels (`LVMH`, `AIRBUS`), and ISIN codes (`FR001400Q9V2`).
- Batch add: a mixed comma/semicolon list adds the valid symbols, reports the unknown one, updates the watchlist, and is reachable from the single-search modal; the guest path works through IndexedDB.
- Navigation and internationalization: privacy page, terms page, dynamic language switching across 6 locales, and footer verification (`Personal Page`, `Portfolio`).
- Price history resilience: transparent recovery when the details request fails on first open, correct loading state (never a premature "no chart points" message), non-empty `1MO` series on first render, and no chart bleed-through between two tickers.
- Ticker details full page: real route navigation, back arrow to the dashboard, deep-linking and reload survival, browser back button, per-symbol page metadata, range switching, and stable single-column mobile layout with no reflow.
- Cache privacy for the ticker page: `no-store` response headers, no personalized markers in the server-rendered HTML, a dynamic (never pre-rendered) route, and a Cache Storage inspection proving the Service Worker persists nothing under `/ticker/` or `/api/tickers`.
- Quote API concurrency: parallel batch requests, mixed parallel calls across every Yahoo-backed endpoint, and full symbol fan-out. Note this runs under Node and therefore cannot reproduce the Workers-only crumb race - see the request-scoped client note above.
- Quotes, sessions and market status: venue open / just closed / opens soon / closed badges, and a US opening displayed on a Paris viewer's clock with the exchange timezone in the tooltip.
- Search engine signals: `robots.txt` allow/disallow rules and sitemap reference, canonical URLs on the homepage and ticker pages, and the `noindex` header on API responses.

---

## Architecture & KV Caching

Yahoo Finance's unofficial endpoints are prone to IP rate limits and crumb expiration. To provide reliable performance and stay within free tier limits, Ticker-Tracker uses a multi-tier fallback architecture:

1. **Cloudflare KV / Local Store Cache**:
   - Live Quotes: cached for 30 seconds.
   - Autocomplete & Search: cached for 1 hour.
   - Historical Chart & Stats: cached for 10 minutes.
   - Degraded payloads are never cached: if the upstream returns an empty price series, the response is served without writing to KV so the next request retries the network instead of replaying a blank chart for the whole TTL window.
2. **Multi-Tier Fetching Engine**:
   - **Tier 1**: `yf.quote()` for real-time market metrics.
   - **Tier 2**: `yf.quoteSummary()` for fundamental valuation modules (`summaryDetail`, `defaultKeyStatistics`, `price`).
   - **Tier 3**: Direct Yahoo Finance Chart API (`query1.finance.yahoo.com/v8/finance/chart`) with browser headers.
   - **Tier 4**: Graceful stale-cache recovery if network requests are degraded.
3. **Client-Side Resilience**:
   - Details requests are issued through `fetchJsonWithRetry()`, which retries transient failures (`5xx`, `408`, `429`, network errors) up to 3 times with capped exponential backoff.
   - Deterministic client errors such as `404` fail fast instead of being retried.
   - This matters most on a cold cache (first open of a symbol, typically outside market hours) where Yahoo Finance is most likely to answer with a transient error. Previously a single failed response was rendered as "no chart points available" and the blank series was then cached, so the chart only recovered after manually switching range.
4. **Request-Scoped Yahoo Finance Client (Workers correctness)**:
   - `yahoo-finance2` memoises the Yahoo crumb promise inside the per-client cookie jar, so a **module-scope client is shared by every concurrent request in a Workers isolate**.
   - The request that created the promise resolves; the others await a promise belonging to an already torn-down request context. The runtime cancels their continuations, the handler never responds, and Cloudflare kills the request with HTTP 500 and `outcome: "exception"` ("code had hung and would never generate a response").
   - Ticker-Tracker therefore creates **one client per request** via `createYahooFinanceClient()`, threaded through the call chain so a 30-symbol batch still performs a single crumb fetch rather than thirty.
   - Cost: a cold request pays the crumb flow once (~1.3 s for a 28-symbol batch); subsequent requests are served from KV in ~25 ms, and no client is created at all when every symbol is still cached.
   - This race is invisible under Node, so the invariant is enforced by `tests/yahooClientLifecycle.test.ts` (no module-scope instantiation, single factory, one client per batch).
5. **Batched quote polling (background scans)**:
   - `getBatchQuotes()` is tuned for the interactive path: it caches one KV entry per symbol, which gives partial responses and a per-symbol stale fallback, at the cost of one KV write per symbol whose TTL expired.
   - Background consumers have the opposite constraints, so `getQuotesBatched()` issues **one `yf.quote([...])` request per 50 symbols** and performs **no KV read or write**. Prices are consumed in memory and discarded.
   - Quotes expose `dayHigh`/`dayLow` (intraday extremes of the current regular session) on top of `fiftyTwoWeekHigh`/`Low`, so a scan can detect a threshold touched between two runs even when the price already reverted.
6. **Freeze-frame ATH/ATL**:
   - `getAthlSnapshot()` calls `yf.chart(symbol, { range: 'max', interval: '1mo' })` once, when a user enables alerts on a ticker, and never on a schedule. The snapshot means *the ATH as it stood on the day alerts were enabled*, which is what the alert is defined against.
   - The in-progress monthly candle is dropped before computing the extremes. Keeping it would persist a reference equal to the current price, so the alert would fire the moment it is created.
   - The snapshot is cached in KV for 24h (to absorb repeated clicks, not to stay fresh) and falls back to the quote's 52-week high/low when the history is empty.

### Account storage (D1)

Accounts are the first relational data set moved out of KV. `users` lives in D1;
quotes, search, ATH/ATL and rates stay in KV as caches. The auth routes depend on
`UserRepository` (`src/lib/users.types.ts`) and never touch a binding directly:

| Adapter | Behaviour |
|---|---|
| `KvUserRepository` | `AUTH_BACKEND=kv`: the pre-migration two-key KV storage |
| `D1UserRepository` | `AUTH_BACKEND=d1`: SQL only |
| `DualWriteUserRepository` | `AUTH_BACKEND=dual`: writes D1 + KV, reads D1 with a KV fallback, lazily imports KV-only accounts |

`AUTH_BACKEND` is unset by default: the app uses `dual` when the `DB` binding is
present and `kv` otherwise, so local unit tests and deployments without D1 keep
working unchanged.

**Setup**

The production database is `tickertracker-d1` (already created). For a fresh
environment:

```bash
npx wrangler d1 create tickertracker-d1
# Copy the returned database_id into wrangler.toml
npx wrangler d1 migrations apply tickertracker-d1 --remote
npx wrangler d1 migrations apply tickertracker-d1 --local   # local dev + e2e
```

`initOpenNextCloudflareForDev()` in `next.config.mjs` exposes the local bindings
to `next dev`. The custom `.kv-local.json` fallback is only used when no binding
is available; with the OpenNext dev context, `next dev` uses the local KV/D1 in
`.wrangler/state`.

**Switch and contract**

The production KV namespace was empty when D1 shipped, so no backfill was needed.
The rollout was:

1. Verify a registration and a login on the deployed app.
2. Set `AUTH_BACKEND=d1` (already the production default in `wrangler.toml`).
3. If a previous deployment wrote legacy `user:*` KV keys, delete them after
   keeping an off-repository backup.

**Rollback**

While `AUTH_BACKEND=dual`, set it back to `kv` and redeploy: KV is still current.
After the contract phase, restore the KV backup or use D1 Time Travel.

`getSessionUser()` verifies that the account still exists in the repository
before accepting a signed cookie. A cookie issued before the account was deleted
(or before the storage migration) is therefore rejected on the next request
instead of surviving until its 30-day expiry.

The unique index `users_email_unique` is the actual guard against concurrent
duplicate registrations; the route maps the constraint error to `409` without a
read-before-write check. Tickers, alert state and push subscriptions are still in
KV and move in Phase 4 of `MIGRATION_STEPS.md`.

### Price-alert evaluation

Alerts are per-ticker and opt-in: each watchlist entry can carry an `alertHigh` and an `alertLow` threshold, expressed in `alertCurrency` (the listing currency unless the user picks another one). `evaluateAlerts()` in `src/lib/alerts.ts` is a pure function with no KV, network or clock dependency beyond the `now` argument:

- **Session extremes, not just the last price.** The upper rule compares `dayHigh` and the lower rule compares `dayLow`, so a spike that already reverted between two scans is still detected.
- **Edge-triggered with hysteresis.** After firing, that side stays disarmed until the price pulls back 1% past the threshold (or rebounds 1% for the lower side). A price oscillating around the threshold therefore produces one notification, not one per scan.
- **The first evaluation only arms.** Enabling an alert on a ticker that is already beyond the threshold stores that side disarmed, so the user is notified about the *next* crossing instead of instantly. This is also why a frozen ATH does not fire on creation.
- **FX-aware.** A threshold entered in EUR on a USD listing is converted with the EUR-based rates before comparison; when no rate is available the ticker is skipped and its arming state is preserved.
- **Cheap to persist.** The result reports `changed`, so the scanner only writes the arming state when a side actually flipped.

Thresholds and arming state live in two different KV keys on purpose. `user:tickers:${userId}` holds the definitions and is written only by the user's requests; `alert:state:${userId}` holds `{ highArmed, lowArmed, highTriggeredAt, lowTriggeredAt }` per ticker and is written only by the scanner. Sharing one key would make each side read-modify-write the other and silently lose updates. A change to either threshold, or to the threshold currency, deletes the ticker's state entry: the next scan then runs the first-evaluation path, arms against the live quote and its FX rate, and cannot notify at save time.

**Opt-in per ticker.** There is no bulk switch and no migration for existing accounts: each user has to open a ticker page and press *Enable price alerts* once for that ticker. The first activation calls `GET /api/tickers/athl`, prefills the two fields with the frozen ATH/ATL and saves immediately, so leaving the fields untouched keeps exactly those values. Editing a field marks that side as `custom`; clearing a field disables that side only.

The panel is rendered by `PriceAlertsSection` on `/ticker/[symbol]` and covers three states: guest (*sign in*), authenticated but not watching the symbol (*add it first*) and enabled (*edit / disable*). Covered by `e2e/price-alerts.spec.ts`.

### Scheduled scan

`runAlertScan()` (`src/lib/alertScan.ts`) is called **in-process** by the `scheduled` handler in `custom-worker.ts`. There is no HTTP round trip and no internal endpoint involved in the cron path: the handler injects its Worker bindings into the runtime (`setRuntimeEnv(env)`), runs the scan, then dispatches notifications (`dispatchAlertNotifications`). This removes the public surface and the `APP_URL` dependency from the scheduled path.

`POST /api/cron/alerts` (and `GET` for manual runs) still exists as an **ops-only** trigger. It fails closed: `503` when `CRON_SECRET` is missing, `401` when the signature is absent, expired or wrong. Authentication is a **timestamped HMAC**, not a static Bearer token: the caller signs `${timestamp}.${METHOD}.${path}` with `CRON_SECRET` (HMAC-SHA256, WebCrypto) and sends `x-cron-timestamp` + `x-cron-signature`. The signature is bound to the exact method and path and expires after five minutes; the scan's 4-minute lock makes a replay inside that window a no-op. Both the route and `scripts/trigger-alert-scan.ts` use `src/lib/cronAuth.ts`.

What one scan does:

1. Lists `user:tickers:*`, keeps the entries that opted into alerts and whose venue is inside a regular session at that instant. The timezone is read from the ticker (stored at add/alert time) and fed to `buildMarketSessions()`; no Yahoo call is made to decide whether a market is open. Unknown venues and futures are evaluated around the clock.
2. Requests the distinct symbols with `getQuotesBatched()`: one HTTP call per 50 symbols, no KV read or write.
3. Evaluates each ticker with `evaluateAlerts()` and writes `alert:state:${userId}` only when an arming side changed. A trigger that touches several tickers of the same user is one write.
4. For each symbol that triggered, writes `quote:<SYM>` with a 24h TTL. The interactive path only considers a quote fresh for 30s, so this is not a freshness cache: it keeps a correct tier-4 fallback for a user who opens the app hours after the notification.
5. Groups the events per user and sends one Web Push notification per user (`dispatchAlertNotifications`).

Cost for 50 tickers with alerts on open venues, 5-minute cadence (~105 scans/day): ~105 Yahoo requests, one lock write per active scan (none when every venue is closed, because the lock is taken after planning), ~0 further writes on a quiet day, and two writes per trigger (state + quote). Each scan also reads one watchlist key per account (`user:tickers:<id>`), so the read budget scales with the number of accounts, not with the number of tickers. `kvList()` returns at most one page (1,000 keys): beyond that, the scan would need pagination or a symbol-to-users index.

The trigger lives in `wrangler.toml` (`[triggers] crons = ["*/5 * * * *"]`). A non-atomic KV lock (`cron:alerts:lock`, 4 min TTL, never deleted) prevents a slow scan from stacking behind itself; it is only written once the plan is known to contain at least one open ticker, so nights and weekends cost zero writes. A duplicate remains harmless because the first run has already disarmed the side it fired.

Importing the scan into the custom worker bundles the data layer next to the generated worker: measured at ~+430 KiB gzip (2.09 → 2.46 MiB), still under the 3 MiB free-plan limit. If that headroom disappears, move the scan to a dedicated queue-consumer Worker and have `scheduled` only enqueue a message.

Required Worker configuration for push:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

`CRON_SECRET` is only needed for the manual trigger endpoint; the scheduled path does not use it. `APP_URL` is no longer required by the cron.

Manual run against a local worker:

```bash
CRON_SECRET=... APP_URL=http://127.0.0.1:8788 npm run cron:trigger
```

The helper (`scripts/trigger-alert-scan.ts`) signs the request with the same module as the route; a plain `curl` with the secret in a header does not work.

### Web Push delivery

When a scan triggers, `dispatchAlertNotifications()` groups the events by user and sends **one notification per user** (`buildAlertNotification`), listing up to three crossed tickers. A single event names the symbol, the threshold and the observed session extreme; clicking it opens `/ticker/<symbol>`. The scheduled handler and the manual route call the same function.

Delivery uses `@block65/webcrypto-web-push` (WebCrypto, RFC 8291 `aes128gcm` + RFC 8292 VAPID) rather than the classic `web-push` package, whose `https.request` dependency does not work on Workers. Subscriptions live in `push:subs:${userId}` (one key per account, up to 10 devices, de-duplicated by endpoint). A push service answer of `404`/`410` removes the endpoint; a transient `5xx`/`429` keeps it. Account deletion drops the key.

Generate the keys once:

```bash
node scripts/generate-vapid-keys.mjs
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # mailto:...
```

The browser subscribes from the alert panel (`enablePushNotifications()`), which requests the permission synchronously from the click so iOS keeps the user gesture, fetches the public key from `GET /api/push/subscribe`, then persists the subscription. `public/sw.js` owns the `push` and `notificationclick` handlers; `CACHE_NAME` is bumped to `v3` so existing installs pick them up.

Platform notes: Chrome, Edge and Firefox work on desktop and Android; Safari requires iOS 16.4+ **and** the PWA installed on the home screen — on a regular Safari tab `PushManager` is unavailable and the panel says so. Notification wording is currently English only, because the scan has no request context and therefore no locale.

Without VAPID keys the scan still runs and arms alerts; only delivery is skipped, so adding the keys later starts notifying without touching stored state.

Covered by `tests/alerts.test.ts` (session spikes, re-arming, first-evaluation arming, FX conversion and missing rates, one-sided configuration).

### Market holiday table

`date-holidays` is no longer a runtime dependency. It is used only by `scripts/generate-market-holidays.ts` (a devDependency) to produce `src/lib/marketHolidays.json`, which is committed:

```json
{
  "generatedAt": "2026-10-21",
  "coverage": { "from": 2026, "to": 2040 },
  "holidays": {
    "Europe/Paris": ["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "..."],
    "America/New_York": ["2026-01-01", "2026-01-19", "2026-02-16", "..."]
  }
}
```

At runtime `marketCalendar.ts` builds one `Set` per venue on first use and does a date lookup. There is no holiday computation, no network call and no KV access. The rules that feed the table (`ignoredHolidays`, `closedOn`, Good Friday, Easter Monday) stay in `MARKET_CALENDARS` and are consumed at generation time.

**Build check.** `npm run build` runs `scripts/ensure-market-holidays.ts` first. It regenerates the table only when:

- `coverage.to` no longer reaches next year, or
- `generatedAt` is older than `MARKET_HOLIDAYS_MAX_AGE_DAYS` (default `30`).

When regeneration produces identical holiday content, only `generatedAt` is refreshed and the build continues: a timestamp-only change is never a commit requirement. When the content actually changes (new rules, extended coverage), the file is written and a CI build fails so the regenerated table is committed before deploying; a local build only warns. Manual regeneration:

```bash
npm run generate:market-holidays
```

Early closes (half-days) and one-off closures (national mourning, weather) are not modelled, as before. Adding a venue means adding it to `MARKET_CALENDARS`, then regenerating.

Removing `date-holidays` also removes `moment`, `moment-timezone`, `astronomia` and `tldts` from the Worker: the bundle dropped from **2.46 MiB to 1.59 MiB gzip** on the current build. Covered by `tests/marketHolidays.test.ts` and the existing `tests/marketCalendar.test.ts`.

### Verifying the Workers behaviour locally

Node cannot reproduce the race, so validate against `workerd` after touching the Yahoo client:

```bash
npm run build                      # opennextjs-cloudflare build
npx wrangler dev --port 8788       # local workerd runtime

# Fire concurrent requests; all must answer 200. Before the fix, 2 of 3
# returned 500 and the log showed the cross-request promise warning.
for i in 1 2 3 4 5 6 7 8; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "http://127.0.0.1:8788/api/tickers/quote?symbols=AAPL,MSFT,NVDA,META,AMZN,GOOGL" &
done; wait
```

---

## API Endpoints

### Market & Tickers
- `GET /api/tickers/search?q={query}`: Search tickers across curated catalog and global exchanges.
- `GET /api/tickers/quote?symbols={AAPL,MC.PA,...}`: Fetch single or batch quotes with valuation multiples.
- `GET /api/tickers/details?symbol={symbol}&range={1mo}`: Retrieve historical chart time series and detailed statistics. Supported ranges: `1d`, `5d`, `1mo`, `6mo`, `1y`, `5y`.
- `GET /api/tickers/athl?symbol={symbol}`: Capture the all-time high and all-time low from the full monthly history, used to prefill price-alert thresholds. Excludes the in-progress candle, falls back to the 52-week range when no history is available, and caches the snapshot for 24h. Authenticated.
- `POST /api/cron/alerts`: Run the scheduled price-alert scan. Requires a timestamped HMAC signature (`x-cron-timestamp` + `x-cron-signature`) built with `CRON_SECRET`; returns counters only.
- `GET /api/rates`: EUR-based fiat exchange rates (cached 24h in KV) used for reference-value currency conversion.

### Pages
- `/`: Watchlist dashboard (quotes, valuation multiples, display modes, tracking targets).
- `/ticker/[symbol]`: Full-page ticker view — live price, trailing & forward P/E, 52-week range, price history chart, key statistics and the sell-side earnings consensus table. Deep-linkable, with a back-to-dashboard arrow in the header. Replaces the former centred details modal, which painted in two passes on mobile and reflowed once its data arrived. The content is rendered full-bleed: no outer card, border or rounded corners, so the space the modal's frame used to consume is reclaimed at the top, sides and bottom.

---

## Privacy & Caching of Personalized Routes

The ticker page renders per-user data: the **reference target (cost basis)**, the **personal notes** and a watchlist-derived quote. None of it may be retained by an intermediary. Four layers are pinned down:

1. **Resolution is client-side.** `TickerDetailsPage` re-reads its watchlist entry from `/api/tickers` (authenticated) or IndexedDB (guest) in the browser. The server-rendered shell therefore contains **no** personalized values, so even a hypothetically cached shell would stay user-agnostic.
2. **The route is forced dynamic.** `export const dynamic = 'force-dynamic'` and `export const revalidate = 0` prevent a future `generateStaticParams` or ISR window from turning the page into a shared artifact.
3. **Explicit response headers.** `next.config.mjs` sets `Cache-Control: private, no-store, max-age=0, must-revalidate` for `/ticker/:path*`. `private` additionally forbids shared/CDN caches. A `Vary: Cookie` header is deliberately *not* set: Next.js manages `Vary` itself and overwrites it, so it would be misleading.
4. **Service Worker network-only.** `public/sw.js` treats `/ticker/` and `/api/` as *personalized routes*: they are never read from **nor written to** Cache Storage. Previously every navigation was cached, which persisted the page on disk. `CACHE_NAME` was bumped to `v2` so existing installs purge those entries on activation, then to `v3` when the Web Push handlers were added.

Offline note: because `/ticker/` is deliberately not cached, opening it with no network shows the browser's offline state rather than a stale page. That is intentional — a cached page could replay another user's reference target on a shared device.

Guarded by `tests/tickerCachePolicy.test.ts` (config-level header assertions) and `e2e/ticker-cache-privacy.spec.ts` (runtime headers, absence of personalized markers in the SSR HTML, and a Cache Storage inspection proving nothing under `/ticker/` or `/api/tickers` is ever persisted).
Guarded by `tests/tickerCachePolicy.test.ts` (config-level header assertions) and `e2e/ticker-cache-privacy.spec.ts` (runtime headers, absence of personalized markers in the SSR HTML, and a Cache Storage inspection proving nothing under `/ticker/` or `/api/tickers` is ever persisted).

### Watchlist Management
- `GET /api/tickers`: Retrieve authenticated user's tickers enriched with quotes.
- `POST /api/tickers`: Add a ticker with tracking value baseline and optional notes.
- `POST /api/tickers/batch`: Add up to 25 tickers at once from a comma/semicolon/space-separated list. Returns `{ added, skipped, failed }`; one batched quote request validates the new symbols and the watchlist is written once.
- `PATCH /api/tickers`: Update tracking value, notes, or the two price-alert thresholds (`alertHigh`, `alertLow`, optional `alertCurrency`; `null` clears a side). Threshold changes delete the ticker's arming state so the next scan re-arms against the live quote.
- `DELETE /api/tickers?id={id}`: Remove a ticker and auto-compact order indices.
- `POST /api/tickers/reorder`: Persist custom ordering sequence of tickers.

### Push Notifications
- `GET /api/push/subscribe`: Return the VAPID public key and the number of subscribed devices. Authenticated.
- `POST /api/push/subscribe`: Persist a browser `PushSubscription` (idempotent per endpoint, up to 10 devices). Authenticated.
- `DELETE /api/push/subscribe?endpoint={endpoint}`: Remove one device. Authenticated.

### Authentication & Account
- `POST /api/auth/register`: Create user account with PBKDF2 password encryption.
- `POST /api/auth/login`: Authenticate email/password credentials and set HTTP-only signed session cookie.
- `GET /api/auth/me`: Retrieve currently authenticated user session.
- `POST /api/auth/logout`: Terminate active session and clear cookies.
- `GET /api/auth/google`: Initiate Google OAuth 2.0 authorization redirect.
- `GET /api/auth/callback/google`: Handle Google OAuth token exchange and session creation.
- `POST /api/auth/changepassword`: Change password with verification of existing password.
- `PATCH /api/auth/preferences`: Update the user's preferred reference currency (used for multi-currency tracking).
- `DELETE /api/auth/delete_my_account`: Permanently delete the account, its D1 row and the associated KV side data.