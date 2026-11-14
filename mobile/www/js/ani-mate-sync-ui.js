// YASA PRESENTS
// ani-mate-sync-ui.js — the phone's half of sync: where its data lives, and the panel.
//
// The engine and the record translation are SHARED (ani-mate-sync.js, one copy, kept
// identical by `npm run sync:shared`). What is phone-specific is only two things:
//
//   1. the data is in the Capacitor filesystem behind window.Storage, not in a Node
//      process behind HTTP like it is on the desktop
//   2. the panel is a full-screen sheet, because this is a phone
//
// ⛔ DESKTOP AND MOBILE SHIP TOGETHER, ALWAYS. His rule, and it is structural here: one
//   v* tag builds the .exe, the .deb, the .AppImage and the .apk into one release, so a
//   sync protocol change that lands on one and not the other cannot be released at all
//   -- it can only be released BROKEN. If you touch anything in ani-mate-sync.js, run
//   `npm run sync:shared` and re-test both.

(function () {
    'use strict';

    if (!window.ANIMATE_SYNC) { console.warn('[sync] engine missing'); return; }
    const shape = window.ANIMATE_SYNC.shape;

    /* The phone's local store. window.Storage is already the only thing that touches
     * history.json and favorites.json, so sync goes through it too rather than opening
     * the files a second way: two writers to one file is how a store gets corrupted.
     *
     * ⚠ THE STRICT READERS AND WRITERS, ON PURPOSE. Storage's ordinary loaders answer an
     * empty list when a file fails to read, and an empty list used to be pushed to the
     * account as "the user deleted everything". The strict ones throw, the engine stops
     * the sync, and nothing is lost.
     *
     * The loop that applies pulled rows is shape.applyFavorites / shape.applyWatch, the
     * same one the desktop server runs. It used to be written out here a second time. */
    const Store = window.Storage;
    const settingsApplied = () => {
        reflectSettings();
        /* The checkbox is not the setting. ani-mate-ui.js keeps the three toggles in its
         * own state, and exports this so a synced value changes behavior, not just a tick. */
        if (typeof window.__animateApplySettings === 'function') window.__animateApplySettings();
    };
    const SYNC = window.ANIMATE_SYNC.create({
        platform: 'android',
        log: (m) => console.log('[sync] ' + m),
        adapter: Object.assign({
            loadFavorites: async () => shape.favoritesOut(await Store.loadFavoritesStrict()),
            loadWatch: async () => shape.watchOut(await Store.loadHistoryStrict()),
            loadDeleted: () => Store.loadDeleted(),
            applyFavorites: async (rows) => {
                await Store.saveFavoritesStrict(shape.applyFavorites(await Store.loadFavoritesStrict(), rows));
            },
            applyWatch: async (rows) => {
                await Store.saveHistoryStrict(shape.applyWatch(await Store.loadHistoryStrict(), rows));
            },
            saveIdentity: async (kind, updates) => {
                if (kind === 'favorites') {
                    await Store.saveFavoritesStrict(shape.setIdentity(kind, await Store.loadFavoritesStrict(), updates));
                } else {
                    await Store.saveHistoryStrict(shape.setIdentity(kind, await Store.loadHistoryStrict(), updates));
                }
            },
            clearDeleted: (kind, keys) => Store.clearDeleted(kind, keys),
        }, window.ANIMATE_SYNC.settingsAdapter(localStorage, settingsApplied)),
    });
    window.SYNC = SYNC;

    /* English titles are ON unless the key says 'false'; the other two are OFF unless it
     * says 'true'. This read `=== 'true'` for all three, so an unset English toggle was
     * drawn unticked while the app was still showing English titles. */
    function reflectSettings() {
        const set = (id, on) => {
            const el = document.getElementById(id);
            if (el) el.checked = on;
        };
        set('english-title-toggle', localStorage.getItem('ani-mate-english-titles') !== 'false');
        set('autoplay-toggle', localStorage.getItem('ani-mate-autoplay') === 'true');
        set('nsfw-toggle', localStorage.getItem('ani-mate-nsfw') === 'true');
    }

    /** Re-render what the sync brought in; a stale screen reads as a failed sync.
     *  ani-mate-ui.js is one big IIFE, so it exports exactly one hook for this. */
    async function refreshViews() {
        reflectSettings();
        try {
            if (typeof window.__animateRefreshAfterSync === 'function') {
                await window.__animateRefreshAfterSync();
            }
        } catch (e) { console.warn('[sync] view refresh: ' + e.message); }
    }

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    function ago(ms) {
        if (!ms) return 'never';
        const s = Math.round((Date.now() - ms) / 1000);
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.round(s / 60) + 'm ago';
        if (s < 86400) return Math.round(s / 3600) + 'h ago';
        return Math.round(s / 86400) + 'd ago';
    }

    /* ── STYLE ────────────────────────────────────────────────────────────────────
     * The same SENTINEL geometry as the desktop panel -- 12px radius, soft lift,
     * three text levels -- but a full-height sheet, because a centered modal on a
     * phone is a box with wasted margins around it. Injected rather than added to
     * the stylesheet so this feature is one file plus the engine. */
    const CSS = `
    .sync-sheet{position:fixed;inset:0;z-index:12000;background:rgba(0,8,14,.96);
        display:flex;flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch;
        padding:18px 16px calc(28px + env(safe-area-inset-bottom,0px));
        padding-top:calc(18px + env(safe-area-inset-top,0px))}
    .sync-sheet h2{font-family:'Audiowide',cursive;color:#00ffff;font-size:17px;
        letter-spacing:1px;margin:0 0 2px}
    .sync-sub{font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:2px;
        color:#4a5068;margin-bottom:14px}
    .sync-prose{font-size:13px;line-height:1.55;color:#8a93a8;margin:0 0 14px}
    .sync-card{background:rgba(0,255,255,.03);border:1px solid rgba(0,255,255,.15);
        border-radius:12px;padding:14px;margin-bottom:10px}
    .sync-card:active{background:rgba(0,255,255,.08)}
    .sync-card-title{font-family:'Orbitron',sans-serif;font-size:11px;letter-spacing:1.5px;
        color:#e0e0e0;margin-bottom:4px}
    .sync-card-note{font-size:12px;color:#4a5068;line-height:1.45}
    .sync-btn{font-family:'Orbitron',sans-serif;font-size:10px;letter-spacing:2px;
        padding:12px 18px;border-radius:10px;border:1px solid #00ffff;color:#00ffff;
        background:linear-gradient(135deg,rgba(0,255,255,.10),rgba(0,255,255,.02));
        min-height:44px}
    .sync-btn.ghost{border-color:rgba(0,255,255,.15);color:#8a93a8;background:none}
    .sync-btn.danger{border-color:#ff3333;color:#ff3333;background:none}
    .sync-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .sync-input{flex:1 1 150px;min-width:0;background:#141a26;
        border:1px solid rgba(0,255,255,.15);border-radius:10px;color:#e0e0e0;
        padding:12px;font-family:'Orbitron',sans-serif;font-size:13px;letter-spacing:1px}
    .sync-secret{font-family:'Orbitron',sans-serif;font-size:15px;letter-spacing:2px;
        color:#ffdd00;background:rgba(255,221,0,.06);border:1px dashed rgba(255,221,0,.35);
        border-radius:10px;padding:14px 10px;text-align:center;word-break:break-all;
        line-height:1.6;margin-bottom:10px}
    .sync-code{font-family:'Orbitron',sans-serif;font-size:38px;letter-spacing:9px;
        color:#ffdd00;text-align:center;padding:14px 0 8px;
        text-shadow:0 0 22px rgba(255,221,0,.35)}
    .sync-warn{font-size:12.5px;line-height:1.5;color:#ffdd00;
        background:rgba(255,221,0,.06);border-left:2px solid #ffdd00;padding:10px 12px;
        margin-bottom:14px}
    .sync-err{font-size:12.5px;color:#ff3333;background:rgba(255,51,51,.07);
        border-left:2px solid #ff3333;padding:9px 12px;margin-bottom:10px}
    .sync-dev{display:flex;align-items:center;gap:8px;padding:10px 12px;
        border:1px solid rgba(0,255,255,.15);border-radius:10px;margin-bottom:8px;
        background:rgba(0,255,255,.03)}
    .sync-dev-main{flex:1;min-width:0}
    .sync-dev-name{font-size:13px;color:#e0e0e0;overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap}
    .sync-dev-meta{font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:1px;
        color:#4a5068;margin-top:2px}
    .sync-dev-here{color:#00ff88}
    .sync-mini{font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:1px;
        padding:9px;border-radius:8px;background:none;border:1px solid rgba(0,255,255,.15);
        color:#8a93a8;min-height:36px}
    .sync-mini.danger{color:#ff3333;border-color:rgba(255,51,51,.3)}
    .sync-foot{display:flex;justify-content:space-between;gap:8px;margin-top:16px;
        padding-top:14px;border-top:1px solid rgba(0,255,255,.15);flex-wrap:wrap}
    .stat-row{display:flex;gap:8px;flex-wrap:wrap}
    .stat-big{flex:1 1 76px;background:rgba(0,255,255,.03);border:1px solid rgba(0,255,255,.15);
        border-radius:10px;padding:12px 8px;text-align:center}
    .stat-big b{display:block;font-family:'Orbitron',sans-serif;font-size:16px;color:#00ffff;
        letter-spacing:1px}
    .stat-big span{font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:2px;color:#4a5068}
    .stat-days{display:flex;align-items:flex-end;gap:3px;height:64px;padding:6px 8px;
        background:rgba(0,255,255,.03);border:1px solid rgba(0,255,255,.15);border-radius:10px}
    .stat-day{flex:1;height:100%;display:flex;align-items:flex-end}
    .stat-day i{display:block;width:100%;border-radius:2px 2px 0 0;
        background:linear-gradient(180deg,#00ffff,rgba(0,255,255,.25))}
    .stat-genre{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .stat-genre-name{flex:0 0 88px;font-size:12px;color:#e0e0e0;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap}
    .stat-genre-bar{flex:1;height:8px;background:#141a26;border-radius:4px;overflow:hidden}
    .stat-genre-bar i{display:block;height:100%;background:linear-gradient(90deg,#00ffff,#ffdd00)}
    .stat-genre-val{flex:0 0 50px;text-align:right;font-family:'Orbitron',sans-serif;
        font-size:9px;color:#8a93a8}
    #sync-open-btn.on{color:#00ff88}
    `;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    let sheet = null;
    let errText = '';
    /* One account action at a time, across re-draws of the panel. */
    let busy = false;
    /* Bumped by every render, so a late async result can tell whether it is still the
     * current view. See render(). */
    let renderGen = 0;

    function close() {
        SYNC.cancelPairing();
        if (sheet) { sheet.remove(); sheet = null; }
        errText = '';
        paintButton();
    }

    function open(view) {
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.className = 'sync-sheet';
            document.body.appendChild(sheet);
        }
        render(view || (SYNC.state().signedIn ? 'on' : 'off'));
    }

    async function render(view, data) {
        if (!sheet) return;
        renderGen++;
        const st = SYNC.state();
        const err = errText ? '<div class="sync-err">' + esc(errText) + '</div>' : '';
        let body = '';

        if (view === 'intro') {
            /* ⛔ A CHOICE, NOT A NOTICE. His call: a popup "you have to interact with
             * (opt-in or out) before it goes away". No close button, and close() is not
             * reachable from the backdrop on this view. Both answers are recorded, so it
             * is asked exactly once either way. */
            body = `
                <h2>SYNC YOUR STUFF?</h2>
                <div class="sync-sub">ONE CHOICE, ASKED ONCE</div>
                <p class="sync-prose">ANI-MATE can keep your favorites, your watch history
                   and your place in every episode the same on this phone and your
                   computer.</p>
                <p class="sync-prose">There is <strong>no email and no password</strong>.
                   You get a recovery key to write down, and that is the whole account.
                   Nothing stored about you has a name on it.</p>
                <div class="sync-row">
                    <button class="sync-btn" id="s-intro-yes">TURN SYNC ON</button>
                    <button class="sync-btn ghost" id="s-intro-no">NOT NOW</button>
                </div>
                <p class="sync-prose" style="margin-top:14px;color:#4a5068">
                   Say no and nothing changes &mdash; the app works exactly as it does now
                   and makes no account requests at all. You can turn it on later from the
                   <strong>&#8646;</strong> button any time.</p>`;
        } else if (view === 'off') {
            body = `
                <h2>SYNC</h2>
                <div class="sync-sub">FAVORITES &middot; HISTORY &middot; PROGRESS</div>
                ${err}
                <p class="sync-prose">Keep your list and your place in every show the same on
                   every device. There is no email and no password &mdash; nothing here knows
                   who you are, and that is on purpose.</p>
                <div class="sync-card" id="s-create">
                    <div class="sync-card-title">&#43; SYNC MY STUFF</div>
                    <div class="sync-card-note">Start fresh. Everything already on this phone
                        comes with you.</div>
                </div>
                <div class="sync-card" id="s-pair">
                    <div class="sync-card-title">&#8646; ADD THIS DEVICE</div>
                    <div class="sync-card-note">Already syncing on your computer? This phone
                        shows a code and you type it in there.</div>
                </div>
                <div class="sync-card" id="s-recover">
                    <div class="sync-card-title">&#8634; I HAVE A RECOVERY KEY</div>
                    <div class="sync-card-note">Lost every device you had? The key is the way
                        back.</div>
                </div>
                <div class="sync-foot">
                    <button class="sync-btn ghost" id="s-stats">&#9201; MY WATCHING</button>
                    <button class="sync-btn ghost" id="s-x">CLOSE</button></div>`;
        } else if (view === 'key') {
            /* `again` is the show-me-again path. The copy stops promising it will never
             * be shown again, because on this device that is no longer true. */
            const again = data && data.again;
            body = `
                <h2>SYNC RECOVERY KEY</h2>
                <div class="sync-sub">${again ? 'SAVED ON THIS PHONE' : 'WRITE THIS DOWN NOW'}</div>
                <div class="sync-secret">${esc(data.recovery_key)}</div>
                <div class="sync-warn">This is the only way back in if you lose your devices.
                    <strong>We cannot send it to you, because we do not know who you are.</strong>
                    ${again
                        ? 'This copy is kept on this phone so you can come back for it. Once you remove it, only a new key can replace it.'
                        : 'Write it down somewhere that is not this phone.'}</div>
                <div class="sync-row">
                    <button class="sync-btn" id="s-copy">COPY</button>
                    <button class="sync-btn ghost" id="s-key-done">${again ? 'DONE' : 'I SAVED IT'}</button>
                    ${again ? '<button class="sync-btn ghost" id="s-key-forget">REMOVE IT FROM THIS PHONE</button>' : ''}
                </div>`;
        } else if (view === 'signout') {
            /* ⛔ SIGNING OUT WITHOUT THE KEY IS PERMANENT LOCKOUT, and nothing tells the
             * user that unless it is said at the moment it matters. */
            const k = SYNC.recoveryKey();
            body = `
                <h2>SIGN OUT OF SYNC?</h2>
                <div class="sync-sub">THIS PHONE ONLY</div>
                ${k ? `<div class="sync-warn">You will need this key to sync this phone
                        again. There is no email to reset it with.</div>
                       <div class="sync-secret">${esc(k)}</div>`
                    : `<div class="sync-warn">This phone does not have a copy of your
                        recovery key &mdash; it joined by pairing. Make sure you have the
                        key from another device, or generate a new one, before signing
                        out.</div>`}
                <p class="sync-prose">Your favorites and history stay on this phone.
                   Signing out only stops them syncing.</p>
                <div class="sync-row">
                    ${k ? '<button class="sync-btn" id="s-copy">COPY KEY</button>' : ''}
                    <button class="sync-btn danger" id="s-out-go">SIGN OUT</button>
                    <button class="sync-btn ghost" id="s-back">CANCEL</button>
                </div>`;
        } else if (view === 'pair') {
            body = `
                <h2>ADD THIS DEVICE</h2>
                <div class="sync-sub">EXPIRES IN <span id="s-ttl">${Number(data.expires_in) || 0}</span>S</div>
                <div class="sync-code">${esc(data.code)}</div>
                <p class="sync-prose">On the device that is already syncing, open
                   <strong>SYNC</strong> and enter this code. Waiting&hellip;</p>
                <div class="sync-foot"><span></span>
                    <button class="sync-btn ghost" id="s-x">CANCEL</button></div>`;
        } else if (view === 'recover') {
            body = `
                <h2>RECOVERY KEY</h2>
                <div class="sync-sub">26 CHARACTERS, DASHES OPTIONAL</div>
                ${err}
                <div class="sync-row">
                    <input class="sync-input" id="s-key-in" placeholder="XXXX-XXXX-XXXX-..."
                           autocomplete="off" autocapitalize="characters" spellcheck="false">
                    <button class="sync-btn" id="s-key-go">RESTORE</button>
                </div>
                <p class="sync-prose">Case and dashes do not matter. This gives this phone a
                   new key of its own; your other devices keep theirs.</p>
                <div class="sync-foot"><span></span>
                    <button class="sync-btn ghost" id="s-back">BACK</button></div>`;
        } else if (view === 'on') {
            const devs = (data && data.devices) || [];
            const rows = devs.map((d) => `
                <div class="sync-dev">
                    <div class="sync-dev-main">
                        <div class="sync-dev-name">${esc(d.label || 'Device')}</div>
                        <div class="sync-dev-meta">${esc((d.platform || 'unknown').toUpperCase())}
                            &middot; ${d.current
                                ? '<span class="sync-dev-here">THIS DEVICE</span>'
                                : 'LAST SEEN ' + esc(ago(d.last_seen).toUpperCase())}</div>
                    </div>
                    <button class="sync-mini" data-rename="${esc(d.id)}">RENAME</button>
                    <button class="sync-mini danger" data-revoke="${esc(d.id)}" data-current="${d.current ? '1' : '0'}">${d.current ? 'SIGN OUT' : 'REMOVE'}</button>
                </div>`).join('');
            body = `
                <h2>SYNC</h2>
                <div class="sync-sub">ON &middot; LAST SYNCED ${esc(ago(st.lastSync).toUpperCase())}</div>
                ${err}
                <div class="sync-row" style="margin-bottom:14px">
                    <button class="sync-btn" id="s-now">&#8646; SYNC NOW</button>
                    <button class="sync-btn ghost" id="s-add">&#43; ADD A DEVICE</button>
                    <button class="sync-btn ghost" id="s-stats">&#9201; MY WATCHING</button>
                </div>
                <div class="sync-card-title" style="margin:14px 0 8px">YOUR DEVICES</div>
                ${rows || '<div class="sync-card-note">Loading&hellip;</div>'}
                <div class="sync-card-title" style="margin:20px 0 8px">RECOVERY KEY</div>
                <div class="sync-card">
                    <div class="sync-card-note">${st.hasKey
                        ? 'Your key is saved on this phone, so you can look at it again any time.'
                        : 'This phone joined by pairing, so it never saw a key and cannot show you one. A new key is the only option here &mdash; it replaces the old one immediately, and your signed-in devices stay signed in.'}</div>
                    <div class="sync-row" style="margin-top:12px">
                        ${st.hasKey ? '<button class="sync-btn" id="s-showkey">SHOW MY KEY</button>' : ''}
                        <button class="sync-btn ghost" id="s-newkey">NEW RECOVERY KEY</button>
                    </div>
                </div>
                <div class="sync-foot">
                    <button class="sync-btn danger" id="s-nuke">DELETE EVERYTHING</button>
                    <button class="sync-btn ghost" id="s-x">CLOSE</button>
                </div>`;
        } else if (view === 'stats') {
            const d = data || {};
            const hrs = (sec) => {
                const n = Math.max(0, Math.round(sec || 0));
                if (n < 60) return n + 's';
                if (n < 3600) return Math.floor(n / 60) + 'm';
                const h = Math.floor(n / 3600), m = Math.round((n % 3600) / 60);
                return h + 'h' + (m ? ' ' + m + 'm' : '');
            };
            const maxG = ((d.genres || [])[0] || {}).seconds || 1;
            const genreRows = (d.genres || []).slice(0, 10).map((g) => `
                <div class="stat-genre">
                    <div class="stat-genre-name">${esc(g.genre)}</div>
                    <div class="stat-genre-bar"><i style="width:${Math.max(2, Math.round(g.seconds / maxG * 100))}%"></i></div>
                    <div class="stat-genre-val">${hrs(g.seconds)}</div>
                </div>`).join('');
            const recent = (d.days || []).slice(0, 14).reverse();
            const maxD = Math.max(1, ...recent.map((x) => x.seconds));
            const dayBars = recent.map((x) => `
                <div class="stat-day" title="${esc(x.day)}">
                    <i style="height:${Math.max(2, Math.round(x.seconds / maxD * 100))}%"></i>
                </div>`).join('');
            const shows = (d.top_shows || []).slice(0, 5).map((sh) => `
                <div class="sync-dev">
                    <div class="sync-dev-main">
                        <div class="sync-dev-name">${esc(sh.title || sh.anime_id)}</div>
                        <div class="sync-dev-meta">${esc(sh.episodes_watched)} OF ${esc(sh.total_episodes || '?')} EPISODES</div>
                    </div>
                </div>`).join('');
            body = `
                <h2>YOUR WATCHING</h2>
                <div class="sync-sub">${d.local_only ? 'THIS PHONE ONLY &middot; TURN ON SYNC TO COMBINE THEM' : 'ACROSS ALL YOUR DEVICES'}</div>
                ${err}
                <div class="stat-row">
                    <div class="stat-big"><b>${hrs(d.total_seconds)}</b><span>TOTAL</span></div>
                    <div class="stat-big"><b>${hrs(d.today_seconds)}</b><span>TODAY</span></div>
                    <div class="stat-big"><b>${d.episodes_watched == null ? '&mdash;' : esc(d.episodes_watched)}</b><span>EPISODES</span></div>
                    <div class="stat-big"><b>${d.shows_started == null ? '&mdash;' : esc(d.shows_started)}</b><span>SHOWS</span></div>
                </div>
                ${recent.length ? `<div class="sync-card-title" style="margin:20px 0 8px">LAST 14 DAYS</div>
                    <div class="stat-days">${dayBars}</div>` : ''}
                ${genreRows ? `<div class="sync-card-title" style="margin:20px 0 8px">WHAT YOU ACTUALLY WATCH</div>
                    ${genreRows}
                    <div class="sync-card-note" style="margin-top:8px">A show counts in full
                        against every genre it carries, so these do not add up to your total
                        watch time &mdash; they rank what you reach for.</div>` : ''}
                ${shows ? `<div class="sync-card-title" style="margin:20px 0 8px">MOST EPISODES</div>${shows}` : ''}
                ${genreRows || recent.length ? '' : '<p class="sync-prose">Nothing counted yet. Watch something and come back.</p>'}
                <div class="sync-foot"><span></span>
                    <button class="sync-btn ghost" id="s-back">BACK</button></div>`;
        } else if (view === 'approve') {
            body = `
                <h2>ADD A DEVICE</h2>
                <div class="sync-sub">ENTER THE CODE IT IS SHOWING</div>
                ${err}
                <div class="sync-row">
                    <input class="sync-input" id="s-code-in" placeholder="000000"
                           inputmode="numeric" maxlength="7" autocomplete="off">
                    <button class="sync-btn" id="s-code-go">APPROVE</button>
                </div>
                <p class="sync-prose">Open SYNC on the other device and it will show you six
                   digits. Only type in a code you asked for yourself.</p>
                <div class="sync-foot"><span></span>
                    <button class="sync-btn ghost" id="s-back">BACK</button></div>`;
        } else if (view === 'joined') {
            body = `
                <h2>DEVICE ADDED</h2>
                <div class="sync-sub">${esc((data.platform || 'device').toUpperCase())}</div>
                <p class="sync-prose"><strong>${esc(data.label)}</strong> is now syncing with
                   this account. If that is not something you just did, remove it from your
                   device list.</p>
                <div class="sync-row">
                    <button class="sync-btn" id="s-devices">DEVICE LIST</button>
                    <button class="sync-btn ghost" id="s-x">DONE</button>
                </div>`;
        }

        sheet.dataset.modal = view;
        sheet.innerHTML = body;
        errText = '';
        wire(view, data);
        if (view === 'on' && !(data && data.devices)) {
            /* ⛔ THE DEVICE LIST ARRIVES LATE AND MUST NOT CLOBBER WHERE THE USER WENT.
             * Tapping SHOW MY KEY while this fetch was in flight used to have the result
             * painted straight over the top of it, so the tap just vanished. */
            const mine = renderGen;
            let devices = null;
            try { devices = await SYNC.devices(); }
            catch (e) { errText = e.message; devices = { devices: [] }; }
            if (mine !== renderGen) return;          // the user moved on; leave them there
            render('on', devices);
        }
    }

    function wire(view, data) {
        const on = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        };
        const fail = (e, back) => { errText = (e && e.message) || String(e); render(back); };
        /* ⚠ ONE ACCOUNT ACTION AT A TIME. The choices on the first screen are cards, not
         * buttons, so they could not be disabled, and a second tap on SYNC MY STUFF
         * made a second account and showed that one's key. */
        const once = (fn) => async () => {
            if (busy) return;
            busy = true;
            try { await fn(); } finally { busy = false; }
        };

        on('s-x', close);
        on('s-intro-yes', once(async () => {
            SYNC.setChoice('on');
            const b = document.getElementById('s-intro-yes');
            if (b) { b.disabled = true; b.textContent = 'SETTING UP...'; }
            try {
                const r = await SYNC.createAccount(deviceHint());
                await refreshViews();
                render('key', r);
            } catch (e) { fail(e, 'off'); }
        }));
        on('s-intro-no', () => {
            /* Recorded so he is never asked twice. The button stays in the tab bar, which
             * is the whole of "a way for people that initially opted out to opt back in". */
            SYNC.setChoice('later');
            close();
        });
        on('s-stats', async () => {
            /* Signed in, ask the account. Signed out, show what this phone alone has
             * counted -- useful either way, and the honest advertisement for sync. */
            if (!SYNC.state().signedIn) { render('stats', SYNC.localStats()); return; }
            try { render('stats', await SYNC.stats()); }
            catch (e) { errText = e.message; render('stats', SYNC.localStats()); }
        });
        on('s-showkey', () => {
            const k = SYNC.recoveryKey();
            if (k) render('key', { recovery_key: k, again: true });
        });
        on('s-key-forget', () => { SYNC.forgetRecoveryKey(); render('on'); });
        on('s-out-go', () => { SYNC.signOut(); close(); });
        on('s-back', () => render(SYNC.state().signedIn ? 'on' : 'off'));
        on('s-create', once(async () => {
            const card = document.getElementById('s-create');
            if (card) {
                card.style.opacity = '.5';
                const note = card.querySelector('.sync-card-note');
                if (note) note.textContent = 'Setting up...';
            }
            try {
                const r = await SYNC.createAccount(deviceHint());
                await refreshViews();
                render('key', r);
            } catch (e) { fail(e, 'off'); }
        }));
        on('s-pair', once(async () => {
            try {
                const r = await SYNC.startPairing(
                    async () => { await refreshViews(); render('on'); },
                    () => { errText = 'That code expired. Ask for a new one.'; render('off'); },
                    deviceHint());
                render('pair', r);
            } catch (e) { fail(e, 'off'); }
        }));
        on('s-recover', () => render('recover'));
        on('s-key-done', () => render('on'));
        on('s-copy', async () => {
            /* ⛔ THE KEY COMES FROM THE VIEW'S DATA ON THE REVEAL SCREENS AND FROM THE
             * ENGINE ON THE SIGN-OUT SCREEN, which is given no data. Reading only `data`
             * made COPY KEY throw inside this try and do nothing, on the one screen
             * where losing the key is permanent. */
            const key = (data && data.recovery_key) || SYNC.recoveryKey() || '';
            const b = document.getElementById('s-copy');
            try {
                if (!key) throw new Error('no key');
                await navigator.clipboard.writeText(key);
                if (b) b.textContent = 'COPIED';
            } catch (e) {
                /* The clipboard refused. Select the key so a long press offers Copy,
                 * and say so instead of leaving a button that appears to have worked. */
                const box = sheet && sheet.querySelector('.sync-secret');
                if (box) {
                    const range = document.createRange();
                    range.selectNodeContents(box);
                    const picked = window.getSelection();
                    picked.removeAllRanges();
                    picked.addRange(range);
                }
                if (b) b.textContent = 'SELECTED: COPY IT FROM THE SCREEN';
            }
        });
        on('s-key-go', once(async () => {
            const v = (document.getElementById('s-key-in') || {}).value || '';
            const b = document.getElementById('s-key-go');
            if (b) { b.disabled = true; b.textContent = 'RESTORING...'; }
            try { await SYNC.recover(v, deviceHint()); await refreshViews(); render('on'); }
            catch (e) { fail(e, 'recover'); }
        }));
        on('s-now', once(async () => {
            const b = document.getElementById('s-now');
            if (b) { b.disabled = true; b.textContent = 'SYNCING...'; }
            try { await SYNC.sync(); await refreshViews(); render('on'); }
            catch (e) { fail(e, 'on'); }
        }));
        on('s-add', () => render('approve'));
        on('s-code-go', once(async () => {
            const v = (document.getElementById('s-code-in') || {}).value || '';
            try { render('joined', await SYNC.approve(v)); }
            catch (e) { fail(e, 'approve'); }
        }));
        on('s-devices', () => render('on'));
        on('s-newkey', async () => {
            /* Two taps. A new key replaces the old one the moment it is made, and a key
             * that someone wrote on paper stops working without their knowing. */
            const b = document.getElementById('s-newkey');
            if (!b) return;
            if (b.dataset.armed !== '1') {
                b.dataset.armed = '1';
                b.textContent = 'THE OLD KEY STOPS WORKING. TAP AGAIN';
                return;
            }
            if (busy) return;
            busy = true;
            b.disabled = true;
            try { render('key', await SYNC.newRecoveryKey()); }
            catch (e) { fail(e, 'on'); }
            finally { busy = false; }
        });
        on('s-nuke', async () => {
            const b = document.getElementById('s-nuke');
            if (!b) return;
            /* Two taps. This one is not undoable and there is no support address to
             * write to afterwards. */
            if (b.dataset.armed !== '1') {
                b.dataset.armed = '1';
                b.textContent = 'TAP AGAIN TO DELETE FOREVER';
                return;
            }
            if (busy) return;
            busy = true;
            b.disabled = true;
            try { await SYNC.deleteAccount(); close(); } catch (e) { fail(e, 'on'); }
            finally { busy = false; }
        });

        /* RENAME is a box in the row, the same on both platforms. The desktop cannot use
         * prompt() at all (Electron does not implement it), and one panel that behaves
         * two ways is two things to keep working. The first tap turns the name into a
         * box and the button into SAVE; the keyboard's Enter saves too. */
        for (const el of sheet.querySelectorAll('[data-rename]')) {
            el.addEventListener('click', () => {
                const row = el.closest('.sync-dev');
                const nameEl = row && row.querySelector('.sync-dev-name');
                if (!nameEl) return;
                const input = document.createElement('input');
                input.className = 'sync-input';
                input.style.cssText = 'flex:none;width:100%;padding:6px 8px;font-size:13px';
                input.maxLength = 40;                 // the server keeps 40 characters
                input.value = nameEl.textContent;
                input.autocomplete = 'off';
                input.spellcheck = false;
                input.enterKeyHint = 'done';
                nameEl.replaceWith(input);
                el.textContent = 'SAVE';
                input.focus();
                input.select();
                let saving = false;
                const save = async () => {
                    if (saving) return;
                    const name = input.value.trim();
                    if (!name) { render('on'); return; }
                    saving = true;
                    try { await SYNC.renameDevice(el.dataset.rename, name); render('on'); }
                    catch (e) { fail(e, 'on'); }
                };
                input.addEventListener('keydown', (ev) => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') save();
                    if (ev.key === 'Escape') render('on');
                });
                el.addEventListener('click', save);
            }, { once: true });
        }
        for (const el of sheet.querySelectorAll('[data-revoke]')) {
            el.addEventListener('click', async () => {
                /* Revoking THIS device is a sign-out, and a sign-out without the recovery
                 * key cannot be undone. Route it through the warning. */
                if (el.dataset.current === '1') { render('signout'); return; }
                try {
                    const r = await SYNC.revokeDevice(el.dataset.revoke);
                    if (r.was_current) { close(); return; }
                    render('on');
                } catch (e) { fail(e, 'on'); }
            });
        }

        if (view === 'pair') {
            let left = Number(data.expires_in) || 0;
            const tick = setInterval(() => {
                const el = document.getElementById('s-ttl');
                if (!el) { clearInterval(tick); return; }
                el.textContent = Math.max(0, --left);
                if (left <= 0) clearInterval(tick);
            }, 1000);
        }
    }

    /* The phone names itself after its model where the WebView will say, so the device
     * list reads "Pixel 9" rather than a third anonymous "Phone". Capacitor exposes the
     * real model; the UA string is the fallback and is often useless, in which case the
     * server's own default ("Phone") is better than a guess. */
    function deviceHint() {
        try {
            const d = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Device;
            if (d && window.__animateDeviceModel) return window.__animateDeviceModel;
        } catch (e) { /* not available */ }
        const m = /;\s*([^;)]+)\s+Build\//.exec(navigator.userAgent || '');
        return m ? m[1].trim() : undefined;
    }
    (async () => {
        try {
            const D = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Device;
            if (D && D.getInfo) {
                const info = await D.getInfo();
                if (info && info.model) window.__animateDeviceModel = info.model;
            }
        } catch (e) { /* the UA fallback covers it */ }
    })();

    function paintButton() {
        const b = document.getElementById('sync-open-btn');
        if (!b) return;
        const st = SYNC.state();
        b.classList.toggle('on', st.signedIn);
    }

    function mount() {
        /* Into the tab bar's row as an icon, because the phone has no settings screen to
         * put it in and the play bar is already four controls wide at 360px. */
        const nav = document.getElementById('tab-bar');
        if (!nav || document.getElementById('sync-open-btn')) return;
        const b = document.createElement('button');
        b.id = 'sync-open-btn';
        b.className = 'tab-btn';
        b.innerHTML = '&#8646;';
        b.title = 'Sync';
        b.style.flex = '0 0 auto';
        b.style.padding = '0 12px';
        b.addEventListener('click', (e) => { e.stopPropagation(); open(); });
        nav.appendChild(b);
        paintButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }

    /* Sync on launch, when the app comes back to the foreground, and every two minutes
     * while it is open -- but ONLY when signed in. An install that has never touched
     * sync must make no network calls for it at all, which is what "optional" means.
     *
     * The resume hook matters more here than on the desktop: a phone spends most of its
     * life suspended, so an interval alone would mean the first thing a user sees after
     * unlocking is yesterday's list. */
    /* ⚠ THE TIMER AND THE RESUME HOOK ARE BOTH UNCONDITIONAL. They used to sit inside
     * the signed-in branch, so a user who turned sync on during a session got neither
     * until the app was killed and relaunched. Both guard on the credential themselves,
     * so a phone that never signs in still makes NO account requests. */
    if (SYNC.state().signedIn) {
        SYNC.sync().then(refreshViews).catch((e) => console.warn('[sync] ' + e.message));
    }
    /* The timer is handed the refresh, so rows pulled in the background reach the screen. */
    SYNC.startAuto(120000, refreshViews);
    /* Asked once, AFTER the changelog has had its turn. ⚠ IT KEEPS CHECKING rather than
     * checking once: a single timeout that bailed because the changelog was still up
     * would mean a fresh install -- the exact case this exists for -- never sees it. */
    if (SYNC.needsIntro()) {
        let waited = 0;
        const introWait = setInterval(() => {
            waited += 800;
            if (!SYNC.needsIntro() || waited > 120000) { clearInterval(introWait); return; }
            if (document.querySelector('.changelog-overlay, .update-dialog') || sheet) return;
            if (!document.getElementById('sync-open-btn')) return;      // UI not mounted yet
            clearInterval(introWait);
            open('intro');
        }, 800);
    }
    document.addEventListener('visibilitychange', () => {
        /* Going to the background: write the watch clock down now. A phone can kill the
         * app at any moment after this, and the last stretch would be gone. */
        if (document.visibilityState !== 'visible') { SYNC.flush(); return; }
        if (!SYNC.state().signedIn) return;
        SYNC.sync().then((s) => {
            if (s && (s.pulled.watch || s.pulled.favorites || s.pulled.settings)) return refreshViews();
        }).catch((e) => console.warn('[sync] ' + e.message));
    });
    window.addEventListener('pagehide', () => SYNC.flush());
    setInterval(paintButton, 30000);

    window.ANIMATE_SYNC_UI = { open, close };
})();
