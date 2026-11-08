-- ANI-MATE accounts — migration 0001: pairing codes become pairing CLAIMS
--
-- ⛔ NOT YET RUN AGAINST THE REMOTE. Run it with the deploy, not before:
--
--     wrangler d1 execute ani-mate-accounts --remote --file migrations/0001-pairing-claims.sql
--
-- WHY: the original pairing flow had the signed-in device mint a code and the new device
-- redeem it, guarded by "3 failed attempts and the code is dead, tracked on the code row".
-- That guard cannot fire. Measured 2026-11-08:
--
--     50,000 wrong guesses -> 0 rows found -> 0 attempts recorded
--
-- The lookup is `WHERE code_hash = sha256(guess)`, so a wrong code matches NO ROW and
-- there is nothing to increment. What was left was a 20-bit secret behind a 300-second
-- TTL — 3,333 req/s to sweep — guarded only by an IP bucket that Cloudflare counts PER
-- COLO and an attacker can spread across addresses.
--
-- The flow now runs the other way: the NEW device shows the code and a device that is
-- ALREADY SIGNED IN approves it, so the privileged call is the one carrying a real token
-- and there is no secret of yours left to guess. See ACCOUNTS-DESIGN.md.
--
-- ⚠ THE DROP IS SAFE ONLY BECAUSE THIS TABLE HAS NEVER HELD A ROW. It was created
-- 2026-11-08 and the endpoints that write it have never been deployed. Pairing codes are
-- 5-minute ephemera in any case, so even in service the worst outcome is "ask for a new
-- code". Verify before running:
--
--     wrangler d1 execute ani-mate-accounts --remote --command "SELECT COUNT(*) FROM pairing_codes"
--
-- Every other table is untouched. Do not widen this migration.

DROP TABLE IF EXISTS pairing_codes;

-- A CLAIM is a device asking to be let in. It exists before any account is attached,
-- which is why there is no account_id here at all: the row is deleted at approval and
-- the account linkage lives on the devices row the approval creates.
CREATE TABLE pairing_codes (
  code_hash   TEXT PRIMARY KEY,            -- SHA-256 of the 6 digits on the new device
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the token the NEW DEVICE generated
  platform    TEXT,
  label_hint  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_pairing_token ON pairing_codes(token_hash);
