'use strict';
/**
 * episode-map.js — turn "this listing, episode N" into "series, season S, episode E".
 *
 * WHY THIS EXISTS (2026-11-07)
 *   Streaming sites restart episode numbering at 1 for every cour. Release trackers and
 *   subtitle databases number continuously within a season. Both are internally consistent
 *   and they disagree, so a lookup that carries the streaming number to a subtitle database
 *   asks for the wrong episode and gets a confident answer.
 *
 *   Measured on hianime.at, 2026-11-07. All four Beastars listings:
 *     Beastars                       12 episodes, 1-12
 *     Beastars 2nd Season            12 episodes, 1-12
 *     Beastars Final Season          12 episodes, 1-12
 *     Beastars Final Season Part 2   12 episodes, 1-12
 *   OpenSubtitles indexes the same final season as S03E01 through S03E24. So Part 2
 *   episode 1 derives to S03E13, and asking for S03E01 returns "An Itchy Collar" -- a real
 *   file, the right series, the right season, 300-plus cues, and twelve episodes early.
 *
 * ⚠⚠ AND ON THE FIRST SHOW IT WAS TESTED AGAINST, THE CORRECT DERIVATION WAS STILL THE
 * WRONG EPISODE. This has to be read before trusting anything below.
 *
 *   hianime Part 2 ep 2..5  <->  OpenSubtitles S03E14..E17, four for four, confirmed by
 *                                identical title card TEXT at an identical 00:01:42.018
 *   hianime Part 2 ep 1     ->   derives to S03E13 by the arithmetic below, and is not it
 *
 *   Proof it is not: at matched timestamps the two files say entirely different things, and
 *   ep 1 shares only 2-3 exact cue start times with EVERY Part 2 file, where the ep2/E14
 *   control shares 91. hianime's episode 1 is a different encode on a different timing grid
 *   from the rest of its own listing. The duration check cannot separate them either --
 *   both run 24.6 minutes.
 *
 *   The arithmetic is right. The host's data is inconsistent with itself. Those are
 *   different problems and only the first one is fixable here.
 *
 * SO WHAT THIS IS FOR. A derived number is good enough to OFFER a track that says which
 * episode it came from, and not good enough to make it the default. The caller appends the
 * result last, never first, and labels it "English (OpenSubtitles S3E13)" so the person
 * watching can see in four seconds that it is wrong. It is a last resort behind every
 * source that is actually tied to the episode being played -- above all the dub-server
 * tracks in hianime-at.js, which are the same episode id and cannot drift.
 *
 * ⛔ THE NUMBER IS DERIVED, NEVER SCORED. This is the 0.5.5 lesson restated for subtitles.
 *   In 0.5.5 cue count was used to choose between listings and it put a whole wrong season on
 *   screen, because the wrong entry had more dialogue. The same trap is open here: S03E01 and
 *   S03E13 both look excellent by every quality measure available. Nothing about a file tells
 *   you it is the wrong episode.
 *
 *   So the mapping is computed from the host's own episode counts, and when it CANNOT be
 *   computed this returns null and the caller does not graft. No subtitles is a disappointment.
 *   The wrong episode's subtitles spoil the show, and that is not recoverable.
 */

/* Qualifiers that mark a different entry rather than a different part of the same one. */
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };

function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The season this listing belongs to, or null when the title does not say. */
function seasonOf(title) {
    const t = norm(title);
    let m = t.match(/\bseason (\d+)\b/) || t.match(/\b(\d+)(?:st|nd|rd|th) season\b/);
    if (m) return Number(m[1]);
    m = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth) season\b/);
    if (m) return ORD[m[1]];
    if (/\bfinal season\b/.test(t)) return 'final';
    /* A bare franchise name is season 1. "Part 2" with no season word is still season 1,
     * which is the usual shape for a split first season. */
    return 1;
}

/** Which cour of its season this listing is. Absent means the first. */
function partOf(title) {
    const t = norm(title);
    const m = t.match(/\b(?:part|cour) (\d+)\b/) ||
              t.match(/\b(?:part|cour) (one|two|three|four)\b/);
    if (!m) return 1;
    const w = { one: 1, two: 2, three: 3, four: 4 };
    return Number(m[1]) || w[m[1]] || 1;
}

/** Strip every season and part qualifier to get the name a subtitle database indexes. */
function franchiseOf(title) {
    let t = String(title || '');
    const drop = [
        /\s*[:\-]?\s*\b(?:part|cour)\s*(?:\d+|one|two|three|four)\b/gi,
        /\s*[:\-]?\s*\bthe final season\b/gi,
        /\s*[:\-]?\s*\bfinal season\b/gi,
        /\s*[:\-]?\s*\bseason\s*\d+\b/gi,
        /\s*[:\-]?\s*\b\d+(?:st|nd|rd|th)\s+season\b/gi,
        /\s*[:\-]?\s*\b(?:first|second|third|fourth|fifth)\s+season\b/gi,
        /\s*[:\-]?\s*\b(?:uncensored|recap|special|ova|movie)\b/gi,
    ];
    for (const re of drop) t = t.replace(re, ' ');
    return t.replace(/\s+/g, ' ').replace(/[\s:\-]+$/, '').trim();
}

/**
 * listings: [{ name, count }] every listing the host has for this franchise, with its
 *           episode count. Order does not matter.
 * chosen:   the listing name actually being played.
 * episode:  the episode number WITHIN that listing.
 *
 * -> { franchise, season, episode, derivedFrom } or null when it cannot be derived.
 */
function resolve({ listings, chosen, episode }) {
    const epn = Number(episode);
    if (!chosen || !Number.isFinite(epn) || epn < 1) return null;

    const franchise = franchiseOf(chosen);
    if (!franchise) return null;

    const rows = (listings || [])
        .filter((l) => l && l.name && Number(l.count) > 0)
        /* Only listings of the SAME franchise may contribute counts. A side story or a
         * different series that happened to come back from the same search would silently
         * inflate the offset. */
        .filter((l) => norm(franchiseOf(l.name)) === norm(franchise))
        .map((l) => ({
            name: l.name,
            count: Number(l.count),
            season: seasonOf(l.name),
            part: partOf(l.name),
        }));

    const me = rows.find((r) => norm(r.name) === norm(chosen));
    if (!me) return null;

    /* "Final Season" has to become a number, and the only honest source for it is how many
     * numbered seasons the host itself lists. Beastars: explicit 1 and 2 exist, so final is 3. */
    const explicit = rows.map((r) => r.season).filter((s) => typeof s === 'number');
    const maxExplicit = explicit.length ? Math.max(...explicit) : 0;
    const seasonNum = (r) => (r.season === 'final' ? maxExplicit + 1 : r.season);

    const season = seasonNum(me);
    if (!Number.isFinite(season) || season < 1) return null;

    /* Sum the parts of THIS season that come before this one. Every one of them must be
     * present with a real count, or the offset is a guess. */
    let offset = 0;
    for (let p = 1; p < me.part; p++) {
        const prior = rows.find((r) => seasonNum(r) === season && r.part === p);
        if (!prior) return null;              // a missing part means an unknowable offset
        offset += prior.count;
    }

    return {
        franchise,
        season,
        episode: offset + epn,
        derivedFrom: me.part > 1
            ? `${chosen} ep ${epn}, plus ${offset} episodes from ` +
              (me.part > 2 ? `parts 1-${me.part - 1}` : 'part 1')
            : `${chosen} ep ${epn}, first part of its season`,
    };
}

module.exports = { resolve, franchiseOf, seasonOf, partOf };
