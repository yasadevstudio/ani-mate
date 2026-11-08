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
     * the files a second way -- two writers to one file is how a store gets corrupted. */
    const SYNC = window.ANIMATE_SYNC.create({
        platform: 'android',
        log: (m) => console.log('[sync] ' + m),
        adapter: {
            loadFavorites: async () => (await window.Storage.loadFavorites()).map(shape.favToSync),
            loadWatch: async () => (await window.Storage.loadHistory()).map(shape.watchToSync),

            applyFavorites: async (rows) => {
                /* ⛔ RE-READ, MERGE, WRITE ONCE. Never hold a snapshot across an await
                 * and write it back: that is precisely the bug that lost real favorites
                 * on the desktop on 2026-11-07, and the phone's store is no safer. */
                const favs = await window.Storage.loadFavorites();
                for (const row of rows) {
                    const at = favs.findIndex((f) => String(f.id) === String(row.anime_id));
                    if (row.deleted) { if (at >= 0) favs.splice(at, 1); continue; }
                    const fav = shape.favFromSync(row, at >= 0 ? favs[at] : null);
                    if (at >= 0) favs[at] = fav; else favs.unshift(fav);
                }
                await window.Storage.saveFavorites(favs);
            },

            applyWatch: async (rows) => {
                const hist = await window.Storage.loadHistory();
                for (const row of rows) {
                    const at = hist.findIndex((h) => String(h.anime_id) === String(row.anime_id));
                    if (row.deleted) { if (at >= 0) hist.splice(at, 1); continue; }
                    const rec = shape.watchFromSync(row, at >= 0 ? hist[at] : null);
                    if (at >= 0) hist[at] = rec; else hist.unshift(rec);
                }
                hist.sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
                if (hist.length > 100) hist.length = 100;
                await window.Storage.saveHistory(hist);
            },

            loadSettings: async () => Object.entries(shape.SETTING_KEYS).map(([k, ls]) => ({
                key: k, value: localStorage.getItem(ls) === 'true' ? 'true' : 'false',
            })),
            applySettings: async (rows) => {
                for (const row of rows) {
                    const ls = shape.SETTING_KEYS[row.key];
                    if (!ls) continue;                  // an unknown key from a newer client
                    localStorage.setItem(ls, row.value === 'true' ? 'true' : 'false');
                }
                reflectSettings();
            },
        },
    });
    window.SYNC = SYNC;

    function reflectSettings() {
        const set = (id, key) => {
            const el = document.getElementById(id);
            if (el) el.checked = localStorage.getItem(key) === 'true';
        };
        set('english-title-toggle', 'ani-mate-english-titles');
        set('autoplay-toggle', 'ani-mate-autoplay');
        set('nsfw-toggle', 'ani-mate-nsfw');
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
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    #sync-open-btn.on{color:#00ff88}
    `;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    let sheet = null;
    let errText = '';

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
        const st = SYNC.state();
        const err = errText ? '<div class="sync-err">' + esc(errText) + '</div>' : '';
        let body = '';

        if (view === 'off') {
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
                <div class="sync-foot"><span></span>
                    <button class="sync-btn ghost" id="s-x">CLOSE</button></div>`;
        } else if (view === 'key') {
            body = `
                <h2>SYNC RECOVERY KEY</h2>
                <div class="sync-sub">WRITE THIS DOWN NOW</div>
                <div class="sync-secret">${esc(data.recovery_key)}</div>
                <div class="sync-warn">This is the only way back in if you lose your devices.
                    <strong>We cannot send it to you, because we do not know who you are.</strong>
                    You will not be shown it again.</div>
                <div class="sync-row">
                    <button class="sync-btn" id="s-copy">COPY</button>
                    <button class="sync-btn ghost" id="s-key-done">I SAVED IT</button>
                </div>`;
        } else if (view === 'pair') {
            body = `
                <h2>ADD THIS DEVICE</h2>
                <div class="sync-sub">EXPIRES IN <span id="s-ttl">${data.expires_in}</span>S</div>
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
                    <button class="sync-mini danger" data-revoke="${esc(d.id)}">${d.current ? 'SIGN OUT' : 'REMOVE'}</button>
                </div>`).join('');
            body = `
                <h2>SYNC</h2>
                <div class="sync-sub">ON &middot; LAST SYNCED ${esc(ago(st.lastSync).toUpperCase())}</div>
                ${err}
                <div class="sync-row" style="margin-bottom:14px">
                    <button class="sync-btn" id="s-now">&#8646; SYNC NOW</button>
                    <button class="sync-btn ghost" id="s-add">&#43; ADD A DEVICE</button>
                </div>
                <div class="sync-card-title" style="margin:14px 0 8px">YOUR DEVICES</div>
                ${rows || '<div class="sync-card-note">Loading&hellip;</div>'}
                <div class="sync-card-title" style="margin:20px 0 8px">RECOVERY</div>
                <div class="sync-card">
                    <div class="sync-card-note">A new key replaces the old one immediately and
                        your signed-in devices stay signed in.</div>
                    <div style="margin-top:12px"><button class="sync-btn ghost" id="s-newkey">NEW RECOVERY KEY</button></div>
                </div>
                <div class="sync-foot">
                    <button class="sync-btn danger" id="s-nuke">DELETE EVERYTHING</button>
                    <button class="sync-btn ghost" id="s-x">CLOSE</button>
                </div>`;
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

        sheet.innerHTML = body;
        errText = '';
        wire(view, data);
        if (view === 'on' && !(data && data.devices)) {
            try { render('on', await SYNC.devices()); }
            catch (e) { errText = e.message; render('on', { devices: [] }); }
        }
    }

    function wire(view, data) {
        const on = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        };
        const fail = (e, back) => { errText = (e && e.message) || String(e); render(back); };

        on('s-x', close);
        on('s-back', () => render(SYNC.state().signedIn ? 'on' : 'off'));
        on('s-create', async () => {
            try {
                const r = await SYNC.createAccount(deviceHint());
                await refreshViews();
                render('key', r);
            } catch (e) { fail(e, 'off'); }
        });
        on('s-pair', async () => {
            try {
                const r = await SYNC.startPairing(
                    async () => { await refreshViews(); render('on'); },
                    () => { errText = 'That code expired. Ask for a new one.'; render('off'); },
                    deviceHint());
                render('pair', r);
            } catch (e) { fail(e, 'off'); }
        });
        on('s-recover', () => render('recover'));
        on('s-key-done', () => render('on'));
        on('s-copy', async () => {
            try {
                await navigator.clipboard.writeText(data.recovery_key);
                const b = document.getElementById('s-copy');
                if (b) b.textContent = 'COPIED';
            } catch (e) { /* clipboard refused; the key is on screen to read */ }
        });
        on('s-key-go', async () => {
            const v = (document.getElementById('s-key-in') || {}).value || '';
            try { await SYNC.recover(v, deviceHint()); await refreshViews(); render('on'); }
            catch (e) { fail(e, 'recover'); }
        });
        on('s-now', async () => {
            const b = document.getElementById('s-now');
            if (b) { b.disabled = true; b.textContent = 'SYNCING...'; }
            try { await SYNC.sync(); await refreshViews(); render('on'); }
            catch (e) { fail(e, 'on'); }
        });
        on('s-add', () => render('approve'));
        on('s-code-go', async () => {
            const v = (document.getElementById('s-code-in') || {}).value || '';
            try { render('joined', await SYNC.approve(v)); }
            catch (e) { fail(e, 'approve'); }
        });
        on('s-devices', () => render('on'));
        on('s-newkey', async () => {
            try { render('key', await SYNC.newRecoveryKey()); }
            catch (e) { fail(e, 'on'); }
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
            try { await SYNC.deleteAccount(); close(); } catch (e) { fail(e, 'on'); }
        });

        for (const el of sheet.querySelectorAll('[data-rename]')) {
            el.addEventListener('click', async () => {
                const name = prompt('Name this device');
                if (!name) return;
                try { await SYNC.renameDevice(el.dataset.rename, name); render('on'); }
                catch (e) { fail(e, 'on'); }
            });
        }
        for (const el of sheet.querySelectorAll('[data-revoke]')) {
            el.addEventListener('click', async () => {
                try {
                    const r = await SYNC.revokeDevice(el.dataset.revoke);
                    if (r.was_current) { close(); return; }
                    render('on');
                } catch (e) { fail(e, 'on'); }
            });
        }

        if (view === 'pair') {
            let left = data.expires_in;
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
    if (SYNC.state().signedIn) {
        SYNC.sync().then(refreshViews).catch((e) => console.warn('[sync] ' + e.message));
        SYNC.startAuto(120000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !SYNC.state().signedIn) return;
            SYNC.sync().then(refreshViews).catch((e) => console.warn('[sync] ' + e.message));
        });
    }
    setInterval(paintButton, 30000);

    window.ANIMATE_SYNC_UI = { open, close };
})();
