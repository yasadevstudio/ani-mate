// YASA PRESENTS
// ani-mate-ui.js - ANI-MATE Mobile UI Logic (Android)
// Adapted from desktop monolith for single-column mobile layout

(function() {
    'use strict';

    // === VERSION (updated by CI on release builds) ===
    const APP_VERSION = '0.2.7';
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
        playLock: false
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

    function renderResults() {
        if (state.results.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results">No results found</div>';
            return;
        }

        const series = state.results.filter(r => r.type === 'series');
        const shorts = state.results.filter(r => r.type === 'short');
        const movies = state.results.filter(r => r.type === 'movie');

        let html = '';
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
    }

    function renderCardGroup(items) {
        return items.map(r => {
            const isFav = state.favorites.some(f => f.id === r.id);
            const typeLabel = r.type === 'series' ? 'SERIES' : r.type === 'short' ? 'SHORT' : 'MOVIE';
            const coverHtml = r.cover
                ? `<div class="cover-wrap"><img src="${r.cover}" loading="lazy" alt=""></div>`
                : '';
            return `<div class="result-card" data-id="${r.id}" data-title="${escAttr(r.name)}" data-eps="${r.episodes}">
                <div class="result-card-row">
                    <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${r.id}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${r.episodes}">${isFav ? '&#9733;' : '&#9734;'}</button>
                    ${coverHtml}
                    <div class="result-info">
                        <div class="result-title">${r.name}</div>
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
                toggleFavorite(star.dataset.favId, star.dataset.favName, star.dataset.favEps);
            });
        });
    }

    // === EPISODES ===
    async function loadEpisodes(animeId, title, epCount) {
        state.selectedAnime = { id: animeId, title, epCount };
        state.selectedEpisode = null;
        state.currentRange = 0;
        updatePlayButton();

        // Show episode panel
        $('panel-title').textContent = title;
        $('panel-meta').textContent = `${epCount || '?'} episodes // ${state.mode.toUpperCase()}`;
        updatePanelFavStar();
        showEpisodePanel();

        // Fetch description (background)
        const descEl = $('anime-description');
        descEl.style.display = 'none';
        descEl.innerHTML = '';
        API.getAnimeInfo(title).then(info => {
            if (info && info.description) {
                let html = stripHtml(info.description);
                if (info.genres && info.genres.length > 0) {
                    html += `<div class="anime-genres">${info.genres.join(' // ')}</div>`;
                }
                if (info.score) {
                    html += `<span class="anime-score"> ${info.score}%</span>`;
                }
                descEl.innerHTML = html;
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

            // Update UI
            $('player-info').textContent =
                `${state.selectedAnime.title} // EP ${state.selectedEpisode} // ${(data.resolution || quality).toUpperCase()}`;
            $('panel-meta').textContent =
                `EP ${state.selectedEpisode} // ${(data.resolution || quality).toUpperCase()} // ${state.mode.toUpperCase()}`;
            highlightEpisode(state.selectedEpisode);

            // Reset watched tracking
            state.watchedMarked = false;
            state.currentPlaybackTime = 0;

            // Launch player
            showPlayer(data.url);
            toast(`Playing: ${state.selectedAnime.title} EP ${state.selectedEpisode}`, 'success');
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

    // Auto-play next episode when current one ends
    video.addEventListener('ended', () => {
        if (!state.autoPlay || !state.selectedAnime || !state.episodes.length) return;
        const currentIdx = state.episodes.indexOf(state.selectedEpisode);
        if (currentIdx === -1 || currentIdx >= state.episodes.length - 1) {
            toast('Series complete!', 'info');
            return;
        }
        const nextEp = state.episodes[currentIdx + 1];
        state.selectedEpisode = nextEp;
        state.pendingResumeTime = 0;
        updatePlayButton();
        highlightEpisode(nextEp);
        $('panel-meta').textContent = `EP ${nextEp} // ${state.mode.toUpperCase()}`;
        toast(`Auto-playing EP ${nextEp}...`, 'info');
        playEpisode();
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

                return `<div class="result-card" data-id="${r.anime_id}" data-title="${escAttr(r.title)}"
                    data-eps="${r.total_episodes || '?'}" data-resume-ep="${resumeEp}" data-resume-time="${resumeTime}">
                    <div class="result-card-row">
                        <div class="result-info">
                            <div class="result-title">${r.title || r.anime_id}</div>
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
                return `<div class="result-card" data-id="${r.id}" data-title="${escAttr(r.name)}" data-eps="${r.episodes}">
                    <div class="result-card-row">
                        <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${r.id}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${r.episodes}">${isFav ? '&#9733;' : '&#9734;'}</button>
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title">${r.name}</div>
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
            html += items.map(r => {
                const airTime = new Date(r.airingAt * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const coverHtml = r.cover
                    ? `<div class="cover-wrap"><img src="${r.cover}" loading="lazy" alt=""></div>`
                    : '';
                const isFav = state.favorites.some(f => f.name === r.title || f.name === r.title_romaji);
                return `<div class="result-card release-card" data-release-title="${escAttr(r.title)}" data-release-romaji="${escAttr(r.title_romaji)}">
                    <div class="result-card-row">
                        <button class="fav-star-inline ${isFav ? 'active' : ''}" data-rel-fav-title="${escAttr(r.title)}" data-rel-fav-romaji="${escAttr(r.title_romaji || '')}" data-rel-fav-eps="${r.totalEpisodes || 0}">${isFav ? '&#9733;' : '&#9734;'}</button>
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title">${r.title}</div>
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
                        const match = results[0];
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
                        state.favorites = await Storage.addFavorite({ id: match.id, name: match.name, episodes: match.episodes || 0 });
                        star.classList.add('active');
                        star.innerHTML = '&#9733;';
                        toast('Added to favorites', 'success');
                        updatePanelFavStar();
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

        resultsContainer.innerHTML = '<div class="section-label">FAVORITES</div>' +
            state.favorites.map(r =>
                `<div class="result-card" data-id="${r.id}" data-title="${escAttr(r.name)}" data-eps="${r.episodes}">
                    <div class="result-card-row">
                        <button class="fav-star-inline active" data-fav-id="${r.id}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${r.episodes}">&#9733;</button>
                        <div class="result-info">
                            <div class="result-title">${r.name}</div>
                            <div class="result-meta">${r.episodes} EP</div>
                        </div>
                    </div>
                </div>`
            ).join('');

        bindCards(resultsContainer);
    }

    async function toggleFavorite(id, name, episodes) {
        const isFav = state.favorites.some(f => f.id === id);
        try {
            if (isFav) {
                state.favorites = await Storage.removeFavorite(id);
                toast('Removed from favorites', 'info');
            } else {
                state.favorites = await Storage.addFavorite({ id, name, episodes: parseInt(episodes) || 0 });
                toast('Added to favorites', 'success');
            }
        } catch (err) {
            toast(`Favorites error: ${err.message}`, 'error');
        }

        updatePanelFavStar();
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
                if (state.isPlaying) video.currentTime += 5;
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (state.isPlaying) video.currentTime -= 5;
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
            toggleFavorite(state.selectedAnime.id, state.selectedAnime.title, state.selectedAnime.epCount);
        }
    });

    // Player back
    $('player-back').addEventListener('click', hidePlayer);

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
    // === AUTO-UPDATE CHECKER ===
    async function checkForUpdate() {
        try {
            const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });
            if (!resp.ok) return;
            const release = await resp.json();
            const latest = (release.tag_name || '').replace(/^v/, '');
            if (!latest || !isNewer(latest, APP_VERSION)) return;

            // Find the mobile APK asset
            const apk = (release.assets || []).find(a => a.name.toLowerCase().includes('mobile') && a.name.endsWith('.apk'));
            if (!apk) return;

            const banner = $('update-banner');
            const text = $('update-text');
            const link = $('update-link');
            const dismiss = $('update-dismiss');

            text.textContent = `ANI-MATE v${latest} available!`;
            link.href = apk.browser_download_url;
            banner.classList.remove('hidden');

            dismiss.onclick = () => {
                banner.classList.add('hidden');
                // Don't nag again this session
            };
        } catch (e) {
            // Silent fail - no network or API issue, not critical
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

        // Check for updates (non-blocking, after 3s to not delay startup)
        setTimeout(checkForUpdate, 3000);
    }

    init();
})();
