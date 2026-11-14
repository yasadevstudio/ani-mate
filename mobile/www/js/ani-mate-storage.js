// YASA PRESENTS
// ani-mate-storage.js - ANI-MATE Storage Layer (Android)
// Uses Capacitor Filesystem for persistent JSON storage

const DATA_DIR = 'ani-mate-data';
const HISTORY_FILE = 'history.json';
const FAVORITES_FILE = 'favorites.json';
const DELETED_FILE = 'deleted.json';
const DELETED_KEEP = 2000;

// Capacitor plugin references (loaded after Capacitor initializes)
let Filesystem, Directory, Encoding;

function initStorage() {
    if (window.Capacitor?.Plugins?.Filesystem) {
        Filesystem = window.Capacitor.Plugins.Filesystem;
        // Capacitor 8 enums
        Directory = { Data: 'DATA' };
        Encoding = { UTF8: 'utf8' };
    }
}

async function readJsonFile(filename) {
    try {
        initStorage();
        if (!Filesystem) return null;
        const result = await Filesystem.readFile({
            path: `${DATA_DIR}/${filename}`,
            directory: Directory.Data,
            encoding: Encoding.UTF8
        });
        return JSON.parse(result.data);
    } catch {
        return null;
    }
}

async function writeJsonFile(filename, data) {
    try {
        initStorage();
        if (!Filesystem) {
            // Fallback to localStorage if Filesystem not available (browser testing)
            localStorage.setItem(`animate_${filename}`, JSON.stringify(data));
            return;
        }
        await Filesystem.writeFile({
            path: `${DATA_DIR}/${filename}`,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
            data: JSON.stringify(data, null, 2),
            recursive: true
        });
    } catch (err) {
        // Fallback to localStorage
        localStorage.setItem(`animate_${filename}`, JSON.stringify(data));
    }
}

/* ── FOR SYNC ONLY: strict reads and writes ────────────────────────────────────────
 * The readers above answer null for ANY failure and the callers turn that into an empty
 * list. That is fine for drawing a screen. For sync it was not: an empty list was pushed
 * to the account as "the user deleted everything". Here a missing file is an honest empty
 * list, and a file that exists and will not read or parse THROWS, which stops the sync.
 * The strict writer throws too, instead of quietly parking the data in localStorage where
 * the next read would not look first. */
async function readListStrict(filename) {
    initStorage();
    if (!Filesystem) {
        const raw = localStorage.getItem(`animate_${filename}`);
        const data = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(data)) throw new Error(filename + ' is not a list');
        return data;
    }
    let result;
    try {
        result = await Filesystem.readFile({
            path: `${DATA_DIR}/${filename}`, directory: Directory.Data, encoding: Encoding.UTF8
        });
    } catch (err) {
        /* Missing is not the same as unreadable. Ask whether the file is there. */
        let exists = true;
        try { await Filesystem.stat({ path: `${DATA_DIR}/${filename}`, directory: Directory.Data }); }
        catch { exists = false; }
        if (exists) throw new Error('could not read ' + filename);
        const raw = localStorage.getItem(`animate_${filename}`);
        const data = raw ? JSON.parse(raw) : [];
        return Array.isArray(data) ? data : [];
    }
    const data = JSON.parse(result.data);
    if (!Array.isArray(data)) throw new Error(filename + ' is not a list');
    return data;
}

async function writeListStrict(filename, data) {
    initStorage();
    if (!Filesystem) {
        localStorage.setItem(`animate_${filename}`, JSON.stringify(data));
        return;
    }
    await Filesystem.writeFile({
        path: `${DATA_DIR}/${filename}`, directory: Directory.Data, encoding: Encoding.UTF8,
        data: JSON.stringify(data, null, 2), recursive: true
    });
}

/* ── THE DELETE JOURNAL ────────────────────────────────────────────────────────────
 * ⛔ A DELETE IS RECORDED WHEN THE USER MAKES ONE. Sync used to infer deletes from
 * absence, and a history list capped at 100 rows produces exactly that absence every
 * time show 101 is watched. The two functions where a user removes something write the
 * row's sync key here; the engine sends tombstones from this journal and nothing else,
 * and clears each entry once it has been pushed.
 * { favorites: { key: when }, watch: { key: when } }   Same shape as the desktop's. */
async function loadDeleted() {
    const j = await readJsonFile(DELETED_FILE);
    let o = j;
    if (!o) { try { o = JSON.parse(localStorage.getItem(`animate_${DELETED_FILE}`) || 'null'); } catch { o = null; } }
    return { favorites: (o && o.favorites) || {}, watch: (o && o.watch) || {} };
}

async function saveDeleted(j) {
    for (const kind of ['favorites', 'watch']) {
        const keys = Object.keys(j[kind]);
        if (keys.length > DELETED_KEEP) {
            keys.sort((a, b) => j[kind][a] - j[kind][b]);
            for (const k of keys.slice(0, keys.length - DELETED_KEEP)) delete j[kind][k];
        }
    }
    await writeJsonFile(DELETED_FILE, j);
}

/** Call BEFORE removing the row: the key depends on the row still being in the list. */
async function noteDeleted(kind, list, localId) {
    try {
        const shape = window.ANIMATE_SYNC && window.ANIMATE_SYNC.shape;
        const key = shape ? shape.keyOfLocal(kind, list, localId) : String(localId);
        const j = await loadDeleted();
        j[kind][key] = Date.now();
        await saveDeleted(j);
    } catch (err) { /* the removal itself must still happen */ }
}

async function clearDeleted(kind, keys) {
    const j = await loadDeleted();
    for (const k of (keys || [])) delete j[kind][String(k)];
    await saveDeleted(j);
}

// History operations
async function loadHistory() {
    const data = await readJsonFile(HISTORY_FILE);
    if (data) return data;
    // Fallback to localStorage
    try { return JSON.parse(localStorage.getItem('animate_history.json') || '[]'); } catch { return []; }
}

async function saveHistory(history) {
    await writeJsonFile(HISTORY_FILE, history);
}

async function addToHistory(entry) {
    const history = await loadHistory();
    const existing = history.findIndex(h => h.anime_id === entry.anime_id);
    const ep = String(entry.episode);

    if (existing >= 0) {
        const rec = history[existing];
        rec.episode = ep;
        rec.quality = entry.quality || rec.quality || 'best';
        rec.mode = entry.mode || rec.mode || 'sub';
        rec.timestamp = new Date().toISOString();
        rec.title = entry.title || rec.title;
        if (!Array.isArray(rec.episodes_watched)) rec.episodes_watched = [];
        if (!entry.skip_watched && !rec.episodes_watched.includes(ep)) rec.episodes_watched.push(ep);
        if (entry.total_episodes) rec.total_episodes = entry.total_episodes;
        if (entry.playback_time !== undefined) {
            rec.playback_time = entry.playback_time;
            rec.playback_episode = ep;
        }
        history.splice(existing, 1);
        history.unshift(rec);
    } else {
        history.unshift({
            anime_id: entry.anime_id,
            title: entry.title,
            episode: ep,
            quality: entry.quality || 'best',
            mode: entry.mode || 'sub',
            timestamp: new Date().toISOString(),
            episodes_watched: entry.skip_watched ? [] : [ep],
            total_episodes: entry.total_episodes || null,
            playback_time: entry.playback_time || 0,
            playback_episode: ep
        });
    }

    if (history.length > 100) history.length = 100;
    await saveHistory(history);
    return history[0];
}

async function saveProgress(animeId, episode, playbackTime) {
    const history = await loadHistory();
    const idx = history.findIndex(h => h.anime_id === animeId);
    if (idx >= 0) {
        history[idx].playback_time = playbackTime || 0;
        history[idx].playback_episode = String(episode);
        await saveHistory(history);
    }
}

async function removeFromHistory(animeId) {
    const history = await loadHistory();
    const idx = history.findIndex(h => h.anime_id === animeId);
    if (idx >= 0) {
        await noteDeleted('watch', history, animeId);
        history.splice(idx, 1);
        await saveHistory(history);
    }
}

async function markWatched(animeId, episode) {
    const history = await loadHistory();
    const idx = history.findIndex(h => h.anime_id === animeId);
    if (idx >= 0) {
        const ep = String(episode);
        if (!Array.isArray(history[idx].episodes_watched)) history[idx].episodes_watched = [];
        if (!history[idx].episodes_watched.includes(ep)) {
            history[idx].episodes_watched.push(ep);
        }
        history[idx].playback_time = 0;
        history[idx].playback_episode = null;
        await saveHistory(history);
    }
}

async function getContinueList() {
    const history = await loadHistory();
    return history
        .filter(h => {
            if (!h.total_episodes) return true;
            const watched = Array.isArray(h.episodes_watched) ? h.episodes_watched.length : 1;
            return watched < h.total_episodes;
        })
        .map(h => {
            const watched = Array.isArray(h.episodes_watched) ? h.episodes_watched : [h.episode];
            const numericEps = watched.map(Number).filter(n => !isNaN(n));
            const maxWatched = numericEps.length > 0 ? Math.max(...numericEps) : 0;
            const nextEp = maxWatched + 1;
            const hasResumePosition = h.playback_time && h.playback_time > 10;
            const resumeEpisode = hasResumePosition ? h.playback_episode || h.episode : String(nextEp);
            const resumeTime = hasResumePosition ? h.playback_time : 0;

            return {
                anime_id: h.anime_id,
                title: h.title,
                episode: h.episode,
                episodes_watched: watched,
                total_episodes: h.total_episodes,
                next_episode: nextEp,
                resume_episode: resumeEpisode,
                resume_time: resumeTime,
                mode: h.mode,
                timestamp: h.timestamp
            };
        });
}

// Favorites operations
async function loadFavorites() {
    const data = await readJsonFile(FAVORITES_FILE);
    if (data) return data;
    try { return JSON.parse(localStorage.getItem('animate_favorites.json') || '[]'); } catch { return []; }
}

async function saveFavorites(favs) {
    await writeJsonFile(FAVORITES_FILE, favs);
}

async function addFavorite(item) {
    const favs = await loadFavorites();
    if (!favs.some(f => f.id === item.id)) {
        const entry = { id: item.id, name: item.name, episodes: item.episodes || 0, added: new Date().toISOString() };
        if (item.title_english) entry.title_english = item.title_english;
        if (item.franchise_id) entry.franchise_id = item.franchise_id;
        /* The cover was passed in and dropped here, so every favorite was stored
         * without one and synced to the desktop without one. */
        if (item.cover) entry.cover = item.cover;
        favs.unshift(entry);
        await saveFavorites(favs);
    }
    return favs;
}

async function removeFavorite(id) {
    const before = await loadFavorites();
    if (before.some(f => f.id === id)) await noteDeleted('favorites', before, id);
    const favs = before.filter(f => f.id !== id);
    await saveFavorites(favs);
    return favs;
}

// Export storage functions
window.Storage = {
    loadHistory,
    saveHistory,
    addToHistory,
    saveProgress,
    markWatched,
    removeFromHistory,
    getContinueList,
    loadFavorites,
    saveFavorites,
    addFavorite,
    removeFavorite,
    // for sync
    loadHistoryStrict: () => readListStrict(HISTORY_FILE),
    saveHistoryStrict: (list) => writeListStrict(HISTORY_FILE, list),
    loadFavoritesStrict: () => readListStrict(FAVORITES_FILE),
    saveFavoritesStrict: (list) => writeListStrict(FAVORITES_FILE, list),
    loadDeleted,
    clearDeleted
};
