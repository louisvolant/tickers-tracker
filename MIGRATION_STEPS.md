# D1 Migration Plan

**Status:** Phases 1–3 implemented (D1 schema, account repository, auth routes). The production KV namespace was empty, so no backfill was needed and the temporary endpoint was removed. The session existence check from Phase 5 is implemented; `session_version` remains pending. Phases 4 and 6 are pending.
**Scope:** move account data to Cloudflare D1 first; watchlists, alert state and push subscriptions in a second wave
**Non-goals:** changing the auth UX, adding email verification/password reset, moving market-data caches out of KV

> **Implementation note (2026-10-22):** `AUTH_BACKEND` defaults to `dual` as soon
> as the `DB` binding exists, rather than requiring an explicit dual-write deploy.
> Existing KV accounts keep logging in through the read fallback, new accounts are
> written to both stores, and the explicit backfill covers accounts that have not
> logged in since the deploy.
>
> **Deployment note (2026-10-22):** the live custom domain is
> `www.tickertracker.net`, attached to the Worker `tickers-tracker` (plural).
> `wrangler.toml` targets that name and sets `AUTH_BACKEND=d1`. The production KV
> namespace contained no user records, so the backfill was not needed.

---

## 1. Why

`kv.ts` is a cache adapter, not a database. It has no unique constraints, no
transactions and no query language, which is acceptable for quotes but not for
accounts. The current auth layer has four concrete defects:

| # | Defect | Where |
|---|---|---|
| 1 | Two concurrent registrations with the same email both pass the existence check | `src/app/api/auth/register/route.ts` |
| 2 | A user is written to two keys (`user:by-email:*`, `user:by-id:*`) with no atomicity; a failure between them leaves a half-created account | `register`, `callback/google` |
| 3 | `preferences` and `changepassword` read-modify-write both keys; concurrent writes can lose an update | `preferences/route.ts`, `changepassword/route.ts` |
| 4 | The signed session cookie stays valid after the account is deleted (it is only cleared on the client) | `src/lib/session.ts` |

D1 fixes 1–3 directly and enables a clean fix for 4.

---

## 2. Current state

### 2.1 KV key inventory

| Key | Value | Written by |
|---|---|---|
| `user:by-email:<email>` | `UserRecord` | auth routes |
| `user:by-id:<id>` | `UserRecord` (duplicate) | auth routes |
| `user:tickers:<userId>` | `UserTicker[]` | watchlist routes |
| `alert:state:<userId>` | `AlertStateMap` | alert scanner |
| `push:subs:<userId>` | `StoredPushSubscription[]` | push routes |
| `quote:<SYM>`, `search:*`, `details:*`, `athl:*`, `rates:eur` | caches | data layer |

`UserRecord` (`src/lib/types.ts`): `id`, `email`, `username`, `hashedPassword?`,
`googleId?`, `createdAt`, `preferredCurrency?`.

### 2.2 Auth routes to migrate

| Route | Current behaviour |
|---|---|
| `POST /api/auth/register` | check by email → write two keys → session |
| `POST /api/auth/login` | read by email → `verifyPassword` → session |
| `GET /api/auth/callback/google` | read by email → create or link `googleId` → session |
| `GET /api/auth/me` | verify cookie only |
| `PATCH /api/auth/preferences` | read by id → update both keys → re-sign cookie |
| `POST /api/auth/changepassword` | read by id (fallback email) → update both keys |
| `DELETE /api/auth/delete_my_account` | delete tickers/state/push/user keys |
| `POST /api/auth/logout` | clear cookie only |

### 2.3 Existing tests

`tests/account.test.ts` exercises KV directly. It must be rewritten around a
repository interface; the current `tests/user-journey.spec.ts` e2e already covers
register → login → change password → delete and will act as the integration net.

---

## 3. Target architecture

### 3.1 What moves to D1

- `users`
- (Phase 4) `tickers`, `alert_state`, `push_subscriptions`
- (Phase 5, optional) `session_version` column or a `sessions` table

### 3.2 What stays in KV

- `quote:<SYM>` — 30s interactive quote cache
- `search:*`, `details:*`, `athl:*` — API caches
- `rates:eur` — FX cache
- `cron:alerts:lock` — scan lock

KV remains the right tool for these: ephemeral, eventually consistent, cheap
reads, no relational constraints.

### 3.3 Phase 1 schema

```sql
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  username          TEXT NOT NULL,
  hashed_password   TEXT,
  google_id         TEXT,
  preferred_currency TEXT,
  created_at        INTEGER NOT NULL
);

-- Case-insensitive uniqueness without forcing the app to normalise on every read.
CREATE UNIQUE INDEX users_email_unique ON users(email COLLATE NOCASE);
CREATE UNIQUE INDEX users_google_id_unique ON users(google_id) WHERE google_id IS NOT NULL;
CREATE INDEX users_created_at_idx ON users(created_at);
```

`hashed_password` and `google_id` are nullable: a Google-only account has no
password, a password account has no Google id.

---

## 4. Principles

1. **Preserve user ids and PBKDF2 hashes.** Existing signed cookies contain the
   user id; keeping ids means no forced logout. Keeping the hash format means
   passwords keep working.
2. **Expand / contract, not big bang.** Add D1 alongside KV, backfill, switch
   reads, then remove KV writes.
3. **One repository interface.** Routes never touch `env.DB` directly; they call
   `UserRepository`. This makes the dual-write phase and the tests possible.
4. **No new bundle cost.** D1 is a binding, not a library.
5. **No secrets or personal data in logs.** Log route + error code only.
6. **Every phase is independently shippable and revertible.**

### Known gaps this migration does not fix

- **No email verification.** A password account can be created with an address the
  user does not own. Google linking by verified email can therefore attach a
  Google identity to an account created by someone else (or take it over). This
  is a pre-existing risk, out of scope here, but worth a dedicated hardening
  task.
- **No auth rate limiting.** Login/registration can be brute-forced. D1 makes an
  `auth_attempts` table easy later; it is not part of this plan.
- **No password reset.** Unchanged.
- **Session revocation is partial.** `getSessionUser()` now checks that the
  account exists, so a deleted account's cookie is rejected. Password changes do
  not yet invalidate other devices; that requires `session_version` (Phase 5).

---

## 5. Phase 0 — Prerequisites and decisions

- [ ] Decide rollout: zero-downtime dual-write (recommended) or maintenance
      window with a one-shot migration.
- [ ] Decide whether session revocation (Phase 5) ships with the account
      migration. Without it, a deleted account's cookie remains valid until
      expiry (30 days) even after Phase 3.
- [ ] Decide whether watchlists/alerts (Phase 4) are part of the same project or
      a follow-up.
- [ ] Choose the D1 primary location close to the main user base.
- [ ] Confirm the Workers plan includes D1 (it does on Paid: 25B rows read/month,
      50M rows written/month, 5 GB storage).
- [ ] Back up the current KV user keys before any deletion (see §12.3).

---

## 6. Phase 1 — D1 foundation

**Goal:** D1 exists, is bound to the Worker, has the `users` schema, and works in
local dev and in production. No auth route changes yet.

### 6.1 Create the database

```bash
npx wrangler d1 create tickertracker-d1
```

Add the binding to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "tickertracker-d1"
database_id = "<id returned by wrangler>"
```

### 6.2 Migration file

```bash
npx wrangler d1 migrations create tickertracker-d1 0001_users
```

Put the schema from §3.3 into
`migrations/0001_users.sql`.

Apply locally and remotely:

```bash
npx wrangler d1 migrations apply tickertracker-d1 --local
npx wrangler d1 migrations apply tickertracker-d1 --remote
```

### 6.3 Local development

`next dev` does not expose Worker bindings by default. Add to
`next.config.mjs`:

```js
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

initOpenNextCloudflareForDev();
```

This gives `getCloudflareContext().env.DB` under `next dev`, backed by the local
D1 in `.wrangler/state`. Keep the existing file-based KV fallback untouched for
now; it is orthogonal.

### 6.4 Smoke check

- [ ] `wrangler d1 execute tickertracker-d1 --local --command "SELECT 1"` works.
- [ ] `next dev` starts and a temporary debug route can read `env.DB`.
- [ ] `wrangler deploy --dry-run` shows the `DB` binding.
- [ ] No bundle-size regression (D1 is a binding).

**Acceptance:** schema applied locally and remotely; binding visible in
`wrangler deploy --dry-run`; no auth behaviour change.

---

## 7. Phase 2 — Repository and auth routes

**Goal:** all auth routes go through a `UserRepository`. Reads still come from KV
until Phase 3; the repository can be backed by KV, D1, or both.

### 7.1 Interface

`src/lib/users.ts`:

```ts
export interface NewUser {
  id: string;
  email: string;
  username: string;
  hashedPassword?: string;
  googleId?: string;
  preferredCurrency?: string;
  createdAt: number;
}

export class EmailAlreadyExistsError extends Error {}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  create(user: NewUser): Promise<UserRecord>;
  updatePreferredCurrency(id: string, currency: string | null): Promise<void>;
  updatePassword(id: string, hashedPassword: string): Promise<void>;
  linkGoogleAccount(email: string, googleId: string, username: string): Promise<UserRecord>;
  delete(id: string): Promise<void>;
}
```

### 7.2 Adapters

| Adapter | Purpose | Lifetime |
|---|---|---|
| `KvUserRepository` | current behaviour, used as the initial backend and rollback path | temporary |
| `D1UserRepository` | SQL implementation | permanent |
| `DualWriteUserRepository` | writes both; reads D1, falls back to KV | Phase 3 only |
| `MemoryUserRepository` | unit tests | permanent (tests) |

Files:

```
src/lib/users.ts              interface + errors + getRepository()
src/lib/users.kv.ts           KvUserRepository
src/lib/users.d1.ts           D1UserRepository
src/lib/users.dual.ts         DualWriteUserRepository (temporary)
tests/helpers/memoryUsers.ts  MemoryUserRepository
```

`getRepository()` resolves `env.DB` from `getCloudflareContext()` and falls back
to KV when the binding is absent (local dev, tests). The active backend can be
forced with `AUTH_BACKEND=kv|d1|dual` for the transition.

### 7.3 Route changes

- `register`: `create()` only. Catch `EmailAlreadyExistsError` → 409. No
  pre-check, so the race disappears.
- `login`: `findByEmail()`.
- `callback/google`: `linkGoogleAccount()` with a single SQL upsert
  (`INSERT ... ON CONFLICT(email) DO UPDATE SET google_id = COALESCE(users.google_id, excluded.google_id)`).
- `preferences`: `updatePreferredCurrency()` — one column update.
- `changepassword`: `findById()` + `updatePassword()`.
- `delete_my_account`: `delete()`; D1 cascade will handle tickers/state/push in
  Phase 4. Until then, keep the KV deletions.
- `me`: unchanged (cookie only) until Phase 5.

### 7.4 Tests

- [ ] Repository contract test run against `MemoryUserRepository` and local D1.
- [ ] Unique email: two `create()` calls → second throws `EmailAlreadyExistsError`.
- [ ] Google linking on an existing password account preserves the password hash.
- [ ] `preferences` and `changepassword` update one row (no two-key divergence).
- [ ] Existing e2e `user-journey.spec.ts` still passes.

**Acceptance:** routes only use the repository; behaviour is identical with the
KV adapter; D1 adapter passes the same contract tests.

---

## 8. Phase 3 — Data migration (expand / contract)

**Goal:** move existing users from KV to D1 without downtime or data loss.

### 8.1 Deploy dual-write

Deploy Phase 2 with `AUTH_BACKEND=dual`:
- every write goes to D1 **and** KV;
- every read goes to D1, falling back to KV when the row is missing.

This means new registrations during the migration are already in D1.

### 8.2 Backfill existing users

Temporary route `src/app/api/admin/migrate-users/route.ts`, protected by
`MIGRATION_SECRET` (Worker secret), removed after the migration:

```
POST /api/admin/migrate-users?dryRun=1   → counts only
POST /api/admin/migrate-users            → insert missing rows
```

Behaviour:
- list `user:by-email:*` (paginate; the current `kvList` returns one page of
  1,000 keys, so the route must page or the app must be under that limit);
- for each record, `INSERT OR IGNORE INTO users (...)`; normalise the email to
  lowercase; map missing optional fields to `NULL`;
- chunk writes in batches of ~50 with `env.DB.batch()`;
- return `{ scanned, inserted, skipped, failed }`;
- never log emails or hashes.

`INSERT OR IGNORE` makes the backfill idempotent: it can be re-run safely after
a partial failure.

### 8.3 Verify

- [ ] `SELECT COUNT(*) FROM users` equals the number of KV `user:by-email:*` keys
      (allow for pre-existing duplicates and log them).
- [ ] Spot-check 10 accounts: id, email, username, currency, Google id, password
      presence (not the hash).
- [ ] Login with a password account.
- [ ] Login with a Google account.
- [ ] `preferences` and `changepassword` work.
- [ ] Account deletion removes the row and cascades (Phase 4 tables once present).

### 8.4 Switch reads

Deploy `AUTH_BACKEND=d1`. The repository reads only D1; the KV fallback is still
present in code but no longer used.

### 8.5 Contract

After a soak period (recommended: one week):

- remove `KvUserRepository` and `DualWriteUserRepository`;
- remove `AUTH_BACKEND` and the KV fallback;
- delete the `user:by-email:*` / `user:by-id:*` keys (keep the backup, §12.3);
- remove the temporary migration route and `MIGRATION_SECRET`;
- update the README and this plan.

**Acceptance:** all auth traffic uses D1; KV contains no user records; no route
references `user:by-email:` or `user:by-id:`.

---

## 9. Phase 4 — Watchlists, alerts and push (second wave)

**Goal:** remove the array-in-KV watchlist and let the scanner query D1 directly.

> **Implementation note (2026-10-30):** the `tickers` table,
> `ticker_migrations` marker, `WatchlistRepository` (KV/D1/dual), the
> KV → D1 backfill/verifier and the D1-backed scanner are implemented.
> `alert_state` and `push_subscriptions` remain in KV: they are operational
> per-user data, not watchlist definitions, and can move in a follow-up without
> touching the row ids or the API contract.

### 9.1 Schema

```sql
CREATE TABLE tickers (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol              TEXT NOT NULL,
  name                TEXT NOT NULL,
  tracking_value      REAL,
  tracking_currency   TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  position            INTEGER NOT NULL,
  alert_high          REAL,
  alert_low           REAL,
  alert_currency      TEXT,
  alert_high_source   TEXT,
  alert_low_source    TEXT,
  alert_set_at        INTEGER,
  exchange_timezone   TEXT,
  created_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX tickers_user_symbol_unique ON tickers(user_id, symbol);
CREATE INDEX tickers_user_position_idx ON tickers(user_id, position);
CREATE INDEX tickers_alert_symbol_idx ON tickers(symbol)
  WHERE alert_high IS NOT NULL OR alert_low IS NOT NULL;

CREATE TABLE alert_state (
  ticker_id          TEXT PRIMARY KEY REFERENCES tickers(id) ON DELETE CASCADE,
  high_armed         INTEGER NOT NULL DEFAULT 1,
  low_armed          INTEGER NOT NULL DEFAULT 1,
  high_triggered_at  INTEGER,
  low_triggered_at   INTEGER
);

CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
```

### 9.2 Migration

- Read each `user:tickers:<id>` array and insert rows, preserving `id`, order and
  alert fields.
- Read `alert:state:<id>` and insert one row per ticker.
- Read `push:subs:<id>` and insert rows, de-duplicated by endpoint.
- Preserve `id` values: the API and e2e tests address tickers by id.
- Backfill with the same temporary admin route pattern, idempotent
  (`INSERT OR IGNORE`).

### 9.3 API and scanner

- `GET/POST/PATCH/DELETE /api/tickers` keep the same JSON contract; only the
  storage changes.
- Reorder becomes `UPDATE tickers SET position = ? WHERE id = ?` in a batch.
- The alert scanner replaces `kvList('user:tickers:')` + per-user reads with one
  query:

```sql
SELECT t.*, s.high_armed, s.low_armed, s.high_triggered_at, s.low_triggered_at
FROM tickers t
LEFT JOIN alert_state s ON s.ticker_id = t.id
WHERE t.alert_high IS NOT NULL OR t.alert_low IS NOT NULL;
```

- The open-market filter still runs in code (timezone from `exchange_timezone`).
- Quote cache stays in KV.
- Confirm that foreign keys are enforced (`PRAGMA foreign_keys` is on by default
  in D1) and add a test for the cascade: deleting a user removes their tickers,
  alert state and push subscriptions. If enforcement is off in a given
  environment, delete the child rows explicitly in a `batch()`.

### 9.4 Acceptance

- [ ] A user can add, edit, reorder and delete tickers; the API response shape is
      unchanged.
- [ ] Duplicate symbol per user is rejected by the unique index.
- [ ] The scanner finds alerts with one query and no `kvList`.
- [ ] Deleting a user cascades tickers, state and push subscriptions.
- [ ] `e2e/price-alerts.spec.ts` and `e2e/user-journey.spec.ts` pass.

---

## 10. Phase 5 — Session revocation (optional, recommended)

**Status (2026-10-22):** the existence check is implemented in
`getSessionUser()`: a signed cookie is rejected when its account no longer exists
in the repository. The `session_version` part (password change / log out
everywhere) is still pending.

**Goal:** a deleted account, a changed password or "log out everywhere" invalidates
existing cookies.

### Option A — `session_version` (small)

```sql
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;
```

- Include `sessionVersion` in the signed cookie payload.
- `getSessionUser()` reads the user and compares the version (one indexed read
  per authenticated request).
- Increment on password change and on "log out everywhere".
- Account deletion removes the row, so the check fails.

### Option B — `sessions` table (more control)

- `sessions(id, user_id, created_at, expires_at, user_agent)`;
- the cookie carries a session id;
- allows per-device revocation and a device list in account settings.

Option A is enough for this app. The cost is one D1 read per authenticated
request; PBKDF2 already dominates login, and quote reads dominate the dashboard.

---

## 11. Testing strategy

| Layer | What | How |
|---|---|---|
| Unit | repository contract, unique email, Google linking, updates | Node test runner + `MemoryUserRepository` |
| SQL | schema constraints and upserts | local D1 via `wrangler d1 execute --local` or a Miniflare-backed test |
| Integration | routes against local D1 | `next dev` with `initOpenNextCloudflareForDev()` + Playwright API calls |
| E2E | full journey | existing `e2e/user-journey.spec.ts` + `e2e/price-alerts.spec.ts` |
| Migration | backfill idempotency | run the admin route twice; counts must not change |

CI must apply local migrations before e2e:

```json
"test:e2e": "wrangler d1 migrations apply tickertracker-d1 --local && playwright test"
```

Add one concurrency test: two simultaneous registrations with the same email →
one `201`, one `409` (or a unique-constraint error mapped to `409`).

---

## 12. Deployment and rollback

### 12.1 Deploy order

1. Phase 1 (schema + binding) — no behaviour change.
2. Phase 2 (repository + routes, KV backend) — no behaviour change.
3. Phase 3a (dual-write) — D1 and KV stay in sync.
4. Phase 3b (backfill) — idempotent.
5. Phase 3c (D1 reads only).
6. Phase 3d (remove KV fallback/writes, after soak).
7. Phase 4 (tickers/alerts) in its own release.
8. Phase 5 (session revocation) in its own release.

### 12.2 Rollback

- **Before 3d:** set `AUTH_BACKEND=kv` or revert the deployment; KV is still
  current thanks to dual-write.
- **After 3d:** restoring KV requires the backup from §12.3; D1 can be restored
  with Time Travel. Do not delete the KV backup until the soak period is over.
- Migrations are additive; do not drop tables as part of a rollback.

### 12.3 KV backup

Before deleting any `user:*` key, export them:

```bash
# 1. List the keys (paginate if you have more than 1,000 users).
npx wrangler kv key list --binding KV --prefix "user:" > user-keys.json

# 2. Export every value, one JSON document per line, outside the repository.
#    A short script looping over the keys is preferable to shell quoting.
npx wrangler kv key get --binding KV "<key>" >> user-values.jsonl
```

Keep the export outside the repository (it contains personal data). Delete it
once D1 is confirmed stable.

---

## 13. Observability

- Log the route, the D1 error code and `meta.rows_read` / `meta.rows_written` on
  failures. Never log emails, hashes or session tokens.
- Add a one-off verification query after backfill; do not leave an admin route
  exposed.
- Cloudflare dashboard → D1 → Metrics for rows read/written; auth should stay in
  the noise.
- Watch login error rates and `409` rates during the transition.

---

## 14. Checklist

### Phase 1
- [ ] D1 database created, binding added to `wrangler.toml`
- [ ] `0001_users.sql` applied locally and remotely
- [ ] `initOpenNextCloudflareForDev()` added to `next.config.mjs`
- [ ] `wrangler deploy --dry-run` shows `env.DB`
- [ ] No bundle regression

### Phase 2
- [ ] `UserRepository` interface and adapters
- [ ] All auth routes use the repository
- [ ] Memory + D1 contract tests
- [ ] Unique email test
- [ ] Existing e2e passes

### Phase 3
- [ ] Dual-write deployed
- [ ] Backfill run twice, counts stable
- [ ] Counts and spot checks match
- [ ] D1 reads deployed
- [ ] Soak period completed
- [ ] KV user keys deleted, backup kept
- [ ] Migration route and secret removed

### Phase 4
- [ ] `tickers`, `alert_state`, `push_subscriptions` schema
- [ ] Backfill idempotent
- [ ] API contract unchanged
- [ ] Scanner uses one SQL query
- [ ] Cascades tested

### Phase 5
- [ ] `session_version` (or `sessions`) implemented
- [ ] Password change invalidates other sessions
- [ ] Deleted account invalidates cookies

---

## 15. Open questions

1. Zero-downtime dual-write or a short maintenance window?
2. Does session revocation ship with this migration, or later?
3. Are watchlists/alerts in the same project, or a follow-up?
4. Which D1 primary location?
5. How long do we keep the KV user backup (one week? one month?)?
6. Do we want email verification / password reset next, or keep scope tight?

---

## 16. Phase 6 — SEO, sitemap and crawlability (independent of D1)

This phase has no dependency on the D1 migration and can ship in parallel. Note
that two of the requested items already exist as generated Next.js routes:

- `src/app/sitemap.ts` → `/sitemap.xml`
- `src/app/robots.ts` → `/robots.txt`

The work is therefore to **complete and verify** them, not to create them from
scratch. The current sitemap only contains `/`, `/privacy` and `/terms`; the
ticker pages are absent, and the metadata is only partially filled.

### 16.1 Sitemap

- [ ] Keep `/`, `/privacy`, `/terms`.
- [ ] Add public ticker pages from the curated catalog, never from a user's
      watchlist:

```ts
import { STOCK_CATALOG } from '@/lib/stockCatalog';

const tickerUrls = STOCK_CATALOG.map((item) => ({
  url: `${baseUrl}/ticker/${encodeURIComponent(item.symbol)}`,
  lastModified: new Date(),
  changeFrequency: 'daily' as const,
  priority: 0.8,
}));
```

- [ ] Never include `/api/`, `/ticker/` pages discovered only from a personal
      watchlist, or any URL containing a user id.
- [ ] Use `getSiteUrl()` for the origin (already done) so the domain follows
      `NEXT_PUBLIC_APP_URL`.
- [ ] Keep the number of URLs under the 50,000 sitemap limit; if the catalog
      grows beyond that, split into a sitemap index.
- [ ] Verify with `curl -s https://www.tickertracker.net/sitemap.xml` and in Google
      Search Console.

### 16.2 Robots

- [ ] Explicitly allow the public pages: `/`, `/ticker/`, `/privacy`, `/terms`.
- [ ] Disallow `/api/` and keep the sitemap reference.
- [ ] Do not disallow `/ticker/`: the page shell is user-agnostic (personal data
      is resolved client-side), so it is safe to index.
- [ ] Verify with `curl -s https://www.tickertracker.net/robots.txt`.

### 16.3 Metadata

- [ ] Homepage: `alternates.canonical`, `openGraph.url`, `twitter.card` and a
      populated `openGraph.images`.
- [ ] Ticker pages: extend `generateMetadata` in
      `src/app/ticker/[symbol]/page.tsx` with a canonical URL, `openGraph` and
      `twitter` overrides per symbol.
- [ ] Add a dedicated **1200×630** social image instead of the 512×512 icon
      (`public/og-image.png` or a dynamic `opengraph-image.tsx` with
      `next/og`). Switch `twitter.card` to `summary_large_image`.
- [ ] Add Google Search Console verification through
      `metadata.verification.google`, fed by a `GOOGLE_SITE_VERIFICATION`
      environment variable (never hardcoded).
- [ ] Keep `metadataBase` on `www.tickertracker.net` (already done).
- [ ] Check that every public page has a unique `<title>` and a useful
      `<meta name="description">`.

### 16.4 Structured data

- [ ] Homepage: `WebSite` + `Organization` JSON-LD (name, url, logo). Do not add
      a `SearchAction` unless a real query-string search route exists.
- [ ] Ticker pages: `BreadcrumbList` (Home → Ticker → SYMBOL). Keep the payload
      public and user-agnostic.
- [ ] Do not inject prices or personal data into JSON-LD: they change constantly
      and could conflict with the visible page.
- [ ] Validate with the Rich Results Test.

### 16.5 Crawlable ticker content

The ticker page is client-personalized: the server shell contains no personal
data, but the main content is rendered client-side. Google renders JavaScript,
but other crawlers may only see the shell.

- [ ] Add a public, server-rendered summary (symbol, name, exchange, 52-week
      range) or a `<noscript>` fallback, without any user data.
- [ ] Keep the personalized blocks (reference target, notes, alerts) client-only.
- [ ] Ensure exactly one `<h1>` per page and descriptive link text.

### 16.6 Performance and Core Web Vitals

- [ ] Code-split the chart: `recharts` is imported statically by
      `TickerDetailsPage`; load the chart component with `next/dynamic` to keep
      it out of the initial bundle.
- [ ] Give chart and image containers explicit dimensions to avoid layout shift
      (CLS).
- [ ] Keep the quote cache and the 30-second refresh; do not add blocking
      requests on first paint.
- [ ] Consider a smaller chart library or a server-rendered sparkline if
      `recharts` remains the largest client dependency.
- [ ] Remove `maximumScale: 1` and `userScalable: false` from the viewport
      config (`src/app/layout.tsx`): preventing zoom hurts accessibility and is
      penalised by Lighthouse.

### 16.7 PWA manifest

- [ ] Add `id`, `scope`, `lang`, `categories` and, if possible, `screenshots`
      to `public/manifest.json`.
- [ ] Keep `start_url: "/"` and the existing icons; add a maskable 512×512 icon
      if the current one is not safe-zone compliant.

### 16.8 Internationalization

- [ ] The locale is client-side (cookie/localStorage) and there are no
      `/[locale]` URLs, so `hreflang` is not applicable today. Do not emit
      misleading `alternates.languages`.
- [ ] Update `document.documentElement.lang` when the user switches language
      (accessibility and crawler hints).
- [ ] If multilingual SEO becomes a goal, introduce localized routes first, then
      `hreflang`.

### 16.9 Tests and monitoring

- [ ] Unit test `sitemap()` and `robots()`: expected URLs, ticker entries,
      sitemap reference, `/api/` disallow.
- [ ] E2E test the rendered `<head>`: canonical, `og:title`, `og:image`,
      `twitter:card`, JSON-LD, and the `/robots.txt` + `/sitemap.xml` responses.
- [ ] Submit the sitemap in Google Search Console and Bing Webmaster Tools.
- [ ] Check the PageSpeed Insights / Lighthouse SEO and accessibility scores
      after deployment.
- [ ] Re-run the checks after the D1 migration (no URL or header regressions).

### 16.10 Definition of done

- [ ] `/sitemap.xml` lists the public pages and the curated ticker pages.
- [ ] `/robots.txt` allows public pages, disallows `/api/`, references the
      sitemap.
- [ ] Every public page has a canonical, a unique title/description and OG/Twitter
      metadata.
- [ ] Homepage and ticker pages expose valid JSON-LD.
- [ ] The ticker page has a crawlable public summary.
- [ ] Lighthouse SEO ≥ 95, accessibility ≥ 90 on mobile.
- [ ] Search Console shows the sitemap as processed without errors.

