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
    /* ── EVERY SERVER, NOT JUST ONE. Added 2026-11-07. ──────────────────────────
     * This adapter only ever read ZokoAnime. hianime also lists HD-1 (megaplay),
     * and HD-1 is the RICHER source: measured on Beastars Season 2 ep2 it returns
     * 36 subtitle tracks including four English variants, where ZokoAnime returns
     * three tracks total.
     *
     * That gap is why "no subtitles" kept recurring on individual episodes. When
     * ZokoAnime's only English file is signs-only, HD-1 frequently has a full one,
     * and nothing here ever looked.
     *
     * GRAFTING IS SAFE, and it was checked rather than assumed. The warning further
     * up about foreign subtitles drifting against a different encode does not apply
     * between these two: on Beastars S2 ep2 both servers return 300 cues with
     * identical timestamps (00:01:32.509, 00:01:33.635, ...) and identical text.
     * Same master, same timing.
     *
     * Each track carries its OWN referer, because the two hosts gate differently:
     * ZokoAnime's vtt wants zokoanime.video, HD-1's wants megaplay.buzz. A single
     * stream-level referer cannot serve both.
     */
    async function serversFor(episodeId) {
        const out = {};
        try {
            const r = await get(`${BASE}/api/theme/episode/servers?episodeId=${episodeId}`, `${BASE}/`);
            let html = '';
            try { html = JSON.parse(r.body).html || ''; } catch { return out; }
            html = html.replace(/\\"/g, '"');
            const re = /data-type="(\w+)"[^>]*data-server-name="([^"]+)"[^>]*data-hash="([^"]*)"/g;
            let m;
            while ((m = re.exec(html))) {
                if (m[1] !== 'sub' && m[1] !== 'dub') continue;
                out[m[1] + ':' + m[2]] = Buffer.from(m[3], 'base64').toString('utf8');
            }
        } catch { /* a server list we cannot read just means fewer candidates */ }
        return out;
    }

    async function megaplayTracks(embed) {
        try {
            const page = await get(embed, `${BASE}/`);
            const id = (page.body.match(/data-id="(\d+)"/) || [])[1];
            if (!id) return [];
            const host = embed.replace(/^(https?:\/\/[^/]*).*/, '$1');
            const r = await get(`${host}/stream/getSources?id=${id}`, embed);
            let j;
            try { j = JSON.parse(r.body); } catch { return []; }
            return (j.tracks || [])
                .filter((x) => x && x.file && x.kind !== 'thumbnails')
                .map((x) => ({
                    lang: /^english/i.test(x.label || '') ? 'en' : (x.lang || ''),
                    label: x.label || x.lang || 'Subtitles',
                    src: x.file,
                    default: !!x.default,
                    referer: host + '/',          // megaplay's CDN gates on its own host
                }));
        } catch { return []; }
    }

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

        // ZokoAnime's own tracks, tagged with the referer THEIR host needs.
        const zoko = (Array.isArray(cfg.subtitles) ? cfg.subtitles : [])
            .map((s) => Object.assign({}, s, { referer: s.referer || embedOrigin }));

        // Pool in HD-1's, which is usually the richer list. Same timing, checked.
        let extra = [];
        const servers = await serversFor(episodeId);
        for (const key of Object.keys(servers)) {
            if (!key.startsWith(mode + ':')) continue;
            if (/ZokoAnime/i.test(key)) continue;          // already have it
            extra = extra.concat(await megaplayTracks(servers[key]));
        }
        const seen = new Set(zoko.map((s) => s.src));
        const subtitles = zoko.concat(extra.filter((s) => s.src && !seen.has(s.src)));

        return {
            url: cfg.src,
            referer: embedOrigin,         // the CDN rejects the request without this
            subtitles,
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

    /* ── MATCH THE SHOW BEFORE JUDGING THE TRACK. Added 2026-11-03. ──────────────
     * The cue check above, added 2026-11-01, made cue count the tiebreaker between
     * listings. That is a USABILITY test being used as an IDENTITY test, and it put
     * the wrong series on screen:
     *
     *   search("Beastars Season 2") ->
     *     "Beastars Final Season Part 2"  malId 61114  ep2 = 421 cues   <- was picked
     *     "Beastars 2nd Season"           malId 40935  ep2 = 300 cues   <- the real one
     *
     *   The final season has MORE dialogue in that episode, so it won. Episode 1 only
     *   came out right by luck: the wrong listing happened to have 7 cues there and
     *   got skipped. A whole season of the wrong show played before anyone noticed,
     *   and it spoils the series it is impersonating.
     *
     * So the order is: WHICH SHOW first, then is the track readable. Cue count only
     * ever separates listings that are already the same show.
     *
     * "Season 2" and "2nd Season" are the same thing and must normalise together, or
     * the correct listing loses to a wrong one that happens to be worded like the
     * query. Extra qualifiers the caller did not ask for -- final, part, movie, ova,
     * special -- are what distinguish a different entry in the same franchise, so
     * they are penalised hard rather than ignored.
     */
    function normTitle(s) {
        return String(s || '').toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
            .replace(/\bseason\s+(\d+)\b/g, 'season $1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    const EXTRA = ['final', 'part', 'movie', 'ova', 'special', 'recap', 'uncensored'];

    function titleScore(hitName, wanted) {
        const a = normTitle(hitName), b = normTitle(wanted);
        if (a === b) return 1000;                       // same show, say so
        const at = a.split(' '), bt = b.split(' ');
        const shared = bt.filter((w) => at.includes(w)).length;
        let n = shared * 10 - Math.abs(at.length - bt.length);
        // a qualifier the caller never asked for means a DIFFERENT entry, not a near miss
        for (const w of EXTRA) if (at.includes(w) && !bt.includes(w)) n -= 60;
        // a season OR part number that disagrees is disqualifying. Part was missing
        // and "Final Season Part 1" happily matched "Final Season Part 2" on it.
        for (const kind of ['season', 'part', 'cour']) {
            const re = new RegExp(kind + ' (\\d+)');
            const na = (a.match(re) || [])[1], nb = (b.match(re) || [])[1];
            if (na && nb && na !== nb) n -= 200;
        }
        return n;
    }

    /* Is this hit plausibly the show that was asked for, or just the closest thing
     * the host happened to return? RANKING CANNOT ANSWER THAT. Sorting a list of
     * one still yields a first place, which is how "BEASTARS FINAL SEASON Part 1"
     * came back as Part 2: the search returned exactly one hit, it was wrong, and
     * ranking it changed nothing.
     */
    function titleAcceptable(hitName, wanted) {
        const a = normTitle(hitName), b = normTitle(wanted);
        if (a === b) return true;
        for (const kind of ['season', 'part', 'cour']) {
            const re = new RegExp(kind + ' (\\d+)');
            const na = (a.match(re) || [])[1], nb = (b.match(re) || [])[1];
            if (na && nb && na !== nb) return false;      // different entry, full stop
        }
        // the hit must not introduce a qualifier the caller never asked for
        for (const w of EXTRA) if (a.split(' ').includes(w) && !b.split(' ').includes(w)) return false;
        /* AND NOTHING ABOUT WORD OVERLAP. A first draft also demanded the hit share
         * 60% of the requested words, which looks sensible and is wrong: hosts list
         * shows under whichever language they prefer. "Kusuriya no Hitorigoto 3rd
         * Season" is listed as "The Apothecary Diaries Season 3" and shares ZERO
         * words with it, so the overlap rule refused a perfectly correct match and
         * made the show unplayable. The host returned this hit FOR this query, so
         * relatedness is already implied; what actually has to be checked is that it
         * is not a DIFFERENT ENTRY, which the number and qualifier tests above do. */
        return true;
    }

    /* Progressively broader queries. The host's own search is the weak link: asking
     * it for the EXACT title can return fewer and worse hits than asking for less.
     * Measured 2026-11-04:
     *   "BEASTARS FINAL SEASON Part 1" -> 1 hit,  Final Season Part 2        (wrong)
     *   "Beastars Final Season"        -> 2 hits, incl. "Beastars Final Season" (right)
     *   "Beastars"                     -> 4 hits, the whole franchise
     * Part 1 is listed as plain "Beastars Final Season" with no "Part" in it, so the
     * more precisely we asked, the worse the answer got. */
    function queryLadder(title) {
        const out = [title];
        const t = String(title || '').trim();
        const drop = [
            /\s+(part|cour)\s*\d+\s*$/i,          // "... Part 1"
            /\s+(season\s*\d+|\d+(st|nd|rd|th)\s+season)\s*$/i,
            /\s+(final|the final)\s+season\s*$/i,
        ];
        let cur = t;
        for (const re of drop) {
            const next = cur.replace(re, '').trim();
            if (next && next !== cur) { out.push(next); cur = next; }
        }
        const first = t.split(/[:\-]/)[0].trim();
        if (first && !out.includes(first)) out.push(first);
        return out.filter((x, i) => x && out.indexOf(x) === i);
    }

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
        // Widen the net until an ACCEPTABLE listing appears, then rank. Asking the
        // host for the exact title can return fewer and worse hits than asking for
        // less, so a single wrong hit is not a reason to stop looking.
        let hits = [];
        const seen = new Set();
        /* RUN THE WHOLE LADDER, do not stop at the first acceptable name. Stopping
         * early put "Tokyo Revengers: Santen Sensou-hen" on an 8-cue signs track:
         * the exact query returns exactly ONE listing, its name is acceptable, so
         * the search stopped there and the cue walk below had nothing to walk to.
         * The broader query "Tokyo Revengers" surfaces a listing with 380 cues.
         * A name being plausible is not the same as that listing being usable, and
         * only collecting every candidate first lets the cue check do its job. */
        for (const q of queryLadder(title)) {
            let got = [];
            try { got = await search(q); } catch { continue; }
            for (const h of got) if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); }
        }
        if (!hits.length) return null;

        // Keep only listings that are plausibly the show asked for. If ranking is
        // allowed to pick from a list containing nothing correct, it will still
        // return something, and that something plays.
        const ok = hits.filter((h) => titleAcceptable(h.name, title));
        if (!ok.length) {
            console.error(`[hianime.at] no listing matches "${title}" ` +
                          `(saw: ${hits.map((h) => h.name).join(', ')}). Refusing to ` +
                          `play a different entry in the same series.`);
            return null;
        }
        /* ⛔ IDENTITY IS A CONSTRAINT, NOT A SCORE. This is the whole lesson of
         * 0.5.5 through 0.5.7 and it has to be stated once, here.
         *
         * Rank, then keep ONLY the best-matching tier and walk inside it. Letting
         * the cue check roam the full ranked list means a listing with better
         * subtitles can outrank the correct show, which is exactly how:
         *   - "Beastars Season 2" played Final Season Part 2 (more cues), and
         *   - "FINAL SEASON Part 2" played Part 1 (7 cues vs 250).
         *
         * A signs-only track on the RIGHT show beats a full script from the wrong
         * one. Subtitles are a preference. Which show is playing is not.
         */
        /* The tier is a BAND, not an exact tie. Requiring s === best was too tight:
         * duplicate listings of the SAME show are named slightly differently
         * (a word more, a colon, a romanisation) and scored a few points apart,
         * so the walk was left with one candidate and no alternative when that
         * one carried a dead track. Cowboy Bebop fell to a 1-cue file and
         * "Super no Ura de Yani Suu Futari" stopped resolving at all.
         *
         * TIER_SLACK sits well under the penalties that mark a DIFFERENT entry
         * (-60 for an unasked-for qualifier, -200 for a season or part mismatch),
         * so near-identical names stay together and other seasons stay out. */
        const TIER_SLACK = 25;
        const scored = ok.map((h) => ({ h, s: titleScore(h.name, title) }))
                         .sort((x, y) => y.s - x.s);
        const best = scored[0].s;
        hits = scored.filter((x) => x.s >= best - TIER_SLACK).map((x) => x.h);

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
                // per-track referer: pooled tracks come from different hosts
                const n = await cueCount(best && best.src, (best && best.referer) || got.referer);
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
