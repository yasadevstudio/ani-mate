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

⚠ **The pairing code is NOT a credential and holding it grants nothing.** See the pairing
flow — it is displayed by the device that wants IN and typed into a device that is already
signed in, so the privileged call is the one carrying a real token. That is what makes six
digits safe; it was not safe in the first version of this document.

All three are high-entropy, so a single SHA-256 is the correct hash — there is no
dictionary to run against them.

**On constant-time comparison, precisely:** lookups are `WHERE token_hash = ?` on an
indexed column, which SQLite does not promise to do in constant time. That is fine and is
not papered over with a `timingSafeEqual` call that compares a value to itself: what an
index-timing oracle could leak is information about a stored **SHA-256**, and SHA-256 is
preimage resistant, so it does not yield the token. `timingSafeEqual` is used where a
secret is genuinely compared in application code, and nowhere else, so that reading this
code tells the truth about what is protecting what.

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
```

**Nothing here is a person.** No email column, no username column, no IP column, no user
agent. That is deliberate and should stay that way.

---

## Flows

### Create — there is no form

    app (first launch, user taps "Sync my stuff")
      -> POST /api/account
      <- { account_id, device_token, recovery_key }

The app stores `account_id` and `device_token` locally, names itself (see below), and shows
the recovery key **once**,
with a copy button and plain words: *this is the only way back in if you lose your devices.
We cannot send it to you, because we do not know who you are.*

### Naming a device

The device labels itself on creation and on pairing, so the list is readable before anyone
touches a setting:

| platform | label |
|---|---|
| Electron | `Desktop` / `Desktop (2)` if that name is taken on the account |
| Android | the device model where the WebView reports it, else `Phone` |

`PATCH /api/devices/:id` renames it. Auto for zero friction, editable because only the owner
knows which Pixel is which.

### Add a second device — the TV flow, and it runs in the direction that is safe

The new device generates its own 32-byte token, asks for a claim, and shows six digits.
Those six digits are typed into a device that is **already signed in**:

    new device:        POST /api/device/claim      Bearer <token it just generated>
                                                -> { code: "418290", expires_in: 300 }
                       GET  /api/device/claim      Bearer <same token>
                                                -> 202 { status: "pending" }      (poll)
                                                -> 200 { account_id, device_id, label }
                                                -> 404  the code expired unapproved

    signed-in device:  POST /api/device/approve    Bearer <its existing device token>
                       { code: "418290" }       -> { status: "approved", label }

On approval the server creates the device row with the token hash the new device supplied,
and deletes the claim. The new device's next poll finds itself authenticated and already
holds its token. **The token is never sent back over the wire and never stored in the
clear.**

#### ⛔ WHY NOT THE OBVIOUS DIRECTION — AND WHY THIS DOCUMENT USED TO BE WRONG

The first version of this design had it the other way around: the signed-in device asks
for a code, the new device redeems it. It named three guards, and the load-bearing one
**could not fire**, measured 2026-11-08:

    50,000 wrong guesses -> 0 rows found -> 0 attempts recorded

The lookup is `WHERE code_hash = sha256(guess)`. A wrong guess matches **no row**, so
there is nothing to increment and "3 failed attempts and the code is dead" never happens
for a single wrong code. What was left was a 20-bit secret (10^6) behind a 300-second TTL
— **3,333 requests/second to sweep the space** — guarded only by an IP bucket that
Cloudflare counts **per colo** and an attacker can spread across addresses.

Reversing the direction deletes the question. In this flow a stranger guessing codes at
`/api/device/approve` must present **their own valid device token**, and a correct guess
attaches *someone else's new device to the attacker's own account* — no access to
anything of yours. There is no server-side secret of yours left to guess, so there is no
counter to get right.

⚠ **The lesson is the one already written into this Worker's rate limiter: a risk you have
NAMED is not a risk you have HANDLED.** Both documents said "3 attempts and it dies" and
both were describing code that could not do it. Sizing a limiter against a weak secret is
worse than restructuring so the secret stops being load-bearing.

What is left, and it is the same in every pairing scheme ever built: someone can talk you
into approving a code that is not yours. That is social engineering, not brute force, so
the approve screen names the platform and label of what is asking to join.

### Recover

    POST /api/account/recover { recovery_key }  -> { account_id, device_token }

Rate limited hard, and it issues a new device token rather than revealing the old ones.

### Sign out / manage devices

    GET    /api/devices          -> list, with label, platform, last_seen
    PATCH  /api/devices/:id      -> rename it
    DELETE /api/devices/:id      -> revoke that one
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
the tombstone and removes it locally. Tombstones are garbage-collected after **180 days**.

The asymmetry matters: a tombstone kept too LONG costs a few rows, while one expired too
EARLY means a device offline past the window never learns about the delete and resurrects
it. When in doubt, keep it longer.

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
| pairing codes cannot be brute forced | the privileged call is `approve`, which needs a real token; guessing a code gains an attacker nothing of yours |
| rate limiting | already built and live |
| no PII | no email, no username, no IP, no analytics |
| deletion is real | `DELETE /api/account` cascades |

**Transport:** Workers are HTTPS-only. Tokens travel in `Authorization: Bearer`, never in a
query string, so they stay out of logs and out of URL history.

---

## Settled, 2026-11-07 19:11

- **Device labels are AUTO-GENERATED AND EDITABLE.** The device names itself on first
  contact so the list is never full of "Unknown device", and the user can rename it. Auto
  for zero friction, editable because only the owner knows which Pixel is which.
- **Tombstone retention is 180 DAYS.** His number. Twice what I guessed, and the direction
  that is actually safe: a tombstone expiring too EARLY is the failure mode, because a
  device offline longer than the window never learns about the delete and silently
  resurrects it on its next push.
- **The UI calls it SYNC, never "Account".** "Account" promises an email field, a password
  field and a forgot-password link, and all three are things this design deliberately does
  not have. "Sync" describes what it actually does. The button reads **Sync my stuff**, the
  settings section reads **Sync**, and the recovery key screen is **Sync recovery key**.

---

## The client half, built 2026-11-08

    server/ani-mate-sync.js          the engine + the record translation. ONE copy.
    ui/ani-mate-ui.html              desktop panel, adapter over /sync/local
    server/ani-mate-server.js        /sync/local GET+POST, /ani-mate-sync.js, /sync/config.js
    mobile/www/js/ani-mate-sync.js   the same engine, copied by `npm run sync:shared`
    mobile/www/js/ani-mate-sync-ui.js  phone panel, adapter over window.Storage

**One engine, two adapters.** The engine knows nothing about where a favorite lives; the
desktop's adapter calls the local Node server because that is where its JSON files are,
and the phone's calls `window.Storage` because that is where its Capacitor files are.

**The record translation is in the engine, not in either adapter.** Measured: the
desktop's history entry and the phone's are field for field identical, down to
`playback_episode` being nulled when an episode finishes. So `shape.watchToSync` and
friends live in the shared file, and the Node server `require()`s them. Writing that
mapping twice is how `position` comes to mean the resume point on one device and the
last-played episode on the other.

### ⛔ NEITHER APP TRACKS WHICH ROWS IT CHANGED

There is no dirty flag on a favorite in either store and adding one meant hooking every
mutation in two codebases. So the engine keeps **its own** record of what it last saw
(`seen`: id -> content hash) and diffs against that. A row in `seen` that is gone from
the local store is a local delete and becomes a tombstone.

Two consequences, both load-bearing:

- **The push is a full snapshot, so it MUST follow a successful pull.** Pushing a stale
  snapshot resurrects whatever another device just deleted. The engine refuses to push if
  the pull failed.
- **The server ignores a push of unchanged content.** Every upsert carries
  `WHERE <row> IS NOT excluded.<row>`. Without it, one device syncing would re-stamp every
  row it owns and the other would re-download the whole account on every pull, forever.
  `IS NOT` rather than `!=` because `NULL != NULL` is NULL, which is falsy, which would
  make every row with an empty column look changed every time.

### What does NOT sync, and why

`quality` only. It is the one preference about the hardware and the connection rather than
the person: pushing a desktop's 1080p onto a phone on cell data is a bug wearing a
feature's clothes. `prefer_english`, `autoplay` and `nsfw` all cross, under the
localStorage keys both apps already used.

### Tested 2026-11-08, against a local D1 through `wrangler dev`

    65/65   the API, including every refusal path, cross-account isolation,
            and that RL_AUTH actually fires
    29/29   two simulated devices converging, including the resurrection case
    23/23   the real desktop page in a browser, driven through its own panel
    21/21   the real mobile page at 360px, driven through its shipped adapter
    18/18   BOTH pages at once on one account: pair by code, converge, delete on
            the phone and have it stay deleted on the desktop, revoke

The last one is the only test that proves the feature rather than the pieces.
