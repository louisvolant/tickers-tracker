-- Sign-in tracking for the administration dashboard.
--
-- Nullable so existing accounts keep their current row until their next login.
-- The type matches users.created_at exactly: Unix epoch in milliseconds
-- (Date.now()), not seconds and not an ISO string.
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
