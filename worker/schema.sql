-- ANI-MATE accounts schema
--
-- GENERATED FROM ACCOUNTS-DESIGN.md. Edit the design, re-extract; do not edit this by
-- hand or the two drift and the doc stops being true.
--
--     python3 -c "import re;print(re.search(r'```sql\n(.*?)```',open('ACCOUNTS-DESIGN.md').read(),re.S).group(1))" > schema.sql
--     wrangler d1 execute ani-mate-accounts --remote --file schema.sql
--
-- Nothing in here is a person: no email, no username, no IP, no user agent.
CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,      -- random, meaningless
  recovery_key_hash TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER                -- set on user-requested deletion
);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the bearer token
  label       TEXT,                        -- auto-generated on pair, user-editable
  platform    TEXT,                        -- electron | android
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX idx_devices_token ON devices(token_hash);

-- A CLAIM is a device asking to be let in. It carries no account_id at all: the row is
-- deleted at approval, and the account linkage lives on the devices row that creates.
--
-- ⚠ THE TABLE IS pairing_claims, NOT pairing_codes. The first cut of this design had a
-- pairing_codes table with `account_id NOT NULL` and an `attempts` counter, and that
-- shape cannot hold a claim: a claim has no account until someone approves it, and
-- SQLite cannot lift a NOT NULL constraint with ALTER TABLE. Giving the table the name
-- the design already uses meant this change needed no destructive migration at all --
-- the old table was created 2026-11-08, was never deployed to, and never held a row.
-- It is simply left behind, empty, until there is a reason to tidy it.
CREATE TABLE pairing_claims (
  code_hash   TEXT PRIMARY KEY,            -- SHA-256 of the 6 digits on the new device
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the token the NEW DEVICE generated
  platform    TEXT,
  label_hint  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_pairing_token ON pairing_claims(token_hash);

-- One table per synced kind. Every row carries updated_at and deleted; see SYNC.
CREATE TABLE watch (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  anime_id    TEXT NOT NULL,
  title       TEXT,
  title_english TEXT,
  episode     TEXT,
  position    REAL,          -- seconds into the episode
  duration    REAL,
  mode        TEXT,          -- sub | dub
  episodes_watched TEXT,     -- json array
  total_episodes   INTEGER,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, anime_id)
);
CREATE INDEX idx_watch_sync ON watch(account_id, updated_at);

CREATE TABLE favorites (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  anime_id    TEXT NOT NULL,
  title       TEXT,
  title_english TEXT,
  episodes    INTEGER,
  franchise_id TEXT,
  cover       TEXT,
  added_at    INTEGER,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, anime_id)
);
CREATE INDEX idx_favorites_sync ON favorites(account_id, updated_at);

CREATE TABLE settings (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,   -- prefer_english | autoplay | nsfw (quality stays on the device)
  value       TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);

-- ⛔ WATCH TIME IS A COUNTER, AND COUNTERS CANNOT BE LAST-WRITE-WINS.
-- Every other table here resolves conflicts by taking the newest write. Do that to a
-- running total and you DELETE TIME: the phone has 400 seconds for today, the desktop
-- has 900, the later push wins and the other number is simply gone.
--
-- So the device is part of the key. Each device owns its own row, only ever raises it,
-- and the account total is the SUM across devices. That is a G-Counter, and it is the
-- only shape that survives two devices watching on the same day without coordination.
--
-- The server also takes MAX(stored, incoming) rather than trusting the incoming number,
-- so a device whose localStorage is cleared restarts from zero locally without erasing
-- the history it already contributed.
-- ⚠ NO FOREIGN KEY ON THE TWO COUNTER TABLES, BECAUSE PRODUCTION HAS NONE. They were
-- created by migrations/0002-watch-time.sql, which declares account_id without one, and
-- this block used to declare one anyway: the file said one thing and the database
-- another (read from the production database on 2026-11-12). Nothing depends on it.
-- DELETE /api/account removes these rows by name, exactly because it does not trust a
-- cascade to do it.
CREATE TABLE watch_time (
  account_id  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  day         TEXT NOT NULL,   -- YYYY-MM-DD in the DEVICE's local time, see below
  seconds     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, day)
);
CREATE INDEX idx_watch_time_acct ON watch_time(account_id, day);

-- Same counter, same reasoning, sliced by genre instead of by day.
CREATE TABLE genre_time (
  account_id  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  genre       TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, genre)
);
CREATE INDEX idx_genre_time_acct ON genre_time(account_id);
