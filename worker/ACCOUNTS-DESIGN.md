# ANI-MATE accounts — design

**Status: design only. Nothing is built. 2026-11-07.**

Four decisions, all YASA's, all settled:

1. **Passwordless.** No password, no username, no email.
2. **Sync everything** — watch history, progress, favorites, settings.
3. **Optional.** The app works with no account exactly as it does today. Signing in only
   adds sync.
4. **No "Sign in with AniList."** Struck.

---

## Why passwordless is the engineering answer, not just a preference

Measured on Cloudflare's edge, 2026-11-07:

    PBKDF2 @ 100,000    ok
    PBKDF2 @ 310,000    NotSupportedError: iteration counts above 100000 are not supported
    PBKDF2 @ 600,000    same
    Argon2 native       absent (WASM only)
    getRandomValues     present
    timingSafeEqual     present
    HMAC-SHA256         present

OWASP's floor for PBKDF2-SHA256 is **600,000** and the platform stops at 100,000. Storing
human-chosen passwords here means storing them below current guidance, or bundling an Argon2
WASM module to work around a problem we do not have to have.

**Iteration count exists only to slow down guessing LOW-ENTROPY secrets.** A password is
guessable because a person chose it. A 256-bit random token is not. Going passwordless does
not dodge the limit, it makes the limit irrelevant.

It also suits what this app is. ANI-MATE streams from pirate sources, and an account row
reading `7f3a…` with no email, no username and no IP is a record with no person in it.

---

## The three secrets

| | size | lives | stored server-side as |
|---|---|---|---|
| **device token** | 32 bytes random | in the app, forever | SHA-256 hash |
| **recovery key** | 128 bits random | written down by the user | SHA-256 hash |
| **pairing code** | 6 digits | 5 minutes, one use | SHA-256 hash |

All three are high-entropy and server-generated, so a single SHA-256 is the correct hash —
there is no dictionary to run against them. Comparisons use `crypto.subtle.timingSafeEqual`.

**Recovery key format:** 26 characters of Crockford base32 (no `I`, `L`, `O`, `U`, so it
cannot be mis-transcribed), displayed in groups of four. 128 bits. Typable on a phone.

    K7M4-9XPQ-2WRB-H3ND-6YTF-5JCV-8A

---

## Schema

```sql
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
  label       TEXT,                        -- "Desktop", "Pixel 8" — user-editable
  platform    TEXT,                        -- electron | android
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX idx_devices_token ON devices(token_hash);

CREATE TABLE pairing_codes (
  code_hash   TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,  -- the code dies at 3, see below
  used_at     INTEGER
);

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
```

**Nothing here is a person.** No email column, no username column, no IP column, no user
agent. That is deliberate and should stay that way.

---

## Flows

### Create — there is no form

    app (first launch, user taps "Sync my stuff")
      -> POST /api/account
      <- { account_id, device_token, recovery_key }

The app stores `account_id` and `device_token` locally and shows the recovery key **once**,
with a copy button and plain words: *this is the only way back in if you lose your devices.
We cannot send it to you, because we do not know who you are.*

### Add a second device — pairing, the way a TV does it

    signed-in device:  POST /api/device/pair-code     -> { code: "418290", expires_in: 300 }
    new device:        POST /api/device/pair {code}   -> { account_id, device_token }

Six digits is only a million combinations, so three things guard it, and all three are
needed:

- **5 minute TTL**
- **single use** — `used_at` is set the moment it works
- **3 failed attempts and the code is dead**, tracked on the code row itself

That last one matters: the Worker's IP rate limiter can be sidestepped by rotating IPs, so
the lockout has to live on the code, not on the caller.

### Recover

    POST /api/account/recover { recovery_key }  -> { account_id, device_token }

Rate limited hard, and it issues a new device token rather than revealing the old ones.

### Sign out / manage devices

    GET    /api/devices       -> list, with label, platform, last_seen
    DELETE /api/devices/:id   -> revoke that one
    POST   /api/account/recovery-key  -> regenerate, invalidating the old one

### Delete the account

    DELETE /api/account   -> cascades everything, immediately

For an app like this, real deletion is a feature, not a checkbox.

---

## Sync

Pull-then-push, with server time as the clock.

    GET  /api/sync?since=<ms>   -> everything changed after that stamp
    POST /api/sync              -> a batch of local changes

Every syncable row has `updated_at` (assigned by the server, never by the client — clocks on
phones lie) and `deleted`. Conflicts resolve **last write wins**.

### ⛔ DELETES NEED TOMBSTONES OR THEY COME BACK

This is the bug every naive sync has. Remove a favorite on the desktop; the phone still has
it in its local list; the phone pushes; the favorite is back. It looks like the app ignored
you.

So a delete sets `deleted = 1` and `updated_at = now`. The row stays, the other device pulls
the tombstone and removes it locally. Tombstones are garbage-collected after 90 days, which
is far longer than any device will plausibly be offline.

### Progress is last-write-wins, deliberately

Tempting to keep the FURTHEST position instead. Wrong: rewatching a series would then be
impossible to record, because every update would lose to the old finish position. The latest
write is what the user actually did most recently.

---

## Security summary

| | |
|---|---|
| nothing to brute force | every secret is server-generated and high-entropy |
| the PBKDF2 cap is irrelevant | it only constrains password hashing, and there are no passwords |
| D1 holds hashes, never secrets | a dump of this database yields nothing usable |
| constant-time comparison | `crypto.subtle.timingSafeEqual`, confirmed present |
| pairing codes lock on 3 failures | on the code row, so rotating IPs does not help |
| rate limiting | already built and live |
| no PII | no email, no username, no IP, no analytics |
| deletion is real | `DELETE /api/account` cascades |

**Transport:** Workers are HTTPS-only. Tokens travel in `Authorization: Bearer`, never in a
query string, so they stay out of logs and out of URL history.

---

## Open, not yet decided

- **Device labels.** Auto-generated ("Desktop", "Pixel 8") or user-typed? Auto is less
  friction; typed is clearer on the device list.
- **Tombstone retention.** 90 days is a guess sized to "longer than a device stays offline",
  and it is the one number in here I have no measurement for.
- **What the UI calls this.** "Account" sets an expectation of email and password. "Sync"
  describes what it actually does.
