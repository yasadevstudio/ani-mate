'use strict';
/**
 * hianime-at.js — a working stream source, implemented from ani-cli 5.1.5's recipe.
 *
 * WHY THIS EXISTS (2026-10-05)
 *   Every source ANI-MATE had was dead at once:
 *     AllAnime   AA_CRYPTO_MISSING — moved to a per-epoch AES-GCM aaReq token
 *     AniDB      503, "Under Maintenance"
 *     AnimePahe  real site is behind Cloudflare, consumet pins a NXDOMAIN host
 *     HiAnime    consumet pins hianime.to, which does not resolve
 *
 *   Reading the actual ani-cli script rather than articles about it gave the answer in one
 *   line: `base_api="https://hianime.at"`. A host nobody had tried, alive, and reachable
 *   with a plain request — no TLS impersonation needed for any step measured here.
 *
 * THE CHAIN, ALL FIVE STEPS VERIFIED LIVE ON 2026-10-05 (Cowboy Bebop, episode 1)
 *   1. GET /search?keyword=...                      -> slug, e.g. cowboy-bebop-1281
 *   2. GET /api/theme/episode/list/<numeric tail>   -> 26 episode ids
 *   3. GET /api/theme/episode/servers?episodeId=    -> base64 hash per server/mode
 *   4. base64 -> embed url (zokoanime.video), fetch it, read window.__P
 *   5. base64(__P) XOR "otaku-embed-v1" -> JSON  -> m3u8 master + subtitle vtt + mal id
 *   master.m3u8 200 -> variant 200 -> segment HTTP 206, video/mp2t, first byte 0x47.
 *
 * THE OBFUSCATION IS NOT CRYPTO. It is a repeating 14-byte XOR against a FIXED key. Unlike
 * AllAnime's rotating epoch scheme there is nothing here to re-derive when it changes, which
 * is the whole reason this is the better source to depend on.
 *
 * AND IT RETURNS THINGS THE APP DID NOT HAVE BEFORE:
 *   - a real English WebVTT subtitle track (ANI-MATE had no subtitle track support at all)
 *   - the MyAnimeList id, which is what ani-skip needs for skip-intro
 *
 * Every request goes through `afetch` so it travels the Electron bridge when one exists.
 */

const BASE = process.env.ANI_MATE_HIANIME || 'https://hianime.at';
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const XOR_KEY = Buffer.from('otaku-embed-v1');

function makeProvider(afetch) {
    async function get(url, referer) {
        const r = await afetch(url, {
            headers: { 'User-Agent': AGENT, ...(referer ? { Referer: referer } : {}) },
        });
        const body = typeof r.text === 'function' ? await r.text() : (r.body || '');
        return { status: r.status, body };
    }

    /** Search -> [{ id: slug, name }]. The slug's numeric tail is the id every later call wants. */
    async function search(query) {
        const { body } = await get(`${BASE}/search?keyword=${encodeURIComponent(query)}`);
        // The top-10 sidebar repeats the result markup. Cut it before parsing or every hit doubles.
        const main = body.split('id="main-sidebar"')[0];
        const out = [];
        const re = /<h3 class="film-name">\s*<a href="[^"]*?\/([^"\/]+)"\s*title="([^"]*)"/g;
        let m;
        while ((m = re.exec(main))) out.push({ id: m[1], name: decodeEntities(m[2]) });
        return out;
    }

    /** Episode list -> [{ id, number }] in broadcast order. */
    async function episodes(slug) {
        const numericId = String(slug).split('-').pop();
        const { body } = await get(`${BASE}/api/theme/episode/list/${numericId}`);
        let html = '';
        try { html = (JSON.parse(body).html || ''); } catch { return []; }
        const out = [];
        const re = /data-number="(\d+)"[^>]*data-id="(\d+)"|data-id="(\d+)"[^>]*data-number="(\d+)"/g;
        let m;
        while ((m = re.exec(html))) {
            const number = m[1] || m[4];
            const id = m[2] || m[3];
            if (number && id) out.push({ id, number });
        }
        return out;
    }

    /**
     * Resolve one episode to a playable stream.
     * -> { url, referer, subtitles: [{lang,label,src,default}], malId, quality } or null
     */
    async function stream(episodeId, mode = 'sub') {
        const { body } = await get(`${BASE}/api/theme/episode/servers?episodeId=${episodeId}`);
        let html = '';
        try { html = (JSON.parse(body).html || ''); } catch { return null; }

        // ZokoAnime is the only embed whose config this understands. The others use different
        // players, so taking "any server" would hand back a page we cannot parse.
        const re = new RegExp(
            `data-type="${mode}"[^>]*data-server-name="ZokoAnime"[^>]*data-hash="([^"]*)"`, 'i');
        const hit = html.replace(/\\"/g, '"').match(re);
        if (!hit) return null;

        const embed = Buffer.from(hit[1], 'base64').toString('utf8');
        if (!/^https?:\/\//.test(embed)) return null;
        const embedOrigin = embed.replace(/^(https?:\/\/[^/]*).*/, '$1/');
        const malId = (embed.match(/\/mal\/(\d+)\//) || [])[1] || null;

        const page = await get(embed, `${BASE}/`);
        const blob = (page.body.match(/window\.__P="([^"]*)"/) || [])[1];
        if (!blob) return null;

        // base64, then a repeating XOR against a fixed key. Not a cipher, a scramble.
        const raw = Buffer.from(blob, 'base64');
        const dec = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i++) dec[i] = raw[i] ^ XOR_KEY[i % XOR_KEY.length];

        let cfg;
        try { cfg = JSON.parse(dec.toString('utf8')); } catch { return null; }
        if (!cfg.src) return null;

        return {
            url: cfg.src,
            referer: embedOrigin,         // the CDN rejects the request without this
            subtitles: Array.isArray(cfg.subtitles) ? cfg.subtitles : [],
            malId,
            quality: (cfg.player && cfg.player.default_quality) || 'auto',
        };
    }

    /**
     * Title -> stream, the shape getEpisodeUrlWithFallbacks wants.
     *
     * WHY THIS WALKS THE SEARCH HITS INSTEAD OF TAKING THE FIRST (2026-10-22)
     *   This took hits[0] and stopped. Tokyo Revengers: Tenjiku-hen episode 11 showed what
     *   that costs. hianime.at lists that show twice:
     *     tokyo-revengers-tenjiku-arc-222              <- hits[0], ep 11 subtitles: []
     *     tokyo-revengers-tenjiku-hen-uncensored-9614  <- hits[1], ep 11 subtitles: ["English"]
     *   Episodes 10 and 12 of the first listing both carry an English track, so the show
     *   looked fine and exactly one episode played silent. Checked upstream directly: the
     *   empty array is what ZokoAnime returns, and the HD-1 server (megaplay) returns
     *   "tracks":[] for the same episode, so it is a genuine hole in that ONE listing --
     *   not a parse failure here, and not something a different server on that listing fixes.
     *
     *   So: keep the first PLAYABLE stream, but keep looking for one that can also be read,
     *   and prefer that. The alternate listing's stream and its .vtt come from the same
     *   encode, so they stay in sync -- grafting a foreign subtitle file onto the original
     *   stream would risk drift, which is worse than no subtitles.
     *
     *   Cost: nothing on the happy path. The first listing with a track returns immediately.
     *   The extra lookups only happen for an episode that currently plays with no subtitles
     *   at all.
     */
    const MAX_LISTINGS = 4;

    /* ── A TRACK EXISTING IS NOT A TRACK WORKING. Added 2026-11-01. ───────────────
     * Beastars Season 2 episode 1 played with no readable subtitles even though a
     * track was present, selected and showing. Measured against the two listings
     * hianime.at returns for that title:
     *
     *   "Beastars Final Season Part 2"  English ->    7 cues   <- hits[0], taken
     *   "Beastars 2nd Season"           English ->  301 cues   <- the real one
     *
     * The 7-cue file is signs only: PLANT PRODUCTION RESEARCH FACILITY, CITY HALL,
     * FESTIVAL OF THE METEOR. 362 bytes across a 24 minute episode.
     *
     * TWO EARLIER FIXES DO NOT CATCH IT, and that is the point.
     *   - the track ranker penalises /forced/i in the LABEL. This file is labelled
     *     plain "English" and carries default:true. Nothing in the metadata says
     *     signs-only.
     *   - the walk below accepted the first listing with `subtitles.length`, which
     *     is presence, not usefulness. One signs track passes that test.
     *
     * So the only honest test is to open the file and count. A 24 minute episode of
     * dialogue runs 250-400 cues; a signs track runs under 30. 40 is the line.
     */
    const MIN_CUES = 40;

    /* The track the player would actually choose, mirroring the UI's ranking so the
     * file counted here is the file shown. Forced last, English first. */
    function bestTrack(subs) {
        const score = (s) => {
            const label = String(s.label || ''), lang = String(s.lang || '');
            let n = 0;
            if (/^en/i.test(lang) || /^english/i.test(label)) n += 100;
            if (/forced/i.test(label)) n -= 1000;
            if (/dubtitle/i.test(label)) n -= 50;
            if (/sdh/i.test(label)) n -= 10;
            return n;
        };
        return subs.slice().sort((a, b) => score(b) - score(a))[0];
    }

    async function cueCount(src, referer) {
        if (!src) return 0;
        try {
            const r = await get(src, referer);
            return (String(r.body).match(/ --> /g) || []).length;
        } catch { return -1; }   // unreadable; treat as unknown, not as signs-only
    }

    async function streamByTitle(title, episodeNumber, mode = 'sub') {
        const hits = await search(title);
        if (!hits.length) return null;

        let silent = null;      // playable, but no subtitle track. Held as the fallback.
        let silentFrom = '';
        let signs = null;       // playable, has a track, but the track is signs only.
        let signsFrom = '';

        for (const hit of hits.slice(0, MAX_LISTINGS)) {
            let got = null;
            try {
                const eps = await episodes(hit.id);
                const ep = eps.find((e) => String(e.number) === String(episodeNumber));
                if (!ep) continue;
                got = await stream(ep.id, mode);
            } catch { continue; }
            if (!got || !got.url) continue;

            if (got.subtitles && got.subtitles.length) {
                const best = bestTrack(got.subtitles);
                const n = await cueCount(best && best.src, got.referer);
                if (n < 0 || n >= MIN_CUES) {          // readable, or unknown: take it
                    if (silent || signs) {
                        console.error(`[hianime.at] ep ${episodeNumber}: using "${hit.name}" ` +
                                      `(${n} cues) over "${signsFrom || silentFrom}"`);
                    }
                    return got;
                }
                console.error(`[hianime.at] ep ${episodeNumber}: "${hit.name}" track is signs only ` +
                              `(${n} cues), looking for a listing with dialogue`);
                if (!signs) { signs = got; signsFrom = hit.name; }
                continue;
            }
            if (!silent) { silent = got; silentFrom = hit.name; }
        }

        // A signs-only track still beats nothing: it is in sync and names the places.
        if (signs) {
            console.error(`[hianime.at] ep ${episodeNumber}: no listing has a dialogue track ` +
                          `(checked ${Math.min(hits.length, MAX_LISTINGS)}), using "${signsFrom}" signs only`);
            return signs;
        }
        if (silent) {
            console.error(`[hianime.at] ep ${episodeNumber}: no listing has a subtitle track ` +
                          `(checked ${Math.min(hits.length, MAX_LISTINGS)}), playing "${silentFrom}" without one`);
        }
        return silent;
    }

    return { name: 'HiAnime.at', base: BASE, search, episodes, stream, streamByTitle };
}

function decodeEntities(s) {
    return String(s).replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

module.exports = { makeProvider };
