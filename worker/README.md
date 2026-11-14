# ANI-MATE edge API

`https://ani-mate.yasadevstudio.workers.dev`

The half of the ANI-MATE server a datacenter IP is allowed to run, so the desktop app and the
Android app can share one backend instead of carrying two implementations of it.

## What runs here, and what cannot

Measured on Cloudflare's edge on 2026-11-07, before any of this was written:

| host | from a Worker | from a client |
|---|---|---|
| hianime.at | 200 | |
| gogoanime.by | 200 | |
| api.allanime.day | 200 | |
| rest.opensubtitles.org (search) | 200 | |
| **graphql.anilist.co** | **403** | 200 with CORS |
| **dl.opensubtitles.org** (download) | **401** | 200 |

AniList's reply is `"You have been manually blocked. Please come to the principal's office."`
Six header variants, all 403: it is an IP block on Cloudflare's range, not a header problem.
`dl.opensubtitles.org` answers `"Making sure you're not a bot!"`.

Both answer a real client perfectly, so both live on the client. That is not a workaround; a
public CORS-enabled read API is meant to be called from the device.

**No video passes through this Worker.** `/api/play` returns a URL and the referer its CDN
demands. Clients fetch the bytes themselves, as they already did. Proxying streams here would
bill every byte to Cloudflare and would break the referer gating anyway.

## Endpoints

    GET /health                                       { api, features, ... }
    GET /api/search?q=
    GET /api/episodes?id=&title=&alt=&mode=&nsfw=
    GET /api/play?title=&alt=&episode=&mode=&nsfw=
    GET /api/subs?query=&season=&episode=
    GET /api/episode-map?title=&episode=

`alt` is the show's other name (romaji or English). A row that has been through sync can
carry the name the other platform knows it by, and the stream host lists a show under
only one of them. `mode` is `sub` or `dub`; anything else is read as `sub`.

`/health` answers `api: 2` and lists `accounts`, `sync` and `stats` under `features`.
The apps ask before they offer to create an account. Deployed 2026-11-13.

## Accounts and sync

`src/accounts.js`. Passwordless and optional; the design, with its reasons, is in
`ACCOUNTS-DESIGN.md`. Every route but the first, the two `claim` routes and `recover`
needs `Authorization: Bearer <device token>`.

**Every one of them also needs `v=2` in its address** (`/api/sync?since=0&v=2`). That is
the sync protocol the client speaks. A request without it, or with less, is the first
sync engine, which was not safe to let in, and is answered 426 with
`{ "error": "This copy of ANI-MATE is too old to sync. ...", "upgrade": true, "needs": 2 }`.
The reasons are in `ACCOUNTS-DESIGN.md`, "Deployed 2026-11-13, and the protocol number".

    POST   /api/account                  create an account, returns the recovery key once
    DELETE /api/account                  delete the account and every row it owns
    POST   /api/account/recover          recovery key -> a new device token
    POST   /api/account/recovery-key     replace the recovery key
    POST   /api/device/claim             a new device asks to join, gets a 6 digit code
    GET    /api/device/claim             that device polls for approval
    POST   /api/device/approve           a signed-in device types the code
    GET    /api/devices                  list
    PATCH  /api/devices/:id              rename
    DELETE /api/devices/:id              remove (this one: sign out)
    GET    /api/sync?since=              rows changed after that stamp
    POST   /api/sync                     a batch of local changes
    GET    /api/stats                    watch time by day and by genre

Limits, per request: 1 MB body, 1000 rows of each kind. Per account: 5000 rows of each
kind, 25 devices. Tests: `node worker/tests/run.mjs` (no network, no wrangler).

## Providers

`src/index.js` imports `../../server/*.js` **unchanged**. They load as-is under
`nodejs_compat`, verified on the edge. One copy, two runtimes: the desktop requires them from
Node, the Worker bundles the same files. The only adaptation needed was `require('node:zlib')`
instead of `require('zlib')`, because the bare specifier resolves to an empty shim here.

## Deploy

    cd worker && wrangler deploy
