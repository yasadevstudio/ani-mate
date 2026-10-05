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

    /** Title -> stream, the shape getEpisodeUrlWithFallbacks wants. */
    async function streamByTitle(title, episodeNumber, mode = 'sub') {
        const hits = await search(title);
        if (!hits.length) return null;
        const eps = await episodes(hits[0].id);
        const ep = eps.find((e) => String(e.number) === String(episodeNumber));
        if (!ep) return null;
        return stream(ep.id, mode);
    }

    return { name: 'HiAnime.at', base: BASE, search, episodes, stream, streamByTitle };
}

function decodeEntities(s) {
    return String(s).replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

module.exports = { makeProvider };
