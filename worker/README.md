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

    GET /health
    GET /api/search?q=
    GET /api/episodes?id=&title=&mode=&nsfw=
    GET /api/play?title=&episode=&mode=&nsfw=
    GET /api/subs?query=&season=&episode=
    GET /api/episode-map?title=&episode=

## Providers

`src/index.js` imports `../../server/*.js` **unchanged**. They load as-is under
`nodejs_compat`, verified on the edge. One copy, two runtimes: the desktop requires them from
Node, the Worker bundles the same files. The only adaptation needed was `require('node:zlib')`
instead of `require('zlib')`, because the bare specifier resolves to an empty shim here.

## Deploy

    cd worker && wrangler deploy
