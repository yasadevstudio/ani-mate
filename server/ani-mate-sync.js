// YASA PRESENTS
// ani-mate-sync.js — the sync engine. ONE copy, both clients.
//
// ⛔ THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR SYNC AND IT RUNS IN BOTH APPS.
//   Desktop loads it from the local server at /ani-mate-sync.js (it ships inside
//   server/**/* already). Mobile needs a real file in the APK, so `npm run sync:shared`
//   copies it to mobile/www/js/ and into the android assets. If you edit it, run that.
//
//   The reason for one copy is not tidiness. mobile/www/js/ani-mate-api.js is a ~4,800
//   line re-implementation of the desktop provider logic, and the two drifted for months:
//   the dub-server subtitle fix, the hianime episode fallback, the bigger covers and the
//   uncensored switch all landed on desktop and none of them reached the phone. Sync is
//   the feature where drift means DATA LOSS, not a missing poster.
//
// ⛔ WHAT THIS FILE DOES NOT DO: it does not know what a favorite is, where it is stored,
//   or how either app renders. It takes an ADAPTER (see configure) and talks to the edge.
//   Keep platform detail out of here; that is what let it be one file at all.
//
// THE PROTOCOL, and why it is shaped this way:
//
//   pull(since) -> apply remotely-changed rows locally -> re-read local -> diff against
//   what we last saw -> push the differences -> remember the server's clock
//
//   ⚠ PULL BEFORE PUSH, ALWAYS, AND NEVER PUSH IF THE PULL FAILED. The push is a full
//   snapshot of local state, so pushing a stale snapshot RESURRECTS whatever another
//   device just deleted. That is the single most common bug in hand-written sync, and
//   this app has already been bitten by its local-only cousin: /favorites/refresh loaded
//   a snapshot, did slow lookups, then wrote the stale array back and lost real
//   favorites. Order is not a style choice here.
//
//   ⚠ NEITHER APP TRACKS WHICH ROWS IT CHANGED. There is no dirty flag on a favorite in
//   the desktop JSON file or in the Capacitor one, and adding one would mean hooking
//   every mutation in two codebases. So the engine keeps its OWN record of what it last
//   saw (`seen`, a map of id -> content hash) and diffs against that. A row that is in
//   `seen` but gone from the local store is a local delete and becomes a tombstone; a row
//   whose hash moved is an edit. The server ignores a push of unchanged content, so being
//   generous about what we push costs a request, never a spurious version.

(function (root) {
    'use strict';

    const DEFAULT_EDGE = 'https://ani-mate.yasadevstudio.workers.dev';
    const POLL_MS = 2500;
    const KINDS = ['watch', 'favorites'];

    /* localStorage can throw outright (private windows, embedded webviews with site data
     * blocked), and a sync feature that takes the whole app down when it cannot remember
     * a token is worse than one that is merely signed out. */
    function memoryStore() {
        const m = new Map();
        return {
            get: (k) => (m.has(k) ? m.get(k) : null),
            set: (k, v) => m.set(k, v),
            remove: (k) => m.delete(k),
        };
    }
    function localStore() {
        try {
            const probe = '__animate_sync_probe__';
            root.localStorage.setItem(probe, '1');
            root.localStorage.removeItem(probe);
            return {
                get: (k) => root.localStorage.getItem(k),
                set: (k, v) => root.localStorage.setItem(k, v),
                remove: (k) => root.localStorage.removeItem(k),
            };
        } catch (e) {
            return memoryStore();
        }
    }

    /** Stable hash of a row: sorted keys, so key order cannot fake a change. */
    function hashRow(row) {
        const keys = Object.keys(row).filter((k) => k !== 'updated_at' && k !== 'deleted').sort();
        let s = '';
        for (const k of keys) {
            const v = row[k];
            s += k + '' + (v === null || v === undefined ? '' : String(v)) + '';
        }
        /* FNV-1a. Not a security hash and does not need to be -- a collision here means
         * one edit does not sync until the next change touches the row. */
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
        }
        return h.toString(36);
    }

    function create(options) {
        const opt = options || {};
        const endpoint = (opt.endpoint || DEFAULT_EDGE).replace(/\/+$/, '');
        const platform = opt.platform || 'electron';
        const adapter = opt.adapter;
        const store = opt.store || localStore();
        const log = opt.log || function () {};
        if (!adapter) throw new Error('ani-mate-sync needs an adapter');

        const K = {
            token: 'animate.sync.token',
            account: 'animate.sync.account',
            device: 'animate.sync.device',
            label: 'animate.sync.label',
            since: 'animate.sync.since',
            seen: 'animate.sync.seen',
            at: 'animate.sync.at',
        };

        let claimTimer = null;
        let autoTimer = null;
        let inFlight = null;

        const getToken = () => store.get(K.token);
        const readSeen = () => {
            try { return JSON.parse(store.get(K.seen) || '{}') || {}; } catch (e) { return {}; }
        };

        function forgetLocal() {
            for (const k of Object.values(K)) store.remove(k);
        }

        async function api(method, path, body, token) {
            const headers = { 'content-type': 'application/json' };
            const t = token === undefined ? getToken() : token;
            if (t) headers.authorization = 'Bearer ' + t;
            const res = await fetch(endpoint + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            let json = null;
            try { json = await res.json(); } catch (e) { /* 204s and error pages */ }
            if (!res.ok) {
                const err = new Error((json && json.error) || ('HTTP ' + res.status));
                err.status = res.status;
                err.detail = json && json.detail;
                err.body = json;
                /* A 401 means this device was revoked from another device. That is a
                 * legitimate instruction, not an error to retry: drop the credential so
                 * the UI stops pretending to be signed in. */
                if (res.status === 401 && t && t === getToken()) {
                    log('this device was revoked elsewhere; signing out locally');
                    forgetLocal();
                }
                throw err;
            }
            return json || {};
        }

        /* A device token generated HERE, not handed to us. The server only ever learns
         * its SHA-256, so a dump of the database cannot sign in as this device. */
        function mintToken() {
            const b = new Uint8Array(32);
            (root.crypto || root.msCrypto).getRandomValues(b);
            let s = '';
            for (const x of b) s += String.fromCharCode(x);
            return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }

        const self = {
            endpoint,

            state() {
                return {
                    signedIn: !!getToken(),
                    accountId: store.get(K.account),
                    deviceId: store.get(K.device),
                    label: store.get(K.label),
                    lastSync: Number(store.get(K.at) || 0) || 0,
                    pairing: !!claimTimer,
                };
            },

            /* ── START HERE: a brand new account, no form, no email ─────────────────
             * Returns the recovery key, which is the ONLY time it is ever available.
             * The caller MUST show it before doing anything else. */
            async createAccount(labelHint) {
                const r = await api('POST', '/api/account',
                                    { platform, label: labelHint }, null);
                store.set(K.token, r.device_token);
                store.set(K.account, r.account_id);
                store.set(K.device, r.device_id);
                store.set(K.label, r.label);
                store.remove(K.since);
                store.remove(K.seen);
                /* First sync pushes everything this device already has, so the stuff the
                 * user has been collecting locally does not look like it vanished. */
                await self.sync();
                return { recovery_key: r.recovery_key, label: r.label };
            },

            /* ── ADD THIS DEVICE TO AN EXISTING ACCOUNT ─────────────────────────────
             * This device shows a code; the user types it into a device that is already
             * signed in. See ACCOUNTS-DESIGN.md for why it runs in this direction and not
             * the obvious one. onPaired fires once approval lands. */
            async startPairing(onPaired, onExpired, labelHint) {
                self.cancelPairing();
                const token = mintToken();
                const r = await api('POST', '/api/device/claim',
                                    { platform, label: labelHint }, token);
                claimTimer = setInterval(async () => {
                    let res;
                    try {
                        res = await api('GET', '/api/device/claim', undefined, token);
                    } catch (e) {
                        if (e.status === 404) {
                            self.cancelPairing();
                            if (onExpired) onExpired();
                        }
                        return;                 // a blip on the network is not an expiry
                    }
                    if (res.status !== 'approved') return;
                    self.cancelPairing();
                    store.set(K.token, token);
                    store.set(K.account, res.account_id);
                    store.set(K.device, res.device_id);
                    store.set(K.label, res.label);
                    /* ⚠ A JOINING DEVICE PULLS FROM ZERO AND MUST NOT PUSH ITS OWN STATE
                     * FIRST. Its local list is whatever it collected before pairing, and
                     * pushing that as a snapshot would resurrect everything the account
                     * had ever deleted. Clearing `seen` makes the first pass pull-only
                     * for anything the account already knows about. */
                    store.remove(K.since);
                    store.remove(K.seen);
                    try { await self.sync(); } catch (e) { log('first sync failed: ' + e.message); }
                    if (onPaired) onPaired(res);
                }, POLL_MS);
                return { code: r.code, expires_in: r.expires_in };
            },

            cancelPairing() {
                if (claimTimer) { clearInterval(claimTimer); claimTimer = null; }
            },

            /** On the device that is already signed in: let the other one in. */
            approve(code) {
                return api('POST', '/api/device/approve', { code: String(code) });
            },

            /* ── LOST EVERY DEVICE ──────────────────────────────────────────────────
             * The recovery key is the whole account. There is no email to fall back on,
             * which is the deliberate trade for storing nothing about anyone. */
            async recover(recoveryKey, labelHint) {
                const r = await api('POST', '/api/account/recover',
                                    { recovery_key: recoveryKey, platform, label: labelHint },
                                    null);
                store.set(K.token, r.device_token);
                store.set(K.account, r.account_id);
                store.set(K.device, r.device_id);
                store.set(K.label, r.label);
                store.remove(K.since);
                store.remove(K.seen);       // pull-only first pass, same reason as pairing
                await self.sync();
                return r;
            },

            devices() { return api('GET', '/api/devices'); },
            renameDevice(id, label) { return api('PATCH', '/api/devices/' + id, { label }); },

            async revokeDevice(id) {
                const r = await api('DELETE', '/api/devices/' + id);
                if (r.was_current) forgetLocal();        // we just signed ourselves out
                return r;
            },

            newRecoveryKey() { return api('POST', '/api/account/recovery-key'); },

            async deleteAccount() {
                const r = await api('DELETE', '/api/account');
                forgetLocal();
                return r;
            },

            /** Local only: forget the credential, keep the data, leave the account alone. */
            signOut() {
                self.cancelPairing();
                self.stopAuto();
                forgetLocal();
            },

            /* ── THE SYNC ITSELF ────────────────────────────────────────────────────── */
            sync() {
                /* One at a time. Two overlapping runs would each diff against the same
                 * `seen` and push the same rows twice, and the second would compute its
                 * diff against a local store the first was still writing. */
                if (inFlight) return inFlight;
                inFlight = runSync().finally(() => { inFlight = null; });
                return inFlight;
            },

            startAuto(ms) {
                self.stopAuto();
                const every = Math.max(30000, ms || 120000);
                autoTimer = setInterval(() => {
                    if (getToken()) self.sync().catch((e) => log('auto sync: ' + e.message));
                }, every);
            },
            stopAuto() {
                if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
            },
        };

        async function runSync() {
            if (!getToken()) throw new Error('not signed in');
            const since = Number(store.get(K.since) || 0) || 0;

            // ── 1. PULL ───────────────────────────────────────────────────────────────
            const remote = await api('GET', '/api/sync?since=' + since);

            // ── 2. APPLY what changed remotely ───────────────────────────────────────
            const applied = { watch: 0, favorites: 0, settings: 0 };
            for (const kind of KINDS) {
                const rows = remote[kind] || [];
                if (!rows.length) continue;
                await adapter['apply' + cap(kind)](rows);
                applied[kind] = rows.length;
            }
            if ((remote.settings || []).length && adapter.applySettings) {
                await adapter.applySettings(remote.settings);
                applied.settings = remote.settings.length;
            }

            // ── 3. DIFF local against what we last saw ───────────────────────────────
            const seen = readSeen();
            const nextSeen = {};
            const payload = {};
            let pushCount = 0;

            for (const kind of KINDS) {
                const rows = (await adapter['load' + cap(kind)]()) || [];
                const was = seen[kind] || {};
                const now = {};
                const out = [];
                for (const row of rows) {
                    const id = row && (row.anime_id !== undefined ? String(row.anime_id) : null);
                    if (!id) continue;
                    const h = hashRow(row);
                    now[id] = h;
                    if (was[id] !== h) { out.push(row); pushCount++; }
                }
                /* Anything we used to have and no longer do was deleted HERE. This is the
                 * only way a local delete reaches the server, because nothing in either
                 * app records one. */
                for (const id of Object.keys(was)) {
                    if (now[id] === undefined) { out.push({ anime_id: id, deleted: true }); pushCount++; }
                }
                nextSeen[kind] = now;
                if (out.length) payload[kind] = out;
            }

            if (adapter.loadSettings) {
                const rows = (await adapter.loadSettings()) || [];
                const was = seen.settings || {};
                const now = {};
                const out = [];
                for (const s of rows) {
                    if (!s || !s.key) continue;
                    const h = hashRow(s);
                    now[s.key] = h;
                    if (was[s.key] !== h) { out.push(s); pushCount++; }
                }
                nextSeen.settings = now;
                if (out.length) payload.settings = out;
            }

            // ── 4. PUSH ──────────────────────────────────────────────────────────────
            if (pushCount) await api('POST', '/api/sync', payload);

            /* ⚠ THE CURSOR IS THE PULL'S CLOCK, NOT THE PUSH'S. Another device can land a
             * write between our pull and our push; advancing to the push's time would
             * step straight over it and that row would never arrive here.
             *
             * The cost, measured: the NEXT sync re-receives the rows this one pushed,
             * exactly once. Applying them is a no-op (same values) and they cannot cause
             * a push back, because the hash in `seen` already matches. The sync after
             * that is silent. Paying one redundant row to never lose a concurrent write
             * is the right side of that trade. */
            store.set(K.since, String(remote.now));
            store.set(K.seen, JSON.stringify(nextSeen));
            store.set(K.at, String(Date.now()));

            const summary = { pulled: applied, pushed: pushCount, at: Date.now() };
            log('sync: pulled ' + (applied.watch + applied.favorites + applied.settings) +
                ', pushed ' + pushCount);
            return summary;
        }

        function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

        return self;
    }

    root.ANIMATE_SYNC = { create, DEFAULT_EDGE };

    /* The desktop loads this over HTTP into a browser page; the Worker and any Node-side
     * test load it as a module. Export both ways so neither has to care. */
    if (typeof module !== 'undefined' && module.exports) module.exports = { create, DEFAULT_EDGE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
