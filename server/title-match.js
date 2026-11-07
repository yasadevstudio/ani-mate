'use strict';
/**
 * title-match.js — deciding WHICH SHOW a search hit is. Shared by every stream provider.
 *
 * WHY THIS IS ITS OWN FILE (2026-11-07)
 *   This logic was written inside hianime-at.js across v0.5.5 to v0.5.8, each version paying
 *   for a specific failure, and three of those failures were the same mistake in different
 *   clothes. When a second provider arrived in 0.6.0 the choice was to copy it or to share
 *   it, and copying it guarantees the copies drift -- which is precisely the complaint that
 *   started 0.6.0: a fix in one place and a break in another.
 *
 *   One purpose, one file. Change it here and every provider gets the fix.
 *
 * ⛔ THE RULE THE WHOLE FILE EXISTS TO ENFORCE: IDENTITY IS A CONSTRAINT, NOT A SCORE.
 *   A signs-only track on the RIGHT show beats a full script from the wrong one. Subtitles
 *   are a preference. Which show is playing is not. Ranking a list that contains nothing
 *   correct still returns a first place, and that first place plays.
 */

/* "Season 2" and "2nd Season" are the same thing and must normalize together, or the correct
 * listing loses to a wrong one that happens to be worded like the query. */
function normTitle(s) {
    return String(s || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
        .replace(/\bseason\s+(\d+)\b/g, 'season $1')
        .replace(/\s+/g, ' ')
        .trim();
}

/* Qualifiers the caller did not ask for are what distinguish a DIFFERENT entry in the same
 * franchise, so they are penalized hard rather than ignored. */
const EXTRA = ['final', 'part', 'movie', 'ova', 'special', 'recap', 'uncensored'];

/* ⚠ EXCEPT "uncensored", WHICH IS A DIFFERENT CUT OF THE SAME ENTRY, NOT A DIFFERENT ENTRY.
 *
 * Treating it like the others quietly broke the 18+ feature. hianime lists both
 * "Overflow (TV ver.)" and "Overflow (Uncensored)"; a search for "Overflow" REFUSED the
 * uncensored one for introducing a qualifier nobody asked for, so the adult toggle returned
 * the broadcast-safe cut. Correct for a general search, pointless for the reason the toggle
 * exists.
 *
 * So it is now conditional. opts.allowUncensored comes from the user's own 18+ switch:
 * off, it disqualifies exactly as before; on, it is allowed AND preferred, because someone
 * who asked for adult content and got the censored version has not been served.
 */
function extrasFor(opts) {
    return (opts && opts.allowUncensored)
        ? EXTRA.filter((w) => w !== 'uncensored')
        : EXTRA;
}

function titleScore(hitName, wanted, opts) {
    const a = normTitle(hitName), b = normTitle(wanted);
    if (a === b) return 1000;                       // same show, say so
    const at = a.split(' '), bt = b.split(' ');
    const shared = bt.filter((w) => at.includes(w)).length;
    let n = shared * 10 - Math.abs(at.length - bt.length);
    // a qualifier the caller never asked for means a DIFFERENT entry, not a near miss
    for (const w of extrasFor(opts)) if (at.includes(w) && !bt.includes(w)) n -= 60;
    // asked for adult content: the uncensored cut is the one that was wanted
    if (opts && opts.allowUncensored && at.includes('uncensored')) n += 40;
    // a season OR part number that disagrees is disqualifying. Part was missing once and
    // "Final Season Part 1" happily matched "Final Season Part 2" on it.
    for (const kind of ['season', 'part', 'cour']) {
        const re = new RegExp(kind + ' (\\d+)');
        const na = (a.match(re) || [])[1], nb = (b.match(re) || [])[1];
        if (na && nb && na !== nb) n -= 200;
    }
    return n;
}

/* Is this hit plausibly the show that was asked for, or just the closest thing the host
 * happened to return? RANKING CANNOT ANSWER THAT. Sorting a list of one still yields a first
 * place, which is how "BEASTARS FINAL SEASON Part 1" came back as Part 2: the search returned
 * exactly one hit, it was wrong, and ranking it changed nothing.
 */
function titleAcceptable(hitName, wanted, opts) {
    const a = normTitle(hitName), b = normTitle(wanted);
    if (a === b) return true;
    for (const kind of ['season', 'part', 'cour']) {
        const re = new RegExp(kind + ' (\\d+)');
        const na = (a.match(re) || [])[1], nb = (b.match(re) || [])[1];
        if (na && nb && na !== nb) return false;      // different entry, full stop
    }
    // the hit must not introduce a qualifier the caller never asked for
    for (const w of extrasFor(opts)) if (a.split(' ').includes(w) && !b.split(' ').includes(w)) return false;
    /* AND NOTHING ABOUT WORD OVERLAP. A first draft also demanded the hit share 60% of the
     * requested words, which looks sensible and is wrong: hosts list shows under whichever
     * language they prefer. "Kusuriya no Hitorigoto 3rd Season" is listed as "The Apothecary
     * Diaries Season 3" and shares ZERO words with it, so the overlap rule refused a
     * perfectly correct match and made the show unplayable. The host returned this hit FOR
     * this query, so relatedness is already implied; what actually has to be checked is that
     * it is not a DIFFERENT ENTRY, which the number and qualifier tests above do. */
    return true;
}

/* Progressively broader queries. The host's own search is the weak link: asking it for the
 * EXACT title can return fewer and worse hits than asking for less. Measured 2026-11-04:
 *   "BEASTARS FINAL SEASON Part 1" -> 1 hit,  Final Season Part 2        (wrong)
 *   "Beastars Final Season"        -> 2 hits, incl. "Beastars Final Season" (right)
 *   "Beastars"                     -> 4 hits, the whole franchise
 * Part 1 is listed as plain "Beastars Final Season" with no "Part" in it, so the more
 * precisely we asked, the worse the answer got. */
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

/* The track the player would actually choose, mirroring the UI's ranking so the file counted
 * server-side is the file shown. Forced last, English first. */
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

/* The tier is a BAND, not an exact tie. Requiring s === best was too tight: duplicate
 * listings of the SAME show are named slightly differently (a word more, a colon, a
 * different romanization) and scored a few points apart, so the walk was left with one
 * candidate and no alternative when that one carried a dead track. Cowboy Bebop fell to a
 * 1-cue file and "Super no Ura de Yani Suu Futari" stopped resolving at all.
 *
 * TIER_SLACK sits well under the penalties that mark a DIFFERENT entry (-60 for an
 * unasked-for qualifier, -200 for a season or part mismatch), so near-identical names stay
 * together and other seasons stay out. */
const TIER_SLACK = 25;

/**
 * Filter to the listings that are plausibly the requested show, then keep only the
 * best-scoring tier. Returns [] when nothing is acceptable, which callers must treat as
 * "refuse to play" rather than "pick the first one anyway".
 */
function acceptableTier(hits, title, opts) {
    const ok = (hits || []).filter((h) => titleAcceptable(h.name, title, opts));
    if (!ok.length) return [];
    const scored = ok.map((h) => ({ h, s: titleScore(h.name, title, opts) }))
                     .sort((x, y) => y.s - x.s);
    const best = scored[0].s;
    return scored.filter((x) => x.s >= best - TIER_SLACK).map((x) => x.h);
}

module.exports = {
    normTitle, titleScore, titleAcceptable, queryLadder, bestTrack, acceptableTier,
    EXTRA, TIER_SLACK,
};
