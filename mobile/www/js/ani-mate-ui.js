// YASA PRESENTS
// ani-mate-ui.js - ANI-MATE Mobile UI Logic (Android)
// Adapted from desktop monolith for single-column mobile layout

(function() {
    'use strict';

    // === VERSION (updated by CI on release builds) ===
    const APP_VERSION = '0.7.2';
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
        pendingResumeTime: 0,
        currentRange: 0,
        autoPlay: false,
        watchedMarked: false,
        currentPlaybackTime: 0,
        progressSaveInterval: null,
        availableLinks: [],
        playerUiVisible: true,
        playerUiTimer: null,
        preferEnglish: true,
        nsfw: false,
        favUpdates: [],
        favReadIds: JSON.parse(localStorage.getItem('ani-mate-fav-read-ids') || '[]')
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

    /* ⚠ EVERY VALUE THAT REACHES innerHTML GOES THROUGH esc(), WHATEVER ITS TYPE. Titles,
     * ids, episode labels, covers and error messages come from other servers, and with
     * sync from another device. The old one was `(s || '').replace(...)`: it threw on a
     * number, so ids and counts were simply written without it. */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    /* One escaper. escAttr was a second one that left '>' and the single quote alone;
     * its call sites keep the name. */
    const escAttr = esc;
    /* One safe class-name token (a result's type is used as a class). */
    const cls = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
    /* The TEXT of a piece of HTML. A <template> is inert: nothing in it runs or loads.
     * The old way was a tag-stripping regular expression, which an unclosed tag passes
     * straight through. */
    const plainBox = document.createElement('template');
    const plainText = (html) => {
        plainBox.innerHTML = String(html == null ? '' : html).replace(/<br\s*\/?>/gi, ' ');
        const t = plainBox.content.textContent || '';
        plainBox.innerHTML = '';
        return t;
    };
    /* Two names for the same show, whatever is missing. */
    const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const isFavId = (id) => (state.favorites || []).some(f => f && String(f.id) === String(id));
    /* A real episode count, or 0 for "not known yet". */
    const countOf = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
    const countLabel = (n) => (countOf(n) ? String(countOf(n)) : '?');

    // === NETWORK STATUS ===
    function updateNetworkStatus() {
        const online = navigator.onLine;
        $('status-dot').classList.toggle('online', online);
        $('status-text').textContent = online ? 'ONLINE' : 'OFFLINE';
    }

    /** Re-draw the tab that is showing, from the data already held. Never fetches, and
     *  never draws a tab that is still waiting for its first answer. */
    function redrawActiveTab() {
        const tab = state.activeTab;
        if (tab === 'favs') renderFavorites();
        else if (tab === 'search') { if (state.results.length) renderResults(); }
        else if (tab === 'daily') { if (state.dailyResults.length) renderDaily(); }
        else if (tab === 'releases') { if (state.releasesDate && state.releasesResults.length) renderReleases(); }
        else if (tab === 'continue') { if (state.continueLoaded) renderContinue(); }
    }

    /** Bring every star on screen in line with the favorites list, without re-drawing
     *  the cards (which would lose the scroll position and close an open group). */
    function refreshStars() {
        document.querySelectorAll('#results-container .fav-star-inline').forEach(star => {
            let on;
            if (star.dataset.favId !== undefined) on = isFavId(star.dataset.favId);
            else {
                /* RELEASES cards are AniList rows with no source id; their star goes by name. */
                const t = star.dataset.relFavTitle, r = star.dataset.relFavRomaji;
                on = state.favorites.some(f => f.name === t || (r && f.name === r));
            }
            star.classList.toggle('active', on);
            star.innerHTML = on ? '&#9733;' : '&#9734;';
        });
    }

    /** Everything that shows a title, re-drawn in the language now chosen. */
    function applyTitleLanguage() {
        redrawActiveTab();
        const sel = state.selectedAnime;
        if (sel) {
            $('panel-title').textContent = (state.preferEnglish && sel.titleEnglish) ? sel.titleEnglish : sel.title;
            renderSeasonStrip();
        }
        if (state.playing && state.nowPlaying) {
            const a = state.playing.anime;
            state.nowPlaying.title = (state.preferEnglish && a.titleEnglish) ? a.titleEnglish : a.title;
            paintNowPlaying();
        }
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
            resultsContainer.innerHTML = '<div class="no-results">Loading watch list...</div>';
            loadContinue();
        } else if (tab === 'daily') {
            resultsContainer.innerHTML = '<div class="no-results">Loading trending anime...</div>';
            loadDaily();
        } else if (tab === 'releases') {
            resultsContainer.innerHTML = '<div class="no-results">Loading airing schedule...</div>';
            if (!state.releasesDate) state.releasesDate = new Date();
            loadReleases();
        } else if (tab === 'favs') {
            const badge = document.querySelector('.fav-badge');
            if (badge) badge.remove();
            renderFavorites();
        }
    }

    // === SEARCH ===
    let searchSeq = 0;
    async function doSearch(query) {
        const mine = ++searchSeq;
        resultsContainer.innerHTML = '<div class="loading-indicator">SCANNING DATABASE...</div>';
        try {
            const found = await API.searchAnime(query, state.mode, state.nsfw);
            /* An earlier search that answers late must not replace a later one. */
            if (mine !== searchSeq) return;
            state.results = found || [];
            /* Every tab draws into the same container. If the user has moved to another
             * tab the results are kept, and drawn when they come back. */
            if (state.activeTab !== 'search') return;
            /* A NEW search closes whatever show was open. renderResults() used to do
             * this itself, on every re-draw. */
            clearOpenShow();
            renderResults();
        } catch (err) {
            if (mine !== searchSeq || state.activeTab !== 'search') return;
            resultsContainer.innerHTML = `<div class="no-results">Error: ${esc(err.message)}</div>`;
            toast(err.message, 'error');
        }
    }

    /* ── FRANCHISE IDENTITY: ONE IMPLEMENTATION, IN server/ani-mate-franchise.js ──
     *
     * ⛔ THIS FILE CARRIED ITS OWN COPY OF THE GROUPING AND IT HAD THE SAME BUG AS THE
     * DESKTOP'S. Both began `if (r.franchise_id)`, and 19 of the 24 rows in a real
     * library have no franchise_id, so neither grouped anything the server had not
     * already tagged. The desktop copy was fixed on 2026-10-12 and again on 2026-11-09;
     * this one was never touched, so the phone stayed broken through both.
     *
     * Do not put logic back here. Add an argument to the shared module. */
    /* If the module is missing the app is misconfigured, and that is worth SAYING —
     * but not worth taking the player down for. Measured: an earlier version of this
     * line was `const FR = ... : null`, and the first call threw out of the IIFE and
     * rendered a blank shell. These stubs turn franchise features off and leave
     * everything else working. */
    const FR = (typeof AniMateFranchise !== 'undefined' && AniMateFranchise) ? AniMateFranchise : {
        franchiseName: (n) => n,
        franchiseBase: () => '',              // no key resolves -> no grouping, no strip
        seasonOrdinal: () => 1,
        seasonLabel: () => 'S1',
        isSeasonSpine: () => true,
        sortSeasons: (l) => l,
        franchiseIndex: () => ({ keyOf: () => '', keyOfLabel: () => '' }),
        groupFranchises: (items) => ({ groups: [], ungrouped: (items || []).slice() }),
        siblingsOf: () => [],
        poolOf: (...lists) => [].concat(...lists.filter(Array.isArray)).filter(r => r && r.id),
        stripOf: (all) => ({ shown: all || [], hidden: 0, spine: all || [] }),
        isStarMember: () => true,
        commonPrefixWords: () => 0,
        __missing: true,
    };
    if (FR.__missing) {
        console.error('ani-mate-franchise.js did not load (404?). Franchise grouping and '
                    + 'season navigation are DISABLED; everything else works. If the '
                    + 'desktop server was started before this file existed, restart it.');
        try { setTimeout(() => toast('Franchise grouping unavailable \u2014 restart the app',
                                     'error'), 1500); } catch (e) { /* no toast yet */ }
    }

    const franchiseName = (n) => FR.franchiseName(n);
    const franchiseBase = (n) => FR.franchiseBase(n);
    const seasonOrdinal = (n) => FR.seasonOrdinal(n);
    const franchiseIndex = (items) => FR.franchiseIndex(items);

    /** Everything the app currently knows about, so grouping and the season strip
     *  cannot disagree about what a franchise contains.
     *
     *  ⚠ ONE ROW PER SHOW, CARRYING EVERYTHING ANY LIST KNOWS ABOUT IT (FR.poolOf). This
     *  was the lists laid end to end, and whoever read it took the first copy of an id:
     *  a favorite (a name and an episode count) hid the copy fetched for the season bar
     *  (format, date). The same call, with the same lists, as the desktop page. */
    function franchisePool() {
        return FR.poolOf(state.results, state.dailyResults, state.releasesResults,
                         state.favorites, state.lookupResults, state.continueResults,
                         state.history,
                         ...Object.keys(franchiseCache).map(k => franchiseCache[k]));
    }

    /** The franchise key for one row, resolved against everything known. */
    function franchiseKeyOf(item) {
        return FR.keyIn(item, franchisePool());
    }

    function groupByFranchise(items, parentMode) {
        return FR.groupFranchises(items, franchisePool(), parentMode);
    }

    function renderFranchiseCard(group) {
        const r = group.parent;
        const isFav = isFavId(r.id);
        const coverHtml = r.cover ? `<div class="cover-wrap"><img src="${esc(r.cover)}" loading="lazy" alt=""></div>` : '';
        const hasEn = !!r.title_english && !sameText(r.title_english, r.name);
        const primaryTitle = (state.preferEnglish && hasEn) ? r.title_english : r.name;
        const count = group.members.length;

        let html = `<div class="franchise-group" data-franchise="${esc(group.franchise_id)}">
            <div class="result-card franchise-parent" data-id="${esc(r.id)}" data-title="${escAttr(r.name)}" data-eps="${countOf(r.episodes)}">
                <div class="result-card-row">
                    <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${esc(r.id)}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${countOf(r.episodes)}" data-fav-english="${escAttr(r.title_english || '')}" data-fav-franchise="${esc(r.franchise_id)}" data-fav-cover="${escAttr(r.cover || '')}">${isFav ? '&#9733;' : '&#9734;'}</button>
                    ${coverHtml}
                    <div class="result-info">
                        <div class="result-title">${esc(primaryTitle)}</div>
                        <div class="result-meta"><span class="result-type series">FRANCHISE</span>${count} entries <span class="franchise-toggle">&#9660;</span></div>
                    </div>
                </div>
            </div>
            <div class="franchise-entries" style="display:none;">`;

        for (const m of group.members) {
            const mFav = isFavId(m.id);
            const typeLabel = m.type === 'series' ? 'SERIES' : m.type === 'short' ? 'SHORT' : 'MOVIE';
            const mHasEn = !!m.title_english && !sameText(m.title_english, m.name);
            const mTitle = (state.preferEnglish && mHasEn) ? m.title_english : m.name;
            html += `<div class="result-card franchise-entry" data-id="${esc(m.id)}" data-title="${escAttr(m.name)}" data-eps="${countOf(m.episodes)}">
                <div class="result-card-row">
                    <button class="fav-star-inline ${mFav ? 'active' : ''}" data-fav-id="${esc(m.id)}" data-fav-name="${escAttr(m.name)}" data-fav-eps="${countOf(m.episodes)}" data-fav-english="${escAttr(m.title_english || '')}" data-fav-franchise="${esc(m.franchise_id)}" data-fav-cover="${escAttr(m.cover || '')}">${mFav ? '&#9733;' : '&#9734;'}</button>
                    <div class="result-info">
                        <div class="result-title">${esc(mTitle)}</div>
                        <div class="result-meta"><span class="result-type ${cls(m.type)}">${typeLabel}</span>${countLabel(m.episodes)} EP</div>
                    </div>
                </div>
            </div>`;
        }
        html += '</div></div>';
        return html;
    }

    function bindFranchiseToggles(container) {
        container.querySelectorAll('.franchise-parent').forEach(card => {
            // Single tap on toggle arrow expands/collapses
            const toggle = card.querySelector('.franchise-toggle');
            if (toggle) {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const group = card.closest('.franchise-group');
                    const entries = group.querySelector('.franchise-entries');
                    const isOpen = entries.style.display !== 'none';
                    entries.style.display = isOpen ? 'none' : 'block';
                    toggle.innerHTML = isOpen ? '&#9660;' : '&#9650;';
                });
            }
            // Single tap on card body loads episodes
            card.addEventListener('click', (e) => {
                if (e.target.closest('.fav-star-inline') || e.target.closest('.franchise-toggle')) return;
                loadEpisodes(card.dataset.id, card.dataset.title, parseInt(card.dataset.eps) || 0);
            });
        });
    }

    // Clear the previously-open show when new results arrive.
    //
    // The episode grid, the range buttons, the season strip and state.arcs all
    // belonged to whatever was open before. Searching Apothecary Diaries after
    // Dragon Ball left the range buttons reading "God of Destruction Beerus 1-18"
    // over a different show's episodes. Resetting inside loadEpisodes was not
    // enough, because that only runs when a selection actually loads — and a click
    // that only expands a franchise card never reaches it. Caught by driving the
    // real UI, 2026-10-13.
    function clearOpenShow() {
        state.arcs = null;
        state.episodes = [];
        state.currentRange = 0;
        state.selectedEpisode = null;
        const rs = document.getElementById('range-selector');
        if (rs) { rs.style.display = 'none'; rs.innerHTML = ''; }
        const st = document.getElementById('season-strip');
        if (st) { st.style.display = 'none'; st.innerHTML = ''; }
        const g = document.getElementById('episode-grid');
        if (g) g.innerHTML = '';
        // and the labels, or the panel still names the previous show
        state.selectedAnime = null;
        for (const [id, txt] of [['selected-anime-title', '--'], ['selected-anime-count', ''],
                                 ['np-title', 'No Selection'], ['np-detail', 'Select an anime to begin'],
                                 ['panel-title', '--'], ['panel-meta', '']]) {
            const e = document.getElementById(id);
            if (e) e.textContent = txt;
        }
    }

    /* ⚠ DRAWS THE RESULTS AND NOTHING ELSE. This used to begin by closing whatever show
     * was open, and it runs for every re-draw: a star, the English switch, coming back to
     * the tab, and a background sync. Starring the open show from its own panel emptied
     * that panel, and a sync that pulled anything cleared the selection under a playing
     * video. Closing the open show belongs to a NEW search, and doSearch does it. */
    function renderResults() {
        if (state.results.length === 0) {
            // "No results" is the same thing on screen whether the query genuinely has
            // no match or every source is unreachable. Ask the sources which it is and
            // say so, rather than leaving it looking like the app is broken.
            resultsContainer.innerHTML = '<div class="no-results">No results found</div>';
            reportSourceTrouble();
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
            const isFav = isFavId(r.id);
            const typeLabel = r.type === 'series' ? 'SERIES' : r.type === 'short' ? 'SHORT' : 'MOVIE';
            const coverHtml = r.cover
                ? `<div class="cover-wrap"><img src="${esc(r.cover)}" loading="lazy" alt=""></div>`
                : '';
            const hasEn = !!r.title_english && !sameText(r.title_english, r.name);
            const primaryTitle = (state.preferEnglish && hasEn) ? r.title_english : r.name;
            const secondaryTitle = (state.preferEnglish && hasEn) ? r.name : (hasEn ? r.title_english : '');
            return `<div class="result-card" data-id="${esc(r.id)}" data-title="${escAttr(r.name)}" data-eps="${countOf(r.episodes)}">
                <div class="result-card-row">
                    <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${esc(r.id)}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${countOf(r.episodes)}" data-fav-english="${escAttr(r.title_english || '')}" data-fav-franchise="${esc(r.franchise_id)}" data-fav-cover="${escAttr(r.cover || '')}">${isFav ? '&#9733;' : '&#9734;'}</button>
                    ${coverHtml}
                    <div class="result-info">
                        <div class="result-title">${esc(primaryTitle)}</div>
                        ${secondaryTitle ? `<div class="result-title-en">${esc(secondaryTitle)}</div>` : ''}
                        <div class="result-meta"><span class="result-type ${cls(r.type)}">${typeLabel}</span>${countLabel(r.episodes)} EP</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    function bindCards(container) {
        // NOT '.result-card' on its own. Franchise parents carry that class too, and
        // bindFranchiseToggles() already binds them, so every franchise card was
        // getting two click handlers and firing loadEpisodes twice per tap.
        container.querySelectorAll('.result-card:not(.franchise-parent)').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.fav-star-inline')) return;
                if (state.activeTab === 'favs' && card.dataset.id) markFavRead(card.dataset.id);
                loadEpisodes(card.dataset.id, card.dataset.title, parseInt(card.dataset.eps) || 0);
            });
        });
        container.querySelectorAll('.fav-star-inline').forEach(star => {
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(star.dataset.favId, star.dataset.favName, star.dataset.favEps, star.dataset.favEnglish, star.dataset.favFranchise, star.dataset.favCover || '');
            });
        });
    }


    // === SEASON STRIP ===
    // Other entries in the same franchise, rendered above the episode grid.
    // state.selectedAnime.franchiseId was being set and never read; this uses it.

    const franchiseCache = {};   // franchise_id -> array of sibling results

    /* commonPrefixWords (how many leading words a set of titles share, for labeling a
     * chip by what distinguishes it) lives in server/ani-mate-franchise.js now. This file
     * and the desktop page each carried the same copy and handed it in as an argument. */

    const seasonLabel = (r, siblings) => FR.seasonLabel(r, siblings);

    const franchiseSiblings = (fid) => FR.siblingsOf(fid, franchisePool());

    function renderSeasonStrip() {
        // expansion is per show, not sticky across selections
        if (state._stripFor !== (state.selectedAnime && state.selectedAnime.id)) {
            state._stripFor = state.selectedAnime && state.selectedAnime.id;
            state.seasonStripExpanded = false;
        }
        const el = document.getElementById('season-strip');
        if (!el) return;
        const sel = state.selectedAnime;
        if (!sel) { el.style.display = 'none'; el.innerHTML = ''; return; }
        /* ⛔ THIS LINE WAS THE "NO NAVIGATION" BUG, ON BOTH PLATFORMS. It read
         *     if (!sel || !sel.franchiseId) { ... return; }
         * so any show the server never gave a franchise_id — 19 of the 24 rows in a real
         * library — got no season bar at all, from any season, no matter how many
         * siblings were sitting in the pool. The key is always derivable from the title,
         * so the gate is now about whether siblings EXIST. */
        const fkey = sel.franchiseId || franchiseKeyOf({ id: sel.id, name: sel.title,
                                                         title_english: sel.titleEnglish });
        if (!fkey) { el.style.display = 'none'; el.innerHTML = ''; return; }
        const all = franchiseSiblings(fkey);
        if (all.length < 2) { el.style.display = 'none'; el.innerHTML = ''; return; }

        // A SEASON strip should list seasons. With a whole franchise under one id,
        // Dragon Ball Super's strip was twelve chips — three series, five films,
        // three ONAs and an OVA — with two different chips both reading "S1".
        // Series form the spine; everything else sits behind one toggle. The entry
        // currently open is always on the spine, whatever its format.
        /* Format alone is wrong in both directions — Netflix ships seasons as ONA, and
         * a null format on this provider is usually an old movie. The rule and its
         * measurements are in server/ani-mate-franchise.js. */
        /* What is shown, and HOW MANY ARE NOT, is one decision made in the shared
         * module (FR.stripOf), so the button below cannot offer rows that are already
         * on screen. */
        const strip = FR.stripOf(all, sel.id, state.seasonStripExpanded);
        // The label's sibling basis is the SPINE, not every entry. Across all 39
        // Dragon Ball rows the shared prefix is zero words, because "Super Dragon
        // Ball Heroes" starts with "Super" — and the labels collapsed back to seven
        // chips reading "S1". Over the spine the prefix is "Dragon Ball" and the
        // remainders are Z, GT, Kai, Super, Daima.
        const spine = strip.spine;
        const sibs = strip.shown;
        if (sibs.length < 2) { el.style.display = 'none'; el.innerHTML = ''; return; }
        el.innerHTML = sibs.map(s => {
            const on = String(s.id) === String(sel.id) ? ' active' : '';
            return `<button class="season-chip${on}" data-id="${escAttr(String(s.id))}"`
                 + ` data-title="${escAttr(s.name)}" data-eps="${countOf(s.episodes)}"`
                 + ` title="${escAttr(s.name)}">${esc(seasonLabel(s, spine))}</button>`;
        }).join('');
        /* ⚠ ONLY WHEN SOMETHING IS HIDDEN. This was "whenever the franchise has a film",
         * and a franchise with one season shows every row already: the button read
         * "+3 more" and did nothing. */
        if (strip.hidden > 0) {
            el.innerHTML += `<button class="season-chip season-more"`
                          + ` title="Films, OVAs and specials in this franchise">`
                          + `+${strip.hidden} more</button>`;
        }
        el.style.display = 'flex';
        const more = el.querySelector('.season-more');
        if (more) more.addEventListener('click', () => {
            state.seasonStripExpanded = true;
            renderSeasonStrip();
        });
        el.querySelectorAll('.season-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                if (String(chip.dataset.id) === String(state.selectedAnime?.id)) return;
                loadEpisodes(chip.dataset.id, chip.dataset.title,
                             parseInt(chip.dataset.eps) || 0);
            });
        });
    }

    // Arriving from favorites or trending means the siblings were never fetched.
    // Search once on the season-stripped title and cache whatever shares the id.
    async function ensureFranchiseSiblings() {
        const sel = state.selectedAnime;
        if (!sel) return;
        /* Same correction as the strip gate: a missing franchise_id used to abort the
         * fetch, so a show with no siblings in the pool could never acquire any and the
         * bar stayed empty forever. Resolve a key first, then fetch. */
        if (!sel.franchiseId) {
            sel.franchiseId = franchiseKeyOf({ id: sel.id, name: sel.title,
                                               title_english: sel.titleEnglish });
        }
        if (!sel.franchiseId) return;
        if (franchiseCache[sel.franchiseId]) return;
        // There used to be an early return here when two siblings were already on
        // hand. franchiseSiblings() reads from whatever the CURRENT SEARCH returned,
        // so the strip settled for the two or three most popular entries — which skew
        // recent — and the earlier seasons were never fetched at all. That is the
        // reported "you can only see the latest ones". Fetch once per franchise,
        // always, and cache it. Removed 2026-10-12.
        // Search the FRANCHISE, not the selected title.
        //
        // This used to strip season markers off whatever was open and search that, so
        // clicking Dragon Ball Super searched "Dragon Ball Super" — which never returns
        // the 1986 original, GT, Kai or Daima. The strip came back as Z | Super |
        // Super: Beerus and the earlier series were simply absent. That is the reported
        // "you can only see the latest ones", and it survived the previous fix because
        // the previous fix only removed an early return.
        //
        // A pattern franchise id carries the franchise's own name ("fp:dragon ball"),
        // which is exactly the right query. Fall back to the stripped title otherwise.
        // 2026-10-13.
        const fid = String(sel.franchiseId);
        /* Search the FRANCHISE, not the open title. A derived key carries the franchise
         * name already ("fp:beastars"), which is exactly the right query. */
        const base = fid.startsWith('fp:') ? fid.slice(3) : FR.franchiseBase(sel.title || '');
        if (!base) return;
        try {
            const found = await API.searchAnime(base, state.mode, state.nsfw);
            /* Keep everything whose RESOLVED key matches — filtering on the raw
             * franchise_id threw away exactly the untagged rows we went looking for. */
            const got = (found || []).filter(r => r && r.id);
            const idx = FR.franchiseIndex(franchisePool().concat(got));
            const mine = idx.keyOfLabel(sel.franchiseId) || idx.keyOf(sel.id);
            franchiseCache[sel.franchiseId] = got.filter(r => idx.keyOf(r.id) === mine);
            if (state.selectedAnime && state.selectedAnime.franchiseId === sel.franchiseId) {
                renderSeasonStrip();
            }
        } catch { /* the strip just stays hidden */ }
    }

    // === EPISODES ===
    /** Everything the app knows about a show id, from every list it is holding. It
     *  used to look in three of them, so a show opened from a season chip, RELEASES,
     *  CONTINUE or a favorite that arrived by sync lost its English title, cover and
     *  AniList id. */
    function knownShow(animeId) {
        const id = String(animeId);
        const row = franchisePool().find(r => r && String(r.id) === id);
        if (row) return row;
        const h = (state.history || []).find(x => x && String(x.anime_id) === id);
        return h ? { id, name: h.title, title_english: h.title_english || '',
                     episodes: h.total_episodes || 0 } : null;
    }

    /**
     * @param {{autoEpisode?: string, resumeTime?: number}} [opts] CONTINUE's "open this show, at this
     *             episode, from here". They travel WITH the call. They used to be left
     *             in two globals for whichever load finished next, so opening a second
     *             show before the first had loaded auto-played the second one at the
     *             first one's offset.
     */
    async function loadEpisodes(animeId, title, epCount, opts) {
        opts = opts || {};
        // Close player if open (don't auto-show video when switching anime)
        if (state.isPlaying) hidePlayer();
        /* ...and call off a play that is still loading for the show being left. */
        playSeq++;

        // Look up English title and franchise from everything currently known
        const matched = knownShow(animeId);
        epCount = countOf(epCount) || countOf(matched && matched.episodes);
        const titleEnglish = matched?.title_english || '';
        /* Resolved, not read: `matched?.franchise_id || ''` left this empty for every
         * untagged show, which is what disabled the season bar downstream. */
        const franchiseId = franchiseKeyOf(matched || { id: animeId, name: title });
        const cover = matched?.cover || '';
        state.selectedAnime = { id: animeId, title, epCount, titleEnglish, franchiseId, cover,
                                anilist_id: matched?.anilist_id || null };
        state.selectedEpisode = null;
        state.currentRange = 0;
        // Clear the PREVIOUS show's arcs and strip before anything renders. Without
        // this, searching Apothecary Diaries after Dragon Ball left the range buttons
        // reading "God of Destruction Beerus 1-18" on a completely different series,
        // because state.arcs persisted and nothing reset it. Caught by driving the
        // real UI, 2026-10-13 — no function-level test can see it.
        state.arcs = null;
        state.episodes = [];
        const _strip = document.getElementById('season-strip');
        if (_strip) { _strip.style.display = 'none'; _strip.innerHTML = ''; }
        updatePlayButton();

        // Show episode panel with preferred title
        const displayTitle = (state.preferEnglish && titleEnglish) ? titleEnglish : title;
        $('panel-title').textContent = displayTitle;
        $('panel-meta').textContent = `${countLabel(epCount)} episodes // ${state.mode.toUpperCase()}`;
        updatePanelFavStar();
        showEpisodePanel();
        renderSeasonStrip();
        ensureFranchiseSiblings();

        /* ⚠ EVERY ANSWER BELOW IS CHECKED AGAINST THE SHOW THAT ASKED FOR IT. Both
         * requests used to draw into whatever was open when they landed, so opening A
         * (slow) and then B left B's title over A's episode grid, and PLAY then asked
         * for B with an episode number picked from A's list. */
        const stillThis = () => !!state.selectedAnime && String(state.selectedAnime.id) === String(animeId);

        // Fetch description with cover image (background)
        const descEl = $('anime-description');
        descEl.style.display = 'none';
        descEl.innerHTML = '';
        API.getAnimeInfo(title).then(info => {
            if (!stillThis() || !info || !(info.description || info.cover)) return;
            /* ⚠ BUILT AS NODES AND WRITTEN AS TEXT. The description comes from AniList
             * or MAL and used to be put in innerHTML after a tag-stripping regular
             * expression, which an unclosed tag passes straight through. */
            const img = (className, src, alt) => {
                const el = document.createElement('img');
                el.className = className; el.loading = 'lazy'; el.alt = alt || '';
                if (/^https?:\/\//i.test(String(src))) el.src = String(src);
                return el;
            };
            descEl.textContent = '';
            if (info.banner) {
                const b = img('anime-banner-img', info.banner, '');
                b.style.cssText = 'width:100%;max-height:140px;object-fit:cover;border-radius:6px;margin-bottom:8px;';
                descEl.appendChild(b);
            }
            const row = document.createElement('div');
            row.className = 'anime-desc-row';
            if (info.cover) row.appendChild(img('anime-cover-img', info.cover, title));
            const body = document.createElement('div');
            body.className = 'anime-desc-text';
            body.appendChild(document.createTextNode(info.description ? plainText(info.description) : ''));
            if (Array.isArray(info.genres) && info.genres.length > 0) {
                const g = document.createElement('div');
                g.className = 'anime-genres';
                g.textContent = info.genres.map(String).join(' // ');
                body.appendChild(g);
            }
            if (Number(info.score) > 0) {
                const sc = document.createElement('span');
                sc.className = 'anime-score';
                sc.textContent = ' ' + Number(info.score) + '%';
                body.appendChild(sc);
            }
            row.appendChild(body);
            descEl.appendChild(row);
            descEl.style.display = 'block';
        }).catch(() => {});

        // Fetch episodes
        const grid = $('episode-grid');
        grid.innerHTML = '<div class="loading-indicator">LOADING EPISODES...</div>';

        try {
            /* ⚠ THE TITLES GO WITH THE ID. The backend finds a show by name; an id from
             * favorites, history or a sync means nothing to it. Both names, because a
             * row that has been through sync can carry the one the desktop knows. */
            const epRes = await API.getEpisodeList(animeId, state.mode,
                                                   matched && matched.anilist_id,
                                                   { title, alt: titleEnglish, nsfw: state.nsfw });
            if (!stillThis()) return;            // another show was opened while this loaded
            // getEpisodeList may return a bare array (older path) or {episodes, arcs}
            const list = Array.isArray(epRes) ? epRes : ((epRes && epRes.episodes) || []);
            state.episodes = list.map(String);
            state.arcs = Array.isArray(epRes) ? null : ((epRes && epRes.arcs) || null);
            renderEpisodeGrid();
            /* The count is known now even when the card that opened this carried none. */
            if (!countOf(state.selectedAnime.epCount) && state.episodes.length) {
                state.selectedAnime.epCount = state.episodes.length;
                $('panel-meta').textContent = `${state.episodes.length} episodes // ${state.mode.toUpperCase()}`;
            }

            // Auto-select the episode CONTINUE asked for
            const autoEp = (opts.autoEpisode == null || opts.autoEpisode === '') ? '' : String(opts.autoEpisode);
            if (autoEp && state.episodes.includes(autoEp)) {
                const resumeAt = Number(opts.resumeTime) > 0 ? Number(opts.resumeTime) : 0;
                state.selectedEpisode = autoEp;
                updatePlayButton();
                highlightEpisode(autoEp);

                if (resumeAt) {
                    toast(`Resuming EP ${autoEp} at ${formatTime(resumeAt)}...`, 'info');
                    playEpisode({ anime: state.selectedAnime, episode: autoEp,
                                  episodes: state.episodes, resumeAt });
                } else {
                    toast(`Ready: EP ${autoEp}`, 'info');
                }
            }
        } catch (err) {
            if (!stillThis()) return;
            grid.innerHTML = `<div class="no-results">Error: ${esc(err.message)}</div>`;
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

        // Ranges. When the series has known story arcs, the range buttons ARE the
        // arcs, so a 131-episode grid splits into "Beerus 1-18" rather than an
        // arbitrary "1-50". That is the whole arc feature: no second control, no new
        // CSS, and it answers "where is the Beerus arc". Falls back to fixed blocks
        // when no arc data exists, which is every series but the few in arcs.json.
        // Added 2026-10-12.
        const arcs = Array.isArray(state.arcs) && state.arcs.length ? state.arcs : null;
        const bands = arcs
            ? arcs.map(a => ({ from: a.from, to: Math.min(a.to, state.episodes.length),
                               label: `${a.name} ${a.from}-${Math.min(a.to, state.episodes.length)}` }))
            : Array.from({ length: Math.ceil(state.episodes.length / RANGE_SIZE) }, (_, i) => {
                  const from = i * RANGE_SIZE + 1;
                  const to = Math.min((i + 1) * RANGE_SIZE, state.episodes.length);
                  return { from, to, label: `${from}-${to}` };
              });

        if (bands.length > 1) {
            rangeSelector.style.display = 'flex';
            rangeSelector.innerHTML = '';
            bands.forEach((b, i) => {
                const btn = document.createElement('button');
                btn.className = `range-btn ${i === (state.currentRange || 0) ? 'active' : ''}`;
                btn.textContent = b.label;
                btn.title = b.label;
                btn.addEventListener('click', () => {
                    state.currentRange = i;
                    renderEpisodeGrid();
                });
                rangeSelector.appendChild(btn);
            });
        } else {
            rangeSelector.style.display = 'none';
        }

        // Slice by the active band. Episode numbers are 1-based, the array is not.
        const band = bands[state.currentRange || 0] || bands[0] || { from: 1, to: state.episodes.length };
        const visibleEps = state.episodes.slice(band.from - 1, band.to);

        // Find watched episodes from history
        const histEntry = state.history.find(h => String(h.anime_id) === String(state.selectedAnime?.id));
        const watchedEps = (histEntry?.episodes_watched || []).map(String);

        grid.innerHTML = visibleEps.map(ep => {
            const isWatched = watchedEps.includes(String(ep));
            const isPlaying = String(state.selectedEpisode) === String(ep);
            return `<button class="episode-btn ${isWatched ? 'watched' : ''} ${isPlaying ? 'playing' : ''}"
                data-ep="${esc(ep)}">${isWatched ? '&#10003; ' : ''}${esc(ep)}</button>`;
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
        const isFav = isFavId(state.selectedAnime.id);
        star.innerHTML = isFav ? '&#9733;' : '&#9734;';
        star.classList.toggle('active', isFav);
    }

    // === VIDEO PLAYER ===
    /* ── WHAT IS PLAYING IS ITS OWN RECORD ────────────────────────────────────────────
     * state.selectedAnime / state.selectedEpisode say what is SELECTED in the grid.
     * state.playing says what the video element is showing:
     *     { anime, episode, episodes, mode, finished }
     *
     * ⛔ They used to be one thing, and all of the playback bookkeeping read the
     * selection:
     *   - a background sync that pulled anything re-drew the search results, which
     *     cleared the selection under a playing video. From then on nothing was saved,
     *     nothing was marked watched, auto-play stopped and the previous and next
     *     buttons did nothing;
     *   - when an episode ended the selection moved to the next one while the finished
     *     video was still loaded, so closing the player filed the finished video's end
     *     time under the NEXT episode.
     * Progress, watched marks, the watch clock's genres, the previous and next buttons
     * and "what comes next" all read state.playing now. */
    const showingPlaying = () => !!state.playing && !!state.selectedAnime
        && String(state.selectedAnime.id) === String(state.playing.anime.id);

    /* A source's own word for the quality, or AUTO. The label used to print the quality
     * that was ASKED FOR as if it were the one playing. */
    const qualityLabel = (r) => {
        const t = String(r || '').trim();
        return t && !/^(best|worst|auto)$/i.test(t) ? t.toUpperCase() : 'AUTO';
    };

    function paintNowPlaying() {
        const n = state.nowPlaying;
        if (!n) return;
        $('player-info').textContent = `${n.title} // EP ${n.episode} // ${n.quality}`;
        if (showingPlaying()) {
            $('panel-meta').textContent = `EP ${n.episode} // ${n.quality} // ${String(n.mode || 'sub').toUpperCase()}`;
        }
    }

    /* The panel under the player describes the SELECTION whenever nothing is playing. */
    function describeSelection() {
        const sel = state.selectedAnime;
        if (!sel) return;
        $('panel-meta').textContent = state.selectedEpisode
            ? `EP ${state.selectedEpisode} selected // ${state.mode.toUpperCase()}`
            : `${countLabel(sel.epCount || state.episodes.length)} episodes // ${state.mode.toUpperCase()}`;
    }

    /* Every play request takes a number. Closing the player, opening another show or
     * asking for something else moves the number on, and an answer that comes back
     * holding an old one is dropped. */
    let playSeq = 0;
    let playPending = null;       // { key, seq } of the request in flight

    /**
     * Play one episode. With no argument it plays the selection (the PLAY button and
     * Enter). CONTINUE, auto-play and the previous/next buttons hand it exactly what to
     * play: { anime, episode, episodes, resumeAt }
     *
     * ⚠ WHAT WAS ASKED FOR IS FIXED HERE, BEFORE THE REQUEST. Everything after the await
     * used to read the selection again, live: tap episode 5 while episode 4 was loading
     * and 4 played under 5's name, with 5's progress and 5's watched mark.
     *
     * ⚠ THE RESUME OFFSET TRAVELS WITH THE REQUEST. It used to sit in a global until
     * some player started, so a play that failed, or was dropped by the old lock, left
     * it armed for whatever was played next.
     */
    async function playEpisode(target) {
        const t = (target && target.anime) ? target
            : { anime: state.selectedAnime, episode: state.selectedEpisode, episodes: state.episodes };
        if (!t.anime || t.episode == null || t.episode === '') return;
        const anime = t.anime;
        const episode = String(t.episode);
        const episodes = (t.episodes || []).map(String);
        const mode = state.mode;
        const quality = $('quality-select').value;

        /* A second tap while exactly this is loading changes nothing. Anything else
         * replaces what was loading: the newest request is the one that plays. (This
         * was a lock, and a lock drops the NEW request, which is the wrong one.) */
        const key = `${anime.id}|${episode}|${mode}`;
        if (playPending && playPending.key === key && playPending.seq === playSeq) return;
        const seq = ++playSeq;
        playPending = { key, seq };

        toast(`Loading EP ${episode}...`, 'info');

        try {
            const data = await API.getEpisodeUrl(anime.id, episode, mode, quality,
                { title: anime.title, alt: anime.titleEnglish || '', nsfw: state.nsfw });

            /* Closed, replaced, or another show opened while this loaded. */
            if (seq !== playSeq) return;

            if (!data || !data.url) {
                toast('No streams available. The episode may not be uploaded yet. Try again later.', 'error');
                return;
            }

            /* Something else is still on screen: file where it got to before it goes. */
            if (state.isPlaying) saveProgress();

            state.availableLinks = data.all_links || [];

            /* ⚠ skip_watched: AN EPISODE IS WATCHED AT 80%, NOT WHEN IT STARTS. Without
             * this flag the store put the episode in the watched list the moment the
             * stream came back, so a film opened for ten seconds counted as seen, and
             * through sync counted as seen on the desktop too. The desktop has passed
             * this flag from the start; the 80% rule below is what marks it. */
            await Storage.addToHistory({
                anime_id: anime.id,
                title: anime.title,
                episode,
                quality: data.resolution || quality,
                mode,
                total_episodes: countOf(anime.epCount) || episodes.length || null,
                skip_watched: true
            });
            state.history = await Storage.loadHistory();
            if (seq !== playSeq) return;       // closed while the history was written

            state.playing = { anime, episode, episodes, mode, finished: false };
            /* If the panel is showing this show, its selection follows what plays. */
            if (showingPlaying()) {
                state.selectedEpisode = episode;
                updatePlayButton();
                highlightEpisode(episode);
            }

            const playTitle = (state.preferEnglish && anime.titleEnglish) ? anime.titleEnglish : anime.title;
            state.nowPlaying = { title: playTitle, episode, quality: qualityLabel(data.resolution), mode };
            paintNowPlaying();

            // Reset watched tracking
            state.watchedMarked = false;
            state.currentPlaybackTime = 0;

            // Launch player. Subtitles ride along: the API layer passes them through
            // instead of rebuilding a url/referer-only object.
            state.streamSubtitles = data.subtitles || [];
            state.streamReferer = data.referer || null;
            state.pendingResumeTime = Number(t.resumeAt) > 0 ? Number(t.resumeAt) : 0;
            showPlayer(data.url);
            toast(`Playing: ${playTitle} EP ${episode}`, 'success');
        } catch (err) {
            if (seq !== playSeq) return;       // replaced: its failure is not news
            const msg = err.message || 'Unknown error';
            if (msg.includes('No stream') || msg.includes('404') || msg.includes('not found')) {
                toast('No streams available. Try again later', 'error');
            } else {
                toast(`Playback error: ${msg}`, 'error');
            }
        } finally {
            if (playPending && playPending.seq === seq) playPending = null;
        }
    }

    // Blob URLs from the previous episode, revoked on the next attach so they do not leak.
    let subBlobUrls = [];

    /**
     * Put the subtitle tracks on the <video>.
     *
     * WHY THE CUES ARE FETCHED BY HAND INSTEAD OF SETTING track.src DIRECTLY.
     * The .vtt is referer-gated exactly like the video — 403 direct, 200 with the header.
     * The xhrSetup trick used for HLS does not help here: a <track> is fetched by the
     * browser's own loader, not through XMLHttpRequest, so CapacitorHttp never intercepts
     * it and no header can be attached. Pointing a track at the raw url yields a silent 403
     * and an empty subtitle menu, which looks exactly like a source with no subtitles.
     *
     * So the text comes through NET.get, which already carries Referer natively, and the
     * element is handed a blob: url. Blobs are same-origin and need no headers at all.
     */
    async function attachSubtitles(video, subs, referer) {
        Array.from(video.querySelectorAll('track')).forEach(t => t.remove());
        subBlobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
        subBlobUrls = [];
        if (!subs.length || !window.NET) return;

        // ONE TRACK, CHOSEN DELIBERATELY, AND ONLY THAT ONE IS FETCHED.
        //
        // The first version attached every track and said `if (sub.default || i === 0)`,
        // intending index 0 as a fallback when nothing is flagged. HiAnime returns TEN
        // languages for some shows (pt, fr, ar, es, es-LA, en, de, it, ru, pl) with English
        // flagged at index 5, so that condition was true for English AND for index 0 and the
        // player rendered Brazilian Portuguese on top of English.
        //
        // Mobile pulls each .vtt over the network to get past the referer gate, so attaching
        // all ten also meant ten downloads to display one. Pick first, fetch once.
        const usable = subs.filter(s => s && s.src);
        // DO NOT TRUST THE SOURCE'S `default` FLAG — IT POINTS AT THE FORCED TRACK.
        // Measured 2026-10-17 on Super no Ura de Yani Suu Futari ep 10 (13 tracks returned):
        //     English            343 cues   first cue "Everyone's in Christmas mode."
        //     English (Forced)     23 cues   first cue "MOROMORO"   <- a station sign
        // Forced carries on-screen signs only, not dialogue, so picking it shows the viewer
        // almost nothing for a whole episode. Rank instead of trusting the flag; `default` is
        // only a tiebreak. Same logic as the desktop player.
        const subScore = (t) => {
            const label = String(t.label || ''), lang = String(t.lang || '');
            let n = 0;
            if (/^en/i.test(lang)) n += 100;
            if (/forced/i.test(label)) n -= 1000;
            if (/dubtitle/i.test(label)) n -= 50;
            if (/sdh/i.test(label)) n -= 10;
            if (t.default) n += 1;
            return n;
        };
        let pick = 0;
        if (usable.length) {
            let best = subScore(usable[0]);
            for (let i = 1; i < usable.length; i++) {
                const n = subScore(usable[i]);
                if (n > best) { best = n; pick = i; }
            }
        }
        const sub = usable[pick];
        if (!sub) return;

        let url;
        try {
            // per-track referer: tracks are pooled from several servers and each
            // host gates on its own. One shared referer 403s the rest.
            const r = await NET.get(sub.src, { referer: sub.referer || referer || '' });
            if (!r.ok || !/^\s*WEBVTT/.test(r.body)) return;   // a 403 page is not a cue file
            url = URL.createObjectURL(new Blob([r.body], { type: 'text/vtt' }));
            subBlobUrls.push(url);
        } catch (e) { return; }

        const t = document.createElement('track');
        t.kind = 'subtitles';
        t.label = sub.label || sub.lang || 'Subtitles';
        t.srclang = sub.lang || 'en';
        t.src = url;
        t.default = true;
        video.appendChild(t);
        // `default` only marks the track; the mode still has to be set, and setting it before
        // the cues parse is a no-op.
        t.addEventListener('load', () => applySubtitleMode(video), { once: true });

        // SUBTITLES DROPPING — SAME BUG AS THE DESKTOP PLAYER. FIXED 2026-10-17.
        // Setting mode='showing' is what makes hls.js turn the track OFF. hls.js 1.6.15 (the
        // version in www/lib/) registers onTextTracksChanged on MEDIA_ATTACHED, gated on
        // `hls.config.renderTextTracksNatively` which defaults to true. That handler scans for
        // the `showing` track, asks findTrackForTextTrack which of ITS OWN tracks it is, gets
        // -1 because this is a native <track> on a blob .vtt with no in-band subtitle
        // playlist, and calls setSubtitleTrack(-1) — its subtitles-off path.
        //
        // attachSubtitles() also runs BEFORE new Hls()/attachMedia() here, so the one-shot
        // load handler was always spent before hls.js had even touched the element. The real
        // fix is renderTextTracksNatively:false on the Hls config; this re-assert is the belt.
        applySubtitleMode(video);
    }

    // Re-assert which subtitle track is showing. Idempotent, so it is safe to call from any
    // hls.js or media event. Mobile appends exactly one track, so index 0 is the pick.
    function applySubtitleMode(video) {
        if (!video || !video.textTracks) return;
        for (let i = 0; i < video.textTracks.length; i++) {
            const want = (i === 0) ? 'showing' : 'disabled';
            if (video.textTracks[i].mode !== want) video.textTracks[i].mode = want;
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

        /* ── WATCH CLOCK ──────────────────────────────────────────────────────────
         * Counts REAL seconds in front of a playing video, never currentTime --
         * currentTime is a POSITION, so a scrub forward would bank time nobody watched
         * and a rewatch would run the total backwards.
         *
         * ⚠ THE GAP GUARD IS THE WHOLE TRICK, AND IT MATTERS MORE ON A PHONE. timeupdate
         * fires ~4x a second, so a healthy delta is ~0.25s. Anything bigger means the
         * clock ran while the video did not -- and a phone does that constantly: screen
         * off, app backgrounded, a call. Counting those would inflate the number by
         * hours. Discarded rather than clamped, because a clamp is still a guess about
         * time nobody was watching. */
        wtLast = Date.now();
        video.removeEventListener('timeupdate', watchClockTick);
        video.addEventListener('timeupdate', watchClockTick);
        for (const evName of ['play', 'playing', 'seeked']) {
            video.removeEventListener(evName, watchClockResume);
            video.addEventListener(evName, watchClockResume);
        }
        document.removeEventListener('visibilitychange', watchClockResume);
        document.addEventListener('visibilitychange', watchClockResume);

        // Save progress every 30s
        if (state.progressSaveInterval) clearInterval(state.progressSaveInterval);
        state.progressSaveInterval = setInterval(saveProgress, 30000);

        // Destroy previous HLS instance
        if (state.hlsInstance) {
            state.hlsInstance.destroy();
            state.hlsInstance = null;
        }

        // === SUBTITLES ===
        // Mobile never built a <track> either. Same gap as the desktop player, found the same
        // day: the field was never carried this far, so there was nothing to attach.
        //
        // NOTE ON WHAT THIS DOES AND DOES NOT FIX. Attaching the track is correct and costs
        // nothing, but every source that currently CARRIES subtitles is referer-gated, and a
        // webview cannot set Referer (see the hianime note in ani-mate-sources.js). So this
        // renders subtitles the moment a non-gated source returns them, or the moment mobile
        // gets a referer-capable media transport — and silently attaches nothing until then.
        // It is groundwork, not a working feature on mobile today. Do not write it up as one.
        attachSubtitles(video, state.streamSubtitles || [], state.streamReferer);

        const isM3u8 = streamUrl.includes('.m3u8') || streamUrl.includes('master.txt');
        state.currentStreamUrl = streamUrl;

        /* Listeners from an earlier attempt must not outlive it. The MP4 path added
         * one-shot `loadeddata` and `error` listeners and left the unused one in place,
         * so a later error ran an old closure and loaded an EARLIER episode's link. */
        if (state.playerAbort) state.playerAbort.abort();
        state.playerAbort = new AbortController();
        const lifetime = state.playerAbort.signal;

        const started = () => {
            $('player-loading').classList.add('hidden');
            if (state.pendingResumeTime > 0) {
                video.currentTime = state.pendingResumeTime;
                state.pendingResumeTime = 0;
            }
            video.play().catch(() => {});
        };
        /* The next link in the list, from where this one stopped. Every retry used to
         * start the episode again from 0:00. Returns false when there is no next link. */
        const tryNextLink = () => {
            const remaining = (state.availableLinks || []).filter(l => l.url !== streamUrl);
            if (!remaining.length) return false;
            const next = remaining[0];
            state.availableLinks = remaining;
            const at = video.currentTime || 0;
            if (at > 0) state.pendingResumeTime = at;
            toast(`Trying ${next.provider} (${next.resolution})...`, 'info');
            showPlayer(next.url);
            return true;
        };
        const giveUp = () => {
            $('player-loading').classList.add('hidden');
            toast('All streams failed. Try again in a moment', 'error');
        };

        if (isM3u8 && Hls.isSupported()) {
            /* ONE function builds the player, for the first attempt and for the second
             * one on the referer-capable transport (see hls-loader-fix.js). */
            const startHls = (native) => {
                const config = {
                    // Keep hls.js out of the native text-track business — see the note in
                    // attachSubtitles(). Without this it disables the <track> we just enabled.
                    renderTextTracksNatively: false,
                    subtitleDisplay: false,
                    /* ⚠ READ hls-loader-fix.js BEFORE TRUSTING THIS. The comment that
                     * used to sit here said this header is sent because CapacitorHttp
                     * replaces XMLHttpRequest. Capacitor's own code, as installed, does
                     * not read that way: for a GET the patched object hands this call to
                     * the WebView's real XMLHttpRequest, which refuses "Referer". It is
                     * kept because it is harmless and would start working on a transport
                     * that honors it; the second attempt below does not depend on it. */
                    xhrSetup: (xhr, url) => {
                        if (!state.streamReferer) return;
                        try { xhr.setRequestHeader('Referer', state.streamReferer); } catch (e) {}
                    }
                };
                if (native) config.loader = window.AniMateNativeHlsLoader(() => state.streamReferer);
                const hls = new Hls(config);
                state.hlsInstance = hls;
                let parsed = false, fragments = 0, netRetries = 0, mediaRetries = 0;

                hls.loadSource(streamUrl);
                hls.attachMedia(video);

                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    parsed = true;
                    started();
                    applySubtitleMode(video);
                    applyQualityChoice();
                });
                hls.on(Hls.Events.FRAG_LOADED, () => { fragments++; netRetries = 0; });
                // A level switch re-runs hls.js's track handling, so re-assert after each one.
                hls.on(Hls.Events.LEVEL_SWITCHED, (ev, d) => {
                    applySubtitleMode(video);
                    const lv = hls.levels && hls.levels[d.level];
                    if (lv && lv.height && state.nowPlaying) {
                        state.nowPlaying.quality = lv.height + 'P';
                        paintNowPlaying();
                    }
                });

                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (!data.fatal || state.hlsInstance !== hls) return;
                    const at = video.currentTime || 0;
                    const network = data.type === Hls.ErrorTypes.NETWORK_ERROR;

                    /* 1. Nothing arrived at all, and the stream came with a referer: the
                     *    host is very likely refusing requests that lack it. Try once on
                     *    the transport that can send it. */
                    if (network && !native && fragments === 0 && state.streamReferer
                        && window.AniMateNativeHlsLoader) {
                        console.log('[player] no data on the standard transport; trying the referer-capable one');
                        if (at > 0) state.pendingResumeTime = at;
                        hls.destroy();
                        startHls(true);
                        return;
                    }
                    /* 2. A stream that WAS playing and dropped: ask again where it
                     *    stopped. This had no recovery at all. */
                    if (network && parsed && fragments > 0 && netRetries < 3) {
                        netRetries++;
                        toast('Connection dropped, reconnecting...', 'info');
                        setTimeout(() => { if (state.hlsInstance === hls) hls.startLoad(); }, 1500 * netRetries);
                        return;
                    }
                    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
                        mediaRetries++;
                        hls.recoverMediaError();
                        return;
                    }
                    /* 3. Another link, if the source gave more than one. */
                    hls.destroy();
                    state.hlsInstance = null;
                    if (!tryNextLink()) giveUp();
                });
            };
            startHls(false);
        } else if (video.canPlayType('application/vnd.apple.mpegurl') && isM3u8) {
            // Native HLS (Safari/WebKit)
            video.addEventListener('loadedmetadata', started, { once: true, signal: lifetime });
            video.src = streamUrl;
        } else {
            // Direct MP4 or other format
            video.addEventListener('loadeddata', started, { once: true, signal: lifetime });
            video.addEventListener('error', () => { if (!tryNextLink()) giveUp(); },
                                   { once: true, signal: lifetime });
            video.src = streamUrl;
        }

        // Show player UI initially, auto-hide after 4s
        showPlayerUi();
    }

    /* ── QUALITY ─────────────────────────────────────────────────────────────────────
     * A stream from the backend is ONE adaptive stream with several levels inside it,
     * and no list of separate links. The control used to look only for separate links,
     * find none, and return without a word. It chooses among the stream's own levels:
     *   BEST    automatic: the highest level the connection sustains
     *   WORST   the lowest level
     *   1080 / 720 / 480 / 360   that height, or the nearest one below it
     * Returns the label it applied, or '' when the stream has nothing to choose from. */
    function applyQualityChoice() {
        const hls = state.hlsInstance;
        const wanted = $('quality-select').value;
        const levels = (hls && hls.levels) ? hls.levels.map((l, i) => ({ i, h: l.height || 0, b: l.bitrate || 0 })) : [];
        if (levels.length < 2) return '';
        let pick = -1, label = 'AUTO';
        if (wanted === 'worst') {
            const low = levels.slice().sort((a, b) => (a.h - b.h) || (a.b - b.b))[0];
            pick = low.i; label = low.h ? low.h + 'P' : 'LOW';
        } else if (wanted !== 'best') {
            const want = parseInt(wanted, 10) || 0;
            const below = levels.filter(l => l.h && l.h <= want).sort((a, b) => b.h - a.h)[0];
            const nearest = levels.slice().sort((a, b) => Math.abs(a.h - want) - Math.abs(b.h - want))[0];
            const got = below || nearest;
            pick = got.i; label = got.h ? got.h + 'P' : 'AUTO';
        }
        hls.currentLevel = pick;
        if (state.nowPlaying) { state.nowPlaying.quality = label; paintNowPlaying(); }
        return label;
    }

    function hidePlayer() {
        /* A play that is still waiting on the network must not open the player after
         * the user has closed it. */
        playSeq++;
        if (state.playerAbort) { state.playerAbort.abort(); state.playerAbort = null; }
        saveProgress();
        state.playing = null;
        state.nowPlaying = null;
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
        state.pendingResumeTime = 0;

        // Capacitor: unlock orientation + allow sleep + show status bar
        try { ScreenOrientation?.unlock(); } catch (e) {}
        try { KeepAwake?.allowSleep(); } catch (e) {}
        try { StatusBar?.show(); } catch (e) {}

        /* The panel under the player: its line of text, and the watched marks. */
        describeSelection();
        if (state.selectedAnime && state.episodes.length) renderEpisodeGrid();
    }

    /* The watched list in memory, brought in line with what was just written. */
    function noteWatchedLocally(playing) {
        const ep = String(playing.episode);
        const histEntry = state.history.find(h => String(h.anime_id) === String(playing.anime.id));
        if (histEntry) {
            if (!Array.isArray(histEntry.episodes_watched)) histEntry.episodes_watched = [];
            if (!histEntry.episodes_watched.includes(ep)) histEntry.episodes_watched.push(ep);
        }
        if (showingPlaying()) renderEpisodeGrid();
    }

    function watchTimeHandler() {
        const playing = state.playing;
        if (state.watchedMarked || !playing || playing.finished) return;
        const currentTime = video.currentTime;
        const duration = video.duration || Infinity;
        state.currentPlaybackTime = currentTime;

        /* Watched at 80% of the video. The 20 minute mark is used ONLY when the length
         * is not known. It used to be "whichever comes first", which marked a two hour
         * film watched at minute 20. */
        const threshold = Number.isFinite(duration) && duration > 0 ? duration * 0.8 : 1200;
        if (currentTime >= threshold) {
            state.watchedMarked = true;
            Storage.markWatched(playing.anime.id, playing.episode);
            noteWatchedLocally(playing);
        }
    }

    function saveProgress() {
        const playing = state.playing;
        /* ⛔ NOT AFTER THE VIDEO HAS ENDED. The 'ended' handler has already filed the
         * finished episode; its end time is not a place to resume from. */
        if (!playing || playing.finished || !video || !video.currentTime || video.ended) return;
        Storage.saveProgress(playing.anime.id, playing.episode, Math.floor(video.currentTime));
    }

    // Handle episode end — autoplay next or mark watched and queue next
    video.addEventListener('ended', async () => {
        /* What ENDED is what was playing, whatever is selected by now. */
        const playing = state.playing;
        if (!playing || playing.finished) return;
        playing.finished = true;

        if (state.progressSaveInterval) {
            clearInterval(state.progressSaveInterval);
            state.progressSaveInterval = null;
        }

        // Mark the finished episode as watched and clear its progress
        state.watchedMarked = true;
        try { await Storage.markWatched(playing.anime.id, playing.episode); } catch (e) {}
        noteWatchedLocally(playing);
        checkFavoritesUpdates();
        if (state.playing !== playing) return;      // closed or replaced while that was written

        const eps = playing.episodes || [];
        const currentIdx = eps.indexOf(String(playing.episode));
        const hasNext = currentIdx !== -1 && currentIdx < eps.length - 1;

        if (!hasNext) {
            toast(currentIdx === -1 ? 'Episode finished' : 'Series complete!', 'info');
            hidePlayer();
            return;
        }

        const nextEp = eps[currentIdx + 1];
        /* The panel follows only if it is still showing the show that was playing. */
        if (showingPlaying()) {
            state.selectedEpisode = nextEp;
            updatePlayButton();
            highlightEpisode(nextEp);
        }

        if (state.autoPlay) {
            toast(`Auto-playing EP ${nextEp}...`, 'info');
            playEpisode({ anime: playing.anime, episode: nextEp, episodes: eps });
        } else {
            hidePlayer();
            toast(`EP ${nextEp} ready. Press Play`, 'info');
        }
    });

    // Quality switching during playback
    $('quality-select').addEventListener('change', (e) => {
        if (!state.isPlaying) return;          // it is read when the next episode starts
        /* The stream's own levels first (see applyQualityChoice). */
        const label = applyQualityChoice();
        if (label) { toast(`Quality: ${label}`, 'info'); return; }
        /* Otherwise the separate links, when the source gave more than one. */
        const wanted = e.target.value;
        const links = state.availableLinks || [];
        const match = wanted === 'best' ? links[0]
            : wanted === 'worst' ? links[links.length - 1]
            : links.find(l => String(l.resolution || '').includes(wanted));
        if (match && match.url !== state.currentStreamUrl) {
            toast(`Switching to ${match.resolution}...`, 'info');
            state.pendingResumeTime = video.currentTime;
            if (state.nowPlaying) { state.nowPlaying.quality = qualityLabel(match.resolution); paintNowPlaying(); }
            showPlayer(match.url);
        } else if (!match && links.length > 1) {
            toast(`${wanted} is not offered for this episode`, 'error');
        } else {
            toast('This stream has one quality', 'info');
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

        /* One step from the episode that is PLAYING, through that show's own list. These
         * read the selection and the open show's list, so they went dead the moment
         * anything cleared the selection under the player. */
        const stepEpisode = (dir) => {
            const playing = state.playing;
            if (!playing || !playing.episodes.length) return;
            const idx = playing.episodes.indexOf(String(playing.episode));
            const to = idx + dir;
            if (idx < 0 || to < 0 || to >= playing.episodes.length) {
                toast(dir > 0 ? 'No next episode' : 'No previous episode', 'info');
                return;
            }
            const ep = playing.episodes[to];
            if (showingPlaying()) {
                state.selectedEpisode = ep;
                updatePlayButton();
                highlightEpisode(ep);
            }
            playEpisode({ anime: playing.anime, episode: ep, episodes: playing.episodes });
        };
        $('ctrl-next-ep').addEventListener('click', (e) => { e.stopPropagation(); stepEpisode(1); });
        $('ctrl-prev-ep').addEventListener('click', (e) => { e.stopPropagation(); stepEpisode(-1); });
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
                    video.currentTime = Math.max(0, video.currentTime - 5);
                    showSeekIndicator('-5s');
                } else if (zone === 'right') {
                    video.currentTime += 5;
                    showSeekIndicator('+5s');
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

    // Runs only after an empty result. Cheap, and it turns a dead end into a diagnosis.
    async function reportSourceTrouble() {
        if (!window.SOURCES) return;
        try {
            const h = await window.SOURCES.healthCheck();
            const live = h.sources.filter(s => s.state === 'up');
            if (live.length) return;   // sources are fine — the query really had no match

            const rows = h.sources.map(s => {
                const label = s.state === 'disabled' ? 'not enabled' : s.state;
                const ms = s.ms != null ? ` &middot; ${Number(s.ms) || 0}ms` : '';
                return `<div class="src-row"><span class="src-name">${esc(s.name)}</span>` +
                       `<span class="src-state src-${cls(s.state)}">${esc(label)}${ms}</span></div>`;
            }).join('');
            const t = h.transports || {};
            const transports = Object.keys(t).filter(k => t[k]).join(', ') || 'none';

            resultsContainer.innerHTML =
                '<div class="no-results source-trouble">' +
                '<div class="st-title">EVERY SOURCE IS UNREACHABLE</div>' +
                '<div class="st-sub">This is not an empty search &mdash; nothing answered.</div>' +
                `<div class="st-rows">${rows}</div>` +
                `<div class="st-foot">transports available: ${esc(transports)}</div>` +
                '</div>';
        } catch { /* leave the plain message */ }
    }

    /* ⚠ EVERY TAB DRAWS INTO THE SAME CONTAINER. Each loader below used to draw when its
     * answer arrived, whichever tab was showing by then: tap DAILY, then FAVS, and a slow
     * DAILY answer replaced the favorites under the FAVS tab. Each one keeps what it
     * fetched and draws only if its own tab is still the one on screen. */
    // === CONTINUE WATCHING ===
    async function loadContinue() {
        resultsContainer.innerHTML = '<div class="loading-indicator">LOADING...</div>';
        try {
            state.continueResults = await Storage.getContinueList();
            state.continueLoaded = true;
            if (state.activeTab === 'continue') renderContinue();
        } catch (err) {
            if (state.activeTab !== 'continue') return;
            resultsContainer.innerHTML = `<div class="no-results">Error: ${esc(err.message)}</div>`;
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

                return `<div class="result-card" data-id="${esc(r.anime_id)}" data-title="${escAttr(r.title)}"
                    data-eps="${countOf(r.total_episodes)}" data-resume-ep="${esc(resumeEp == null ? '' : resumeEp)}" data-resume-time="${Number(resumeTime) || 0}">
                    <div class="result-card-row">
                        <div class="result-info">
                            <div class="result-title">${esc(contPrimary)}</div>
                            ${contSecondary ? `<div class="result-title-en">${esc(contSecondary)}</div>` : ''}
                            <div class="result-meta">
                                <span class="result-type series">${esc(resumeLabel)}</span>
                                ${esc(totalLabel)} // ${esc(String(r.mode || 'sub').toUpperCase())}
                            </div>
                        </div>
                    </div>
                </div>`;
            }).join('');

        // Click to load episodes and auto-select resume episode
        resultsContainer.querySelectorAll('.result-card').forEach(card => {
            /* A long press that ended in the dialog below is not also a tap. */
            let longPressed = false;
            card.addEventListener('click', () => {
                if (longPressed) { longPressed = false; return; }
                /* The episode and the offset travel WITH this request (see loadEpisodes). */
                loadEpisodes(card.dataset.id, card.dataset.title, countOf(card.dataset.eps), {
                    autoEpisode: card.dataset.resumeEp,
                    resumeTime: parseFloat(card.dataset.resumeTime) || 0,
                });
            });
            // Long-press to remove from continue watching
            let lpTimer;
            card.addEventListener('touchstart', () => {
                lpTimer = setTimeout(async () => {
                    longPressed = true;
                    const id = card.dataset.id;
                    const title = card.dataset.title;
                    if (!confirm(`Remove "${title}" from history?`)) return;
                    try {
                        /* Waited for, and the list in memory follows it. This called
                         * showToast(), which does not exist, so the row was removed and
                         * the handler threw before it could say so. */
                        await Storage.removeFromHistory(id);
                        state.history = await Storage.loadHistory();
                        state.continueResults = state.continueResults.filter(r => String(r.anime_id) !== String(id));
                        renderContinue();
                        toast(`Removed "${title}"`, 'info');
                    } catch (err) {
                        toast('Could not remove it: ' + err.message, 'error');
                    }
                }, 600);
            }, { passive: true });
            card.addEventListener('touchend', () => clearTimeout(lpTimer));
            card.addEventListener('touchmove', () => clearTimeout(lpTimer));
        });
    }

    // === DAILY TRENDING ===
    async function loadDaily() {
        resultsContainer.innerHTML = '<div class="loading-indicator">LOADING TRENDING...</div>';
        try {
            state.dailyResults = (await API.getDailyPopular(state.mode)) || [];
            if (state.activeTab === 'daily') renderDaily();
        } catch (err) {
            if (state.activeTab !== 'daily') return;
            resultsContainer.innerHTML = `<div class="no-results">Error: ${esc(err.message)}</div>`;
        }
    }

    function renderDaily() {
        if (state.dailyResults.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results">No trending anime today</div>';
            return;
        }

        resultsContainer.innerHTML = '<div class="section-label">TRENDING TODAY</div>' +
            state.dailyResults.map((r, i) => {
                const isFav = isFavId(r.id);
                const coverHtml = r.cover
                    ? `<div class="cover-wrap"><img src="${esc(r.cover)}" loading="lazy" alt=""></div>`
                    : '';
                const hasEn = !!r.title_english && !sameText(r.title_english, r.name);
                const primary = (state.preferEnglish && hasEn) ? r.title_english : r.name;
                const secondary = (state.preferEnglish && hasEn) ? r.name : (hasEn ? r.title_english : '');
                return `<div class="result-card" data-id="${esc(r.id)}" data-title="${escAttr(r.name)}" data-eps="${countOf(r.episodes)}">
                    <div class="result-card-row">
                        <button class="fav-star-inline ${isFav ? 'active' : ''}" data-fav-id="${esc(r.id)}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${countOf(r.episodes)}" data-fav-english="${escAttr(r.title_english || '')}" data-fav-cover="${escAttr(r.cover || '')}">${isFav ? '&#9733;' : '&#9734;'}</button>
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title">${esc(primary)}</div>
                            ${secondary ? `<div class="result-title-en">${esc(secondary)}</div>` : ''}
                            <div class="result-meta"><span class="result-type series">#${i + 1}</span>${countLabel(r.episodes)} EP</div>
                        </div>
                    </div>
                </div>`;
            }).join('');

        bindCards(resultsContainer);
    }

    // === RELEASES (AIRING SCHEDULE) ===
    async function loadReleases() {
        if (!state.releasesDate) state.releasesDate = new Date();
        const y = state.releasesDate.getFullYear(), mo = String(state.releasesDate.getMonth()+1).padStart(2,'0'), dd = String(state.releasesDate.getDate()).padStart(2,'0');
        const dateStr = `${y}-${mo}-${dd}`;
        resultsContainer.innerHTML = '<div class="loading-indicator">SCANNING SCHEDULE...</div>';

        /* PREV and NEXT each make a new date object, so "is this still the day that was
         * asked for" is one comparison. */
        const asked = state.releasesDate;
        try {
            const found = await API.getAiringSchedule(dateStr);
            if (state.releasesDate !== asked) return;
            state.releasesResults = found || [];
            if (state.activeTab === 'releases') renderReleases();
        } catch (err) {
            if (state.releasesDate !== asked || state.activeTab !== 'releases') return;
            resultsContainer.innerHTML = `<div class="no-results">Error: ${esc(err.message)}</div>`;
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
                    ? `<div class="cover-wrap"><img src="${esc(r.cover)}" loading="lazy" alt=""></div>`
                    : '';
                const isFav = state.favorites.some(f => f.name === r.title || f.name === r.title_romaji);
                const hoursSinceAir = (nowSec - r.airingAt) / 3600;
                const tagHtml = r.airingAt > nowSec
                    ? '<span class="release-tag pending">UPCOMING</span>'
                    : hoursSinceAir < 6
                        ? '<span class="release-tag publishing">PUBLISHING</span>'
                        : '<span class="release-tag released">AIRED</span>';
                const relHasEn = !!r.title && !!r.title_romaji && !sameText(r.title, r.title_romaji);
                const relPrimary = (state.preferEnglish || !relHasEn) ? r.title : r.title_romaji;
                const relSecondary = (state.preferEnglish && relHasEn) ? r.title_romaji : (relHasEn ? r.title : '');
                return `<div class="result-card release-card" data-release-title="${escAttr(r.title)}" data-release-romaji="${escAttr(r.title_romaji)}" data-release-anilist-id="${esc(r.anilist_id || '')}">
                    <div class="result-card-row">
                        <button class="fav-star-inline ${isFav ? 'active' : ''}" data-rel-fav-title="${escAttr(r.title)}" data-rel-fav-romaji="${escAttr(r.title_romaji || '')}" data-rel-fav-eps="${countOf(r.totalEpisodes)}">${isFav ? '&#9733;' : '&#9734;'}</button>
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title">${esc(relPrimary)} ${tagHtml}</div>
                            ${relSecondary ? `<div class="result-title-en">${esc(relSecondary)}</div>` : ''}
                            <div class="result-meta">
                                <span class="result-type series">${esc(r.format || 'TV')}</span>
                                EP ${esc(r.episode)}${r.totalEpisodes ? '/' + esc(r.totalEpisodes) : ''}
                                — <span class="release-time">${esc(airTime)}</span>
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

    /* What the last RELEASES tap found. Kept so the show that opens knows its English
     * title, cover and AniList id (see knownShow); these rows used to be dropped. */
    state.lookupResults = [];
    let releaseSeq = 0;

    async function findRelease(title, romaji) {
        let results = (await API.searchAnime(title, state.mode, state.nsfw)) || [];
        if (results.length === 0 && romaji && romaji !== title) {
            results = (await API.searchAnime(romaji, state.mode, state.nsfw)) || [];
        }
        return results;
    }

    function bindReleaseCards() {
        document.querySelectorAll('.release-card').forEach(card => {
            card.addEventListener('click', async (e) => {
                if (e.target.closest('.fav-star-inline')) return;
                const title = card.dataset.releaseTitle;
                const romaji = card.dataset.releaseRomaji;
                /* Two cards tapped one after the other: only the last one opens. */
                const mine = ++releaseSeq;
                toast(`Searching for ${title}...`, 'info');

                try {
                    const results = await findRelease(title, romaji);
                    if (mine !== releaseSeq) return;
                    if (results.length > 0) {
                        const match = bestTitleMatch(results, title, romaji);
                        /* The schedule row is an AniList row, so its id is exact, but
                         * only for a result whose name IS that title. bestTitleMatch
                         * falls back to "close" and then to "first". */
                        const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        const wanted = [norm(title), norm(romaji)].filter(Boolean);
                        const exact = [norm(match.name), norm(match.title_english)].some(n => n && wanted.includes(n));
                        const aid = parseInt(card.dataset.releaseAnilistId, 10);
                        if (exact && aid > 0 && !match.anilist_id) match.anilist_id = aid;
                        state.lookupResults = results;
                        loadEpisodes(match.id, match.name, match.episodes);
                    } else {
                        toast('Not found on streaming source', 'error');
                    }
                } catch (err) {
                    if (mine === releaseSeq) toast(`Search error: ${err.message}`, 'error');
                }
            });
        });

        // Bind favorite stars on release cards (the show is looked up by name first)
        document.querySelectorAll('.release-card .fav-star-inline').forEach(star => {
            let working = false;
            star.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (working) return;             // a second tap while the first is looking it up
                working = true;
                const title = star.dataset.relFavTitle;
                const romaji = star.dataset.relFavRomaji;
                try {
                    // Check if already favorited by name
                    const existing = state.favorites.find(f => f.name === title || (romaji && f.name === romaji));
                    if (existing) {
                        state.favorites = await Storage.removeFavorite(existing.id);
                        toast('Removed from favorites', 'info');
                    } else {
                        toast('Adding to favorites...', 'info');
                        const results = await findRelease(title, romaji);
                        if (!results.length) { toast('Not found on streaming source', 'error'); return; }
                        /* The result that MATCHES the title. This took the first hit,
                         * whatever it was, and starred that. */
                        const match = bestTitleMatch(results, title, romaji);
                        const fav = { id: match.id, name: match.name, episodes: match.episodes || 0,
                                      title_english: match.title_english || title };
                        if (match.cover) fav.cover = match.cover;
                        state.favorites = await Storage.addFavorite(fav);
                        toast('Added to favorites', 'success');
                    }
                    refreshStars();
                    updatePanelFavStar();
                    checkFavoritesUpdates();
                } catch (err) {
                    toast(`Favorites error: ${err.message}`, 'error');
                } finally {
                    working = false;
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

        /* ⛔ THIS WAS A SECOND, HAND-COPIED GROUPING keyed on `if (r.franchise_id)` —
         * a copy of a copy. One implementation now, shared with the desktop and with
         * the results grid.
         *
         * 'first' — "show cards should only be the first season card on FAV". The old
         * parent was members[0] of an insertion-ordered list, i.e. whichever season was
         * starred first. */
        const { groups, ungrouped } = groupByFranchise(state.favorites, 'first');

        const updatedIds = new Set((state.favUpdates || []).map(u => u.id));
        let html = '<div class="section-label">FAVORITES</div>';

        for (const group of groups) {
            const fid = group.franchise_id;
            const members = group.members;
            const parent = group.parent;
            const hasEn = !!parent.title_english && !sameText(parent.title_english, parent.name);
            const primary = (state.preferEnglish && hasEn) ? parent.title_english : parent.name;
            const franchiseHasUpdate = members.some(m => updatedIds.has(m.id));
            const franchiseDot = franchiseHasUpdate ? '<span class="fav-new-dot" title="New episode this week"></span>' : '';

            html += `<div class="franchise-group" data-franchise="${esc(fid)}">
                <div class="result-card franchise-parent" data-id="${esc(parent.id)}" data-title="${escAttr(parent.name)}" data-eps="${countOf(parent.episodes)}">
                    <div class="result-card-row">
                        <button class="fav-star-inline active" data-fav-id="${esc(parent.id)}" data-fav-name="${escAttr(parent.name)}" data-fav-eps="${countOf(parent.episodes)}" data-fav-english="${escAttr(parent.title_english || '')}" data-fav-franchise="${esc(fid)}" data-fav-cover="${escAttr(parent.cover || '')}">&#9733;</button>
                        ${parent.cover ? `<div class="release-cover-wrap"><img class="release-cover" src="${escAttr(parent.cover)}" loading="lazy" alt=""></div>` : ''}
                        <div class="result-info">
                            <div class="result-title">${esc(primary)}${franchiseDot}</div>
                            <div class="result-meta"><span class="result-type series">FRANCHISE</span>${members.length} entries <span class="franchise-toggle">&#9660;</span></div>
                        </div>
                    </div>
                </div>
                <div class="franchise-entries" style="display:none;">`;
            for (const m of members) {
                const mHasEn = !!m.title_english && !sameText(m.title_english, m.name);
                const mTitle = (state.preferEnglish && mHasEn) ? m.title_english : m.name;
                html += `<div class="result-card franchise-entry" data-id="${esc(m.id)}" data-title="${escAttr(m.name)}" data-eps="${countOf(m.episodes)}">
                    <div class="result-card-row">
                        <button class="fav-star-inline active" data-fav-id="${esc(m.id)}" data-fav-name="${escAttr(m.name)}" data-fav-eps="${countOf(m.episodes)}" data-fav-english="${escAttr(m.title_english || '')}" data-fav-franchise="${esc(fid)}" data-fav-cover="${escAttr(m.cover || '')}">&#9733;</button>
                        ${m.cover ? `<div class="release-cover-wrap"><img class="release-cover" src="${escAttr(m.cover)}" loading="lazy" alt=""></div>` : ''}
                        <div class="result-info">
                            <div class="result-title">${esc(mTitle)}</div>
                            <div class="result-meta">${countLabel(m.episodes)} EP</div>
                        </div>
                    </div>
                </div>`;
            }
            html += '</div></div>';
        }

        html += ungrouped.map(r => {
            const hasEn = !!r.title_english && !sameText(r.title_english, r.name);
            const primary = (state.preferEnglish && hasEn) ? r.title_english : r.name;
            const secondary = (state.preferEnglish && hasEn) ? r.name : (hasEn ? r.title_english : '');
            const newDot = updatedIds.has(r.id) ? '<span class="fav-new-dot" title="New episode this week"></span>' : '';
            return `<div class="result-card" data-id="${esc(r.id)}" data-title="${escAttr(r.name)}" data-eps="${countOf(r.episodes)}">
                <div class="result-card-row">
                    <button class="fav-star-inline active" data-fav-id="${esc(r.id)}" data-fav-name="${escAttr(r.name)}" data-fav-eps="${countOf(r.episodes)}" data-fav-english="${escAttr(r.title_english || '')}" data-fav-franchise="${esc(r.franchise_id)}" data-fav-cover="${escAttr(r.cover || '')}">&#9733;</button>
                    ${r.cover ? `<div class="release-cover-wrap"><img class="release-cover" src="${escAttr(r.cover)}" loading="lazy" alt=""></div>` : ''}
                    <div class="result-info">
                        <div class="result-title">${esc(primary)}${newDot}</div>
                        ${secondary ? `<div class="result-title-en">${esc(secondary)}</div>` : ''}
                        <div class="result-meta">${countLabel(r.episodes)} EP</div>
                    </div>
                </div>
            </div>`;
        }).join('');

        resultsContainer.innerHTML = html;
        bindCards(resultsContainer);
        bindFranchiseToggles(resultsContainer);
    }

    /* Every season of this franchise we can name, fetching once if the pool does not
     * already hold them: "all seasons should always be brough up for a show". Starring
     * from FAVS or history means the siblings were never searched for, so the local pool
     * holds exactly one row and a fetch is the only way to know the rest. */
    async function franchiseMembers(self, key) {
        /* Seasons, not the whole franchise. Films and OVAs are reachable from the strip's
         * "+N more" and do not belong in a favorites list of shows. The rules
         * (FR.narrowToFranchise, FR.starSet) are shared with the desktop; what is this
         * file's own is how it searches. */
        let sibs = key ? franchiseSiblings(key) : [];
        if (sibs.length < 2) {
            const base = key && key.startsWith('fp:') ? key.slice(3) : FR.franchiseBase(self.name);
            if (base) {
                try {
                    const found = await API.searchAnime(base, state.mode, state.nsfw);
                    const got = (found || []).filter(r => r && r.id);
                    const mine = FR.narrowToFranchise(self, franchisePool(), got);
                    franchiseCache[key || mine.key] = mine.rows;
                    sibs = franchiseSiblings(key || mine.key);
                } catch { /* offline or no match: star just the one row */ }
            }
        }
        return FR.starSet(self, sibs);
    }

    /** Which favorites belong to the same franchise as `id`. */
    function favoritesInFranchise(id, self) {
        return FR.inFranchiseOf(id, state.favorites, franchisePool(), self);
    }

    /* ⛔ FAVORITING IS A FRANCHISE ACTION, NOT A ROW ACTION.
     * "it should fav all seasons of it, not just one and all seasons should always be
     * brough up for a show." Both directions, or the star lies: starring a franchise and
     * then un-starring it would leave the other seasons behind. */
    const favBusy = new Set();
    async function toggleFavorite(id, name, episodes, titleEnglish, franchiseId, cover) {
        /* One toggle per show at a time. A double tap ran two of these side by side:
         * both saw "not a favorite" and both added. */
        if (favBusy.has(String(id))) return;
        favBusy.add(String(id));
        const isFav = state.favorites.some(f => String(f.id) === String(id));
        const self = { id, name, episodes: parseInt(episodes) || 0,
                       title_english: titleEnglish || '', cover: cover || '',
                       franchise_id: franchiseId || '' };
        try {
            if (isFav) {
                const doomed = favoritesInFranchise(id, self);
                for (const f of doomed) state.favorites = await Storage.removeFavorite(f.id);
                toast(doomed.length > 1 ? `Removed ${doomed.length} seasons from favorites`
                                        : 'Removed from favorites', 'info');
            } else {
                const key = franchiseKeyOf(self);
                const members = await franchiseMembers(self, key);
                for (const m of members) {
                    const favData = { id: m.id, name: m.name,
                                      episodes: parseInt(m.episodes) || 0,
                                      title_english: m.title_english || '' };
                    /* Never overwrite a real server franchise_id with a derived one —
                     * only fill the blank, so the grouping survives a cold start where
                     * state.favorites is the entire pool. */
                    const fx = m.franchise_id || (key.startsWith('fp:') ? key : '');
                    if (fx) favData.franchise_id = fx;
                    if (m.cover) favData.cover = m.cover;
                    state.favorites = await Storage.addFavorite(favData);
                }
                toast(members.length > 1 ? `Added ${members.length} seasons to favorites`
                                         : 'Added to favorites', 'success');
            }
        } catch (err) {
            toast(`Favorites error: ${err.message}`, 'error');
            /* Part of a franchise may have been saved before the failure. Read the list
             * back instead of guessing. */
            try { state.favorites = await Storage.loadFavorites(); } catch (e) { /* keep what is held */ }
        } finally {
            favBusy.delete(String(id));
        }

        updatePanelFavStar();
        checkFavoritesUpdates();
        /* FAVS is re-drawn, because a show leaves the list. Everywhere else only the
         * stars change, in place. This re-drew the search results, and re-drawing them
         * closed the open show: starring a show from its own panel emptied the panel.
         * On RELEASES it fetched the whole day's schedule again. */
        if (state.activeTab === 'favs') renderFavorites();
        else refreshStars();
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
                /* Enter on the episode that is already playing used to start it again
                 * from the beginning. */
                if (state.isPlaying) break;
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
    /* Not `playEpisode` itself: a listener is handed the click event, and playEpisode
     * takes "what to play" as its argument. */
    $('play-btn').addEventListener('click', () => playEpisode());

    // Episode panel back
    $('panel-back').addEventListener('click', hideEpisodePanel);

    // Episode panel fav star
    $('panel-fav').addEventListener('click', () => {
        if (state.selectedAnime) {
            toggleFavorite(state.selectedAnime.id, state.selectedAnime.title, state.selectedAnime.epCount, state.selectedAnime.titleEnglish, state.selectedAnime.franchiseId || '', state.selectedAnime.cover || '');
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
        applyTitleLanguage();
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

    // NSFW toggle (default OFF)
    const savedNsfw = localStorage.getItem('ani-mate-nsfw') === 'true';
    state.nsfw = savedNsfw;
    const nsfwEl = $('nsfw-toggle');
    if (nsfwEl) {
        nsfwEl.checked = savedNsfw;
        nsfwEl.addEventListener('change', (e) => {
            state.nsfw = e.target.checked;
            localStorage.setItem('ani-mate-nsfw', e.target.checked);
            toast(state.nsfw ? '18+ content ON' : '18+ content OFF', 'info');
        });
    }

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
                    headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ANI-MATE-Android' },
                    connectTimeout: 10000,
                    readTimeout: 10000
                });
                if (resp.status !== 200) return;
                release = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
            } else {
                const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
                    headers: { 'Accept': 'application/vnd.github.v3+json' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!resp.ok) return;
                release = await resp.json();
            }

            const latest = (release.tag_name || '').replace(/^v/, '');
            if (!latest || !isNewer(latest, APP_VERSION)) return;

            // 24h cooldown: don't nag if user dismissed this version recently
            const dismissKey = 'ani-mate-update-dismissed';
            try {
                const dismissed = JSON.parse(localStorage.getItem(dismissKey) || '{}');
                if (dismissed.version === latest && (Date.now() - dismissed.at) < 86400000) return;
            } catch { /* corrupted — ignore */ }

            // Find the mobile APK asset
            const apk = (release.assets || []).find(a => a && typeof a.name === 'string'
                && a.name.toLowerCase().includes('mobile') && a.name.endsWith('.apk'));
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

    /* Only this project's own release downloads. The address comes out of an API answer;
     * the native installer checks it again (see ApkInstaller.java), and this is the
     * same rule on the near side so a bad one never gets that far. */
    function isReleaseDownload(url) {
        const want = ('https://github.com/' + GITHUB_REPO + '/releases/download/').toLowerCase();
        return typeof url === 'string' && url.toLowerCase().startsWith(want);
    }

    function showUpdateDialog(version, downloadUrl, changelog) {
        if (!isReleaseDownload(downloadUrl)) {
            console.warn('Update skipped: the download is not on this project\'s release page');
            return;
        }
        // Remove existing dialog if any
        const existing = document.getElementById('update-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'update-dialog-overlay';
        overlay.className = 'update-overlay';

        overlay.innerHTML = `
            <div class="update-dialog">
                <div class="update-dialog-title">UPDATE AVAILABLE</div>
                <div class="update-dialog-version">v${esc(APP_VERSION)} → v${esc(version)}</div>
                <div class="update-dialog-changelog" id="update-notes"></div>
                <div class="update-dialog-progress hidden" id="update-progress">
                    <div class="update-progress-bar"><div class="update-progress-fill" id="update-progress-fill"></div></div>
                    <div class="update-progress-text" id="update-progress-text">Downloading...</div>
                    <div class="update-dialog-buttons" style="margin-top:12px">
                        <button class="update-btn-later" id="update-hide">HIDE</button>
                    </div>
                </div>
                <div class="update-dialog-buttons" id="update-buttons">
                    <button class="update-btn-later" id="update-later">LATER</button>
                    <button class="update-btn-install" id="update-install">UPDATE NOW</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        /* ⚠ THE NOTES ARE WRITTEN AS TEXT. They are whatever the release page says,
         * fetched over the network, and they used to be put into the page as HTML. */
        const notes = overlay.querySelector('#update-notes');
        const text = String(changelog || '').trim().substring(0, 300);
        if (text) {
            notes.style.whiteSpace = 'pre-line';
            notes.textContent = text;
        } else {
            notes.remove();
        }

        document.getElementById('update-later').onclick = () => {
            localStorage.setItem('ani-mate-update-dismissed', JSON.stringify({ version, at: Date.now() }));
            overlay.remove();
        };
        /* Once a download had started the dialog had no way out, and a download that
         * stalled left it over the whole app. The download carries on behind it. */
        document.getElementById('update-hide').onclick = () => overlay.remove();
        document.getElementById('update-install').onclick = () => {
            localStorage.removeItem('ani-mate-update-dismissed');
            startUpdate(downloadUrl, overlay);
        };
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
    // Optional line shown above the list in the update popup. Empty string hides it.
    const CHANGELOG_NOTE = "Scrolling is fixed -- the browse grid was growing instead of scrolling, so anything past the first screenful could not be reached. Cards are a uniform size now. And sync is here: one optional account keeps your list, your history and your place in every episode the same on your computer and your phone, with no email and no password.";

    const CHANGELOG = [
        "Scrolling works again. Favorites, search, daily, releases and continue all share one container, and it was growing to fit its contents instead of scrolling -- so everything past the first screenful was simply unreachable",
        "Cards are all the same size. They were four different heights depending on whether a title ran to two lines and whether the show had a separate English name",
        "The bar above the grid no longer bunches up. The quality and audio controls stay together, and SYNC, PLAY and DL move as one block instead of scattering across a second row",
        "Sync across your devices. Favorites, watch history and your exact resume position stay the same on the desktop and the phone",
        "ANI-MATE asks you once, on first launch, whether you want sync on. Say no and nothing changes; the SYNC button is there whenever you change your mind",
        "No email, no password, no username. You get a recovery key to write down, and that is the whole account -- nothing stored about you has a name on it",
        "You can pull your recovery key back up any time from the device you made it on, so missing the first popup costs you nothing",
        "Adding a second device is the TV flow: the new one shows six digits and you type them into the device you are already signed in on",
        "A device list you can rename and sign out of, from any of your devices. Signing out shows you your recovery key first, because without it there is no way back in",
        "MY WATCHING: how long you have actually watched, by day, which genres you really reach for, and the shows you have put the most episodes into. It counts whether or not you use sync, and adds up across your devices when you do",
        "Deleting your account really deletes it, immediately, including the watch history and the stats",
    ];

    function showChangelog() {
        const lastVer = localStorage.getItem('ani-mate-last-version');
        if (lastVer === APP_VERSION) return;
        const overlay = document.createElement('div');
        overlay.className = 'changelog-overlay';
        overlay.innerHTML = `
            <div class="changelog-modal">
                <div class="changelog-ver">ANI-MATE v${APP_VERSION}</div>
                ${CHANGELOG_NOTE ? `<p class="changelog-note">${esc(CHANGELOG_NOTE)}</p>` : ''}
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
    /* ── THE WEEK'S AIRING LIST, FETCHED ONCE AND KEPT FOR HALF AN HOUR ────────────────
     * The check below runs after every star, after every finished episode and at launch,
     * and each run used to fetch this list again: up to 20 requests. AniList allows this
     * address 30 a minute (measured 2026-11-12), so starring two shows in a row was
     * enough to have covers, descriptions and the schedule refused for the next minute.
     * The list changes a few times an hour; what changes on a star is the FAVORITES,
     * and matching those against a list already held costs nothing.
     * A fetch that fails is not repeated for five minutes. */
    const airing = { at: 0, list: null, loading: null, failedAt: 0 };
    async function recentlyAired() {
        const now = Date.now();
        if (airing.list && now - airing.at < 30 * 60 * 1000) return airing.list;
        if (airing.loading) return airing.loading;
        if (now - airing.failedAt < 5 * 60 * 1000) return airing.list || [];
        airing.loading = (async () => {
            const nowSec = Math.floor(Date.now() / 1000);
            const weekAgo = nowSec - (7 * 86400);
            const all = [];
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
                /* Through the counted door, as a spare question. A refusal, or no room
                 * to spare, is a failure and not an empty page: half a list kept as the
                 * whole list would hide new episodes for half an hour. */
                const json = await API.anilistPost(gql, { page, gt: weekAgo, lt: nowSec }, 8000, 'spare');
                if (json === null) throw new Error('AniList has no room to spare');
                const pg = json?.data?.Page;
                if (pg?.airingSchedules) all.push(...pg.airingSchedules);
                hasNext = pg?.pageInfo?.hasNextPage || false;
                page++;
            }
            return all;
        })().then((list) => {
            airing.list = list; airing.at = Date.now(); airing.loading = null;
            return list;
        }, (err) => {
            airing.loading = null; airing.failedAt = Date.now();
            throw err;
        });
        return airing.loading;
    }

    async function checkFavoritesUpdates() {
        if (state.favorites.length === 0) {
            const badge = document.querySelector('.fav-badge');
            if (badge) badge.remove();
            return;
        }
        try {
            const allRecent = await recentlyAired();

            // Check which favorites match recently aired shows
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const updates = [];
            for (const fav of state.favorites) {
                const favNorm = norm(fav.name);
                if (!favNorm) continue;
                const match = allRecent.find(s => {
                    const romaji = norm(s.media?.title?.romaji);
                    const english = norm(s.media?.title?.english);
                    return (romaji && romaji === favNorm) || (english && english === favNorm) ||
                           (romaji && (romaji.includes(favNorm) || favNorm.includes(romaji))) ||
                           (english && (english.includes(favNorm) || favNorm.includes(english)));
                });
                if (match) updates.push({ id: fav.id, name: fav.name });
            }

            // Filter out read IDs
            state.favUpdates = updates.filter(u => !state.favReadIds.includes(u.id));
            updateFavBadge();
        } catch (e) { /* non-critical */ }
    }

    function updateFavBadge() {
        const badge = document.querySelector('.fav-badge');
        if (badge) badge.remove();
        const unread = (state.favUpdates || []).length;
        if (unread > 0) {
            const favBtn = document.querySelector('[data-tab="favs"]');
            if (favBtn) {
                const b = document.createElement('span');
                b.className = 'fav-badge';
                b.title = `${unread} favorite${unread > 1 ? 's have' : ' has'} new episodes`;
                favBtn.style.position = 'relative';
                favBtn.appendChild(b);
            }
        }
    }

    function markFavRead(favId) {
        state.favUpdates = (state.favUpdates || []).filter(u => u.id !== favId);
        if (!state.favReadIds.includes(favId)) {
            state.favReadIds.push(favId);
            localStorage.setItem('ani-mate-fav-read-ids', JSON.stringify(state.favReadIds));
        }
        updateFavBadge();
    }

    // Global image error handler — hide broken cover/banner images
    document.addEventListener('error', function(e) {
        if (e.target.tagName === 'IMG' && (e.target.classList.contains('release-cover') || e.target.classList.contains('anime-cover-img') || e.target.classList.contains('anime-banner-img'))) {
            e.target.style.display = 'none';
        }
    }, true);

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

        /* The default view, unless a tab was tapped while the two lists above were still
         * being read. This line used to be written over whatever was on screen: FAVS
         * tapped in that moment said "No favorites yet" (it had been drawn from the
         * empty list) and then went to the search prompt with its own tab still lit.
         * Seen on an Android 16 emulator, 2026-11-14; 0.7.1 did the same. */
        if (state.activeTab === 'favs') renderFavorites();
        else if (state.activeTab === 'search' && !(state.results && state.results.length)) {
            resultsContainer.innerHTML = '<div class="no-results">Search for anime above</div>';
        }

        // Show changelog on version update
        showChangelog();

        // Fill the content index in the background on a fresh install, so a query

        // that describes a show instead of naming it has a corpus to search.

        window.CONTENT_INDEX?.seedIfEmpty();


        // Check for new episodes on favorites (non-blocking)
        setTimeout(checkFavoritesUpdates, 2000);

        // Check for updates (non-blocking, after 3s to not delay startup)
        setTimeout(checkForUpdate, 3000);

        // ...and again whenever the app comes back to the foreground.
        // Android keeps the WebView alive when an app is backgrounded, so init() runs
        // once per cold start and never again. Without this a resident app can sit for
        // weeks without noticing a release — which is exactly what happened with v0.4.5.
        // Throttled to once an hour so returning to the app is not a network event.
        App?.addListener?.('appStateChange', ({ isActive }) => {
            if (!isActive) return;
            const last = Number(localStorage.getItem('ani-mate-update-checked') || 0);
            if (Date.now() - last < 3600000) return;
            localStorage.setItem('ani-mate-update-checked', String(Date.now()));
            checkForUpdate();
        });
    }

    /* ── THE HOOK SYNC NEEDS ──────────────────────────────────────────────────────
     * Everything in this file is inside an IIFE, so ani-mate-sync-ui.js cannot reach
     * renderFavorites() or loadContinue() to show what a sync just brought in. One
     * exported function, rather than exposing the internals or moving them out.
     *
     * ⚠ state.favorites IS AN IN-MEMORY CACHE. Sync writes favorites.json directly, so
     * re-rendering without re-reading would paint the list from before the sync and
     * look exactly like a sync that did nothing. */

    /* See the note where this is wired up, in showPlayer. */
    let wtLast = 0;
    const WT_MAX_GAP = 2;

    /* Restart the clock instead of letting the first tick after a pause, a seek or the
     * app coming back to the foreground bill the whole idle stretch. Without this the gap
     * guard is the only defense, and a 1.9s pause slips straight through it. */
    function watchClockResume() { wtLast = Date.now(); }

    function watchClockTick() {
        const video = document.getElementById('video-player');
        const now = Date.now();
        if (!video || video.paused || video.seeking || video.ended
            || document.visibilityState !== 'visible') {
            wtLast = now;
            return;
        }
        const delta = (now - wtLast) / 1000;
        wtLast = now;
        if (delta <= 0 || delta > WT_MAX_GAP) return;
        if (window.SYNC) window.SYNC.noteWatching(delta, currentGenres());
    }

    /* The genres of whatever is playing. They come from the client because they must:
     * graphql.anilist.co answers every Cloudflare Worker IP with 403, so the edge cannot
     * look a show up. The app already has them -- it is what the cards render. */
    function currentGenres() {
        const of = (state.playing && state.playing.anime) || state.selectedAnime;
        const id = of && String(of.id || '');
        if (!id) return [];
        const pools = [state.results, state.favorites, state.dailyResults,
                       state.releasesResults, state.continueResults, state.lookupResults];
        for (const pool of pools) {
            if (!Array.isArray(pool)) continue;
            for (const it of pool) {
                if (it && String(it.id) === id && Array.isArray(it.genres)) return it.genres;
            }
        }
        return [];
    }

    window.__animateRefreshAfterSync = async function () {
        try {
            state.favorites = await Storage.loadFavorites();
            /* The history too: watched marks and resume points pulled from another
             * device live there, and the grid's check marks are drawn from this copy. */
            state.history = await Storage.loadHistory();
            updatePanelFavStar();
            if (state.activeTab === 'favs') renderFavorites();
            else if (state.activeTab === 'continue') {
                /* Read first, draw after. loadContinue() blanks the list to a loading
                 * line before it reads, which threw the list away and back on every
                 * sync. */
                state.continueResults = await Storage.getContinueList();
                state.continueLoaded = true;
                if (state.activeTab === 'continue') renderContinue();
            }
            /* ⛔ SEARCH, DAILY AND RELEASES GET THEIR STARS UPDATED, NOT A RE-DRAW. This
             * called renderResults() on the search tab, and renderResults() cleared the
             * open show: a sync that pulled one row, two minutes into an episode, took
             * the selection out from under the player. */
            else refreshStars();
            if (state.selectedAnime && state.episodes.length) renderEpisodeGrid();
        } catch (err) {
            console.warn('[sync] refresh after sync: ' + err.message);
        }
    };

    /* ── A SETTING ARRIVED FROM ANOTHER DEVICE ────────────────────────────────────────
     * ani-mate-sync-ui.js has written the key and ticked the box. The app itself reads
     * the three switches from `state`, which only this file can reach. Sync has called
     * this function since the day settings were added, and it was never defined: 18+
     * turned off on the desktop showed as off here and every search still asked for it,
     * until the app was restarted. */
    window.__animateApplySettings = function () {
        state.preferEnglish = localStorage.getItem('ani-mate-english-titles') !== 'false';
        state.autoPlay = localStorage.getItem('ani-mate-autoplay') === 'true';
        state.nsfw = localStorage.getItem('ani-mate-nsfw') === 'true';
        const set = (id, on) => { const el = $(id); if (el) el.checked = on; };
        set('english-title-toggle', state.preferEnglish);
        set('autoplay-toggle', state.autoPlay);
        set('nsfw-toggle', state.nsfw);
        applyTitleLanguage();
    };

    init();
})();
