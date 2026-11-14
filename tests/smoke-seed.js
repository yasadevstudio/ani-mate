// YASA PRESENTS
/* smoke-seed.js: the small library the platform checks put into an OLDER version of the
 * app before the new one is installed over it (scripts/smoke-windows.js,
 * scripts/smoke-android.js). Three favorites and two history rows, written the way 0.7.1
 * wrote them: no sync identity, no delete journal, nothing 0.7.2 added.
 *
 * The shows are real titles on purpose. Sync names a show by its AniList id, and AniList
 * has to be able to find it; a made-up title would test the fallback and nothing else.
 * The ids are made up: nothing is fetched by them.
 */
'use strict';

const FAVORITES = [
    { id: 'smokeSeedFrieren01', name: 'Sousou no Frieren', title_english: "Frieren: Beyond Journey's End", episodes: 28 },
    { id: 'smokeSeedMonster02', name: 'Monster', title_english: 'Monster', episodes: 74 },
    { id: 'smokeSeedMushishi3', name: 'Mushishi', episodes: 26 },
];

/** History rows as 0.7.1 stored them (desktop: addToForgeHistory; phone: addToHistory).
 *  The first is part-way through episode 4, the second has nothing to resume. */
function history(now) {
    const t = now || Date.now();
    return [
        { anime_id: 'smokeSeedFrieren01', title: 'Sousou no Frieren', episode: '4', quality: 'best', mode: 'sub',
          timestamp: new Date(t - 3600e3).toISOString(), episodes_watched: ['1', '2', '3'], total_episodes: 28,
          playback_time: 312.5, playback_episode: '4', title_english: "Frieren: Beyond Journey's End" },
        { anime_id: 'smokeSeedMonster02', title: 'Monster', episode: '2', quality: 'best', mode: 'dub',
          timestamp: new Date(t - 7200e3).toISOString(), episodes_watched: ['1', '2'], total_episodes: 74,
          playback_time: 0, playback_episode: null },
    ];
}

/** What a later version must still show for those rows. `rows` is its history list. */
function historyKept(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const f = list.find((h) => h && h.anime_id === 'smokeSeedFrieren01');
    const m = list.find((h) => h && h.anime_id === 'smokeSeedMonster02');
    const sorted = (a) => (Array.isArray(a) ? a.map(String).sort().join(',') : '(none)');
    return {
        both: !!f && !!m,
        watched: !!f && !!m && sorted(f.episodes_watched) === '1,2,3' && sorted(m.episodes_watched) === '1,2',
        resume: !!f && Number(f.playback_time) === 312.5 && String(f.playback_episode) === '4',
        saw: JSON.stringify([f && { w: f.episodes_watched, t: f.playback_time, e: f.playback_episode }, m && { w: m.episodes_watched }]),
    };
}

module.exports = { FAVORITES, history, historyKept };
