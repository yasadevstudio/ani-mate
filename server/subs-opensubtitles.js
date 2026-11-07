'use strict';
/**
 * subs-opensubtitles.js — the first subtitle source that is NOT a streaming site.
 *
 * WHY THIS EXISTS (2026-11-07)
 *   Every subtitle ANI-MATE could reach came from the site serving the video, and the
 *   2026-11-07 provider survey showed why that is a dead end: the streaming ecosystem is a
 *   monoculture. hianime.at, AniLight and gogoanime.by all resolve to the same two backends
 *   (ZokoAnime and megaplay), so "try another provider" reaches the same file. When an
 *   episode is published without a script track there is no door inside that room.
 *
 *   BEASTARS FINAL SEASON Part 2 episode 1 is the case that proved it. Measured:
 *     hianime ZokoAnime ..... 1 track, 7 cues, on-screen signs only
 *     hianime HD-1 .......... 0 subtitle tracks
 *     all four hianime listings for the franchise ... 12 episodes each, 1-12
 *   The last line is the important one. hianime splits the final season into two listings of
 *   twelve, so Part 2 episode 1 is "episode 1" everywhere on that host and NO fallback inside
 *   hianime can reach a file indexed as episode 13.
 *
 * WHAT THIS ADDS, AND IT WAS PROBED LIVE BEFORE A LINE WAS WRITTEN
 *   rest.opensubtitles.org answers with NO API KEY and NO ACCOUNT. The modern
 *   api.opensubtitles.com needs both; this legacy host does not, which is the only reason it
 *   is usable here. Measured 2026-11-07:
 *     /search/episode-13/query-beastars/season-3/sublanguageid-eng
 *       -> BEASTARS - S03E13.en.srt, 338 cues, 25,318 bytes, uploaded by a VIP member
 *     Part 2 coverage: episodes 13-22 and 24 present, episode 23 absent. 11 of 12.
 *
 *   THE GENERIC QUERY LIES ABOUT COVERAGE. `/search/query-beastars/sublanguageid-eng` caps
 *   at 96 rows and returned only S02E01-12 and S03E01-12, which reads as "Part 2 is not
 *   there". It is there. Always ask for the episode explicitly.
 *
 * WHEN THE TIMING LINES UP, AND WHEN IT DOES NOT
 *   Checked on four episodes rather than assumed. Every OpenSubtitles file for this season
 *   puts the episode title card at exactly 00:01:42,018, and so does every hianime track:
 *     hianime Part2 ep2 <-> S03E14   "ALGAMA BOTANICAL GARDEN"   102.018 both
 *     hianime Part2 ep3 <-> S03E15   "IN A DUSTY UNIVERSE"       102.018 both
 *     hianime Part2 ep4 <-> S03E16   "THE RED IN OUR LIVES"      102.018 both
 *     hianime Part2 ep5 <-> S03E17   "SWEET HUNGER"              102.018 both
 *   Same encode, same grid. The cue TEXT differs because these are two translations of one
 *   video, so do not expect text equality and do not use it as a test.
 *
 *   ⚠ EPISODE 1 BREAKS THE PATTERN AND IS THE REASON THIS SOURCE IS A LAST RESORT. hianime's
 *   Part 2 episode 1 derives to S03E13 and is not S03E13: at matched timestamps the files
 *   say different things, and it shares 2-3 exact cue times with every Part 2 file where the
 *   ep2/E14 control shares 91. Four episodes agreeing is not the whole listing agreeing.
 *
 *   THE EPISODE THAT OPENED 0.6.0 IS NOT FIXED BY THIS FILE. It is fixed by reading
 *   hianime's own DUB servers for the same episode id -- 336 cues, same timing grid, proven
 *   by the signs cues landing at identical timestamps. See hianime-at.js. This source is for
 *   episodes where nothing tied to the video has anything at all, and even then the track it
 *   adds is labeled with the episode number it came from and is never the default.
 *
 * TWO THINGS IN THESE FILES HAVE TO BE REMOVED BEFORE A PLAYER SEES THEM
 *   1. ADVERTS. Cue 1 and the final cue of S03E13 are both
 *        "Do you want subtitles for any video?  -=[ ai.OpenSubtitles.com ]=-"
 *      The last one runs sixty seconds. They are cues, not metadata, so nothing but a
 *      content filter catches them.
 *   2. THE FORMAT. These are SubRip. A <track> element renders WebVTT and nothing else, so
 *      an .srt handed straight to the player loads with zero cues and looks like a 403.
 */

const zlib = require('zlib');

const BASE = process.env.ANI_MATE_OPENSUBS || 'https://rest.opensubtitles.org';
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* A dialogue track for a 24 minute episode runs 250-400 cues. A signs-only track runs under
 * 30. Same line the stream providers use, and for the same reason: presence is not
 * usefulness. */
const MIN_CUES = 40;

/* Path segments are slash-delimited in this API, so a slash inside a value would invent a
 * new segment. Everything that is not safe becomes a space, which is what the host's own
 * search box does with punctuation. */
function seg(s) {
    return encodeURIComponent(String(s || '').replace(/[\/\\]+/g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Ask for ONE episode. season and episode are required on purpose: see the note above about
 * the generic query under-reporting coverage.
 * -> [{ id, file, format, encoding, size, downloads, link, season, episode, movieName, added, hi }]
 */
async function search(afetch, { query, season, episode, lang = 'eng' }) {
    if (!query || !season || !episode) return [];
    const url = `${BASE}/search/episode-${seg(episode)}/query-${seg(query)}` +
                `/season-${seg(season)}/sublanguageid-${seg(lang)}`;
    let rows;
    try {
        const r = await afetch(url, { headers: { 'User-Agent': AGENT } });
        if (r.status !== 200) return [];
        const body = typeof r.text === 'function' ? await r.text() : (r.body || '');
        rows = JSON.parse(body);
    } catch { return []; }
    if (!Array.isArray(rows)) return [];

    return rows
        .filter((s) => s && s.SubDownloadLink && /^(srt|vtt|ass|ssa)$/i.test(s.SubFormat || ''))
        .map((s) => ({
            id: String(s.IDSubtitleFile || ''),
            file: s.SubFileName || '',
            format: String(s.SubFormat || '').toLowerCase(),
            encoding: s.SubEncoding || 'UTF-8',
            size: Number(s.SubSize || 0),
            downloads: Number(s.SubDownloadsCnt || 0),
            link: s.SubDownloadLink,
            season: Number(s.SeriesSeason || 0),
            episode: Number(s.SeriesEpisode || 0),
            movieName: s.MovieName || '',
            added: s.SubAddDate || '',
            hi: String(s.SubHearingImpaired || '0') === '1',
        }))
        /* The host returns the requested episode plus, occasionally, neighbors. Keep only
         * the episode that was ASKED FOR. Letting a neighbor through is the subtitle version
         * of the 0.5.5 bug, where a better-looking file from the wrong entry won. */
        .filter((s) => s.season === Number(season) && s.episode === Number(episode))
        /* Plain English before hearing-impaired and before forced: an HI file is correct but
         * carries sound descriptions, and a forced file is signs only. */
        .sort((a, b) => {
            const rank = (x) => (/-forced/i.test(x.file) ? 2 : (x.hi || /-HI\b/i.test(x.file) ? 1 : 0));
            return rank(a) - rank(b) || titleAgrees(b) - titleAgrees(a) || b.downloads - a.downloads;
        });
}

/* DOES THE FILENAME AGREE WITH THE METADATA?
 *
 * MovieName is the episode title as IMDb has it, and it is reliable. Filenames are typed by
 * uploaders and are not. On Cowboy Bebop S01E01 the two disagree outright:
 *     MovieName "Cowboy Bebop" Asteroid Blues
 *     SubFileName  Cowboy Bebop - S01E01 - Stray Dog Strut.eng.srt
 * Stray Dog Strut is episode TWO. The metadata is right and the name is wrong, and the file
 * fits the episode duration perfectly, so no structural check can separate it from a correct
 * one. A file that NAMES its episode and names it correctly is the safer pick.
 *
 * ⚠ A PREFERENCE, NOT A FILTER. Plenty of correct files carry no title at all --
 * "BEASTARS - S03E13.en.srt" is the only candidate for the episode this release was written
 * for, and it names no title. Scoring this as a tiebreak keeps those usable; filtering on it
 * would have thrown away the one file that mattered.
 */
function titleAgrees(s) {
    const ep = String(s.movieName || '').replace(/^\s*"[^"]*"\s*/, '').trim();
    if (!ep || ep.length < 4) return 0;
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
    return norm(s.file).includes(norm(ep)) ? 1 : 0;
}

/**
 * Download one file and hand back WebVTT.
 *
 * THIS USES NODE'S OWN fetch RATHER THAN THE ELECTRON BRIDGE, DELIBERATELY. The bridge
 * marshals bodies as STRINGS, and these downloads are gzip. A gzip stream decoded as UTF-8
 * is corrupt before it arrives, with no error to notice. The bridge exists to solve
 * Cloudflare challenges, and neither rest.opensubtitles.org nor dl.opensubtitles.org
 * presents one, so nothing is lost by going direct.
 */
async function fetchVtt(entry) {
    if (!entry || !entry.link) return null;
    const r = await fetch(entry.link, {
        headers: { 'User-Agent': AGENT, Accept: '*/*' },
        redirect: 'follow',
    });
    if (!r.ok) return null;

    const buf = Buffer.from(await r.arrayBuffer());
    let text;
    /* The link ends in .gz and has always answered gzipped, but a host that stops gzipping
     * one day should degrade to working rather than to garbage. Sniff the magic bytes. */
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { text = zlib.gunzipSync(buf).toString('utf8'); }
        catch { return null; }
    } else {
        text = buf.toString('utf8');
    }
    if (!text || !text.trim()) return null;

    const cues = stripAdverts(parseCues(text));
    if (cues.length < MIN_CUES) return null;
    /* lastCue is how the caller tells a file for THIS cut from a file for a different one.
     * It is the only structural signal a subtitle file carries about which video it belongs
     * to, and it is the reason the live-action Cowboy Bebop stopped being grafted onto the
     * anime: same series name, same S01E01, 47 minute episodes. */
    return {
        vtt: emitVtt(cues),
        cues: cues.length,
        firstCue: cues[0].start,
        lastCue: cues[cues.length - 1].start,
    };
}

function countCues(s) {
    return (String(s).match(/-->/g) || []).length;
}

/* Adverts the uploader tool injects. These are real cues with real timings, so only their
 * TEXT identifies them.
 *
 * ⚠ A FIRST PASS MATCHED ONLY "opensubtitles" AND REPORTED ITSELF CLEAN. The advert in
 * BEASTARS S03E13 is:
 *     Watch Online Movies and Series for FREE
 *     www.osdb.link/lm
 * No "opensubtitles" anywhere in it, because osdb.link is their own shortener. The grep that
 * verified the strip was looking for the one word the advert did not contain, so a check
 * built on a proxy passed while the advert shipped. Match the SHORTENER and the STOCK
 * SENTENCES, both of which were read off real files.
 */
const ADVERT = [
    /osdb\.link/i,
    /opensubtitles/i,
    /\b(?:subscene|subdl|addic7ed|podnapisi|yifysubtitles|subsource)\b/i,
    /watch online movies and series for free/i,
    /support us and become (?:a )?vip/i,
    /advertise your (?:product|brand)/i,
    /remove all ads/i,
    /=\[\s*ai\./i,
];

/* The wording rotates between uploader versions; the SHAPE does not. A cue at the very start
 * or the very end that is nothing but a bare URL is an advert whatever it says. Restricted to
 * the edges on purpose: a URL in the middle of an episode is far more likely to be dialogue
 * on a screen than a promotion. */
const BARE_URL = /(?:https?:\/\/|www\.)\S+/i;

function isAdvert(text, { edge = false } = {}) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    if (ADVERT.some((re) => re.test(flat))) return true;
    return edge && BARE_URL.test(flat);
}

/**
 * Parse SubRip OR WebVTT into cues. One parser for both, because the only real differences
 * are a header line and a comma, and two parsers would mean two places to fix.
 * -> [{ start, end, text }] with start/end in seconds
 */
const TS = /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

function secs(h, m, s, ms) {
    return (Number(h || 0) * 3600) + (Number(m) * 60) + Number(s) + (Number((ms + '00').slice(0, 3)) / 1000);
}

/**
 * SubStation Alpha -> cues.
 *
 * WHY ASS IS SUPPORTED AT ALL. A first pass accepted only srt and vtt, and on Cowboy Bebop
 * S01E01 that discarded the most-downloaded file in the list by a wide margin:
 *     Cowboy Bebop - S01E01 Bluray 720p_track5_eng.ass ....... 43,392 downloads
 *     Cowboy Bebop - Session 01 [Asteroid Blues] (ENGLISH) ... 34,829   (srt)
 * Anime subtitles are predominantly ASS because that is what fansub groups author in, so
 * refusing the format throws away most of the coverage that exists for exactly the content
 * this app plays.
 *
 * THE COLUMN ORDER IS DECLARED, NOT FIXED. [Events] carries its own `Format:` line and the
 * order genuinely varies between authoring tools, so the indices of Start, End and Text are
 * read from that line rather than assumed. Assuming them yields cues with the style name as
 * their text, which renders as a screen full of "Default".
 */
function parseAss(text) {
    const body = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    let iStart = 1, iEnd = 2, iText = 9;        // the conventional order, used until told otherwise
    const cues = [];
    for (const line of body.split('\n')) {
        const f = line.match(/^\s*Format\s*:\s*(.+)$/i);
        if (f && /\bStart\b/i.test(f[1])) {
            const cols = f[1].split(',').map((c) => c.trim().toLowerCase());
            const at = (n) => cols.indexOf(n);
            if (at('start') >= 0) iStart = at('start');
            if (at('end') >= 0) iEnd = at('end');
            if (at('text') >= 0) iText = at('text');
            continue;
        }
        const d = line.match(/^\s*Dialogue\s*:\s*(.+)$/i);
        if (!d) continue;
        /* Text is the LAST field and may itself contain commas, so split only as many times
         * as there are fields before it. */
        const parts = d[1].split(',');
        const head = parts.slice(0, iText);
        const raw = parts.slice(iText).join(',');
        const t = assTime(head[iStart]), e = assTime(head[iEnd]);
        if (t === null || e === null) continue;
        const clean = String(raw)
            .replace(/\{[^}]*\}/g, '')          // {\pos(..)}, {\i1} and friends
            .replace(/\\[Nnh]/g, '\n')          // ASS line breaks and hard spaces
            .replace(/\n{2,}/g, '\n')
            .trim();
        if (!clean) continue;
        cues.push({ start: t, end: e, text: clean });
    }
    /* Dialogue lines are in authoring order, which is not always chronological. */
    return cues.sort((a, b) => a.start - b.start);
}

/* ASS time is H:MM:SS.cc -- centiseconds, two digits, and a single-digit hour. */
function assTime(s) {
    const m = String(s || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!m) return null;
    return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]) +
           Number((m[4] + '00').slice(0, m[4].length === 2 ? 2 : 3)) / (m[4].length === 2 ? 100 : 1000);
}

function parseCues(text) {
    const body = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    /* One entry point for every format we accept, so callers never have to know which. */
    if (/^\s*\[Script Info\]/i.test(body) || /^\s*Dialogue\s*:/im.test(body)) return parseAss(body);
    const cues = [];
    for (const block of body.trim().split(/\n{2,}/)) {
        const lines = block.split('\n');
        // a leading SubRip counter, or a VTT cue identifier, is not timing or text
        if (lines.length && !TS.test(lines[0])) lines.shift();
        if (!lines.length) continue;
        const m = lines[0].match(TS);
        if (!m) continue;
        const t = lines.slice(1).join('\n').trim();
        if (!t) continue;
        cues.push({
            start: secs(m[1] && m[1].slice(0, -1), m[2], m[3], m[4]),
            end: secs(m[5] && m[5].slice(0, -1), m[6], m[7], m[8]),
            text: t,
        });
    }
    return cues;
}

/* Adverts live at the edges, so "is this an edge cue" is part of the test. Two from each end
 * is enough: every file measured carries at most one. */
function stripAdverts(cues) {
    const n = cues.length;
    return cues.filter((c, i) => !isAdvert(c.text, { edge: i < 2 || i >= n - 2 }));
}

function fmt(t) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000);
    const p = (x, w = 2) => String(x).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

/**
 * Cues -> WebVTT text. Three things the browser is strict about, and getting any of them
 * wrong yields a file it accepts and renders as nothing:
 *   - the WEBVTT header line is mandatory
 *   - the fraction separator is a DOT, not a comma
 *   - cues are separated by a blank line
 */
function emitVtt(cues) {
    const out = ['WEBVTT', ''];
    for (const c of cues) out.push(`${fmt(c.start)} --> ${fmt(c.end)}`, c.text, '');
    return out.join('\n');
}

function srtToVtt(srt) { return emitVtt(stripAdverts(parseCues(srt))); }
function cleanVtt(vtt) { return srtToVtt(vtt); }

module.exports = {
    name: 'OpenSubtitles', search, fetchVtt, countCues, MIN_CUES,
    parseCues, stripAdverts, emitVtt, srtToVtt, cleanVtt, isAdvert,
};
