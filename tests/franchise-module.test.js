// YASA PRESENTS
/* The shared franchise module, on its own: server/ani-mate-franchise.js.
 *
 *     node tests/franchise-module.test.js        # offline, no server, no browser
 *
 * tests/franchise-ui.test.js (a local suite) drives the module through the desktop page's glue with a
 * real 24-row library. This file is the other half: the rules themselves, one case at a
 * time, each one a title or a list that used to come out wrong. Every case below failed
 * on the module as it stood on 2026-11-12 before that day's changes, except the ones
 * marked "still", which pin behavior that was already right and must stay right.
 */
'use strict';
const path = require('path');
const FR = require(path.join(__dirname, '..', 'server', 'ani-mate-franchise.js'));

let fails = 0, passes = 0;
function ok(cond, msg) {
    if (cond) { passes++; console.log('  ok    ' + msg); }
    else { fails++; console.log('  FAIL  ' + msg); }
}
function eq(got, want, msg) {
    const same = JSON.stringify(got) === JSON.stringify(want);
    ok(same, msg + (same ? '' : '   [got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ']'));
}
const section = (s) => console.log('\n' + s);
const names = (rows) => rows.map(r => r.name);

// ── a digit after "No." is the show's name ──────────────────────────────────────────
section('a digit after "No." belongs to the name');
eq(FR.franchiseBase('Kaiju No. 8'), 'kaiju no. 8', 'Kaiju No. 8 keeps its 8');
eq(FR.franchiseBase('Kaiju No. 8 Season 2'), 'kaiju no. 8', 'and its second season has the same base');
eq(FR.seasonOrdinal('Kaiju No. 8'), 1, 'Kaiju No. 8 is season 1, not season 8');
eq(FR.seasonOrdinal('Kaiju No. 8 Season 2'), 2, 'Kaiju No. 8 Season 2 is season 2');
{
    const rows = [{ id: 'k2', name: 'Kaiju No. 8 Season 2' }, { id: 'k1', name: 'Kaiju No. 8' }];
    const g = FR.groupFranchises(rows, rows, 'first');
    eq(g.groups.length, 1, 'the two rows form one franchise');
    eq(g.groups[0] && g.groups[0].parent.name, 'Kaiju No. 8', 'and its card is the first season');
}
eq(FR.franchiseBase('Cyberpunk: Edgerunners 2'), 'cyberpunk: edgerunners', 'still: a bare trailing 2 is a sequel');
eq(FR.seasonOrdinal('Cyberpunk: Edgerunners 2'), 2, 'still: and it is season 2');
eq(FR.franchiseBase('Mob Psycho 100'), 'mob psycho 100', 'still: a number of several digits is the name');
eq(FR.franchiseBase('Steins;Gate 0'), 'steins;gate 0', 'still: a trailing 0 is the name');

// ── what follows a season marker is that season's subtitle ──────────────────────────
section('a subtitle after a season marker');
eq(FR.franchiseBase('Shingeki no Kyojin: The Final Season - Kanketsu-hen'), 'shingeki no kyojin',
   'the last part of the final season has the show\'s base');
eq(FR.franchiseBase('Shingeki no Kyojin: The Final Season'), 'shingeki no kyojin', 'still: so does the final season');
eq(FR.franchiseBase('Shingeki no Kyojin'), 'shingeki no kyojin', 'still: and the show');
eq(FR.franchiseName('Shingeki no Kyojin: The Final Season - Kanketsu-hen'), 'Shingeki no Kyojin',
   'and its display name is the show\'s');
eq(FR.franchiseBase('Sword Art Online: Alicization Season 2 - War of Underworld'),
   FR.franchiseBase('Sword Art Online: Alicization Season 2'), 'a subtitle after "Season 2" changes nothing');
eq(FR.franchiseBase('Tensei Shitara Slime Datta Ken 4th Season Part 1 & 2'),
   'tensei shitara slime datta ken', 'still: a paired part is not a subtitle');
eq(FR.franchiseBase('Re:ZERO -Starting Life in Another World- Season 2'),
   FR.franchiseBase('Re:ZERO -Starting Life in Another World-'), 'still: dashes that belong to a name survive');

// ── parts of a season sort in order ─────────────────────────────────────────────────
section('parts sort in order');
{
    const rows = [
        { id: 'b4', name: 'BEASTARS FINAL SEASON Part 2', episodes: 12 },
        { id: 'b3', name: 'BEASTARS FINAL SEASON Part 1', episodes: 6 },
        { id: 'b2', name: 'Beastars 2nd Season', episodes: 12 },
        { id: 'b1', name: 'Beastars', episodes: 12 },
    ];
    eq(names(FR.sortSeasons(rows.slice())),
       ['Beastars', 'Beastars 2nd Season', 'BEASTARS FINAL SEASON Part 1', 'BEASTARS FINAL SEASON Part 2'],
       'final season Part 1 comes before Part 2, though Part 2 has more episodes');
    eq(FR.partOrdinal('BEASTARS FINAL SEASON Part 2'), 2, 'partOrdinal reads the part');
    eq(FR.partOrdinal('Beastars'), 0, 'and 0 when the title names none');
}
{
    const rows = [{ id: 'a2', name: 'Show Season 2 Part 2', episodes: 13 },
                  { id: 'a1', name: 'Show Season 2 Part 1', episodes: 11 }];
    eq(names(FR.sortSeasons(rows.slice())), ['Show Season 2 Part 1', 'Show Season 2 Part 2'],
       'Season 2 Part 1 comes before Season 2 Part 2');
}

// ── a row with no format is not "last" ──────────────────────────────────────────────
section('a row with no format');
{
    /* A half-fetched favorites list: season 2 has its details, season 1 does not yet. */
    const rows = [
        { id: 's2', name: 'Kusuriya no Hitorigoto 2nd Season', anilist_format: 'TV', start_key: 20250110 },
        { id: 's1', name: 'Kusuriya no Hitorigoto' },
    ];
    const g = FR.groupFranchises(rows, rows, 'first');
    eq(g.groups[0] && g.groups[0].parent.name, 'Kusuriya no Hitorigoto',
       'the card is season 1 even while only season 2 has a format');
    eq(FR.formatRank({ name: 'X' }), 0, 'no format, no hint in the title: ranks with the series');
    eq(FR.formatRank({ name: 'Dragon Ball Z Movie 01' }), 3, 'no format, the title says Movie: ranks with films');
    eq(FR.formatRank({ name: 'Show OVA' }), 4, 'no format, the title says OVA');
    eq(FR.formatRank({ name: 'Dragon Ball Z Movie 01', anilist_format: 'TV' }), 0, 'a real format wins over the title');
    eq(FR.formatRank({ name: 'X', anilist_format: 'MOVIE' }), 3, 'still: MOVIE ranks 3');
}

// ── the pool keeps what every copy knows ────────────────────────────────────────────
section('the pool: one row per show, with everything any copy knew');
{
    const favorite = { id: 'x1', name: 'Show', episodes: 12 };                       // sparse, and first
    const fetched = { id: 'x1', name: 'Show', episodes: 12, anilist_format: 'TV', start_key: 20200101,
                      genres: ['Drama'] };
    const pool = FR.poolOf([favorite], [], [fetched]);
    eq(pool.length, 1, 'one row for one id');
    eq(pool[0].anilist_format, 'TV', 'the format comes from the later, fuller copy');
    eq(pool[0].start_key, 20200101, 'and so does the date');
    ok(favorite.anilist_format === undefined, 'the caller\'s own row is not changed');
    const hist = FR.poolOf([{ anime_id: 'h9', title: 'From History', total_episodes: 24 }]);
    eq(hist[0] && { id: hist[0].id, name: hist[0].name, episodes: hist[0].episodes },
       { id: 'h9', name: 'From History', episodes: 24 }, 'a history row is read as a show row');
    eq(FR.poolOf([{ title: 'No id at all', anilist_id: 5 }]).length, 0, 'a row with no id is left out');
    eq(FR.poolOf(null, undefined, 'x', [null, undefined]).length, 0, 'things that are not lists are ignored');

    /* The case that mattered. Dragon Ball Z is a favorite (a stored row: no format), and
     * the season bar has fetched the franchise, where the same show is described in
     * full. Whether Z stands on the season row is decided by its FORMAT. */
    const fav = [{ id: 'd1', name: 'Dragon Ball', franchise_id: 'fp:dragon ball' },
                 { id: 'd2', name: 'Dragon Ball Z', franchise_id: 'fp:dragon ball' }];
    const fetchedForBar = [
        { id: 'd2', name: 'Dragon Ball Z', franchise_id: 'fp:dragon ball', anilist_format: 'TV', start_key: 19890426 },
        { id: 'd3', name: 'Dragon Ball GT', franchise_id: 'fp:dragon ball', anilist_format: 'TV', start_key: 19960207 },
    ];
    const merged = FR.stripOf(FR.siblingsOf('fp:dragon ball', FR.poolOf(fav, fetchedForBar)), 'd1', false);
    eq(names(merged.shown), ['Dragon Ball', 'Dragon Ball Z', 'Dragon Ball GT'],
       'a favorite takes its format from the fetched copy, so Z is on the season row');
    /* The pool as it used to be built: the lists end to end, first copy wins. */
    const endToEnd = FR.stripOf(FR.siblingsOf('fp:dragon ball', fav.concat(fetchedForBar)), 'd1', false);
    ok(!names(endToEnd.shown).includes('Dragon Ball Z'),
       '(with the lists laid end to end, the favorite\'s bare copy wins and Z drops behind "+1 more")');
}

// ── "+N more" counts what is actually hidden ────────────────────────────────────────
section('the season bar: shown, and how many are not');
{
    const tv = (id, name) => ({ id, name, anilist_format: 'TV' });
    const film = (id, name) => ({ id, name, anilist_format: 'MOVIE' });
    const all = [tv('a', 'Show'), tv('b', 'Show Season 2'), film('c', 'Show Movie'), film('d', 'Show Movie 2')];
    let st = FR.stripOf(all, 'a', false);
    eq([st.shown.length, st.hidden], [2, 2], 'two seasons shown, two films behind "+2 more"');
    st = FR.stripOf(all, 'a', true);
    eq([st.shown.length, st.hidden], [4, 0], 'expanded: all four shown, nothing hidden');
    /* One season and three films: the bar shows all four, so there is nothing to offer. */
    const lone = [tv('a', 'Show'), film('c', 'Show Movie'), film('d', 'Show Movie 2'), film('e', 'Show Movie 3')];
    st = FR.stripOf(lone, 'a', false);
    eq([st.shown.length, st.hidden], [4, 0], 'one season: every row is already shown, so 0 are hidden');
    st = FR.stripOf(all, 'c', false);
    ok(st.shown.some(r => r.id === 'c'), 'the open row is always shown, even when it is a film');
    eq(FR.stripOf([], 'a', false).hidden, 0, 'an empty franchise hides nothing');
}

// ── the reported strip: Tokyo Revengers, opened from FAVS at its last season ────────
section('Tokyo Revengers from FAVS (the strip that read "Chibi Reve | S1 | ... | +4 more")');
{
    /* Four rows the way a favorites file can hold them: no format, no date, and only two
     * of the four carry a franchise id. Then what a search for the franchise returns: the
     * same four fully described, a chibi spinoff that AniList files as an ONA, and a
     * film. */
    const favs = [
        { id: 'trSeiyaKessenxxxx', name: 'Tokyo Revengers: Seiya Kessen-hen', title_english: 'Tokyo Revengers Season 2',
          episodes: 13, franchise_id: '120120', anilist_format: null, start_key: null },
        { id: 'trTenjikuxxxxxxxx', name: 'Tokyo Revengers: Tenjiku-hen', title_english: 'Tokyo Revengers Season 2 Part 2',
          episodes: 13, franchise_id: '120120', anilist_format: null, start_key: null },
        { id: 'trSantenSensouxxx', name: 'Tokyo Revengers: Santen Sensou-hen', title_english: 'Tokyo Revengers: War of the Three Titans Arc',
          episodes: 2, franchise_id: null, anilist_format: null, start_key: null },
        { id: 'trFirstSeasonxxxx', name: 'Tokyo Revengers', title_english: 'Tokyo Revengers',
          episodes: 25, franchise_id: null, anilist_format: null, start_key: null },
    ];
    const id = (re) => favs.find(f => re.test(f.name) && (re.source !== '^Tokyo Revengers$' || f.name === 'Tokyo Revengers')).id;
    const s1 = favs.find(f => f.name === 'Tokyo Revengers').id;
    const last = id(/Santen Sensou/);
    const fetched = [
        { id: s1, name: 'Tokyo Revengers', anilist_format: 'TV', start_key: 20210411, episodes: 24 },
        { id: id(/Seiya Kessen/), name: 'Tokyo Revengers: Seiya Kessen-hen', anilist_format: 'TV', start_key: 20230108, episodes: 13 },
        { id: id(/Tenjiku/), name: 'Tokyo Revengers: Tenjiku-hen', anilist_format: 'TV', start_key: 20231004, episodes: 13 },
        { id: last, name: 'Tokyo Revengers: Santen Sensou-hen', anilist_format: 'TV', start_key: 20261004, episodes: 2 },
        /* Tagged, as the server tags search rows from AniList's own links between
         * entries. A film called "... Movie" has nothing in its TITLE to tie it to the
         * show; the tag is what does. */
        { id: 'chibi', name: 'Tokyo Revengers: Chibi Reve', anilist_format: 'ONA', start_key: 20210412, episodes: 24, franchise_id: '120120' },
        { id: 'film', name: 'Tokyo Revengers Movie', anilist_format: 'MOVIE', start_key: 20210709, episodes: 1, franchise_id: '120120' },
    ];
    eq(favs.length, 4, 'the fixture holds the four seasons');
    const pool = FR.poolOf(favs, fetched);
    const key = FR.franchiseIndex(pool).keyOf(last);
    const sibs = FR.siblingsOf(key, pool);
    const strip = FR.stripOf(sibs, last, false);
    eq(names(strip.shown), ['Tokyo Revengers', 'Tokyo Revengers: Seiya Kessen-hen',
                            'Tokyo Revengers: Tenjiku-hen', 'Tokyo Revengers: Santen Sensou-hen'],
       'the bar is the four seasons, in the order they aired, with the first season first');
    eq(strip.hidden, 2, 'the spinoff and the film are the 2 behind "+2 more"');
    const open = FR.stripOf(sibs, last, true);
    eq(open.shown.length - strip.shown.length, strip.hidden, 'and pressing it reveals exactly those 2');
    eq(FR.seasonLabel(strip.shown[0], strip.spine), 'S1', 'the first chip reads S1');
    ok(!names(strip.shown).includes('Tokyo Revengers: Chibi Reve'), 'the chibi spinoff is not on the season row');
    /* With the lists end to end, the favorites' bare copies win, none of them has a
     * format, and the season row collapses to the one row that is open. */
    const before = FR.stripOf(FR.siblingsOf(key, favs.concat(fetched)), last, false);
    eq(before.spine.length, 1, '(end to end, the only row recognized as a season is the open one)');
}

// ── which rows a star covers ────────────────────────────────────────────────────────
section('which rows a star covers');
ok(FR.isStarMember({ id: 'a', anilist_format: 'TV' }, 'z'), 'a series');
ok(FR.isStarMember({ id: 'a' }, 'z'), 'a row with no format');
ok(FR.isStarMember({ id: 'a', anilist_format: 'ONA' }, 'z'), 'an ONA (how streaming services ship seasons)');
ok(!FR.isStarMember({ id: 'a', anilist_format: 'MOVIE' }, 'z'), 'not a film');
ok(FR.isStarMember({ id: 'a', anilist_format: 'MOVIE' }, 'a'), 'unless the film is the row that was starred');
ok(!FR.isStarMember(null, 'a'), 'and never nothing');

// ── labels, with the prefix rule living in the module ───────────────────────────────
section('chip labels');
{
    const spine = [{ id: 1, name: 'Dragon Ball' }, { id: 2, name: 'Dragon Ball Z' }, { id: 3, name: 'Dragon Ball GT' }];
    eq(spine.map(r => FR.seasonLabel(r, spine)), ['S1', 'Z', 'GT'], 'named entries are labeled by what distinguishes them');
    eq(FR.commonPrefixWords(['Tokyo Revengers', 'Tokyo Revengers: Seiya Kessen-hen']), 2,
       'a trailing colon does not shorten the shared prefix');
    eq(FR.commonPrefixWords(['Only One']), 0, 'one title shares nothing');
    eq(FR.seasonLabel({ name: 'BEASTARS FINAL SEASON Part 1' }, []), 'FINAL P1', 'still: a final season part');
}

// ── a name shared by separate series ───────────────────────────────────────────────
section('a name shared by separate series (Gundam)');
{
    const R = (id, name, extra) => Object.assign({ id, name, episodes: 25 }, extra || {});
    const gundam = [
        R('g79', 'Mobile Suit Gundam'),
        R('ibo1', 'Mobile Suit Gundam: Iron-Blooded Orphans'), R('ibo2', 'Mobile Suit Gundam: Iron-Blooded Orphans 2nd Season'),
        R('wfm1', 'Mobile Suit Gundam: The Witch from Mercury'), R('wfm2', 'Mobile Suit Gundam: The Witch from Mercury Season 2'),
        R('oo1', 'Mobile Suit Gundam 00'), R('oo2', 'Mobile Suit Gundam 00 Second Season'),
    ];
    const g = FR.groupFranchises(gundam, gundam, 'first');
    const groupOf = (id) => (g.groups.find(x => x.members.some(m => m.id === id)) || { members: [] }).members.map(m => m.id);
    eq(groupOf('ibo1'), ['ibo1', 'ibo2'], 'Iron-Blooded Orphans is a franchise of its two seasons');
    eq(groupOf('wfm1'), ['wfm1', 'wfm2'], 'The Witch from Mercury is another');
    eq(groupOf('oo1'), ['oo1', 'oo2'], 'Gundam 00 and its "Second Season", spelled out, are a third');
    ok(g.ungrouped.some(r => r.id === 'g79'), 'and the 1979 series stands alone');
    const idx = FR.franchiseIndex(gundam);
    ok(idx.keyOf('ibo1') !== idx.keyOf('wfm1'), 'so a star on one does not reach the other: '
        + JSON.stringify([idx.keyOf('ibo1'), idx.keyOf('wfm1')]));
    eq(FR.siblingsOf(idx.keyOf('wfm2'), gundam).map(r => r.id), ['wfm1', 'wfm2'], 'the siblings of Mercury Season 2 are Mercury\'s');
    eq(FR.seasonOrdinal('Mobile Suit Gundam 00 Second Season'), 2, '"Second Season" is season 2');
    eq(FR.franchiseBase('Mobile Suit Gundam 00 Second Season'), 'mobile suit gundam 00', 'and its base keeps the 00');

    /* One of the two alone, with the 1979 series: the list of names decides. */
    const two = [R('g79', 'Mobile Suit Gundam'), R('ibo1', 'Mobile Suit Gundam: Iron-Blooded Orphans')];
    eq(FR.groupFranchises(two, two, 'first').groups.length, 0, 'one Gundam series next to the 1979 one is not its second season');

    /* The same series under its two names is still one row's worth of franchise. */
    const both = [R('a', 'Kidou Senshi Gundam: Tekketsu no Orphans', { title_english: 'Mobile Suit Gundam: Iron-Blooded Orphans' }),
                  R('b', 'Mobile Suit Gundam: Iron-Blooded Orphans 2nd Season')];
    eq(FR.groupFranchises(both, both, 'first').groups.length, 1, 'a romaji row and an English row of the same series still meet');
}

section('still one franchise: a subtitle that is a season');
{
    const R = (id, name) => ({ id, name, episodes: 12 });
    const one = (rows, why) => {
        const g = FR.groupFranchises(rows, rows, 'first');
        ok(g.groups.length === 1 && g.groups[0].members.length === rows.length && g.ungrouped.length === 0,
           'still: ' + why + ' (' + g.groups.length + ' group, ' + g.ungrouped.length + ' loose)');
    };
    one([R('1', 'Tokyo Revengers'), R('2', 'Tokyo Revengers: Seiya Kessen-hen'), R('3', 'Tokyo Revengers: Tenjiku-hen')],
        'Tokyo Revengers and its arcs');
    one([R('1', 'Tokyo Ghoul'), R('2', 'Tokyo Ghoul:re'), R('3', 'Tokyo Ghoul:re 2nd Season')],
        'Tokyo Ghoul and both seasons of :re, one subtitle with a second season');
    one([R('1', 'Sword Art Online'), R('2', 'Sword Art Online: Alicization'),
         R('3', 'Sword Art Online: Alicization - War of Underworld'), R('4', 'Sword Art Online: Alicization - War of Underworld 2nd Season')],
        'Sword Art Online through War of Underworld');
    one([R('1', 'Dr. Stone'), R('2', 'Dr. Stone: Stone Wars'), R('3', 'Dr. Stone: New World'), R('4', 'Dr. Stone: New World Part 2'),
         R('5', 'Dr. Stone: Science Future'), R('6', 'Dr. Stone: Science Future Part 2')],
        'Dr. Stone, where two arcs come in parts');
    one([R('1', 'Shingeki no Kyojin'), R('2', 'Shingeki no Kyojin Season 2'), R('3', 'Shingeki no Kyojin: The Final Season'),
         R('4', 'Shingeki no Kyojin: The Final Season Part 2'), R('5', 'Shingeki no Kyojin: The Final Season - Kanketsu-hen')],
        'Shingeki no Kyojin to its last part');
}

// ── the four rules the two UI files each had ────────────────────────────────────────
section('the rules both UI files hand their lists to');
{
    const R = (id, name, extra) => Object.assign({ id, name, episodes: 12 }, extra || {});
    const pool = [R('b1', 'Beastars'), R('b2', 'Beastars Season 2'), R('m', 'Monster')];
    eq(FR.keyIn(pool[1], pool), 'fp:beastars', 'keyIn: a season is in its show\'s franchise');
    eq(FR.keyIn(R('b3', 'BEASTARS FINAL SEASON Part 1'), pool), 'fp:beastars', 'keyIn: a row the pool has not met yet is counted in');
    eq(pool.length, 3, 'keyIn: and the caller\'s list is not changed');
    eq(FR.keyIn(null, pool), '', 'keyIn: no row, no key');
    eq(FR.keyIn(R('x', 'Trigun'), []), 'fp:trigun', 'keyIn: with nothing known, the title\'s own base');

    const favs = [pool[0], pool[2]];
    eq(FR.inFranchiseOf('b2', favs, pool).map(r => r.id), ['b1'], 'inFranchiseOf: the favorites that share a franchise with a row');
    eq(FR.inFranchiseOf('m', favs, pool).map(r => r.id), ['m'], 'inFranchiseOf: a show with no siblings is itself');
    eq(FR.inFranchiseOf('b9', favs, pool, R('b9', 'Beastars Final Season Part 2')).map(r => r.id), ['b1'],
       'inFranchiseOf: a row no list holds is placed by the row handed in');
    eq(FR.inFranchiseOf('nope', favs, pool).map(r => r.id), [], 'inFranchiseOf: an unknown id matches nothing');

    const got = [R('b1', 'Beastars'), R('b2', 'Beastars Season 2'), R('z', 'Zom 100')];
    const mine = FR.narrowToFranchise(R('b3', 'BEASTARS FINAL SEASON Part 1'), [], got);
    eq([mine.key, mine.rows.map(r => r.id)], ['fp:beastars', ['b1', 'b2']], 'narrowToFranchise: of what a search returned, only this show\'s rows');

    const sibs = [R('b1', 'Beastars', { anilist_format: 'TV' }), R('bm', 'Beastars Movie', { anilist_format: 'MOVIE' }),
                  R('b2', 'Beastars Season 2', { anilist_format: 'TV' })];
    eq(FR.starSet(sibs[0], sibs).map(r => r.id), ['b1', 'b2'], 'starSet: a star covers the seasons, not the film');
    eq(FR.starSet(sibs[1], sibs).map(r => r.id), ['b1', 'bm', 'b2'], 'starSet: the row that was starred is covered whatever it is');
    eq(FR.starSet(R('new', 'Beastars Season 3'), sibs).map(r => r.id), ['new', 'b1', 'b2'], 'starSet: and comes first when its siblings did not include it');
}
{
    /* Both UI files now ask the module. If either grows its own copy back, this says so. */
    const fs = require('fs');
    for (const f of [['the desktop page', path.join(__dirname, '..', 'ui', 'ani-mate-ui.html')],
                     ['the phone', path.join(__dirname, '..', 'mobile', 'www', 'js', 'ani-mate-ui.js')]]) {
        const src = fs.readFileSync(f[1], 'utf8');
        ok(/FR\.keyIn\(/.test(src) && /FR\.inFranchiseOf\(/.test(src) && /FR\.narrowToFranchise\(/.test(src) && /FR\.starSet\(/.test(src),
           f[0] + ' asks the module for all four');
    }
}

// ── the named franchises, in one place ──────────────────────────────────────────────
section('the named-franchise list');
ok(Array.isArray(FR.PATTERNS) && FR.PATTERNS.length === 37, 'all 37 names are here (' + (FR.PATTERNS || []).length + ')');
ok(FR.PATTERNS.indexOf('dragon ball') >= 0 && FR.PATTERNS.indexOf("jojo's bizarre adventure") >= 0, 'including dragon ball and jojo');
{
    const fs = require('fs');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'ani-mate-server.js'), 'utf8');
    const phone = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'www', 'js', 'ani-mate-api.js'), 'utf8');
    ok(!/'jujutsu kaisen'/.test(server), 'the server no longer carries its own copy of the list');
    ok(!/'jujutsu kaisen'/.test(phone), 'nor does the phone');
}

console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
process.exit(fails ? 1 : 0);
