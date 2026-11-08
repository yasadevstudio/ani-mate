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

-- A CLAIM is a device asking to be let in. It exists before any account is attached,
-- which is why account_id is nullable here and NOT NULL everywhere else.
CREATE TABLE pairing_codes (
  code_hash   TEXT PRIMARY KEY,            -- SHA-256 of the 6 digits on the new device
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the token the NEW DEVICE generated
  platform    TEXT,
  label_hint  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_pairing_token ON pairing_codes(token_hash);

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
  key         TEXT NOT NULL,   -- prefer_english | autoplay | nsfw | quality | mode
  value       TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);

