// YASA PRESENTS
// ani-mate-ui.js - ANI-MATE Mobile UI Logic (Android)
// Adapted from desktop monolith for single-column mobile layout

(function() {
    'use strict';

    // === VERSION (updated by CI on release builds) ===
    const APP_VERSION = '0.3.4';
    const GITHUB_REPO = 'YASADevStudio/ani-mate';

    // === STATE ===
    const state = {
        mode: 'sub',
        results: [],
        episodes: [],
        selectedAnime: null,
        selectedEpisode: null,
        isPlaying: false,
        hlsInstance: null,
        history: [],
        favorites: [],
        activeTab: 'search',
        dailyResults: [],
        releasesDate: null,
        releasesResults: [],
        continueResults: [],
        pendingAutoEpisode: null,
        pendingResumeTime: 0,
        currentRange: 0,
        autoPlay: false,
        watchedMarked: false,
        currentPlaybackTime: 0,
        progressSaveInterval: null,
        availableLinks: [],
        playerUiVisible: true,
        playerUiTimer: null,
        playLock: false,
        preferEnglish: true
    };

    // === CAPACITOR PLUGINS ===
    const Plugins = window.Capacitor?.Plugins || {};
    const { App, StatusBar, SplashScreen, ScreenOrientation, KeepAwake } = Plugins;

    // === DOM HELPERS ===
    const $ = (id) => document.getElementById(id);
    const video = $('video-player');
    const episodePanel = $('episode-panel');
    const playerOverlay = $('player-overlay');
    const resultsContainer = $('results-container');
    const searchInput = $('search-input');

    // === UTILITIES ===
    function toast(msg, type = 'info') {
        const container = $('toast-container');
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        container.appendChild(el);
        setTimeout(() => el.remove(), 3500);
    }

    function formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function escAttr(str) {
        return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function esc(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function stripHtml(str) {
        return (str || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
    }

    // === NETWORK STATUS ===
    function updateNetworkStatus() {
        const online = navigator.onLine;
        $('status-dot').classList.toggle('online', online);
        $('status-text').textContent = online ? 'ONLINE' : 'OFFLINE';
    }

    // === TAB SWITCHING ===
    function switchTab(tab) {
        state.activeTab = tab;
        document.querySelectorAll('.tab-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === tab));

        $('search-box').style.display = tab === 'search' ? 'block' : 'none';

        if (tab === 'search') {
            if (state.results.length > 0) renderResults();
            else resultsContainer.innerHTML = '<div class="no-results">Search for anime above</div>';
        } else if (tab === 'continue') {
            loadContinue();
        } else if (tab === 'daily') {
            loadDaily();
        } else if (tab === 'releases') {
            if (!state.releasesDate) state.releasesDate = new Date();
            loadReleases();
        } else if (tab === 'favs') {
            renderFavorites();
        }
    }

    // === SEARCH ===
    async function doSearch(query) {
        resultsContainer.innerHTML = '<div class="loading-indicator">SCANNING DATABASE...</div>';
        try {
            state.results = await API.searchAnime(query, state.mode);
            renderResults();
        } catch (err) {
            resultsContainer.innerHTML = `<div class="no-results">Error: ${err.message}</div>`;
            toast(err.message, 'error');
        }
    }

    function groupByFranchise(items) {
        const franchises = {};
        const ungrouped = [];
        for (const r of items) {
            if (r.franchise_id) {
                if (!franchises[r.franchise_id]) franchises[r.franchise_id] = [];
                franchises[r.franchise_id].push(r);
            } else {
                ungrouped.push(r);
            }
        }
        const groups = [];
        const FORMAT_RANK = { TV: 0, TV_SHORT: 1, ONA: 2, MOVIE: 3, OVA: 4, SPECIAL: 5, MUSIC: 6 };
        for (const [fid, members] of Object.entries(franchises)) {
            if (members.length === 1) {
                ungrouped.push(members[0]);
            } else {
                // Sort: TV format first (main series), then by episode count desc
                members.sort((a, b) => {
                    const aFmt = FORMAT_RANK[a.anilist_format] ?? 99;
                    const bFmt = FORMAT_RANK[b.anilist_format] ?? 99;
                    if (aFmt !== bFmt) return aFmt - bFmt;
                    return (b.episodes || 0) - (a.episodes || 0);
                });
                groups.push({ franchise_id: fid, parent: members[0], members });
            }
        }
        return { groups, ungrouped };
    }

    function renderFranchiseCard(group) {
        const r = group.parent;
        const isFav = state.favorites.some(f => f.id === r.id);
        const coverHtml = r.cover ? `<div class="cover-wrap"><img src="${r.cover}" loading="lazy" alt=""></div>` : '';
        const hasEn = r.title_english && r.title_english.toLowerCase() !== r.name.toLowerCase();
        const primaryTitle = (state.preferEnglish && hasEn) ? r.title_english : r.name;
        const count = group.members.length;

        let html = `<div class="franchise-group" data-franchise="${group.franchise_id}">
            <div class="result-card franchise-parent" data-id="${r.id}" data-title="${escAttr(r.name)}" data-eps="${r.episodes}">
                <div class="result-card-row">
                    <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${r.id}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${r.episodes}" data-fav-english="${escAttr(r.title_english || '')}" data-fav-franchise="${r.franchise_id || ''}">${isFav ? '&#9733;' : '&#9734;'}</button>
                    ${coverHtml}
                    <div class="result-info">
                        <div class="result-title">${esc(primaryTitle)}</div>
                        <div class="result-meta"><span class="result-type series">FRANCHISE</span>${count} entries <span class="franchise-toggle">&#9660;</span></div>
                    </div>
                </div>
            </div>
            <div class="franchise-entries" style="display:none;">`;

        for (const m of group.members) {
            const mFav = state.favorites.some(f => f.id === m.id);
            const typeLabel = m.type === 'series' ? 'SERIES' : m.type === 'short' ? 'SHORT' : 'MOVIE';
            const mHasEn = m.title_english && m.title_english.toLowerCase() !== m.name.toLowerCase();
            const mTitle = (state.preferEnglish && mHasEn) ? m.title_english : m.name;
            html += `<div class="result-card franchise-entry" data-id="${m.id}" data-title="${escAttr(m.name)}" data-eps="${m.episodes}">
                <div class="result-card-row">
                    <button class="fav-star-inline ${mFav ? 'active' : ''}" data-fav-id="${m.id}" data-fav-name="${escAttr(m.name)}" data-fav-eps="${m.episodes}" data-fav-english="${escAttr(m.title_english || '')}" data-fav-franchise="${m.franchise_id || ''}">${mFav ? '&#9733;' : '&#9734;'}</button>
                    <div class="result-info">
                        <div class="result-title">${esc(mTitle)}</div>
                        <div class="result-meta"><span class="result-type ${m.type}">${typeLabel}</span>${m.episodes} EP</div>
                    </div>
                </div>
            </div>`;
        }
        html += '</div></div>';
        return html;
    }

    function bindFranchiseToggles(container) {
        container.querySelectorAll('.franchise-parent').forEach(card => {
            // Tap to expand/collapse on mobile
            let tapCount = 0, tapTimer;
            card.addEventListener('click', (e) => {
                if (e.target.closest('.fav-star-inline')) return;
                tapCount++;
                if (tapCount === 1) {
                    tapTimer = setTimeout(() => {
                        tapCount = 0;
                        // Single tap: load the parent anime
                        loadEpisodes(card.dataset.id, card.dataset.title, parseInt(card.dataset.eps) || 0);
                    }, 300);
                } else if (tapCount === 2) {
                    clearTimeout(tapTimer);
                    tapCount = 0;
                    // Double tap: toggle expand
                    const group = card.closest('.franchise-group');
                    const entries = group.querySelector('.franchise-entries');
                    const toggle = card.querySelector('.franchise-toggle');
                    const isOpen = entries.style.display !== 'none';
                    entries.style.display = isOpen ? 'none' : 'block';
                    toggle.innerHTML = isOpen ? '&#9660;' : '&#9650;';
                }
            });
        });
    }

    function renderResults() {
        if (state.results.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results">No results found</div>';
            return;
        }

        const { groups, ungrouped } = groupByFranchise(state.results);

        let html = '';
        if (groups.length > 0) {
            for (const g of groups) html += renderFranchiseCard(g);
        }

        const series = ungrouped.filter(r => r.type === 'series');
        const shorts = ungrouped.filter(r => r.type === 'short');
        const movies = ungrouped.filter(r => r.type === 'movie');

        if (series.length > 0) {
            html += '<div class="section-label">SERIES</div>' + renderCardGroup(series);
        }
        if (shorts.length > 0) {
            html += '<div class="section-label">SHORT SERIES</div>' + renderCardGroup(shorts);
        }
        if (movies.length > 0) {
            html += '<div class="section-label">MOVIES & SPECIALS</div>' + renderCardGroup(movies);
        }

        resultsContainer.innerHTML = html;
        bindCards(resultsContainer);
        bindFranchiseToggles(resultsContainer);
    }

    function renderCardGroup(items) {
        return items.map(r => {
            const isFav = state.favorites.some(f => f.id === r.id);
            const typeLabel = r.type === 'series' ? 'SERIES' : r.type === 'short' ? 'SHORT' : 'MOVIE';
            const coverHtml = r.cover
                ? `<div class="cover-wrap"><img src="${r.cover}" loading="lazy" alt=""></div>`
                : '';
            const hasEn = r.title_english && r.title_english.toLowerCase() !== r.name.toLowerCase();
            const primaryTitle = (state.preferEnglish && hasEn) ? r.title_english : r.name;
            const secondaryTitle = (state.preferEnglish && hasEn) ? r.name : (hasEn ? r.title_english : '');
            return `<div class="result-card" data-id="${r.id}" data-title="${escAttr(r.name)}" data-eps="${r.episodes}">
                <div class="result-card-row">
                    <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${r.id}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${r.episodes}" data-fav-english="${escAttr(r.title_english || '')}" data-fav-franchise="${r.franchise_id || ''}">${isFav ? '&#9733;' : '&#9734;'}</button>
                    ${coverHtml}
                    <div class="result-info">
                        <div class="result-title">${esc(primaryTitle)}</div>
                        ${secondaryTitle ? `<div class="result-title-en">${esc(secondaryTitle)}</div>` : ''}
                        <div class="result-meta"><span class="result-type ${r.type}">${typeLabel}</span>${r.episodes} EP</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    function bindCards(container) {
        container.querySelectorAll('.result-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.fav-star-inline')) return;
                loadEpisodes(card.dataset.id, card.dataset.title, parseInt(card.dataset.eps) || 0);
            });
        });
        container.querySelectorAll('.fav-star-inline').forEach(star => {
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(star.dataset.favId, star.dataset.favName, star.dataset.favEps, star.dataset.favEnglish, star.dataset.favFranchise);
            });
        });
    }

    // === EPISODES ===
    async function loadEpisodes(animeId, title, epCount) {
        // Close player if open (don't auto-show video when switching anime)
        if (state.isPlaying) hidePlayer();

        // Look up English title from available data
        const allSources = [...(state.results || []), ...(state.dailyResults || []), ...(state.favorites || [])];
        const matched = allSources.find(r => r.id === animeId);
        const titleEnglish = matched?.title_english || '';
        const franchiseId = matched?.franchise_id || '';
        state.selectedAnime = { id: animeId, title, epCount, titleEnglish, franchiseId };
        state.selectedEpisode = null;
        state.currentRange = 0;
        updatePlayButton();

        // Show episode panel with preferred title
        const displayTitle = (state.preferEnglish && titleEnglish) ? titleEnglish : title;
        $('panel-title').textContent = displayTitle;
        $('panel-meta').textContent = `${epCount || '?'} episodes // ${state.mode.toUpperCase()}`;
        updatePanelFavStar();
        showEpisodePanel();

        // Fetch description with cover image (background)
        const descEl = $('anime-description');
        descEl.style.display = 'none';
        descEl.innerHTML = '';
        API.getAnimeInfo(title).then(info => {
            if (info && (info.description || info.cover)) {
                const cleanDesc = info.description ? stripHtml(info.description) : '';
                const coverHtml = info.cover ? `<img class="anime-cover-img" src="${esc(info.cover)}" alt="${esc(title)}" loading="lazy">` : '';
                let textHtml = cleanDesc;
                if (info.genres && info.genres.length > 0) {
                    textHtml += `<div class="anime-genres">${info.genres.join(' // ')}</div>`;
                }
                if (info.score) {
                    textHtml += `<span class="anime-score"> ${info.score}%</span>`;
                }
                descEl.innerHTML = `<div class="anime-desc-row">${coverHtml}<div class="anime-desc-text">${textHtml}</div></div>`;
                descEl.style.display = 'block';
            }
        }).catch(() => {});

        // Fetch episodes
        const grid = $('episode-grid');
        grid.innerHTML = '<div class="loading-indicator">LOADING EPISODES...</div>';

        try {
            state.episodes = await API.getEpisodeList(animeId, state.mode);
            renderEpisodeGrid();

            // Auto-select pending episode (from Continue tab)
            if (state.pendingAutoEpisode) {
                const autoEp = state.pendingAutoEpisode;
                const hasResume = state.pendingResumeTime > 0;
                state.pendingAutoEpisode = null;

                if (state.episodes.includes(autoEp) || state.episodes.includes(String(autoEp))) {
                    state.selectedEpisode = String(autoEp);
                    updatePlayButton();
                    highlightEpisode(String(autoEp));

                    if (hasResume) {
                        toast(`Resuming EP ${autoEp} at ${formatTime(state.pendingResumeTime)}...`, 'info');
                        playEpisode();
                    } else {
                        toast(`Ready: EP ${autoEp}`, 'info');
                    }
                }
            }
        } catch (err) {
            grid.innerHTML = `<div class="no-results">Error: ${err.message}</div>`;
            toast(err.message, 'error');
        }
    }

    const RANGE_SIZE = 50;

    function renderEpisodeGrid() {
        const grid = $('episode-grid');
        const rangeSelector = $('range-selector');

        if (state.episodes.length === 0) {
            grid.innerHTML = '<div class="no-results">No episodes available</div>';
            rangeSelector.style.display = 'none';
            return;
        }

        // Range selector for long series
        if (state.episodes.length > RANGE_SIZE) {
            rangeSelector.style.display = 'flex';
            const totalRanges = Math.ceil(state.episodes.length / RANGE_SIZE);
            rangeSelector.innerHTML = '';
            for (let i = 0; i < totalRanges; i++) {
                const start = i * RANGE_SIZE + 1;
                const end = Math.min((i + 1) * RANGE_SIZE, state.episodes.length);
                const btn = document.createElement('button');
                btn.className = `range-btn ${i === state.currentRange ? 'active' : ''}`;
                btn.textContent = `${start}-${end}`;
                btn.addEventListener('click', () => {
                    state.currentRange = i;
                    renderEpisodeGrid();
                });
                rangeSelector.appendChild(btn);
            }
        } else {
            rangeSelector.style.display = 'none';
        }

        // Slice episodes by current range
        const start = (state.currentRange || 0) * RANGE_SIZE;
        const visibleEps = state.episodes.slice(start, start + RANGE_SIZE);

        // Find watched episodes from history
        const histEntry = state.history.find(h => h.anime_id === state.selectedAnime?.id);
        const watchedEps = histEntry?.episodes_watched || [];

        grid.innerHTML = visibleEps.map(ep => {
            const isWatched = watchedEps.includes(String(ep));
            const isPlaying = state.selectedEpisode === ep || state.selectedEpisode === String(ep);
            return `<button class="episode-btn ${isWatched ? 'watched' : ''} ${isPlaying ? 'playing' : ''}"
                data-ep="${ep}">${isWatched ? '&#10003; ' : ''}${ep}</button>`;
        }).join('');

        grid.querySelectorAll('.episode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                state.selectedEpisode = btn.dataset.ep;
                highlightEpisode(btn.dataset.ep);
                updatePlayButton();
                $('panel-meta').textContent = `EP ${btn.dataset.ep} selected // ${state.mode.toUpperCase()}`;
            });
        });
    }

    function highlightEpisode(ep) {
        document.querySelectorAll('.episode-btn').forEach(b => {
            b.classList.toggle('playing', b.dataset.ep === String(ep));
        });
    }

    function showEpisodePanel() {
        episodePanel.classList.add('show');
    }

    function hideEpisodePanel() {
        episodePanel.classList.remove('show');
    }

    function updatePlayButton() {
        $('play-btn').disabled = !(state.selectedAnime && state.selectedEpisode);
    }

    function updatePanelFavStar() {
        if (!state.selectedAnime) return;
        const star = $('panel-fav');
        const isFav = state.favorites.some(f => f.id === state.selectedAnime.id);
        star.innerHTML = isFav ? '&#9733;' : '&#9734;';
        star.classList.toggle('active', isFav);
    }

    // === VIDEO PLAYER ===
    async function playEpisode() {
        if (!state.selectedAnime || !state.selectedEpisode || state.playLock) return;
        state.playLock = true;

        const quality = $('quality-select').value;
        toast(`Loading EP ${state.selectedEpisode}...`, 'info');

        try {
            const data = await API.getEpisodeUrl(
                state.selectedAnime.id,
                state.selectedEpisode,
                state.mode,
                quality
            );

            if (!data || !data.url) {
                toast('No stream URL available', 'error');
                return;
            }

            state.availableLinks = data.all_links || [];

            // Update history
            await Storage.addToHistory({
                anime_id: state.selectedAnime.id,
                title: state.selectedAnime.title,
                episode: state.selectedEpisode,
                quality: data.resolution || quality,
                mode: state.mode,
                total_episodes: state.selectedAnime.epCount || null
            });
            state.history = await Storage.loadHistory();

            // Update UI with preferred title
            const playTitle = (state.preferEnglish && state.selectedAnime.titleEnglish) ? state.selectedAnime.titleEnglish : state.selectedAnime.title;
            $('player-info').textContent =
                `${playTitle} // EP ${state.selectedEpisode} // ${(data.resolution || quality).toUpperCase()}`;
            $('panel-meta').textContent =
                `EP ${state.selectedEpisode} // ${(data.resolution || quality).toUpperCase()} // ${state.mode.toUpperCase()}`;
            highlightEpisode(state.selectedEpisode);

            // Reset watched tracking
            state.watchedMarked = false;
            state.currentPlaybackTime = 0;

            // Launch player
            showPlayer(data.url);
            toast(`Playing: ${playTitle} EP ${state.selectedEpisode}`, 'success');
        } catch (err) {
            toast(`Playback error: ${err.message}`, 'error');
        } finally {
            state.playLock = false;
        }
    }

    function showPlayer(streamUrl) {
        playerOverlay.classList.remove('hidden');
        $('player-loading').classList.remove('hidden');
        state.isPlaying = true;

        // Capacitor: landscape + keep awake + hide status bar
        try { ScreenOrientation?.lock({ orientation: 'landscape' }); } catch (e) {}
        try { KeepAwake?.keepAwake(); } catch (e) {}
        try { StatusBar?.hide(); } catch (e) {}

        // Watch time tracking
        video.removeEventListener('timeupdate', watchTimeHandler);
        video.addEventListener('timeupdate', watchTimeHandler);

        // Save progress every 30s
        if (state.progressSaveInterval) clearInterval(state.progressSaveInterval);
        state.progressSaveInterval = setInterval(saveProgress, 30000);

        // Destroy previous HLS instance
        if (state.hlsInstance) {
            state.hlsInstance.destroy();
            state.hlsInstance = null;
        }

        const isM3u8 = streamUrl.includes('.m3u8') || streamUrl.includes('master.txt');

        if (isM3u8 && Hls.isSupported()) {
            const hls = new Hls();
            state.hlsInstance = hls;

            hls.loadSource(streamUrl);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                $('player-loading').classList.add('hidden');
                if (state.pendingResumeTime > 0) {
                    video.currentTime = state.pendingResumeTime;
                    state.pendingResumeTime = 0;
                }
                video.play().catch(() => {});
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    // Auto-fallback: try next available link
                    const currentUrl = streamUrl;
                    const remaining = state.availableLinks.filter(l => l.url !== currentUrl);
                    if (remaining.length > 0) {
                        const next = remaining[0];
                        state.availableLinks = remaining;
                        toast(`Trying ${next.provider} (${next.resolution})...`, 'info');
                        hls.destroy();
                        state.hlsInstance = null;
                        showPlayer(next.url);
                    } else {
                        $('player-loading').classList.add('hidden');
                        toast('All streams failed — try another quality', 'error');
                    }
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl') && isM3u8) {
            // Native HLS (Safari/WebKit)
            video.src = streamUrl;
            video.addEventListener('loadedmetadata', () => {
                $('player-loading').classList.add('hidden');
                if (state.pendingResumeTime > 0) {
                    video.currentTime = state.pendingResumeTime;
                    state.pendingResumeTime = 0;
                }
                video.play().catch(() => {});
            }, { once: true });
        } else {
            // Direct MP4 or other format
            video.src = streamUrl;
            video.addEventListener('loadeddata', () => {
                $('player-loading').classList.add('hidden');
                if (state.pendingResumeTime > 0) {
                    video.currentTime = state.pendingResumeTime;
                    state.pendingResumeTime = 0;
                }
                video.play().catch(() => {});
            }, { once: true });
            video.addEventListener('error', () => {
                const remaining = state.availableLinks.filter(l => l.url !== streamUrl);
                if (remaining.length > 0) {
                    const next = remaining[0];
                    state.availableLinks = remaining;
                    toast(`Trying ${next.provider} (${next.resolution})...`, 'info');
                    showPlayer(next.url);
                } else {
                    $('player-loading').classList.add('hidden');
                    toast('All streams failed — try another quality', 'error');
                }
            }, { once: true });
        }

        // Show player UI initially, auto-hide after 4s
        showPlayerUi();
    }

    function hidePlayer() {
        saveProgress();
        if (state.progressSaveInterval) {
            clearInterval(state.progressSaveInterval);
            state.progressSaveInterval = null;
        }

        playerOverlay.classList.add('hidden');
        video.pause();
        video.removeAttribute('src');
        video.load();

        if (state.hlsInstance) {
            state.hlsInstance.destroy();
            state.hlsInstance = null;
        }
        state.isPlaying = false;

        // Capacitor: unlock orientation + allow sleep + show status bar
        try { ScreenOrientation?.unlock(); } catch (e) {}
        try { KeepAwake?.allowSleep(); } catch (e) {}
        try { StatusBar?.show(); } catch (e) {}
    }

    function watchTimeHandler() {
        if (state.watchedMarked || !state.selectedAnime || !state.selectedEpisode) return;
        const currentTime = video.currentTime;
        const duration = video.duration || Infinity;
        state.currentPlaybackTime = currentTime;

        // Mark as watched after 80% of video OR 20 minutes
        const threshold = Math.min(1200, duration * 0.8);
        if (currentTime >= threshold) {
            state.watchedMarked = true;
            Storage.markWatched(state.selectedAnime.id, state.selectedEpisode);

            // Update local state
            const histEntry = state.history.find(h => h.anime_id === state.selectedAnime.id);
            if (histEntry) {
                if (!Array.isArray(histEntry.episodes_watched)) histEntry.episodes_watched = [];
                if (!histEntry.episodes_watched.includes(String(state.selectedEpisode))) {
                    histEntry.episodes_watched.push(String(state.selectedEpisode));
                }
            }
            renderEpisodeGrid();
        }
    }

    function saveProgress() {
        if (!state.selectedAnime || !state.selectedEpisode || !video || !video.currentTime) return;
        Storage.saveProgress(
            state.selectedAnime.id,
            state.selectedEpisode,
            Math.floor(video.currentTime)
        );
    }

    // Handle episode end — autoplay next or mark watched and queue next
    video.addEventListener('ended', async () => {
        if (!state.selectedAnime || !state.episodes.length) return;

        // Mark current episode as watched and clear progress
        if (state.selectedEpisode) {
            try { await Storage.markWatched(state.selectedAnime.id, state.selectedEpisode); } catch (e) {}
            checkFavoritesUpdates();
        }

        const currentIdx = state.episodes.indexOf(state.selectedEpisode);
        const hasNext = currentIdx !== -1 && currentIdx < state.episodes.length - 1;

        if (!hasNext) {
            toast('Series complete!', 'info');
            hidePlayer();
            return;
        }

        const nextEp = state.episodes[currentIdx + 1];
        state.selectedEpisode = nextEp;
        state.pendingResumeTime = 0;
        updatePlayButton();
        highlightEpisode(nextEp);
        $('panel-meta').textContent = `EP ${nextEp} // ${state.mode.toUpperCase()}`;

        if (state.autoPlay) {
            toast(`Auto-playing EP ${nextEp}...`, 'info');
            playEpisode();
        } else {
            hidePlayer();
            toast(`EP ${nextEp} ready — press Play`, 'info');
        }
    });

    // Quality switching during playback (uses cached links)
    $('quality-select').addEventListener('change', (e) => {
        if (!state.isPlaying || state.availableLinks.length === 0) return;
        const wanted = e.target.value;
        let match;
        if (wanted === 'best') match = state.availableLinks[0];
        else if (wanted === 'worst') match = state.availableLinks[state.availableLinks.length - 1];
        else match = state.availableLinks.find(l => l.resolution.includes(wanted));

        if (match) {
            toast(`Switching to ${match.resolution}...`, 'info');
            state.pendingResumeTime = video.currentTime;
            showPlayer(match.url);
        } else {
            toast(`${wanted} not available`, 'error');
        }
    });

    // === PLAYER UI CONTROLS ===
    function showPlayerUi() {
        const ui = $('player-ui');
        ui.classList.remove('fade');
        state.playerUiVisible = true;
        resetUiHideTimer();
    }

    function resetUiHideTimer() {
        clearTimeout(state.playerUiTimer);
        state.playerUiTimer = setTimeout(() => {
            if (!video.paused) {
                $('player-ui').classList.add('fade');
                state.playerUiVisible = false;
            }
        }, 4000);
    }

    function togglePlayerUi() {
        if (state.playerUiVisible) {
            $('player-ui').classList.add('fade');
            state.playerUiVisible = false;
            clearTimeout(state.playerUiTimer);
        } else {
            showPlayerUi();
        }
    }

    function showSeekIndicator(text) {
        const el = $('seek-indicator');
        el.textContent = text;
        el.classList.remove('hidden');
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => el.classList.add('hidden'), 700);
    }

    function updatePlayPauseBtn() {
        const btn = $('ctrl-play');
        if (btn) btn.innerHTML = video.paused ? '&#9654;' : '&#9646;&#9646;';
    }

    // Progress bar updates
    function updateProgressBar() {
        if (!video.duration || !isFinite(video.duration)) return;
        const pct = (video.currentTime / video.duration) * 100;
        $('progress-filled').style.width = pct + '%';
        $('progress-thumb').style.left = pct + '%';
        $('time-current').textContent = formatTime(video.currentTime);
        $('time-total').textContent = formatTime(video.duration);
    }

    function updateBufferedBar() {
        if (!video.duration || !video.buffered.length) return;
        const end = video.buffered.end(video.buffered.length - 1);
        const pct = (end / video.duration) * 100;
        $('progress-buffered').style.width = pct + '%';
    }

    video.addEventListener('timeupdate', updateProgressBar);
    video.addEventListener('progress', updateBufferedBar);
    video.addEventListener('play', updatePlayPauseBtn);
    video.addEventListener('pause', () => {
        updatePlayPauseBtn();
        // Keep UI visible when paused
        showPlayerUi();
        clearTimeout(state.playerUiTimer);
    });
    video.addEventListener('loadedmetadata', () => {
        $('time-total').textContent = formatTime(video.duration);
    });

    // Progress bar seeking (touch + mouse)
    function setupProgressSeeking() {
        const bar = $('progress-bar');
        let seeking = false;

        function seekTo(e) {
            const rect = bar.getBoundingClientRect();
            const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
            const pct = Math.max(0, Math.min(1, x / rect.width));
            if (video.duration && isFinite(video.duration)) {
                video.currentTime = pct * video.duration;
                updateProgressBar();
            }
        }

        bar.addEventListener('touchstart', (e) => {
            seeking = true;
            bar.classList.add('seeking');
            seekTo(e);
            resetUiHideTimer();
        }, { passive: true });

        bar.addEventListener('touchmove', (e) => {
            if (seeking) seekTo(e);
        }, { passive: true });

        bar.addEventListener('touchend', () => {
            seeking = false;
            bar.classList.remove('seeking');
        });

        bar.addEventListener('mousedown', (e) => {
            seeking = true;
            bar.classList.add('seeking');
            seekTo(e);
        });

        document.addEventListener('mousemove', (e) => {
            if (seeking) seekTo(e);
        });

        document.addEventListener('mouseup', () => {
            if (seeking) {
                seeking = false;
                bar.classList.remove('seeking');
            }
        });
    }
    setupProgressSeeking();

    // Control buttons
    function setupControlButtons() {
        $('ctrl-play').addEventListener('click', (e) => {
            e.stopPropagation();
            if (video.paused) video.play();
            else video.pause();
            resetUiHideTimer();
        });

        $('ctrl-rw').addEventListener('click', (e) => {
            e.stopPropagation();
            video.currentTime = Math.max(0, video.currentTime - 10);
            showSeekIndicator('-10s');
            resetUiHideTimer();
        });

        $('ctrl-ff').addEventListener('click', (e) => {
            e.stopPropagation();
            video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
            showSeekIndicator('+10s');
            resetUiHideTimer();
        });

        $('ctrl-next-ep').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.selectedAnime || !state.episodes.length) return;
            const idx = state.episodes.indexOf(state.selectedEpisode);
            if (idx < 0 || idx >= state.episodes.length - 1) {
                toast('No next episode', 'info');
                return;
            }
            const nextEp = state.episodes[idx + 1];
            state.selectedEpisode = nextEp;
            state.pendingResumeTime = 0;
            updatePlayButton();
            highlightEpisode(nextEp);
            $('panel-meta').textContent = `EP ${nextEp} // ${state.mode.toUpperCase()}`;
            toast(`Loading EP ${nextEp}...`, 'info');
            playEpisode();
        });

        $('ctrl-prev-ep').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.selectedAnime || !state.episodes.length) return;
            const idx = state.episodes.indexOf(state.selectedEpisode);
            if (idx <= 0) {
                toast('No previous episode', 'info');
                return;
            }
            const prevEp = state.episodes[idx - 1];
            state.selectedEpisode = prevEp;
            state.pendingResumeTime = 0;
            updatePlayButton();
            highlightEpisode(prevEp);
            $('panel-meta').textContent = `EP ${prevEp} // ${state.mode.toUpperCase()}`;
            toast(`Loading EP ${prevEp}...`, 'info');
            playEpisode();
        });
    }
    setupControlButtons();

    // === TOUCH CONTROLS ===
    function setupTouchControls() {
        let lastTapTime = 0;
        let lastTapZone = null;
        let singleTapTimeout = null;

        function handleTap(zone) {
            const now = Date.now();
            const isDoubleTap = (now - lastTapTime < 300) && lastTapZone === zone;
            lastTapTime = now;
            lastTapZone = zone;

            if (isDoubleTap) {
                // Cancel pending single tap
                clearTimeout(singleTapTimeout);
                // Double tap action
                if (zone === 'left') {
                    video.currentTime = Math.max(0, video.currentTime - 10);
                    showSeekIndicator('-10s');
                } else if (zone === 'right') {
                    video.currentTime += 10;
                    showSeekIndicator('+10s');
                } else if (zone === 'center') {
                    // Double-tap center = toggle fullscreen
                    if (document.fullscreenElement) document.exitFullscreen();
                    else video.requestFullscreen?.().catch(() => {});
                }
            } else {
                // Wait to see if it's a double tap
                singleTapTimeout = setTimeout(() => {
                    if (zone === 'center') {
                        if (video.paused) video.play();
                        else video.pause();
                    }
                    togglePlayerUi();
                }, 300);
            }
        }

        $('tz-left').addEventListener('click', () => handleTap('left'));
        $('tz-center').addEventListener('click', () => handleTap('center'));
        $('tz-right').addEventListener('click', () => handleTap('right'));
    }

    // === CONTINUE WATCHING ===
    async function loadContinue() {
        resultsContainer.innerHTML = '<div class="loading-indicator">LOADING...</div>';
        try {
            state.continueResults = await Storage.getContinueList();
            renderContinue();
        } catch (err) {
            resultsContainer.innerHTML = `<div class="no-results">Error: ${err.message}</div>`;
        }
    }

    function renderContinue() {
        if (state.continueResults.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results">No anime to continue. Start watching!</div>';
            return;
        }

        resultsContainer.innerHTML = '<div class="section-label">CONTINUE WATCHING</div>' +
            state.continueResults.map(r => {
                const watchedCount = Array.isArray(r.episodes_watched) ? r.episodes_watched.length : 1;
                const totalLabel = r.total_episodes ? `${watchedCount}/${r.total_episodes}` : `${watchedCount} watched`;
                const hasResume = r.resume_time && r.resume_time > 10;
                const resumeLabel = hasResume
                    ? `RESUME EP ${r.resume_episode} at ${formatTime(r.resume_time)}`
                    : `NEXT: EP ${r.next_episode}`;
                const resumeEp = hasResume ? r.resume_episode : r.next_episode;
                const resumeTime = hasResume ? r.resume_time : 0;

                // Look up English title from favorites
                const favMatch = state.favorites.find(f => f.id === r.anime_id);
                const contEnglish = favMatch?.title_english || '';
                const contHasEn = contEnglish && contEnglish.toLowerCase() !== (r.title || '').toLowerCase();
                const contPrimary = (state.preferEnglish && contHasEn) ? contEnglish : (r.title || r.anime_id);
                const contSecondary = (state.preferEnglish && contHasEn) ? r.title : (contHasEn ? contEnglish : '');

                return `<div class="result-card" data-id="${r.anime_id}" data-title="${escAttr(r.title)}"
                    data-eps="${r.total_episodes || '?'}" data-resume-ep="${resumeEp}" data-resume-time="${resumeTime}">
                    <div class="result-card-row">
                        <div class="result-info">
                            <div class="result-title">${esc(contPrimary)}</div>
                            ${contSecondary ? `<div class="result-title-en">${esc(contSecondary)}</div>` : ''}
                            <div class="result-meta">
                                <span class="result-type series">${resumeLabel}</span>
                                ${totalLabel} // ${(r.mode || 'sub').toUpperCase()}
                            </div>
                        </div>
                    </div>
                </div>`;
            }).join('');

        // Click to load episodes and auto-select resume episode
        resultsContainer.querySelectorAll('.result-card').forEach(card => {
            card.addEventListener('click', () => {
                state.pendingAutoEpisode = card.dataset.resumeEp;
                state.pendingResumeTime = parseFloat(card.dataset.resumeTime) || 0;
                loadEpisodes(card.dataset.id, card.dataset.title, parseInt(card.dataset.eps) || 0);
            });
            // Long-press to remove from continue watching
            let lpTimer;
            card.addEventListener('touchstart', () => {
                lpTimer = setTimeout(() => {
                    const id = card.dataset.id;
                    const title = card.dataset.title;
                    if (confirm(`Remove "${title}" from history?`)) {
                        Storage.removeFromHistory(id);
                        state.continueResults = state.continueResults.filter(r => r.anime_id !== id);
                        renderContinue();
                        showToast(`Removed "${title}"`);
                    }
                }, 600);
            });
            card.addEventListener('touchend', () => clearTimeout(lpTimer));
            card.addEventListener('touchmove', () => clearTimeout(lpTimer));
        });
    }

    // === DAILY TRENDING ===
    async function loadDaily() {
        resultsContainer.innerHTML = '<div class="loading-indicator">LOADING TRENDING...</div>';
        try {
            state.dailyResults = await API.getDailyPopular(state.mode);
            renderDaily();
        } catch (err) {
            resultsContainer.innerHTML = `<div class="no-results">Error: ${err.message}</div>`;
        }
    }

    function renderDaily() {
        if (state.dailyResults.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results">No trending anime today</div>';
            return;
        }

        resultsContainer.innerHTML = '<div class="section-label">TRENDING TODAY</div>' +
            state.dailyResults.map((r, i) => {
                const isFav = state.favorites.some(f => f.id === r.id);
                const coverHtml = r.cover
                    ? `<div class="cover-wrap"><img src="${r.cover}" loading="lazy" alt=""></div>`
                    : '';
                const hasEn = r.title_english && r.title_english.toLowerCase() !== r.name.toLowerCase();
                const primary = (state.preferEnglish && hasEn) ? r.title_english : r.name;
                const secondary = (state.preferEnglish && hasEn) ? r.name : (hasEn ? r.title_english : '');
                return `<div class="result-card" data-id="${r.id}" data-title="${escAttr(r.name)}" data-eps="${r.episodes}">
                    <div class="result-card-row">
                        <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${r.id}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${r.episodes}" data-fav-english="${escAttr(r.title_english || '')}">${isFav ? '&#9733;' : '&#9734;'}</button>
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title">${esc(primary)}</div>
                            ${secondary ? `<div class="result-title-en">${esc(secondary)}</div>` : ''}
                            <div class="result-meta"><span class="result-type series">#${i + 1}</span>${r.episodes} EP</div>
                        </div>
                    </div>
                </div>`;
            }).join('');

        bindCards(resultsContainer);
    }

    // === RELEASES (AIRING SCHEDULE) ===
    async function loadReleases() {
        if (!state.releasesDate) state.releasesDate = new Date();
        const dateStr = state.releasesDate.toISOString().slice(0, 10);
        resultsContainer.innerHTML = '<div class="loading-indicator">SCANNING SCHEDULE...</div>';

        try {
            state.releasesResults = await API.getAiringSchedule(dateStr);
            renderReleases();
        } catch (err) {
            resultsContainer.innerHTML = `<div class="no-results">Error: ${err.message}</div>`;
        }
    }

    function renderReleases() {
        const results = state.releasesResults;
        const d = state.releasesDate;
        const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const isToday = d.toDateString() === new Date().toDateString();

        let html = `<div class="date-nav">
            <button class="date-nav-btn" id="date-prev">&laquo; PREV</button>
            <span class="date-nav-label">${isToday ? 'TODAY — ' : ''}${dateLabel.toUpperCase()}</span>
            <button class="date-nav-btn" id="date-next">NEXT &raquo;</button>
        </div>`;

        if (results.length === 0) {
            html += '<div class="no-results">No releases this day</div>';
            resultsContainer.innerHTML = html;
            bindDateNav();
            return;
        }

        const slots = { morning: [], afternoon: [], evening: [], night: [] };
        for (const r of results) {
            const h = new Date(r.airingAt * 1000).getHours();
            if (h >= 6 && h < 12) slots.morning.push(r);
            else if (h >= 12 && h < 18) slots.afternoon.push(r);
            else if (h >= 18) slots.evening.push(r);
            else slots.night.push(r);
        }

        const labels = { morning: 'MORNING', afternoon: 'AFTERNOON', evening: 'EVENING', night: 'LATE NIGHT' };

        for (const [slot, items] of Object.entries(slots)) {
            if (items.length === 0) continue;
            html += `<div class="section-label">${labels[slot]}</div>`;
            const nowSec = Math.floor(Date.now() / 1000);
            html += items.map(r => {
                const airTime = new Date(r.airingAt * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const coverHtml = r.cover
                    ? `<div class="cover-wrap"><img src="${r.cover}" loading="lazy" alt=""></div>`
                    : '';
                const isFav = state.favorites.some(f => f.name === r.title || f.name === r.title_romaji);
                const isReleased = r.airingAt <= nowSec;
                const tagHtml = isReleased
                    ? '<span class="release-tag released">RELEASED</span>'
                    : '<span class="release-tag pending">PENDING</span>';
                const relHasEn = r.title && r.title_romaji && r.title.toLowerCase() !== r.title_romaji.toLowerCase();
                const relPrimary = (state.preferEnglish || !relHasEn) ? r.title : r.title_romaji;
                const relSecondary = (state.preferEnglish && relHasEn) ? r.title_romaji : (relHasEn ? r.title : '');
                return `<div class="result-card release-card" data-release-title="${escAttr(r.title)}" data-release-romaji="${escAttr(r.title_romaji)}">
                    <div class="result-card-row">
                        <button class="fav-star-inline ${isFav ? 'active' : ''}" data-rel-fav-title="${escAttr(r.title)}" data-rel-fav-romaji="${escAttr(r.title_romaji || '')}" data-rel-fav-eps="${r.totalEpisodes || 0}">${isFav ? '&#9733;' : '&#9734;'}</button>
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title">${esc(relPrimary)} ${tagHtml}</div>
                            ${relSecondary ? `<div class="result-title-en">${esc(relSecondary)}</div>` : ''}
                            <div class="result-meta">
                                <span class="result-type series">${r.format || 'TV'}</span>
                                EP ${r.episode}${r.totalEpisodes ? '/' + r.totalEpisodes : ''}
                                — <span class="release-time">${airTime}</span>
                            </div>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        resultsContainer.innerHTML = html;
        bindDateNav();
        bindReleaseCards();
    }

    function bindDateNav() {
        $('date-prev')?.addEventListener('click', () => {
            state.releasesDate = new Date(state.releasesDate.getTime() - 86400000);
            loadReleases();
        });
        $('date-next')?.addEventListener('click', () => {
            state.releasesDate = new Date(state.releasesDate.getTime() + 86400000);
            loadReleases();
        });
    }

    function bestTitleMatch(results, targetTitle, targetRomaji) {
        if (!results || results.length === 0) return null;
        const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const targets = [norm(targetTitle), norm(targetRomaji)].filter(Boolean);
        for (const r of results) {
            const names = [norm(r.name), norm(r.title_english)].filter(Boolean);
            if (names.some(n => targets.includes(n))) return r;
        }
        for (const r of results) {
            const names = [norm(r.name), norm(r.title_english)].filter(Boolean);
            if (names.some(rn => targets.some(t => rn.includes(t) || t.includes(rn)))) return r;
        }
        return results[0];
    }

    function bindReleaseCards() {
        document.querySelectorAll('.release-card').forEach(card => {
            card.addEventListener('click', async (e) => {
                if (e.target.closest('.fav-star-inline')) return;
                const title = card.dataset.releaseTitle;
                const romaji = card.dataset.releaseRomaji;
                toast(`Searching for ${title}...`, 'info');

                try {
                    let results = await API.searchAnime(title, state.mode);
                    if (results.length === 0 && romaji && romaji !== title) {
                        results = await API.searchAnime(romaji, state.mode);
                    }
                    if (results.length > 0) {
                        const match = bestTitleMatch(results, title, romaji);
                        loadEpisodes(match.id, match.name, match.episodes);
                    } else {
                        toast('Not found on streaming source', 'error');
                    }
                } catch (err) {
                    toast(`Search error: ${err.message}`, 'error');
                }
            });
        });

        // Bind favorite stars on release cards (async AllAnime lookup)
        document.querySelectorAll('.release-card .fav-star-inline').forEach(star => {
            star.addEventListener('click', async (e) => {
                e.stopPropagation();
                const title = star.dataset.relFavTitle;
                const romaji = star.dataset.relFavRomaji;

                // Check if already favorited by name
                const existing = state.favorites.find(f => f.name === title || (romaji && f.name === romaji));
                if (existing) {
                    state.favorites = await Storage.removeFavorite(existing.id);
                    star.classList.remove('active');
                    star.innerHTML = '&#9734;';
                    toast('Removed from favorites', 'info');
                    updatePanelFavStar();
                    checkFavoritesUpdates();
                    return;
                }

                toast('Adding to favorites...', 'info');
                try {
                    let results = await API.searchAnime(title, state.mode);
                    if (results.length === 0 && romaji && romaji !== title) {
                        results = await API.searchAnime(romaji, state.mode);
                    }
                    if (results.length > 0) {
                        const match = results[0];
                        state.favorites = await Storage.addFavorite({ id: match.id, name: match.name, episodes: match.episodes || 0, title_english: match.title_english || title });
                        star.classList.add('active');
                        star.innerHTML = '&#9733;';
                        toast('Added to favorites', 'success');
                        updatePanelFavStar();
                        checkFavoritesUpdates();
                    } else {
                        toast('Not found on streaming source', 'error');
                    }
                } catch (err) {
                    toast(`Favorites error: ${err.message}`, 'error');
                }
            });
        });
    }

    // === FAVORITES ===
    function renderFavorites() {
        if (state.favorites.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results">No favorites yet. Star an anime to save it.</div>';
            return;
        }

        // Group favorites by franchise
        const franchises = {};
        const ungrouped = [];
        for (const r of state.favorites) {
            if (r.franchise_id) {
                if (!franchises[r.franchise_id]) franchises[r.franchise_id] = [];
                franchises[r.franchise_id].push(r);
            } else {
                ungrouped.push(r);
            }
        }

        let html = '<div class="section-label">FAVORITES</div>';

        for (const [fid, members] of Object.entries(franchises)) {
            if (members.length === 1) { ungrouped.push(members[0]); continue; }
            const parent = members[0];
            const hasEn = parent.title_english && parent.title_english.toLowerCase() !== parent.name.toLowerCase();
            const primary = (state.preferEnglish && hasEn) ? parent.title_english : parent.name;

            html += `<div class="franchise-group" data-franchise="${fid}">
                <div class="result-card franchise-parent" data-id="${parent.id}" data-title="${escAttr(parent.name)}" data-eps="${parent.episodes}">
                    <div class="result-card-row">
                        <button class="fav-star-inline active" data-fav-id="${parent.id}" data-fav-name="${escAttr(parent.name)}" data-fav-eps="${parent.episodes}" data-fav-english="${escAttr(parent.title_english || '')}" data-fav-franchise="${fid}">&#9733;</button>
                        <div class="result-info">
                            <div class="result-title">${esc(primary)}</div>
                            <div class="result-meta"><span class="result-type series">FRANCHISE</span>${members.length} entries <span class="franchise-toggle">&#9660;</span></div>
                        </div>
                    </div>
                </div>
                <div class="franchise-entries" style="display:none;">`;
            for (const m of members) {
                const mHasEn = m.title_english && m.title_english.toLowerCase() !== m.name.toLowerCase();
                const mTitle = (state.preferEnglish && mHasEn) ? m.title_english : m.name;
                html += `<div class="result-card franchise-entry" data-id="${m.id}" data-title="${escAttr(m.name)}" data-eps="${m.episodes}">
                    <div class="result-card-row">
                        <button class="fav-star-inline active" data-fav-id="${m.id}" data-fav-name="${escAttr(m.name)}" data-fav-eps="${m.episodes}" data-fav-english="${escAttr(m.title_english || '')}" data-fav-franchise="${fid}">&#9733;</button>
                        <div class="result-info">
                            <div class="result-title">${esc(mTitle)}</div>
                            <div class="result-meta">${m.episodes} EP</div>
                        </div>
                    </div>
                </div>`;
            }
            html += '</div></div>';
        }

        html += ungrouped.map(r => {
            const hasEn = r.title_english && r.title_english.toLowerCase() !== r.name.toLowerCase();
            const primary = (state.preferEnglish && hasEn) ? r.title_english : r.name;
            const secondary = (state.preferEnglish && hasEn) ? r.name : (hasEn ? r.title_english : '');
            return `<div class="result-card" data-id="${r.id}" data-title="${escAttr(r.name)}" data-eps="${r.episodes}">
                <div class="result-card-row">
                    <button class="fav-star-inline active" data-fav-id="${r.id}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${r.episodes}" data-fav-english="${escAttr(r.title_english || '')}" data-fav-franchise="${r.franchise_id || ''}">&#9733;</button>
                    <div class="result-info">
                        <div class="result-title">${esc(primary)}</div>
                        ${secondary ? `<div class="result-title-en">${esc(secondary)}</div>` : ''}
                        <div class="result-meta">${r.episodes} EP</div>
                    </div>
                </div>
            </div>`;
        }).join('');

        resultsContainer.innerHTML = html;
        bindCards(resultsContainer);
        bindFranchiseToggles(resultsContainer);
    }

    async function toggleFavorite(id, name, episodes, titleEnglish, franchiseId) {
        const isFav = state.favorites.some(f => f.id === id);
        try {
            if (isFav) {
                state.favorites = await Storage.removeFavorite(id);
                toast('Removed from favorites', 'info');
            } else {
                const favData = { id, name, episodes: parseInt(episodes) || 0, title_english: titleEnglish || '' };
                if (franchiseId) favData.franchise_id = franchiseId;
                state.favorites = await Storage.addFavorite(favData);
                toast('Added to favorites', 'success');
            }
        } catch (err) {
            toast(`Favorites error: ${err.message}`, 'error');
        }

        updatePanelFavStar();
        checkFavoritesUpdates();
        // Re-render current tab if it shows stars
        if (state.activeTab === 'favs') renderFavorites();
        else if (state.activeTab === 'daily') renderDaily();
        else if (state.activeTab === 'releases') loadReleases();
        else if (state.activeTab === 'search' && state.results.length > 0) renderResults();
    }

    // === BACK BUTTON (Android) ===
    function setupBackButton() {
        if (!App) return;
        App.addListener('backButton', () => {
            if (state.isPlaying) {
                hidePlayer();
            } else if (episodePanel.classList.contains('show')) {
                hideEpisodePanel();
            } else if (state.activeTab !== 'search') {
                switchTab('search');
            } else {
                App.exitApp();
            }
        });
    }

    // === KEYBOARD SHORTCUTS (Bluetooth keyboards) ===
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

        switch (e.key) {
            case '/':
                e.preventDefault();
                searchInput.focus();
                break;
            case 'Enter':
                if (state.selectedEpisode) playEpisode();
                break;
            case 'Escape':
                if (state.isPlaying) hidePlayer();
                else if (episodePanel.classList.contains('show')) hideEpisodePanel();
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (state.isPlaying) video.currentTime += 10;
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (state.isPlaying) video.currentTime -= 10;
                break;
            case ' ':
                if (state.isPlaying) {
                    e.preventDefault();
                    video.paused ? video.play() : video.pause();
                }
                break;
            case 'f':
                if (state.isPlaying) {
                    if (document.fullscreenElement) document.exitFullscreen();
                    else video.requestFullscreen?.().catch(() => {});
                }
                break;
        }
    });

    // === EVENT LISTENERS ===

    // Search
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const q = e.target.value.trim();
            if (q) { searchInput.blur(); doSearch(q); }
        }
    });

    // Mode toggle
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.mode = btn.dataset.mode;
        });
    });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Play button
    $('play-btn').addEventListener('click', playEpisode);

    // Episode panel back
    $('panel-back').addEventListener('click', hideEpisodePanel);

    // Episode panel fav star
    $('panel-fav').addEventListener('click', () => {
        if (state.selectedAnime) {
            toggleFavorite(state.selectedAnime.id, state.selectedAnime.title, state.selectedAnime.epCount, state.selectedAnime.titleEnglish, state.selectedAnime.franchiseId || '');
        }
    });

    // Player back
    $('player-back').addEventListener('click', hidePlayer);

    // English title toggle (default ON)
    const savedEnglish = localStorage.getItem('ani-mate-english-titles') !== 'false';
    state.preferEnglish = savedEnglish;
    $('english-title-toggle').checked = savedEnglish;
    $('english-title-toggle').addEventListener('change', (e) => {
        state.preferEnglish = e.target.checked;
        localStorage.setItem('ani-mate-english-titles', e.target.checked);
        toast(state.preferEnglish ? 'English titles primary' : 'Japanese titles primary', 'info');
        // Re-render current tab
        if (state.activeTab === 'daily') renderDaily();
        else if (state.activeTab === 'releases') renderReleases();
        else if (state.activeTab === 'search' && state.results.length > 0) renderResults();
        else if (state.activeTab === 'favs') renderFavorites();
        else if (state.activeTab === 'continue') renderContinue();
    });

    // Auto-play toggle
    const savedAutoPlay = localStorage.getItem('ani-mate-autoplay') === 'true';
    state.autoPlay = savedAutoPlay;
    $('autoplay-toggle').checked = savedAutoPlay;
    $('autoplay-toggle').addEventListener('change', (e) => {
        state.autoPlay = e.target.checked;
        localStorage.setItem('ani-mate-autoplay', e.target.checked);
        toast(state.autoPlay ? 'Auto-play ON' : 'Auto-play OFF', 'info');
    });

    // Network status events
    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);

    // === INIT ===
    // === AUTO-UPDATE SYSTEM (In-App Download + Install) ===
    const ApkInstaller = window.Capacitor?.Plugins?.ApkInstaller;

    async function checkForUpdate() {
        try {
            // Use CapacitorHttp directly to avoid fetch interception issues
            const http = window.Capacitor?.Plugins?.CapacitorHttp;
            let release;
            if (http) {
                const resp = await http.get({
                    url: `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
                    headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ANI-MATE-Android' }
                });
                if (resp.status !== 200) return;
                release = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
            } else {
                const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
                    headers: { 'Accept': 'application/vnd.github.v3+json' }
                });
                if (!resp.ok) return;
                release = await resp.json();
            }

            const latest = (release.tag_name || '').replace(/^v/, '');
            if (!latest || !isNewer(latest, APP_VERSION)) return;

            // Find the mobile APK asset
            const apk = (release.assets || []).find(a => a.name.toLowerCase().includes('mobile') && a.name.endsWith('.apk'));
            if (!apk) return;

            // Show update dialog
            showUpdateDialog(latest, apk.browser_download_url, release.body || '');
        } catch (e) {
            // Silent fail - no network or API issue, not critical
            console.warn('Update check failed:', e);
        }
    }

    function isNewer(remote, local) {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        for (let i = 0; i < Math.max(r.length, l.length); i++) {
            const rv = r[i] || 0;
            const lv = l[i] || 0;
            if (rv > lv) return true;
            if (rv < lv) return false;
        }
        return false;
    }

    function showUpdateDialog(version, downloadUrl, changelog) {
        // Remove existing dialog if any
        const existing = document.getElementById('update-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'update-dialog-overlay';
        overlay.className = 'update-overlay';

        const cl = changelog.replace(/\n/g, '<br>').substring(0, 300);

        overlay.innerHTML = `
            <div class="update-dialog">
                <div class="update-dialog-title">UPDATE AVAILABLE</div>
                <div class="update-dialog-version">v${APP_VERSION} → v${version}</div>
                ${cl ? `<div class="update-dialog-changelog">${cl}</div>` : ''}
                <div class="update-dialog-progress hidden" id="update-progress">
                    <div class="update-progress-bar"><div class="update-progress-fill" id="update-progress-fill"></div></div>
                    <div class="update-progress-text" id="update-progress-text">Downloading...</div>
                </div>
                <div class="update-dialog-buttons" id="update-buttons">
                    <button class="update-btn-later" id="update-later">LATER</button>
                    <button class="update-btn-install" id="update-install">UPDATE NOW</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('update-later').onclick = () => overlay.remove();
        document.getElementById('update-install').onclick = () => startUpdate(downloadUrl, overlay);
    }

    async function startUpdate(url, overlay) {
        const buttons = document.getElementById('update-buttons');
        const progress = document.getElementById('update-progress');
        const progressFill = document.getElementById('update-progress-fill');
        const progressText = document.getElementById('update-progress-text');

        // Switch to progress view
        buttons.classList.add('hidden');
        progress.classList.remove('hidden');

        if (ApkInstaller) {
            // Listen for progress events
            const progressListener = await ApkInstaller.addListener('downloadProgress', (data) => {
                const pct = data.percent || 0;
                progressFill.style.width = pct + '%';
                const mb = ((data.downloaded || 0) / 1048576).toFixed(1);
                const totalMb = ((data.total || 0) / 1048576).toFixed(1);
                progressText.textContent = `Downloading... ${mb}/${totalMb} MB (${pct}%)`;
            });

            try {
                progressText.textContent = 'Downloading update...';
                await ApkInstaller.downloadAndInstall({ url });
                progressText.textContent = 'Installing...';
                // Dialog stays until Android installer takes over
            } catch (e) {
                progressText.textContent = 'Update failed: ' + (e.message || 'Unknown error');
                buttons.classList.remove('hidden');
                progress.classList.add('hidden');
                toast('Update failed. Try again later.', 'error');
            } finally {
                progressListener?.remove();
            }
        } else {
            // Fallback: open download URL in browser (no native plugin available)
            progressText.textContent = 'Opening download...';
            window.open(url, '_system');
            setTimeout(() => overlay.remove(), 2000);
        }
    }

    // === CHANGELOG ===
    const CHANGELOG = [
        'Fixed franchise grouping — anime now properly grouped by series',
        'Main series cover and title shown instead of spinoffs/chibi',
        'Improved name matching for better AniList data enrichment'
    ];

    function showChangelog() {
        const lastVer = localStorage.getItem('ani-mate-last-version');
        if (lastVer === APP_VERSION) return;
        const overlay = document.createElement('div');
        overlay.className = 'changelog-overlay';
        overlay.innerHTML = `
            <div class="changelog-modal">
                <div class="changelog-ver">ANI-MATE v${APP_VERSION}</div>
                <ul>${CHANGELOG.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
                <button class="changelog-dismiss">GOT IT</button>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.changelog-dismiss').addEventListener('click', () => {
            localStorage.setItem('ani-mate-last-version', APP_VERSION);
            overlay.remove();
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                localStorage.setItem('ani-mate-last-version', APP_VERSION);
                overlay.remove();
            }
        });
    }

    // === FAVORITES BADGE (new episode in last 7 days detection) ===
    async function checkFavoritesUpdates() {
        if (state.favorites.length === 0) {
            const badge = document.querySelector('.fav-badge');
            if (badge) badge.remove();
            return;
        }
        try {
            // Query AniList for all episodes aired in last 7 days
            const now = Math.floor(Date.now() / 1000);
            const weekAgo = now - (7 * 86400);
            const allRecent = [];
            let page = 1, hasNext = true;
            const gql = `query ($page: Int, $gt: Int, $lt: Int) {
                Page(page: $page, perPage: 50) {
                    pageInfo { hasNextPage }
                    airingSchedules(airingAt_greater: $gt, airingAt_lesser: $lt, sort: [TIME]) {
                        episode airingAt media { id title { romaji english } }
                    }
                }
            }`;
            while (hasNext && page <= 20) {
                const resp = await fetch('https://graphql.anilist.co', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ query: gql, variables: { page, gt: weekAgo, lt: now } }),
                    signal: AbortSignal.timeout(8000)
                });
                const json = await resp.json();
                const pg = json?.data?.Page;
                if (pg?.airingSchedules) allRecent.push(...pg.airingSchedules);
                hasNext = pg?.pageInfo?.hasNextPage || false;
                page++;
            }

            // Check if any favorites match recently aired shows
            const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            let hasUpdates = false;
            for (const fav of state.favorites) {
                const favNorm = norm(fav.name);
                const match = allRecent.find(s => {
                    const romaji = norm(s.media?.title?.romaji);
                    const english = norm(s.media?.title?.english);
                    return (romaji && romaji === favNorm) || (english && english === favNorm) ||
                           (romaji && (romaji.includes(favNorm) || favNorm.includes(romaji))) ||
                           (english && (english.includes(favNorm) || favNorm.includes(english)));
                });
                if (match) { hasUpdates = true; break; }
            }

            const badge = document.querySelector('.fav-badge');
            if (hasUpdates) {
                if (!badge) {
                    const favBtn = document.querySelector('[data-tab="favs"]');
                    if (favBtn) {
                        const b = document.createElement('span');
                        b.className = 'fav-badge';
                        favBtn.style.position = 'relative';
                        favBtn.appendChild(b);
                    }
                }
            } else if (badge) {
                badge.remove();
            }
        } catch (e) { /* non-critical */ }
    }

    async function init() {
        // Hide Capacitor splash screen
        try { await SplashScreen?.hide(); } catch (e) {}

        // Network status
        updateNetworkStatus();

        // Load persisted data
        state.history = await Storage.loadHistory();
        state.favorites = await Storage.loadFavorites();

        // Setup touch controls and back button
        setupTouchControls();
        setupBackButton();

        // Default view
        resultsContainer.innerHTML = '<div class="no-results">Search for anime above</div>';

        // Show changelog on version update
        showChangelog();

        // Check for new episodes on favorites (non-blocking)
        setTimeout(checkFavoritesUpdates, 2000);

        // Check for updates (non-blocking, after 3s to not delay startup)
        setTimeout(checkForUpdate, 3000);
    }

    init();
})();
