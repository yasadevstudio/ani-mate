-- ANI-MATE accounts — migration 0002: watch time and genre analysis
--
--     wrangler d1 execute ani-mate-accounts --remote --file migrations/0002-watch-time.sql
--
-- Purely additive: two new tables and two indexes. Nothing existing is touched.
--
-- ⛔ READ THIS BEFORE CHANGING THE PRIMARY KEY. device_id is in it because watch time is
-- a COUNTER, and last-write-wins on a counter deletes time: the phone has 400 seconds for
-- today, the desktop has 900, the later push wins and the other number is simply gone.
-- Per-device rows summed at read is a G-Counter, and it is the only arrangement that is
-- correct for two devices used on the same day with no coordination between them.

CREATE TABLE IF NOT EXISTS watch_time (
  account_id  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  day         TEXT NOT NULL,   -- YYYY-MM-DD in the DEVICE's local time
  seconds     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, day)
);
CREATE INDEX IF NOT EXISTS idx_watch_time_acct ON watch_time(account_id, day);

CREATE TABLE IF NOT EXISTS genre_time (
  account_id  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  genre       TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, genre)
);
CREATE INDEX IF NOT EXISTS idx_genre_time_acct ON genre_time(account_id);
