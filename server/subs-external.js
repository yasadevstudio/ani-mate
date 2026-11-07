'use strict';
/**
 * subs-external.js — the subtitle chain, independent of whoever is serving the video.
 *
 * WHY A SEPARATE CHAIN (2026-11-07)
 *   ANI-MATE conflated two questions that have different answers: "where is the video" and
 *   "where are the subtitles". Until now the second was always answered by whoever answered
 *   the first, so an episode published without a script track had no subtitles anywhere, and
 *   adding stream providers could not help because they share backends.
 *
 *   Separating them is what makes a real fallback possible. The stream keeps coming from
 *   hianime; the subtitles can come from a database that never served a frame of video.
 *
 * SAFE, AND CHECKED RATHER THAN ASSUMED. Grafting a subtitle file from one source onto
 * another source's encode risks drift. Measured on four episodes of this season: the title
 * card lands at exactly 00:01:42.018 in both the hianime track and the OpenSubtitles file,
 * on every one. Same master, same grid. The full working is in subs-opensubtitles.js.
 *
 * THE FILE IS FETCHED AND CONVERTED HERE, NOT IN THE PLAYER, for three reasons that each
 * broke something earlier:
 *   - FORMAT. These are SubRip. A <track> element renders WebVTT and nothing else, so an
 *     .srt handed to the player loads with zero cues and is indistinguishable from a 403.
 *   - GZIP. The download is gzipped and the Electron bridge marshals bodies as strings, so
 *     it has to be read as bytes server-side.
 *   - ⚠ NOT THROUGH /proxy-stream. v0.5.9 added server-side proxying on top of the UI's own
 *     and produced `/proxy-stream?url=%2Fproxy-stream%3F...`, a 400 on every track. These
 *     entries carry NO referer precisely so the UI leaves `src` alone and requests this
 *     server directly. Do not give them one.
 */

const fs = require('fs');
const path = require('path');
const opensubs = require('./subs-opensubtitles');

/* Tried in order. Each entry needs: name, and search/fetchVtt with the shapes in
 * subs-opensubtitles.js. Deliberately a list of ONE working source rather than a list of
 * five hopeful ones -- ani-py's rule, and the reason the old five-provider list returned
 * subtitles from exactly one of them:
 *     "a provider that cannot resolve costs failover time and implies a safety net that
 *      is not there."
 * Proven dead 2026-11-07 and therefore absent: animetosho (no extracted attachments on any
 * of six Beastars releases, subtitles are inside 1GB MKVs), subdl (Cloudflare 403),
 * kitsunekko (Japanese, seasons 1-2 only, zipped), jimaku and sub.wyzie.ru (API key),
 * gestdown (every subtitle route 404s). */
const CHAIN = [opensubs];

/* How far past the end of the video a legitimate subtitle file may reach. Credits and
 * post-credit lines land after the last segment on some encodes, so this is not zero; it is
 * nowhere near the 1300 second overrun that a file for a different cut shows. */
const TAIL_SLACK = 45;

/**
 * How long is this episode, in seconds, according to the stream itself.
 *
 * WHY THE CHAIN NEEDS THIS AT ALL, and it is not a nicety. A subtitle database is indexed by
 * series name, season and episode, and those three can all match while the file belongs to a
 * completely different video. Measured 2026-11-07:
 *
 *   query "Cowboy Bebop" S01E01 -> Cowboy.Bebop.S01E01.Cowboy.Gospel...AGLET.srt
 *     465 cues, last cue at 00:46:37, first line "Shitbag corporations."
 *   the anime's episode 1, from the m3u8 ....... 1483.1s  (24.7 min)
 *
 * That file is the 2021 LIVE-ACTION series. Same name, same season, same episode number,
 * 47 minute episodes, and every quality measure available says it is excellent. Nothing
 * about a subtitle file tells you which video it is for EXCEPT how long it runs.
 *
 * This is the same lesson as 0.5.5 one more time: cue count, download count and file name all
 * measure usability, and none of them measures identity.
 */
async function probeDuration(afetch, url, referer) {
    const hdr = { 'User-Agent': 'Mozilla/5.0', ...(referer ? { Referer: referer } : {}) };
    try {
        const r = await afetch(url, { headers: hdr });
        if (r.status !== 200) return 0;
        let txt = typeof r.text === 'function' ? await r.text() : (r.body || '');
        /* A master playlist lists variants, not segments. Follow the first one; every
         * variant of the same episode is the same length, so which one does not matter. */
        if (/#EXT-X-STREAM-INF/.test(txt)) {
            const v = txt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
            if (!v) return 0;
            const abs = /^https?:/.test(v) ? v : url.replace(/[^/]*$/, '') + v;
            const r2 = await afetch(abs, { headers: hdr });
            if (r2.status !== 200) return 0;
            txt = typeof r2.text === 'function' ? await r2.text() : (r2.body || '');
        }
        let total = 0;
        for (const m of String(txt).matchAll(/#EXTINF:\s*([\d.]+)/g)) total += Number(m[1]) || 0;
        return total;
    } catch { return 0; }
}

function makeChain(afetch, dataDir) {
    const cacheDir = path.join(dataDir, 'subcache');

    /* A token, not a URL. The UI gets `/subtitle?t=<token>` and this server resolves it from
     * disk, so no external host and no referer ever reaches the player. */
    function tokenFor(provider, season, episode, id) {
        return [provider, season, episode, id]
            .map((x) => String(x).replace(/[^A-Za-z0-9._-]+/g, '_'))
            .join('-');
    }

    function cachePath(token) {
        /* Tokens are built above from a sanitized alphabet, but this is the one place a
         * value off the wire becomes a filesystem path, so re-check it here rather than
         * trusting the caller. */
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(token) || token.includes('..')) return null;
        return path.join(cacheDir, `${token}.vtt`);
    }

    function read(token) {
        const p = cachePath(token);
        if (!p) return null;
        try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
    }

    function write(token, vtt) {
        const p = cachePath(token);
        if (!p) return false;
        try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(p, vtt, 'utf8');
            return true;
        } catch (e) {
            console.error('[subs] cache write failed:', e.message);
            return false;
        }
    }

    /**
     * Find an English dialogue track for one episode.
     * map: the output of episode-map.resolve -> { franchise, season, episode, derivedFrom }
     * -> [{ lang, label, src, default, cues, origin }]  (at most one entry today)
     */
    async function find(map, opts = {}) {
        if (!map || !map.franchise || !map.season || !map.episode) return [];
        const durationSec = Number(opts.durationSec) || 0;
        if (!durationSec) {
            console.error('[subs] no episode duration available; grafting without the ' +
                          'length check, which is the only identity test a subtitle file has');
        }

        for (const provider of CHAIN) {
            let hits = [];
            try {
                hits = await provider.search(afetch, {
                    query: map.franchise, season: map.season, episode: map.episode,
                });
            } catch (e) {
                console.error(`[subs] ${provider.name} search failed:`, e.message);
                continue;
            }
            if (!hits.length) {
                console.error(`[subs] ${provider.name}: nothing for ` +
                              `${map.franchise} S${map.season}E${map.episode}`);
                continue;
            }

            /* Walk the candidates. A file can be listed and still be unreadable or be a
             * forced/signs file under a plain name, and only opening it says which. */
            for (const hit of hits.slice(0, 6)) {
                const token = tokenFor(provider.name, map.season, map.episode, hit.id);
                const cached = read(token);
                if (cached) {
                    const cues = provider.countCues(cached);
                    console.error(`[subs] ${provider.name}: cached ${hit.file} (${cues} cues)`);
                    return [entry(provider, hit, token, cues, map)];
                }
                let got = null;
                try { got = await provider.fetchVtt(hit); }
                catch (e) { console.error(`[subs] ${provider.name} fetch failed:`, e.message); }
                if (!got) continue;

                /* THE LENGTH CHECK. A file that runs past the end of this video is for a
                 * different video, whatever its name says. Nothing is cached when this
                 * fails, so a rejected candidate is re-checked rather than remembered. */
                if (durationSec && got.lastCue > durationSec + TAIL_SLACK) {
                    console.error(`[subs] ${provider.name}: REFUSED ${hit.file} -- last cue at ` +
                                  `${got.lastCue.toFixed(0)}s but this episode is ` +
                                  `${durationSec.toFixed(0)}s. That file is for a different cut.`);
                    continue;
                }
                if (!write(token, got.vtt)) continue;
                console.error(`[subs] ${provider.name}: ${hit.file} -> ${got.cues} cues ` +
                              `(ends ${got.lastCue.toFixed(0)}s of ${durationSec.toFixed(0)}s) ` +
                              `for S${map.season}E${map.episode} (${map.derivedFrom})`);
                return [entry(provider, hit, token, got.cues, map)];
            }
        }
        return [];
    }

    /* ⛔ THE LABEL NAMES THE EPISODE IT IS FOR, AND THAT IS NOT COSMETIC.
     *
     * The derivation in episode-map.js is arithmetically sound and it still produced the
     * WRONG EPISODE on the first show it was tested against. Measured 2026-11-07:
     *
     *   hianime "Beastars Final Season Part 2" ep 2..5 match OpenSubtitles S03E14..E17
     *     exactly -- identical title card text at an identical 00:01:42.018, four for four.
     *   hianime ep 1 therefore derives to S03E13. It is NOT S03E13.
     *     At matched timestamps the two files say completely different things, and ep 1
     *     shares 2-3 exact cue times with EVERY Part 2 file, where the ep2/E14 control
     *     shares 91. hianime's ep 1 is a different encode on a different grid.
     *
     * So the number can be derived correctly from the host's own data and still be wrong,
     * because the host's episode 1 is not the episode the rest of its list implies. Duration
     * cannot catch it either: both run 24.6 minutes.
     *
     * Therefore this track:
     *   - is appended LAST, never first, so any track from the episode's own servers wins.
     *     The UI's ranker breaks ties by taking the EARLIER entry, so order is the mechanism.
     *   - carries default:false, so it is chosen only when nothing else is English.
     *   - SAYS WHICH EPISODE IT IS, e.g. "English (OpenSubtitles S3E13)". The person watching
     *     is the only one who can tell it is the wrong episode, and they can tell in about
     *     four seconds. Hiding the origin is how a whole wrong season went unnoticed.
     */
    function entry(provider, hit, token, cues, map) {
        return {
            lang: 'en',
            label: `English (${provider.name} S${map.season}E${map.episode})`,
            src: `/subtitle?t=${encodeURIComponent(token)}`,
            default: false,
            cues,
            origin: `${provider.name} S${map.season}E${map.episode} (${hit.file})`,
        };
    }

    return {
        find, read, cacheDir,
        probeDuration: (url, referer) => probeDuration(afetch, url, referer),
        providers: CHAIN.map((p) => p.name),
    };
}

module.exports = { makeChain };
