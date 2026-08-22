'use strict';
/**
 * providers/anidb.js — AniDB source provider for ANI-MATE.
 *
 * WHY THIS EXISTS (2026-08-22):
 *   Every source the app previously knew is dead:
 *     AllAnime   403 Cloudflare  (blocks main-process requests; the site's own page-context
 *                                 calls reach GraphQL and return 400 persisted-query misses)
 *     AnimePahe  animepahe.si has NO DNS; live domains 403 or serve a different structure
 *     HiAnime    522 origin timeout on every known domain
 *     consumet   1.8.8 IS the latest — unpublished since 2026-01-20, scrapers stale
 *
 *   Upstream `ani-cli` migrated off AllAnime to anidb.app, and that source is alive.
 *   VERIFIED 2026-08-22 through the Electron bridge: 200 on a cold request, no challenge.
 *   Plain `curl` gets 403; the same request over Chromium's network stack succeeds, which
 *   is what ../electron-net-bridge.js provides.
 *
 * THE CHAIN, all measured against one-piece (3880):
 *   search    GET /browse?q={q}                        -> HTML, anchors /anime/{slug}-{id}
 *   episodes  GET /api/frontend/anime/{id}/episodes    -> {episodes:[{id,number,number2,filler}]}
 *                                                          (1,174 for One Piece)
 *   languages GET /api/frontend/episode/{ep}/languages -> {languages:[{code,name,embed_url}]}
 *                                                          code is 'jpn' (sub) or 'eng' (dub)
 *   stream    GET {embed_url}                          -> HTML containing a master.m3u8 on
 *                                                          hls.anidb.app (HTTP 200, plays)
 *
 * NOTE ON MODE: this source expresses audio language, not subtitle state. 'jpn' is the
 * subbed track and 'eng' the dubbed one, so ANI-MATE's sub/dub maps cleanly onto it.
 *
 * Every request goes through the injected `afetch` so it travels the bridge. Nothing here
 * calls global fetch directly — a bare request from the forked server would be a 403.
 */

const BASE = 'https://anidb.app';
const HLS_RE = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i;
const LINK_RE = /\/anime\/([a-z0-9-]+)-(\d+)/gi;

function titleFromSlug(slug) {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @param {(url:string, opts?:object)=>Promise<any>} afetch bridge-backed fetch
 */
function createAniDB(afetch) {

    async function getText(path) {
        const r = await afetch(BASE + path, { method: 'GET' });
        if (!r || !r.ok) {
            const code = r ? r.status : 0;
            const err = new Error(`anidb ${path} -> HTTP ${code}`);
            err.status = code;
            throw err;
        }
        return r.text();
    }

    async function getJson(path) {
        const body = await getText(path);
        try {
            return JSON.parse(body);
        } catch (e) {
            throw new Error(`anidb ${path} -> non-JSON response`);
        }
    }

    return {
        name: 'AniDB',

        /** -> [{ id, slug, title }] */
        async search(query) {
            const html = await getText('/browse?q=' + encodeURIComponent(query));
            const out = [];
            const seen = new Set();
            let m;
            LINK_RE.lastIndex = 0;
            while ((m = LINK_RE.exec(html)) !== null) {
                const id = m[2];
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ id, slug: m[1], title: titleFromSlug(m[1]) });
                if (out.length >= 40) break;
            }
            return out;
        },

        /** -> [{ id, number, filler }] ; `number` is what the UI shows */
        async getEpisodes(showId) {
            const j = await getJson(`/api/frontend/anime/${encodeURIComponent(showId)}/episodes`);
            const eps = Array.isArray(j.episodes) ? j.episodes : [];
            return eps.map((e) => ({
                id: e.id,
                number: e.number2 != null ? `${e.number}.${e.number2}` : String(e.number),
                filler: !!e.filler
            }));
        },

        /**
         * Resolve one episode to a playable HLS URL.
         * mode: 'sub' -> jpn audio, 'dub' -> eng audio. Falls back to whatever exists.
         * -> { url, referer, language } | null
         */
        async getStream(episodeId, mode = 'sub') {
            const j = await getJson(`/api/frontend/episode/${encodeURIComponent(episodeId)}/languages`);
            const langs = Array.isArray(j.languages) ? j.languages : [];
            if (!langs.length) return null;
            const want = mode === 'dub' ? 'eng' : 'jpn';
            const pick = langs.find((l) => l.code === want) || langs[0];
            if (!pick || !pick.embed_url) return null;

            // The embed page carries the master playlist in its HTML; no script execution
            // needed to read it. Loading it in a window also works but costs a window.
            const r = await afetch(pick.embed_url, { method: 'GET' });
            if (!r || !r.ok) return null;
            const html = await r.text();
            const m = html.match(HLS_RE);
            if (!m) return null;
            return { url: m[0], referer: BASE, language: pick.code };
        },

        /** Cheap liveness probe for the health check. */
        async health() {
            const t0 = Date.now();
            try {
                const r = await afetch(BASE + '/api/frontend/anime/3880/episodes', { method: 'GET' });
                const ok = !!(r && r.ok);
                return { name: 'AniDB', ok, status: r ? r.status : 0, ms: Date.now() - t0 };
            } catch (e) {
                return { name: 'AniDB', ok: false, status: 0, ms: Date.now() - t0, error: String(e.message || e) };
            }
        }
    };
}

module.exports = { createAniDB, BASE };
