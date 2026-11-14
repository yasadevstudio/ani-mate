-- ANI-MATE accounts — migration 0001: pairing CLAIMS
--
--     wrangler d1 execute ani-mate-accounts --remote --file migrations/0001-pairing-claims.sql
--
-- ⚠ THIS MIGRATION DESTROYS NOTHING. It adds one table and one index. The now-unused
-- `pairing_codes` table is left exactly where it is, empty, because there is no reason to
-- remove it in the same breath as shipping a feature. Tidy it later, deliberately.
--
-- WHY A NEW TABLE RATHER THAN AN ALTERED ONE: the original pairing_codes had
-- `account_id TEXT NOT NULL` and an `attempts` counter. A claim has no account until
-- someone approves it, and SQLite cannot lift a NOT NULL constraint with ALTER TABLE, so
-- the old shape cannot hold the new row no matter what is added to it. The design already
-- calls these claims; the table now says so too, and the rename is what let this be an
-- additive migration instead of a drop.
--
-- WHY THE FLOW CHANGED AT ALL — measured 2026-11-08, not reasoned about:
-- the design's own guard ("3 failed attempts and the code is dead, tracked on the code
-- row") cannot fire. The lookup is `WHERE code_hash = sha256(guess)`, so a wrong code
-- matches NO ROW and there is nothing to increment:
--
--     50,000 wrong guesses -> 0 rows found -> 0 attempts recorded
--
-- That left a 20-bit secret behind a 300-second TTL (3,333 req/s to sweep the space)
-- guarded only by an IP bucket Cloudflare counts PER COLO. The flow now runs the other
-- way: the NEW device shows the code and a device that is ALREADY SIGNED IN approves it,
-- so the privileged call carries a real token and there is no secret of yours left to
-- guess. See ACCOUNTS-DESIGN.md.

CREATE TABLE IF NOT EXISTS pairing_claims (
  code_hash   TEXT PRIMARY KEY,            -- SHA-256 of the 6 digits on the new device
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the token the NEW DEVICE generated
  platform    TEXT,
  label_hint  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_token ON pairing_claims(token_hash);
