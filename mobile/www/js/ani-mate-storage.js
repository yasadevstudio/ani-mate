// YASA PRESENTS
// ani-mate-storage.js - ANI-MATE Storage Layer (Android)
// Uses Capacitor Filesystem for persistent JSON storage

const DATA_DIR = 'ani-mate-data';
const HISTORY_FILE = 'history.json';
const FAVORITES_FILE = 'favorites.json';

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
        favs.unshift(entry);
        await saveFavorites(favs);
    }
    return favs;
}

async function removeFavorite(id) {
    const favs = (await loadFavorites()).filter(f => f.id !== id);
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
    removeFavorite
};
