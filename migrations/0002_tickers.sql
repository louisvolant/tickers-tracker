-- Watchlists move from the `user:tickers:<userId>` KV JSON array to relational
-- rows. Alert thresholds are part of the ticker (they are edited by the
-- watchlist API); the arming state that the scanner mutates stays in KV for now.
--
-- `quote_json` preserves the last known quote that the KV array used to carry,
-- so a transient Yahoo failure after the cutover still falls back to the same
-- data instead of showing an empty price.
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
  quote_json          TEXT,
  created_at          INTEGER NOT NULL
);

-- A user cannot watch the same symbol twice, even under concurrent adds.
CREATE UNIQUE INDEX tickers_user_symbol_unique ON tickers(user_id, symbol);
CREATE INDEX tickers_user_position_idx ON tickers(user_id, position);
CREATE INDEX tickers_alert_symbol_idx ON tickers(symbol)
  WHERE alert_high IS NOT NULL OR alert_low IS NOT NULL;

-- Marks a user whose KV watchlist has been imported. Without it, an empty D1
-- list cannot be distinguished from a not-yet-migrated user, and a lazy import
-- could resurrect tickers that the user deleted after the cutover.
CREATE TABLE ticker_migrations (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  migrated_at INTEGER NOT NULL
);
