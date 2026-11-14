# ANI-MATE accounts — design

**Status: BUILT AND TESTED, NOT DEPLOYED. Designed 2026-11-07, built 2026-11-08.**

The Worker, the D1 schema and both clients are written and green. Nothing is live: no
`wrangler deploy` has run, no tag exists, and the working tree is unpushed pending YASA's
review. Two sections at the bottom record what changed while building — the pairing flow
reversed, and the opt-in prompt plus key recall were added — and both supersede the
original text where they disagree with it.

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
| **recovery key** | 130 bits random | written down by the user | SHA-256 hash |
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
cannot be mis-transcribed), displayed in groups of four. 130 bits (26 characters, 5 bits
each; this said 128). Typable on a phone.

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

> **Changed 2026-11-12.** That is still what the SERVER does with two pushes. The client no
> longer lets it be the whole story: when a row changed on this device AND on another since
> the last sync, the engine merges the two before it pushes. See "Rewritten 2026-11-12" at
> the end of this document.

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
| deletion is real | `DELETE /api/account` removes the rows of every table by name; it does not rely on a cascade |

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

> **Both halves of that changed on 2026-11-12, because both lost data.** A row missing from
> the local list is NOT a delete any more: the history is capped at 100 rows and a file can
> fail to read, and each of those used to delete shows from the account. Deletes come from
> a journal the delete buttons write. And the push is not a snapshot: it is the rows whose
> content hash moved. See "Rewritten 2026-11-12" at the end of this document.

Two consequences, both load-bearing:

- **The push MUST follow a successful pull.** Pushing without one resurrects whatever
  another device just deleted. The engine refuses to push if the pull failed.
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

---

## Opt-in, and getting the key back. His calls, 2026-11-08.

> *"make sure users can pull up their keys 1 more time after the inital popup cuz not
> everyone will read. or maybe make the sync thing a whole different popup that you have
> to interact with (opt-in or out) before it goes away. we should also have a way for
> people that initially opted out to opt back in"*

### A popup that has to be answered

On a fresh install, after the changelog has had its turn, both clients show **SYNC YOUR
STUFF?** with exactly two buttons: **TURN SYNC ON** and **NOT NOW**. It has no close
button, the backdrop does not dismiss it, and Escape does not either. Either answer is
recorded in `animate.sync.choice`, and it is never asked again.

⚠ **It WAITS for the changelog rather than racing it.** Two stacked modals on first launch
is how a user dismisses both without reading either. And it has to keep checking, not
check once: a single timeout that gave up because the changelog was still open would mean
a fresh install never sees it, which is the only case it exists for.

### Opting back in

The **SYNC** button never goes away, and after a decline it opens the same three-way panel
(start fresh / add this device / I have a recovery key). So opting back in is one click,
and declining is remembered rather than nagged.

### ⛔ THE KEY CAN BE SHOWN AGAIN, AND ONLY THE DEVICE CAN DO IT

The server stores a SHA-256 and there is no endpoint that can reverse it. That is the
design, not a limitation to route around. So the **device** keeps a copy, in
`animate.sync.recoverykey`, and the panel has **SHOW MY KEY**.

**Why that is acceptable rather than a compromise:** the device token is already in the
same storage, and a device token is strictly MORE powerful than a recovery key — it is
live account access with no further step. Anyone who can read one can already read the
other. What would be wrong is sending the key back to the server, or keeping it on a
device that never had the account.

**A device that joined by pairing never sees a key and never stores one.** That is
correct, and the panel says so plainly: it offers a NEW key instead, which is the only
honest option.

### ⛔ AND SIGNING OUT SHOWS THE KEY FIRST

Falls straight out of the above: once the token is gone the key is the only way back, and
nothing else in the flow would tell the user that at the moment it matters. So revoking
the device you are holding shows the key, with *"you will need this key to sync this
computer again"*, before it will proceed. If the device has no key (it was paired), it
says that instead.

`forgetLocal()` therefore keeps `rkey` and `choice`. The key is dropped in exactly two
places: when the user says they have saved it, and when the account is deleted outright.
Deleting it on sign-out, or on a revoke from another device, would turn both into silent
permanent lockout.

### One race worth recording

The signed-in panel paints immediately with "Loading…" and then fetches the device list.
A tap on SHOW MY KEY inside that window used to have the fetch's result painted straight
over the top of it, so the tap simply vanished. Fixed with a render generation counter —
the same fix, for the same reason, as the favorites generation counter added 2026-11-07.

### Tested 2026-11-08 on both real pages

    46/46   the opt-in popup is unanswerable-away, both answers recorded, a decline is
            remembered, the SYNC button still opts back in, SHOW MY KEY returns the SAME
            key, it survives a restart, and a sign-out shows the key and does not drop it

---

## Watch time and genre analysis. His ask, 2026-11-08: *"add all the shit for accounts that we talked about as well"*

Named back on 2026-11-07 as the reason for having accounts at all — *"we could eventually
add things like watch time tracking and genre analysis, etc. lots of potential here."*

### What is counted

**Real seconds in front of a playing video.** Not `currentTime`, and not episode count.
`currentTime` is a POSITION: scrubbing forward 20 minutes would bank 20 minutes nobody
watched, and a rewatch would run the number backwards. The clients accumulate wall-clock
time between `timeupdate` events, only while the video is actually playing, and discard
any gap bigger than a few seconds so a pause, a seek or a tab the OS suspended cannot be
counted as viewing.

### ⛔ WHY THE DEVICE IS IN THE PRIMARY KEY

Because a total is not a value. See the schema comment above: last-write-wins on a
counter deletes time. Per-device rows summed at read is the only arrangement that is
correct when two devices are used on the same day, and it needs no locking or ordering.

### The day is the DEVICE's local day, deliberately

A person who watches at 1am wants it on the night they were up, not shifted by UTC. The
cost is that two devices in different timezones can file the same hour under different
days, which is the right trade for a personal stats screen — nobody is reconciling this
against a ledger.

### Genres come from the client, because they have to

`graphql.anilist.co` returns 403 to every Cloudflare Worker IP (measured 2026-11-07), so
the edge cannot look up what a show's genres are. The client already has them — it is
what the cards render — so it attributes the seconds as it counts them and pushes totals.

### `GET /api/stats`

    { total_seconds, today_seconds, days: [{day, seconds}],
      genres: [{genre, seconds}], episodes_watched, shows_started, top_shows: [...] }

Aggregated across every device on the account. `days` is capped at 365 rows so the
response cannot grow without bound.

---

## Rewritten 2026-11-12: what the engine does now

The sections above record how sync was designed and why. This one records what was wrong
with it once two devices were actually pointed at each other, and what
`server/ani-mate-sync.js` does instead. The first fault and the third were reproduced
against the old engine, in a harness, before anything was changed. The other four were
found by reading it.

### What went wrong

| fault | what the user saw |
|---|---|
| a device pulled back its own push and treated it as news | a favorite removed between two syncs came back |
| "missing from the local list" meant "deleted" | the 101st show watched pushed the oldest one out of the account; a favorites file that failed to read once deleted every favorite everywhere |
| the pull cursor was the server's clock at the moment of the answer | a row committed while that answer was being built was never delivered to that device |
| two devices changed the same show between syncs | the later push replaced the earlier one whole, and the episodes watched on the other device were gone |
| the desktop and the phone give the same show different ids | a show favorited on one appeared on the other as a second show that would not play |
| a switch the user never touched was pushed as "off" | turning on 18+ on one device was undone by the other device's next sync |

### The rules

1. **An echo is skipped.** Each pulled row is hashed; if the hash is the one this device
   last saw for that key, it is this device's own write coming back, and nothing happens.
2. **A change on both sides is merged, not replaced.** Watch rows: the scalar fields come
   from the newer side and `episodes_watched` is the union of both. Favorites: the remote
   row wins and its gaps are filled from the local one.
3. **A delete happens only when a delete button was pressed.** The delete paths write a
   journal (`ani-mate-deleted.json` on the desktop, `deleted.json` on the phone). The
   engine sends a tombstone for a key in the journal and for nothing else. A pulled
   tombstone is applied only if the local row has not changed since it was last seen;
   otherwise the local row wins and is pushed back.
4. **The cursor overlaps.** The next pull starts 120 seconds before the server time of the
   previous one. Rows delivered twice are echoes (rule 1) and cost nothing.
5. **One show, one key, on both platforms.** A row whose title strictly matches an AniList
   title syncs under `al:<AniList id>`; otherwise under its native id. The lookup happens
   on the device (the Worker cannot reach AniList), before the pull.
   - **A row is pushed whether or not its lookup has happened.** AniList allows an address
     30 requests a minute and the app spends them on covers too, so a first sync often
     runs before the lookups can. Such a row goes up under its native id and is re-keyed
     to `al:<id>` on a later sync; the device that made the row retires the old key.
   - **A row that only arrived by sync is a guest** (`from_sync` on the stored row, or an
     `al:` placeholder id). When this device turns out to have its own row for the same
     show, the guest folds into it: watched episodes are united, gaps filled, and the
     device's own id is the one kept, because it is the id this platform can open.
   - **Only the owner of a key retires it.** A guest row that gains its AniList key is
     pushed under the new key and its old key is left alone. Retiring it from here was
     read by the owner as "your row was deleted".
   - The first version folded only placeholders and held nothing back, so two devices that
     both first synced while AniList was unreachable kept every shared show twice, for
     good. Found by `npm run test:sync` on a run that AniList rate limited; it is
     scenario 8b in `sync-engine.test.mjs` and staged in the end-to-end suite.
6. **An unset switch is not pushed.** Only a setting the user has actually set is sent.
7. **The server has limits.** 1 MB per request, 1000 rows of each kind per push, 5000 per
   account, 25 devices, every field cleaned to its type and length. `/health` answers
   `api: 2`, and the engine refuses to create or join an account against a Worker that
   does not, with a message that says sync is not available yet.

### Tested

    node worker/tests/run.mjs        the Worker suites, on node:sqlite, no network
        sync-engine.test.mjs         two simulated devices and the real engine: echo,
                                     merge, the 100 row cap, a failed read, a late commit,
                                     settings, identity across platforms, rename, joining
        sync-api.test.mjs            the limits, the cleaners, the refusals

These run in CI before a release is built (`.github/workflows/release.yml`). The numbers
quoted under "Tested 2026-11-08" above were runs against `wrangler dev` on that day and
are not reproduced by anything in the repository.

    npm run test:sync                the real pages and the real engine against this Worker
                                     run locally by wrangler (a local database in a temp
                                     folder): pairing through both panels, one row per show
                                     across two id schemes, the echo, a delete that stays
                                     deleted, settings, every button of the panel, and a
                                     staged AniList outage followed by recovery.

**Known limit: the resume point at a first meeting.** A row's time is stamped by the server
when it is pushed (the pull cursor depends on that), so when two devices that both hold a
show meet for the first time, "newer" means "pushed later", not "watched later". The
watched episodes are always the union of both; the episode and position come from
whichever side the stamps favor. From the second sync on, a stamp is within two minutes of
the watching it records. Getting the first meeting right needs a column for the device's
own time, which is a schema change.

## Deployed 2026-11-13, and the protocol number

His choices that day: asked whether to deploy the Worker, **Deploy now** (13:27 CST);
asked whether to deploy a check that refuses the old sync code, **Deploy the check**
(22:21 CST). Live version after the second: `d82b29f2-4e34-4db6-9ac6-de944e6a35f9`.

**Every account request carries `v=<protocol>` in its address, and the server refuses a
client that sends less than 2** (`MIN_CLIENT` in `src/accounts.js`, `SYNC_PROTOCOL` in
`server/ani-mate-sync.js`). The answer is 426 with a sentence a panel can show as it is.

Why it exists: the first engine used these same routes with these same bodies, so the
server could not tell it from the rewritten one, and it still existed in any app window
opened before the rewrite and on `main` at `d6a96e8`. Measured locally the hour after
the first deploy, with that engine out of `.session-notes/2026-11-12/`: it made an
account, synced, and after one failed read of its own favorites removed all three
favorites from another device on the account (shows AniList cannot name, which keep
their own ids as keys). The server accepted it from 13:27 to 22:21; no account was made
in that time.

Raise both numbers together when a change to the engine makes an older engine dangerous
to an account. A later engine than the server knows is let in.

Checked on the public address after each deploy: the read-only checks, the app's own
engine end to end with a throwaway account that is deleted at the end, and the real old
engine, which is refused (`.session-notes/2026-11-13/`).

**Not tested: two real installs.** No released app has a sync screen yet (v0.7.1 has
none). The desktop app from the working tree and the phone's page in a browser have been
through it; an installed phone has not.
