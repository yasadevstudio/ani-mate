'use strict';
/**
 * gogoanime-by.js — a stream source that is NOT part of the hianime monoculture.
 *
 * WHY THIS EXISTS (2026-11-07)
 *   The provider survey run for v0.6.0 found that nearly every anime host still answering
 *   resolves to the same two backends. hianime.at serves ZokoAnime and megaplay; AniLight's
 *   watch route hands back `megaplay.buzz/stream/s-2/168223/sub`, the SAME megaplay id for the
 *   same episode. Three "providers", one answer. Adding more of those is not redundancy, it
 *   is a longer list of doors into one room.
 *
 *   This one is different, and that is the entire reason it was worth writing. Its SD player
 *   resolves to GOOGLE'S OWN video hosting -- the file is served from googlevideo.com out of
 *   a Blogger upload. Nothing about it shares infrastructure with hianime, so when hianime is
 *   down, blocked or missing an episode, this answers independently.
 *
 * MEASURED LIVE, 2026-11-07, Beastars Final Season Part 2 episode 1:
 *   1. GET /?s=beastars                 -> /series/beastars-final-season-part-2/
 *   2. GET /series/<slug>/              -> 12 episode pages, 1-12
 *   3. GET /<slug>-episode-1-english-subbed/
 *        -> data-src="/player/?source=blogger&url=<base64>"   labeled SD
 *           data-src="/player/?source=embed&url=<base64>"     labeled Mega
 *   4. GET the blogger player           -> var fileUrl = "https://rr2---sn-....googlevideo.com/..."
 *   5. that URL, range request          -> HTTP 206, video/mp4, 76,864,683 bytes,
 *                                          dur=1476.510, ipbypass=yes
 *
 * ⚠ THE "Mega" PLAYER IS NOT USABLE AND IS NOT TRIED. It resolves to
 * `megavid.buzz/mal/<malId>/<ep>/<mode>`, whose own API answers with rich metadata -- 35
 * subtitle tracks on an episode where hianime has one -- pointing at `s-90.megavid.se`, which
 * is NXDOMAIN from Cloudflare's own authoritative nameservers. Live API, dead CDN. Recorded
 * here so the next person does not spend the afternoon finding that out again.
 *
 * THE SUBTITLES ARE BURNED IN. These are "english-subbed" encodes, so there is no track to
 * return and nothing to go missing: `subtitles` is always empty and the words are in the
 * picture. For an episode hianime publishes without a script track, that is a complete answer
 * rather than a fallback.
 *
 * WHAT IT COSTS: itag 18, which is 360p. Lower than hianime's HLS, which is why this sits
 * BEHIND hianime rather than in front of it. A watchable 360p beats a 1080p stream that will
 * not load.
 */

const BASE = process.env.ANI_MATE_GOGOANIME || 'https://gogoanime.by';
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const { queryLadder, acceptableTier } = require('./title-match');

function makeProvider(afetch) {
    async function get(url, referer) {
        const r = await afetch(url, {
            headers: { 'User-Agent': AGENT, ...(referer ? { Referer: referer } : {}) },
        });
        const body = typeof r.text === 'function' ? await r.text() : (r.body || '');
        return { status: r.status, body };
    }

    /** Search -> [{ id: series url, name }] */
    async function search(query) {
        const { body } = await get(`${BASE}/?s=${encodeURIComponent(query)}`);
        const out = [];
        const seen = new Set();
        const re = /href="(https?:\/\/[^"]*\/series\/[^"]+)"[^>]*itemprop="url"[^>]*title="([^"]*)"/g;
        let m;
        while ((m = re.exec(body))) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            out.push({ id: m[1], name: decodeEntities(m[2]) });
        }
        return out;
    }

    /** Episode list -> [{ id: episode url, number }] */
    async function episodes(seriesUrl) {
        const { body } = await get(seriesUrl, `${BASE}/`);
        const out = [];
        const seen = new Set();
        /* The slug carries the number and a language suffix that varies
         * ("-episode-1-english-subbed", sometimes just "-episode-1"), so the number is taken
         * from the slug rather than from the link text, which is styled markup. */
        const re = /href="(https?:\/\/[^"]*?-episode-(\d+)(?:-[^"\/]*)?\/)"/g;
        let m;
        while ((m = re.exec(body))) {
            if (seen.has(m[2])) continue;
            seen.add(m[2]);
            out.push({ id: m[1], number: m[2] });
        }
        return out.sort((a, b) => Number(a.number) - Number(b.number));
    }

    /**
     * Resolve one episode page to a playable file.
     * -> { url, referer, subtitles: [], quality, hardsub: true } or null
     */
    async function stream(episodeUrl) {
        const page = await get(episodeUrl, `${BASE}/`);
        if (page.status !== 200) return null;

        /* Only the blogger player is parsed. The embed/Mega one points at a dead CDN (see the
         * header), so taking "any player" would hand back a URL that cannot be fetched --
         * which in the player is indistinguishable from the source being broken. */
        const players = [];
        const re = /data-src="([^"]*\/player\/\?source=blogger[^"]*)"/g;
        let m;
        while ((m = re.exec(page.body))) players.push(decodeEntities(m[1]));
        if (!players.length) return null;

        for (const p of players) {
            const pl = await get(p, episodeUrl);
            if (pl.status !== 200) continue;
            const hit = pl.body.match(/var\s+fileUrl\s*=\s*"([^"]+)"/);
            if (!hit) continue;
            const file = decodeEntities(hit[1]);
            if (!/^https?:\/\//.test(file)) continue;
            return {
                url: file,
                referer: `${BASE}/`,
                subtitles: [],        // burned into the picture; there is no track
                hardsub: true,
                quality: (file.match(/[?&]itag=(\d+)/) || [])[1] === '18' ? '360p' : 'auto',
            };
        }
        return null;
    }

    /** Title -> stream, the shape getEpisodeUrlWithFallbacks wants. */
    async function streamByTitle(title, episodeNumber, opts = {}) {
        let hits = [];
        const seen = new Set();
        for (const q of queryLadder(title)) {
            let got = [];
            try { got = await search(q); } catch { continue; }
            for (const h of got) if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); }
        }
        if (!hits.length) return null;

        /* Same identity rule as every other provider, from the same module. A different
         * entry in the same franchise is not a near miss, and this host lists parts
         * separately exactly like hianime does. */
        const tier = acceptableTier(hits, title, opts);
        if (!tier.length) {
            console.error(`[gogoanime.by] no listing matches "${title}" ` +
                          `(saw: ${hits.map((h) => h.name).join(', ')}). Refusing to play ` +
                          `a different entry in the same series.`);
            return null;
        }

        for (const hit of tier.slice(0, 3)) {
            try {
                const eps = await episodes(hit.id);
                const ep = eps.find((e) => String(e.number) === String(episodeNumber));
                if (!ep) continue;
                const st = await stream(ep.id);
                if (st && st.url) {
                    st.listing = hit.name;
                    /* Burned-in subtitles are not a missing track, so this must NOT read as
                     * 'none' -- that would send the external subtitle chain looking for a
                     * file to graft onto a picture that already has the words in it. */
                    st.subsQuality = 'hardsub';
                    st.subsCues = 0;
                    return st;
                }
            } catch (e) { console.error('[gogoanime.by]', e.message); }
        }
        return null;
    }

    return { name: 'Gogoanime.by', base: BASE, search, episodes, stream, streamByTitle };
}

function decodeEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&#038;/g, '&')
        .replace(/&#039;/g, "'").replace(/&quot;/g, '"');
}

module.exports = { makeProvider };
