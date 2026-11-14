/**
 * ani-mate-franchise.js — ONE answer to "what franchise is this, and which season".
 *
 * ⛔ THIS FILE EXISTS BECAUSE THE ANSWER WAS WRITTEN FOUR TIMES AND ALL FOUR WERE WRONG.
 * Measured 2026-11-09:
 *
 *     ui/ani-mate-ui.html            groupByFranchise + an inline copy in renderFavorites
 *     mobile/www/js/ani-mate-ui.js   groupByFranchise again, byte-identical logic
 *     tests/franchise-regression.py  card_opens(), a Python port of it
 *
 * Every one of them began `if (r.franchise_id)`, and 19 of the 24 rows in a real library
 * have no franchise_id — so none of them grouped anything the server had not already
 * tagged. Each fix went into one copy. The Python port's own docstring records it drifting
 * once and "reported a working fix as a failure".
 *
 * ⚠ SO DO NOT COPY A FUNCTION OUT OF HERE INTO A RENDERER. Add an argument instead. The
 * duplication IS the bug class, not a symptom of it.
 *
 * ── HOW IT IS LOADED ─────────────────────────────────────────────────────────────────
 * The same three-consumer arrangement as ani-mate-sync.js, and the same rule:
 *
 *     desktop   served at /ani-mate-franchise.js by server/ani-mate-server.js
 *     phone     copied into mobile/www/js/ by `npm run sync:shared`, shipped in the APK
 *     node      require()d by the test suites
 *
 * > RUN `npm run sync:shared` AFTER ANY EDIT, AND `npm run sync:verify` BEFORE A RELEASE.
 * > It exits non-zero on drift. Two platforms that disagree about what a franchise is do
 * > not produce a broken half — they produce two devices that group the same library
 * > differently.
 *
 * Nothing here touches `state`, the DOM, or the network. It is pure functions over rows,
 * which is why it can be tested exhaustively and why the platform glue stays thin.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;    // node
    root.AniMateFranchise = api;                                               // browser
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* Season and part markers, in one place. Used for stripping them off a title, for
     * reading a season number out of one, and for deciding whether a row is a season. */
    const MARKERS = '(?:\\d+\\s*(?:st|nd|rd|th)\\s+Season|Season\\s*\\d+|Part\\s*\\d+'
                  + '|Cour\\s*\\d+|Final Season|The Final Season'
                  /* Spelled out: "Mobile Suit Gundam 00 Second Season". Without this that
                   * title was its own franchise next to "Mobile Suit Gundam 00". */
                  + '|(?:Second|Third|Fourth|Fifth)\\s+Season)';
    const SPELLED = { second: 2, third: 3, fourth: 4, fifth: 5 };
    /* `(?:\s*(?:&|and|-|~|+)\s*\d+)?` catches a PAIRED part. Without it
     * "Tensei Shitara Slime Datta Ken 4th Season Part 1 & 2" strips to
     * "... & 2" and never merges with season 1. */
    const STRIP = new RegExp('\\s*[:\\-]?\\s*\\b' + MARKERS
                           + '(?:\\s*(?:&|and|-|~|\\+)\\s*\\d+)?\\b', 'gi');
    const HAS_MARKER = new RegExp('\\b' + MARKERS + '\\b', 'i');
    const NOT_A_SEASON = ['MOVIE', 'OVA', 'SPECIAL', 'MUSIC'];
    /* A season marker, then a separator, then more words: "The Final Season - Kanketsu-hen",
     * "Season 2: War of Underworld". What follows the marker is that SEASON's subtitle and
     * no part of the franchise's name. Without this the base of
     * "Shingeki no Kyojin: The Final Season - Kanketsu-hen" came out as
     * "shingeki no kyojin - kanketsu-hen", and the last part of the show stood alone. */
    const AFTER_MARKER = new RegExp('(\\b' + MARKERS + '\\b(?:\\s*(?:&|and|-|~|\\+)\\s*\\d+)?)'
                                  + '\\s*[:\\-\\u2013\\u2014]\\s+\\S.*$', 'i');

    /* ── FRANCHISES NAMED OUTRIGHT ─────────────────────────────────────────────────────
     * Long-running shows whose entries AniList does not link to one another. A title
     * that starts with one of these belongs to it.
     *
     * ⛔ THIS LIST WAS IN TWO FILES, server/ani-mate-server.js and
     * mobile/www/js/ani-mate-api.js, under a comment that said KEEP IN STEP. It had
     * already been out of step once: the phone had 18 where the server had 36, and half
     * the franchises the desktop grouped did not group on the phone. Both read this one. */
    const PATTERNS = [
        'jujutsu kaisen', 'one piece', 'attack on titan', 'shingeki no kyojin',
        'demon slayer', 'kimetsu no yaiba', 'my hero academia', 'boku no hero academia',
        'sword art online', 'naruto', 'dragon ball', 'bleach', 'hunter x hunter',
        'fullmetal alchemist', 'mob psycho', 're zero', 'overlord', 'konosuba',
        'jojo', "jojo's bizarre adventure", 'spy x family', 'spy family',
        'dr stone', 'dr. stone', 'solo leveling', 'ore dake level up',
        'mushoku tensei', 'that time i got reincarnated as a slime', 'tensei shitara slime',
        'danmachi', 'is it wrong to try to pick up girls in a dungeon',
        'chainsaw man', 'vinland saga', 'mashle', 'blue lock', 'frieren',
        'oshi no ko',
    ];

    /* A digit that follows "No." (or "#", or "Number") is part of the NAME: "Kaiju No. 8"
     * is not the eighth season of "Kaiju No.". Returns the title without a trailing
     * sequel digit, or the title unchanged when the digit is not one. */
    const NUMBER_WORD = /^(?:no\.?|n[o\u00ba\u00b0]\.?|number|#)$/i;
    function dropSequelDigit(t) {
        const m = t.match(/^(.*\S)\s+[2-9]$/);
        if (!m) return t;
        const prev = m[1].split(/\s+/).pop();
        return NUMBER_WORD.test(prev) || /#$/.test(prev) ? t : m[1];
    }

    /** A display name with the season markers taken off. */
    function franchiseName(n) {
        return String(n || '').replace(AFTER_MARKER, '$1').replace(STRIP, '')
            .replace(/\s{2,}/g, ' ').replace(/[\s:\-]+$/, '').trim() || n;
    }

    /**
     * The franchise key a title implies, lowercased.
     *
     * ⛔ NEVER KEY A FRANCHISE OFF `franchise_id` ALONE. In a real 24-row library only 5
     * rows carry one, and the two Beastars rows DISAGREE — one says '107660', the other
     * says nothing. A title is always present, so the key is derived and the stored id is
     * demoted to one merge signal among several.
     */
    function franchiseBase(name) {
        let t = String(name || '').replace(AFTER_MARKER, '$1').replace(STRIP, '')
            .replace(/\s{2,}/g, ' ').replace(/[\s:\-]+$/, '').trim();

        /* Seasons are often arc names rather than numbers — "Tokyo Revengers:
         * Tenjiku-hen". Strip a trailing ": subtitle", but ONLY when the head is
         * substantial.
         *
         * ⚠ THE GUARD IS NOT OPTIONAL. Without it "Re:ZERO ..." reduces to "re", which
         * merges every unrelated show whose title starts "Re:". Measured against a real
         * library: with the guard, 6 correct franchises form and nothing false-merges. */
        const i = t.indexOf(':');
        if (i > 0) {
            const head = t.slice(0, i).trim();
            if (head.length >= 8 && head.split(/\s+/).length >= 2) t = head;
        }

        /* Trailing sequel markers, after the colon split so "Clevatess II: Majuu no Ou"
         * and "Mushoku Tensei III: ..." reduce to the franchise. Roman numerals II-IV
         * only; "V" eats real titles.
         *
         * A bare trailing number is restricted to ONE digit 2-9, and the restriction is
         * the point: season 1 is never numbered, and excluding multi-digit numbers keeps
         * "Mob Psycho 100", "Zom 100", "Gundam 00" and "Steins;Gate 0" intact.
         * "Cyberpunk: Edgerunners 2" needs this — its colon head is one word, so the
         * split above declines it and nothing else would merge it with season 1. */
        t = dropSequelDigit(t.replace(/\s+(?:II|III|IV)$/, ''))
             .replace(/[\s:\-&+]+$/, '').trim();
        return t.toLowerCase();
    }

    /**
     * Which season this is, read off the title. 1 when nothing says otherwise, 900 for a
     * final season.
     *
     * ⛔ THIS IS THE ONLY ORDERING SIGNAL A STORED FAVORITE HAS. Every row in a real
     * favorites file has `start_key: null` and `anilist_format: null`, so a sort on
     * format-then-date is a NO-OP on them and `members[0]` is whichever season was
     * starred first. That is how a FAVS card came out reading "BEASTARS FINAL SEASON
     * Part 1".
     */
    function seasonOrdinal(name) {
        const t = String(name || '');
        if (/\bfinal\s+season\b/i.test(t)) return 900;        // last, whatever its number
        let m = t.match(/\b(\d+)\s*(?:st|nd|rd|th)\s+Season\b/i)
             || t.match(/\bSeason\s*(\d+)\b/i)
             || t.match(/\bCour\s*(\d+)\b/i);
        if (m) return parseInt(m[1], 10) || 1;
        m = t.match(/\b(Second|Third|Fourth|Fifth)\s+Season\b/i);
        if (m) return SPELLED[m[1].toLowerCase()];
        m = t.match(/\s+(II|III|IV)\b/);
        if (m) return { II: 2, III: 3, IV: 4 }[m[1]];
        m = t.match(/(\S+)\s+([2-9])(?:\s*(?:&|and|-|~|\+)\s*\d+)?\s*$/);
        /* ...unless the digit follows "No.": "Kaiju No. 8" is season 1 of its show. */
        if (m && !NUMBER_WORD.test(m[1]) && !/#$/.test(m[1])) return parseInt(m[2], 10);
        m = t.match(/\bPart\s*(\d+)\b/i);                     // a part with no season word
        if (m) return parseInt(m[1], 10);
        return 1;
    }

    /** Which PART of its season this is: 0 when the title names none. Breaks the tie
     *  seasonOrdinal leaves between "FINAL SEASON Part 1" and "FINAL SEASON Part 2" (both
     *  900) and between "Season 2 Part 1" and "Season 2 Part 2" (both 2). */
    function partOrdinal(name) {
        const m = String(name || '').match(/\bPart\s*(\d+)\b/i)
               || String(name || '').match(/\bCour\s*(\d+)\b/i);
        return m ? (parseInt(m[1], 10) || 0) : 0;
    }

    /* How many leading words a set of titles share. Used to label a chip by what
     * DISTINGUISHES it: over "Dragon Ball", "Dragon Ball Z", "Dragon Ball GT" the shared
     * prefix is two words and the labels are S1, Z, GT.
     *
     * Words are compared with trailing punctuation stripped. "Tokyo Revengers" and
     * "Tokyo Revengers: Seiya Kessen-hen" differ at word 2 only because of the colon, so
     * the prefix collapsed to "Tokyo" and every chip read "Revengers...". 2026-10-13.
     *
     * (This sat in both UI files, identical, and was handed in as an argument.) */
    function commonPrefixWords(names) {
        const list = (names || []).filter(Boolean).map(String);
        if (list.length < 2) return 0;
        const w = (x) => (x || '').toLowerCase().replace(/[:\uFF1A\-\u2013\u2014,.]+$/, '');
        const split = list.map(n => n.split(/\s+/));
        let i = 0;
        while (split.every(parts => parts[i] !== undefined && w(parts[i]) === w(split[0][i]))) i++;
        return i;
    }

    /**
     * The chip label for one row, given its spine siblings.
     *
     * ⛔ ORDER IS THE WHOLE BUG HERE. "Part N" used to be checked alongside the season
     * patterns, so "BEASTARS FINAL SEASON Part 1" matched Part and returned 'S1' — the
     * same label as season 1. Measured in the real DOM: the strip read S1 | S2 | S1, the
     * second S1 being the final season and marked active. A final season is NAMED, never
     * numbered; nobody calls Beastars "season 4".
     */
    function seasonLabel(r, siblings, prefixWords) {
        const n = (r && r.name) || '';
        if (/\bfinal\s+season\b/i.test(n)) {
            const fp = n.match(/\bPart\s*(\d+)/i);
            return fp ? 'FINAL P' + fp[1] : 'FINAL';
        }
        /* A season AND a part is both, in that order — matching the season alone labels
         * "Season 2 Part 1" and "Season 2 Part 2" identically. */
        let m = n.match(/\bSeason\s*(\d+)\s*Part\s*(\d+)/i)
             || n.match(/(\d+)\s*(?:st|nd|rd|th)\s+Season\s*Part\s*(\d+)/i);
        if (m) return 'S' + m[1] + 'P' + m[2];
        m = n.match(/(\d+)\s*(?:st|nd|rd|th)\s+Season/i)
         || n.match(/\bSeason\s*(\d+)/i)
         || n.match(/\bS(\d+)\b/);
        if (m) return 'S' + m[1];
        /* A bare "Part N" is a part, not a season. It used to render as 'S'+N, claiming a
         * season number the title never gave. */
        m = n.match(/\bPart\s*(\d+)/i);
        if (m) return 'P' + m[1];

        /* The third argument is accepted for callers that still pass their own; the
         * module's is the one both platforms use. */
        const k = (typeof prefixWords === 'function' ? prefixWords : commonPrefixWords)(
            (siblings || []).map(s => s && s.name).filter(Boolean));
        if (k > 0) {
            const rest = n.split(/\s+/).slice(k).join(' ')
                          .replace(/^[:\-\u2013\u2014]\s*/, '').trim();
            if (rest) return rest.length > 18 ? rest.slice(0, 17) + '\u2026' : rest;
            return 'S1';                 // this entry IS the shared title: the original
        }
        const c = n.split(':');          // "Show: Arc Name" -> "Arc Name"
        if (c.length > 1) {
            const tail = c.slice(1).join(':').trim();
            if (tail) return tail.length > 18 ? tail.slice(0, 17) + '\u2026' : tail;
        }
        const f = ((r && r.anilist_format) || '').toUpperCase();
        if (NOT_A_SEASON.indexOf(f) >= 0) return f;
        return 'S1';
    }

    /**
     * Is this row part of the season spine, or does it belong behind "+N more"?
     *
     * ⛔ FORMAT IS THE WRONG SIGNAL, IN BOTH DIRECTIONS, AND I GOT IT WRONG TWICE.
     * The original rule was TV / TV_SHORT / the open row — but BEASTARS FINAL SEASON
     * Parts 1 and 2 are both ONA on AniList, because Netflix ships seasons as ONA. So a
     * season he had just asked to navigate to sat in the films-and-specials overflow.
     *
     * ⚠ AND THE OBVIOUS WIDENING IS WORSE. Admitting any row with NO format puts twelve
     * null-format Dragon Ball movies and specials on the spine — measured, 8 chips become
     * 20 — which is the exact wall this filter exists to prevent.
     *
     * What separates a season from a film is that THE TITLE SAYS SO. Measured old -> new:
     * beastars 2 -> 4, dragon ball 8 -> 8, dragon ball super 3 -> 3, tokyo revengers
     * 4 -> 4, mushoku tensei 5 -> 5.
     */
    function isSeasonSpine(x, openId) {
        const f = ((x && x.anilist_format) || '').toUpperCase();
        if (f === 'TV' || f === 'TV_SHORT') return true;
        if (openId !== undefined && String(x && x.id) === String(openId)) return true;
        return HAS_MARKER.test((x && x.name) || '') && NOT_A_SEASON.indexOf(f) < 0;
    }

    const FORMAT_RANK = { TV: 0, TV_SHORT: 1, ONA: 2, MOVIE: 3, OVA: 4, SPECIAL: 5, MUSIC: 6 };

    /* Where a row stands among formats when sorting.
     *
     * ⛔ A ROW WITH NO FORMAT IS NOT "LAST". It used to rank 99, after music videos. A
     * stored favorite has no format until its details have been fetched, and they are
     * fetched a few at a time, so a half-fetched list had season 2 (format TV, rank 0)
     * ahead of season 1 (no format yet, rank 99) and the FAVS card became season 2.
     * An unknown format stands with the series, and the date and the season number
     * decide, unless the TITLE says what the row is. */
    const TITLE_SAYS = [
        [/\b(?:movie|film|gekijou-?ban)\b/i, 3],
        [/\b(?:ova|oad)\b/i, 4],
        [/\b(?:specials?|recap|picture drama)\b/i, 5],
    ];
    function formatRank(row) {
        const f = String((row && row.anilist_format) || '').toUpperCase();
        if (FORMAT_RANK[f] !== undefined) return FORMAT_RANK[f];
        const name = String((row && row.name) || '');
        for (const pair of TITLE_SAYS) if (pair[0].test(name)) return pair[1];
        return 0;
    }

    /**
     * Order seasons for display: series before films, then by release date, then by the
     * season number in the title.
     *
     * ⛔ A DATE DECIDES ONLY WHEN BOTH ROWS HAVE ONE. This was `(a.start_key || 0)`, so
     * every UNDATED row sorted to the front — and on a stored favorites list, where
     * start_key is null on every row, that is all of them.
     */
    function sortSeasons(list) {
        return list.sort(function (a, b) {
            const aFmt = formatRank(a), bFmt = formatRank(b);
            if (aFmt !== bFmt) return aFmt - bFmt;
            const aK = a.start_key || 0, bK = b.start_key || 0;
            if (aK && bK && aK !== bK) return aK - bK;
            const aO = seasonOrdinal(a.name), bO = seasonOrdinal(b.name);
            if (aO !== bO) return aO - bO;
            /* Part 1 before Part 2. Without this the two halves of a final season were
             * ordered by which has more episodes. */
            const aP = partOrdinal(a.name), bP = partOrdinal(b.name);
            if (aP !== bP) return aP - bP;
            return (b.episodes || 0) - (a.episodes || 0);
        });
    }

    /* ── A NAME SHARED BY SEPARATE SERIES ──────────────────────────────────────────────
     * "Mobile Suit Gundam: Iron-Blooded Orphans" and "Mobile Suit Gundam: The Witch from
     * Mercury" are not two seasons of "Mobile Suit Gundam". A subtitle after a colon is
     * usually a season ("Tokyo Revengers: Tenjiku-hen"), which is why franchiseBase()
     * cuts it off. Under a name like this one it is a series of its own.
     *
     * Measured 2026-11-12: both reduced to "mobile suit gundam", became one franchise,
     * and one star tap starred or removed both.
     *
     * Titles cannot always tell the two cases apart, so the cut is refused only on
     * evidence:
     *   - the name is in UMBRELLAS, or
     *   - the rows at hand prove it: TWO OR MORE different subtitles under one name each
     *     have numbered seasons of their own ("...: Iron-Blooded Orphans 2nd Season" and
     *     "...: The Witch from Mercury Season 2").
     * One subtitle with a second season proves nothing: "Tokyo Ghoul:re 2nd Season" and
     * "Sword Art Online: Alicization - War of Underworld 2nd Season" are seasons of their
     * shows. Parts and cours do not count at all: "Dr. Stone: New World Part 2". */
    const UMBRELLAS = ['mobile suit gundam', 'kidou senshi gundam'];
    const NUMBERED_SEASON = /\b(?:\d+\s*(?:st|nd|rd|th)\s+Season|Season\s*\d+|(?:Second|Third|Fourth|Fifth)\s+Season)\b/i;

    /** A title at the colon franchiseBase() would cut it at: { head, long }, lowercased,
     *  where `long` is the base with the subtitle kept. null when there is no such cut. */
    function colonSplit(name) {
        const t = String(name || '').replace(AFTER_MARKER, '$1').replace(STRIP, '')
            .replace(/\s{2,}/g, ' ').replace(/[\s:\-]+$/, '').trim();
        const i = t.indexOf(':');
        if (i <= 0) return null;
        const head = t.slice(0, i).trim();
        if (!(head.length >= 8 && head.split(/\s+/).length >= 2)) return null;
        const long = dropSequelDigit(t.replace(/\s+(?:II|III|IV)$/, ''))
            .replace(/[\s:\-&+]+$/, '').trim();
        return { head: head.toLowerCase(), long: long.toLowerCase() };
    }

    /** The names, among these titles, under which a subtitle is a series and not a season. */
    function umbrellaHeads(titles) {
        const numbered = new Map();          // head -> the subtitles that have a numbered season
        for (const name of (titles || [])) {
            if (!NUMBERED_SEASON.test(String(name || ''))) continue;
            const c = colonSplit(name);
            if (!c) continue;
            if (!numbered.has(c.head)) numbered.set(c.head, new Set());
            numbered.get(c.head).add(c.long);
        }
        const out = new Set(UMBRELLAS);
        numbered.forEach(function (subs, head) { if (subs.size >= 2) out.add(head); });
        return out;
    }

    /**
     * Union rows into franchises on THREE signals: a shared franchise_id, a shared title
     * base, and a shared English-title base.
     *
     * Union rather than priority, because the signals cover different gaps — the id joins
     * rows whose titles differ ("Kusuriya no Hitorigoto" / "The Apothecary Diaries"), and
     * the title base joins rows the server never tagged. Measured on a real library: by
     * id alone 5 of 24 rows group; by this union, 6 correct franchises form.
     *
     * Returns { keyOf(id), keyOfLabel(label) }.
     */
    function franchiseIndex(items) {
        const parent = new Map();
        const add = function (x) { if (!parent.has(x)) parent.set(x, x); return x; };
        const find = function (x) {
            while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
            return x;
        };
        const union = function (a, b) {
            a = find(add(a)); b = find(add(b));
            if (a !== b) parent.set(a, b);
        };

        const titles = [];
        for (const r of (items || [])) {
            if (!r || !r.id) continue;
            titles.push(r.name);
            if (r.title_english) titles.push(r.title_english);
        }
        const umbrellas = umbrellaHeads(titles);
        /* The base of a title among THESE rows: the subtitle stays on under an umbrella. */
        const baseOf = function (name) {
            const c = colonSplit(name);
            return c && umbrellas.has(c.head) ? c.long : franchiseBase(name);
        };

        for (const r of (items || [])) {
            if (!r || !r.id) continue;
            const self = add('id:' + r.id);
            const base = baseOf(r.name);
            if (base) union(self, 'fp:' + base);
            if (r.title_english) {
                const eb = baseOf(r.title_english);
                if (eb && eb !== base) union(self, 'fp:' + eb);
            }
            if (r.franchise_id) union(self, 'fid:' + r.franchise_id);
        }

        /* ONE canonical label per franchise, chosen deterministically — a cache and a
         * stored franchiseId are keyed by it, so it cannot be whichever label happened to
         * win the union.
         *
         * SHORTEST `fp:` LABEL IS NOT ARBITRARY. A component holding fp:dragon ball z,
         * fp:dragon ball super, fp:dragon ball gt and fp:dragon ball canonicalizes to
         * "fp:dragon ball", and searching that bare name is the only query that returns
         * Z, GT, Kai and Daima. A longer label would silently undo the 2026-10-13 "you
         * can only see the latest ones" fix. */
        const byRoot = new Map();
        for (const label of parent.keys()) {
            const r = find(label);
            if (!byRoot.has(r)) byRoot.set(r, []);
            byRoot.get(r).push(label);
        }
        const canon = new Map();
        for (const [root, labels] of byRoot) {
            const fp = labels.filter(l => l.indexOf('fp:') === 0)
                             .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
            const fid = labels.filter(l => l.indexOf('fid:') === 0).sort();
            canon.set(root, fp[0] || fid[0] || labels.slice().sort()[0]);
        }
        return {
            keyOf: function (id) {
                return (parent.has('id:' + id) ? canon.get(find('id:' + id)) : '') || '';
            },
            /* Resolve ANY label to the current canonical — a stored franchiseId, a raw
             * numeric franchise_id off a data- attribute, or a bare franchise name.
             * Without this, a key computed from a smaller pool stops matching the moment
             * the pool grows and the component re-canonicalizes. */
            keyOfLabel: function (label) {
                const v = String(label || '');
                if (!v) return '';
                for (const cand of [v, 'fid:' + v, 'fp:' + franchiseBase(v)]) {
                    if (parent.has(cand)) return canon.get(find(cand)) || '';
                }
                return '';
            },
        };
    }

    /**
     * Group rows into franchises. `pool` is everything the app knows, so two rows in
     * `items` can be siblings via a third row that only exists in favorites.
     *
     * `parentMode`:
     *   'score' (default) — the card opens the best search match. Deliberate, 2026-10-12:
     *                       searching "Dragon Ball Super" must not open Z from 1989.
     *   'first'           — the card IS the first season, for FAVS.
     */
    function groupFranchises(items, pool, parentMode) {
        const list = (items || []).filter(r => r && r.id);
        const idx = franchiseIndex((pool || []).concat(list));
        const franchises = new Map();
        const ungrouped = [];
        const seen = new Set();
        for (const r of list) {
            if (seen.has(String(r.id))) continue;
            seen.add(String(r.id));
            const k = idx.keyOf(r.id) || ('id:' + r.id);
            if (!franchises.has(k)) franchises.set(k, []);
            franchises.get(k).push(r);
        }
        const groups = [];
        for (const [fid, members] of franchises) {
            if (members.length === 1) { ungrouped.push(members[0]); continue; }
            sortSeasons(members);
            const byScore = members.reduce(function (best, m) {
                const ms = m.search_score === undefined || m.search_score === null ? -1 : m.search_score;
                const bs = best.search_score === undefined || best.search_score === null ? -1 : best.search_score;
                return ms > bs ? m : best;
            }, members[0]);
            /* members is sorted series-first then chronological, so members[0] is the
             * first SEASON — not the first thing in the franchise, which could be a
             * movie. */
            groups.push({ franchise_id: fid, members: members,
                          parent: parentMode === 'first' ? members[0] : byScore });
        }
        return { groups: groups, ungrouped: ungrouped, index: idx };
    }

    /** Rows in `pool` whose resolved franchise key matches `fid`, in display order. */
    function siblingsOf(fid, pool) {
        const idx = franchiseIndex(pool || []);
        const want = idx.keyOfLabel(fid) || String(fid);
        const seen = new Set();
        const out = [];
        for (const r of (pool || [])) {
            if (!r || !r.id || seen.has(String(r.id))) continue;
            if (idx.keyOf(r.id) !== want) continue;
            seen.add(String(r.id));
            out.push(r);
        }
        return sortSeasons(out);
    }

    /* ── EVERYTHING THE APP KNOWS, ONE ROW PER SHOW ───────────────────────────────────
     * Pass every list the app is holding. Returns one row per id, and when a show is in
     * more than one list the row carries everything any copy knew.
     *
     * ⛔ THE POOL USED TO BE THE LISTS LAID END TO END, and whoever read it took the first
     * copy of an id it met. A favorite comes first and knows a name and an episode count;
     * the copy fetched for the season bar comes last and knows the format and the date.
     * So for any show the user had starred, the season bar sorted and filtered on a row
     * with no format and no date, which is the row that sorts wrong.
     *
     * Each platform also built its own pool from a different set of lists (the desktop
     * left out the watch history, the phone left out releases). There is one now.
     *
     * A history row names its show `anime_id` / `title`; it is read as a show row. A row
     * with no id (the airing schedule) has nothing to be matched by and is left out.
     * The rows returned are COPIES: nothing here changes the caller's lists. */
    function isBlank(v) {
        return v === undefined || v === null || v === '' || v === 0
            || (Array.isArray(v) && v.length === 0);
    }
    function poolOf() {
        const byId = new Map();
        const out = [];
        for (let i = 0; i < arguments.length; i++) {
            const list = arguments[i];
            if (!Array.isArray(list)) continue;
            for (const raw of list) {
                if (!raw) continue;
                let r = raw;
                if (isBlank(r.id) && !isBlank(r.anime_id)) {
                    r = { id: r.anime_id, name: r.title, title_english: r.title_english || '',
                          episodes: r.total_episodes || 0 };
                }
                if (isBlank(r.id) || isBlank(r.name)) continue;
                const key = String(r.id);
                const have = byId.get(key);
                if (!have) {
                    const copy = Object.assign({}, r);
                    byId.set(key, copy);
                    out.push(copy);
                    continue;
                }
                for (const f of Object.keys(r)) {
                    if (isBlank(have[f]) && !isBlank(r[f])) have[f] = r[f];
                }
            }
        }
        return out;
    }

    /**
     * What the season bar shows for one franchise.
     *
     *   all       every row of the franchise, in display order (siblingsOf)
     *   openId    the show that is open; it is always shown
     *   expanded  true once the user has asked for the films and specials too
     *
     * Returns { shown, hidden, spine }: the rows to draw, HOW MANY ARE NOT DRAWN, and the
     * season rows (the basis for labels).
     *
     * ⛔ `hidden` IS WHAT "+N more" MUST BE DRAWN FROM. Both UIs used to draw the button
     * whenever the franchise had any film or special. When a franchise had fewer than two
     * seasons the bar already showed every row, and the button sat there offering "+3
     * more" and doing nothing when pressed.
     */
    function stripOf(all, openId, expanded) {
        const rows = all || [];
        const spine = rows.filter(function (x) { return isSeasonSpine(x, openId); });
        const shown = expanded ? rows : (spine.length >= 2 ? spine : rows);
        return { shown: shown, hidden: rows.length - shown.length, spine: spine };
    }

    /**
     * Does starring `self` also star `x`? A star covers the SEASONS of a franchise: the
     * series, and the row that was starred. Films, OVAs and specials are reachable from
     * the season bar and do not belong in a list of shows. A row with no format is a
     * season until something says otherwise, because a stored favorite has none.
     * (Each UI file had this as an inline `isSeason`.)
     */
    function isStarMember(x, selfId) {
        if (!x) return false;
        if (selfId !== undefined && String(x.id) === String(selfId)) return true;
        const f = String(x.anilist_format || '').toUpperCase();
        return !f || f === 'TV' || f === 'TV_SHORT' || f === 'ONA';
    }

    /* ── FOUR RULES BOTH UI FILES HAD, WRITTEN OUT IN EACH ─────────────────────────────
     * Each took the same lists and gave the same answer, and each fix had to be made
     * twice. A UI file now hands over its lists and asks. */

    /** The franchise key of one row among everything known. `pool` is poolOf(...); the
     *  row is counted in even when the pool does not hold it yet. */
    function keyIn(item, pool) {
        if (!item || !item.id) return '';
        const all = (pool || []).slice();
        if (!all.some(function (p) { return p && String(p.id) === String(item.id); })) all.push(item);
        return franchiseIndex(all).keyOf(item.id) || ('fp:' + franchiseBase(item.name));
    }

    /** The rows of `list` that are in the same franchise as the row `id`, and that row
     *  itself. `self` is the row when no list holds it yet. */
    function inFranchiseOf(id, list, pool, self) {
        const idx = franchiseIndex((pool || []).concat(self ? [self] : []));
        const mine = idx.keyOf(id);
        return (list || []).filter(function (f) {
            return !!f && !!f.id && (String(f.id) === String(id) || (!!mine && idx.keyOf(f.id) === mine));
        });
    }

    /** Of the rows a search returned, the ones in `self`'s franchise.
     *  @returns {{ key: string, rows: Array }} */
    function narrowToFranchise(self, pool, got) {
        const found = got || [];
        const idx = franchiseIndex((pool || []).concat([self], found));
        const mine = idx.keyOf(self.id);
        return { key: mine, rows: found.filter(function (r) { return idx.keyOf(r.id) === mine; }) };
    }

    /** What a star on `self` covers, given its siblings: the seasons (isStarMember), and
     *  `self`, first, if the siblings did not include it. */
    function starSet(self, siblings) {
        const out = (siblings || []).filter(function (x) { return isStarMember(x, self.id); });
        if (!out.some(function (x) { return String(x.id) === String(self.id); })) out.unshift(self);
        return out;
    }

    return {
        franchiseName: franchiseName,
        franchiseBase: franchiseBase,
        seasonOrdinal: seasonOrdinal,
        partOrdinal: partOrdinal,
        seasonLabel: seasonLabel,
        commonPrefixWords: commonPrefixWords,
        isSeasonSpine: isSeasonSpine,
        isStarMember: isStarMember,
        keyIn: keyIn,
        inFranchiseOf: inFranchiseOf,
        narrowToFranchise: narrowToFranchise,
        starSet: starSet,
        formatRank: formatRank,
        sortSeasons: sortSeasons,
        franchiseIndex: franchiseIndex,
        groupFranchises: groupFranchises,
        siblingsOf: siblingsOf,
        poolOf: poolOf,
        stripOf: stripOf,
        FORMAT_RANK: FORMAT_RANK,
        MARKERS: MARKERS,
        PATTERNS: PATTERNS,
        UMBRELLAS: UMBRELLAS,
    };
});
