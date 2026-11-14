/**
 * accounts.js — passwordless sync for ANI-MATE.
 *
 * The design and the reasoning live in ../ACCOUNTS-DESIGN.md. The short version:
 *
 *   No password, no username, no email. High-entropy secrets instead — a device token,
 *   a recovery key, and a short-lived pairing claim — all stored as a single SHA-256.
 *
 * ⛔ WHY NOT PASSWORDS, MEASURED ON THE EDGE 2026-11-07:
 *   Cloudflare caps PBKDF2 at 100,000 iterations (310k and 600k both throw
 *   NotSupportedError) and ships no native Argon2. OWASP's floor for PBKDF2-SHA256 is
 *   600,000. Iteration count exists ONLY to slow guessing of low-entropy secrets, i.e.
 *   things a human chose. Nothing here is chosen by a human, so a single SHA-256 is
 *   correct and the platform's limit stops mattering instead of being worked around.
 *
 * ⛔ AND NOTHING STORED HERE IS A PERSON. No email column, no username column, no IP,
 *   no user agent. ANI-MATE streams from pirate sources; a row that reads `7f3a…` and
 *   nothing else is the point, not an oversight. Do not add "just an email for recovery".
 */

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford: no I L O U
const RECOVERY_CHARS = 26;          // 26 x 5 bits = 130 bits
const PAIR_TTL_MS = 5 * 60 * 1000;
const TOMBSTONE_MS = 180 * 24 * 60 * 60 * 1000;   // his number, 2026-11-07

const now = () => Date.now();
const enc = new TextEncoder();

function randomId(bytes = 16) {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url. This is what a device carries forever. */
function newToken() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The recovery key the user writes down. Crockford base32 so it cannot be
 * mis-transcribed, grouped in fours so it can be read aloud.
 *
 * ⚠ REJECTION SAMPLING, not modulo. `byte % 32` over 0-255 is uniform only because 256
 * divides evenly by 32 — true here, but the moment someone changes the alphabet length
 * it silently biases the key and nobody notices. Draw and discard instead.
 */
function newRecoveryKey() {
    const out = [];
    const buf = new Uint8Array(64);
    const limit = 256 - (256 % RECOVERY_ALPHABET.length);
    while (out.length < RECOVERY_CHARS) {
        crypto.getRandomValues(buf);
        for (const byte of buf) {
            if (out.length >= RECOVERY_CHARS) break;
            if (byte >= limit) continue;                 // discard the biased tail
            out.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
        }
    }
    return out.join('').replace(/(.{4})(?=.)/g, '$1-');
}

/** Typing it back in should not care about case, spaces, or the dashes we added. */
function normalizeRecoveryKey(s) {
    return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
        // Crockford's own aliases, so a hand-copied O or I still works
        .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}

function newPairCode() {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return String(b[0] % 1000000).padStart(6, '0');
}

async function sha256(s) {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * A real calendar day, YYYY-MM-DD, or null.
 *
 * ⚠ THE SHAPE IS NOT THE VALIDATION. `/^\d{4}-\d{2}-\d{2}$/` happily accepts
 * "2026-13-99", which was stored and then sat at the top of the stats screen forever
 * (caught by the test, 2026-11-08). Date alone is not enough either: it parses
 * "2026-02-30" and silently rolls it to March 2nd. The round-trip catches both --
 * if formatting it back does not give the same string, it was never that day.
 */
function validDay(v) {
    const str = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    const d = new Date(str + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10) === str ? str : null;
}

/* ── LIMITS ────────────────────────────────────────────────────────────────────────
 * ⛔ AN ACCOUNT COSTS NOTHING TO CREATE, SO EVERYTHING AN ACCOUNT CAN STORE HAS A CEILING.
 * Without these, one script could fill the database and sync would fail for everyone.
 * The numbers are far above real use: history is capped at 100 rows by both apps and a
 * large favorites list is a few hundred. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ROWS_PER_PUSH = 1000;          // per kind, per request
const MAX_ROWS_PER_ACCOUNT = 5000;       // per kind
const MAX_DEVICES = 25;
const MAX_GENRES_PER_DEVICE = 200;
const MAX_DAYS_PER_PUSH = 800;
const SETTING_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const LAST_SEEN_EVERY_MS = 10 * 60 * 1000;

/* Every value a client sends is forced into the type and size its column expects. An
 * object or an array never reaches bind() (it used to throw and fail the whole push), and
 * a string cannot be longer than anything a real title or cover address is. */
const text = (v, max) => (v === null || v === undefined || typeof v === 'object')
    ? null : (String(v).slice(0, max) || null);
const whole = (v, min, max) => {
    if (v !== null && typeof v === 'object') return null;      // [12] must not read as 12
    const n = typeof v === 'number' ? v : (/^-?\d+(\.\d+)?$/.test(String(v || '')) ? Number(v) : NaN);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : null;
};
const real = (v, min, max) => {
    const n = (v !== null && typeof v === 'object') ? NaN : Number(v);
    return (v === null || v === undefined || v === '' || !Number.isFinite(n))
        ? null : Math.min(max, Math.max(min, n));
};
const webAddress = (v) => {
    const s = text(v, 600);
    return s && /^https?:\/\//i.test(s) ? s : null;
};
/* The watched list crosses as a JSON string. Parse it and write it back out, so what is
 * stored is always an array of short strings and never whatever happened to be sent. */
function episodeList(v) {
    let a = v;
    if (typeof v === 'string') { try { a = JSON.parse(v); } catch (e) { a = []; } }
    if (!Array.isArray(a)) a = [];
    const out = [];
    for (const x of a) {
        if (x === null || x === undefined || typeof x === 'object') continue;
        const e = String(x).slice(0, 12);
        if (e) out.push(e);
        if (out.length >= 5000) break;
    }
    return JSON.stringify(out);
}
const CLEAN = {
    watch: {
        title: (v) => text(v, 300),
        title_english: (v) => text(v, 300),
        episode: (v) => text(v, 20),
        position: (v) => real(v, 0, 1e6) || 0,
        duration: (v) => real(v, 0, 1e6),
        mode: (v) => (v === 'dub' ? 'dub' : (v === 'sub' ? 'sub' : null)),
        episodes_watched: (v) => episodeList(v),
        total_episodes: (v) => { const n = whole(v, 1, 100000); return n && n > 0 ? n : null; },
    },
    favorites: {
        title: (v) => text(v, 300),
        title_english: (v) => text(v, 300),
        episodes: (v) => whole(v, 0, 100000) || 0,
        franchise_id: (v) => text(v, 200),
        cover: (v) => webAddress(v),
        added_at: (v) => whole(v, 0, 9e15),
    },
};
const cleanId = (v) => {
    if (v === null || v === undefined || typeof v === 'object') return null;
    const s = String(v);
    return s.length >= 1 && s.length <= 200 ? s : null;
};
const cleanPlatform = (v) => {
    const s = String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    return s || null;
};

function bearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') || '').trim());
    return m ? m[1] : null;
}

/**
 * Constant-time compare, for the one place a secret is compared in application code:
 * the recovery key, where the candidate arrives in the body.
 *
 * ⚠ IT IS NOT WHAT PROTECTS THE TOKEN LOOKUPS, and calling it on a value we just queried
 * BY would be theater — comparing a row against the thing that selected it is always
 * equal. Those lookups are `WHERE token_hash = ?` on an index, which SQLite makes no
 * constant-time promise about. That is fine: an index-timing oracle leaks about a stored
 * SHA-256, and SHA-256 is preimage resistant, so it does not yield the token.
 */
function sameHash(a, b) {
    const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
    if (x.length !== y.length) return false;
    return crypto.subtle.timingSafeEqual(x, y);
}

/* ── device naming ─────────────────────────────────────────────────────────────────
 * The device names itself so the list is readable before anyone opens a setting, and
 * stays editable because only the owner knows which Pixel is which. */
async function autoLabel(db, accountId, platform, hint) {
    const base = hint && String(hint).trim()
        ? String(hint).trim().slice(0, 40)
        : (platform === 'android' ? 'Phone' : 'Desktop');
    const { results } = await db.prepare(
        'SELECT label FROM devices WHERE account_id = ?').bind(accountId).all();
    const taken = new Set((results || []).map((r) => r.label));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
    return `${base} (${randomId(2)})`;
}

/** Bearer token -> the account it belongs to, or null. Also stamps last_seen. */
export async function authenticate(db, req) {
    const token = bearer(req);
    if (!token) return null;
    const row = await db.prepare(
        'SELECT id, account_id FROM devices WHERE token_hash = ?')
        .bind(await sha256(token)).first();
    if (!row) return null;
    /* A device syncs twice every two minutes. Stamping last_seen on each of those was a
     * database write per request for a field shown to the minute at best. */
    const t = now();
    await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ? ' +
                     'AND (last_seen IS NULL OR last_seen < ?)')
        .bind(t, row.id, t - LAST_SEEN_EVERY_MS).run();
    return { accountId: row.account_id, deviceId: row.id };
}

/**
 * Create the device row.
 *
 * `tokenHash` is supplied only by the pairing flow, where the NEW DEVICE generated the
 * token itself and the server only ever sees its hash — so there is nothing to hand back
 * and nothing stored in the clear. Every other caller lets the server mint one, and gets
 * it in the response exactly once.
 */
async function issueDevice(db, accountId, platform, hint, tokenHash = null) {
    const token = tokenHash ? null : newToken();
    const id = randomId(8);
    platform = cleanPlatform(platform);
    const have = await db.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ?')
        .bind(accountId).first();
    if (have && Number(have.n) >= MAX_DEVICES) {
        const e = new Error('too many devices on this account'); e.tooMany = true; throw e;
    }
    const label = await autoLabel(db, accountId, platform, hint);
    await db.prepare(
        'INSERT INTO devices (id, account_id, token_hash, label, platform, created_at, last_seen) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, accountId, tokenHash || await sha256(token), label,
              platform || null, now(), now()).run();
    return token ? { device_id: id, device_token: token, label } : { device_id: id, label };
}

/* ── the tables that sync, and the columns each one carries ───────────────────────
 * Declared once so push, pull and the tombstone sweep cannot disagree about shape. */
const SYNCED = {
    watch: {
        key: 'anime_id',
        cols: ['title', 'title_english', 'episode', 'position', 'duration', 'mode',
               'episodes_watched', 'total_episodes'],
    },
    favorites: {
        key: 'anime_id',
        cols: ['title', 'title_english', 'episodes', 'franchise_id', 'cover', 'added_at'],
    },
};

/* ⛔ THE OLDEST SYNC ENGINE THIS SERVER LETS IN.
 * Every engine since the rewrite of 2026-11-12 sends `v=<its protocol>` in the address of
 * every request (SYNC_PROTOCOL in server/ani-mate-sync.js). The first engine sends
 * nothing. It used these same routes with these same bodies, so until this check the
 * server could not tell it from the current one, and it was not safe to let in:
 * measured 2026-11-13, it made an account, synced, and after one failed read of its own
 * favorites removed all three favorites from another device on the account.
 * It still exists: in any window of the app left open since before the rewrite, and on
 * `main` at d6a96e8. The answer is 426 with a sentence its own panel shows as it is. */
const MIN_CLIENT = 2;

export async function handleAccounts(req, env, p, q) {
    const db = env.DB;
    if (!db) return json({ error: 'sync is not configured on this deployment' }, 503);
    let spoken = 0;
    try { spoken = Number(new URL(req.url).searchParams.get('v')) || 0; } catch (e) { spoken = 0; }
    if (spoken < MIN_CLIENT) {
        return json({ error: 'This copy of ANI-MATE is too old to sync. Close it, update or reopen ANI-MATE, and turn sync on again.',
                      upgrade: true, needs: MIN_CLIENT }, 426);
    }
    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH') {
        /* Read as text so the size is known before anything is parsed. */
        const raw = await req.text().catch(() => '');
        if (raw.length > MAX_BODY_BYTES) return json({ error: 'request too large' }, 413);
        try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
        /* JSON `null`, a number or an array is valid JSON and is not a request. */
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }

    // ── create ────────────────────────────────────────────────────────────────────
    if (p === '/api/account' && req.method === 'POST') {
        const accountId = randomId(16);
        const recovery = newRecoveryKey();
        await db.prepare(
            'INSERT INTO accounts (id, recovery_key_hash, created_at) VALUES (?, ?, ?)')
            .bind(accountId, await sha256(normalizeRecoveryKey(recovery)), now()).run();
        const dev = await issueDevice(db, accountId, body.platform, body.label);
        /* The recovery key is returned EXACTLY ONCE, here. It is never stored in the
         * clear and there is no endpoint that can show it again, because there is no
         * email to send it to and no identity to prove. */
        return json({ account_id: accountId, recovery_key: recovery, ...dev }, 201);
    }

    /* ── PAIRING ──────────────────────────────────────────────────────────────────
     * ⛔ THE DIRECTION OF THIS FLOW IS THE SECURITY PROPERTY. The device that wants IN
     * shows the code; a device that is ALREADY SIGNED IN types it. So the privileged
     * call is the one carrying a real token, and a stranger guessing six digits at
     * /api/device/approve would attach someone else's new phone to THEIR OWN account,
     * gaining nothing of yours.
     *
     * ⛔ IT USED TO RUN THE OTHER WAY AND THE GUARD DID NOT WORK. The design named
     * "3 failed attempts and the code is dead, tracked on the code row itself".
     * Measured 2026-11-08: 50,000 wrong guesses found 0 rows, so 0 attempts were ever
     * recorded — a wrong code matches NO ROW, and there is nothing to increment. What
     * remained was a 20-bit secret (10^6) behind a 300s TTL, i.e. 3,333 req/s to sweep
     * the space, guarded only by an IP bucket that Cloudflare counts PER COLO and an
     * attacker can spread across addresses. Reversing the flow deletes the question
     * instead of sizing a limiter against a weak secret.
     * A RISK YOU HAVE NAMED IS NOT A RISK YOU HAVE HANDLED.
     *
     * What is left is social engineering — talking someone into approving a code that is
     * not theirs — which no pairing scheme avoids. So approve hands back the platform
     * and label of whatever just joined, and the UI has to show it. */

    // the new device asks to be let in, carrying a token IT generated
    if (p === '/api/device/claim' && req.method === 'POST') {
        const token = bearer(req);
        if (!token) return json({ error: 'generate a device token and send it as Bearer' }, 400);
        const tokenHash = await sha256(token);
        /* Already a real device? Then this is not a claim, and saying so plainly beats
         * minting a second identity for the same token. */
        const already = await db.prepare('SELECT id FROM devices WHERE token_hash = ?')
            .bind(tokenHash).first();
        if (already) return json({ error: 'this device is already paired' }, 409);

        await db.prepare('DELETE FROM pairing_claims WHERE token_hash = ? OR expires_at < ?')
            .bind(tokenHash, now()).run();

        /* Six digits across a handful of live claims collides essentially never, but
         * "essentially never" is not a reason to let an INSERT throw in a user's face. */
        let code = null;
        for (let i = 0; i < 8 && !code; i++) {
            const c = newPairCode();
            const taken = await db.prepare('SELECT 1 FROM pairing_claims WHERE code_hash = ?')
                .bind(await sha256(c)).first();
            if (!taken) code = c;
        }
        if (!code) return json({ error: 'could not allocate a code, try again' }, 503);

        await db.prepare(
            'INSERT INTO pairing_claims (code_hash, token_hash, platform, label_hint, ' +
            'created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(await sha256(code), tokenHash, cleanPlatform(body.platform),
                  text(body.label, 40),
                  now(), now() + PAIR_TTL_MS).run();
        return json({ code, expires_in: PAIR_TTL_MS / 1000 }, 201);
    }

    // ...and polls with that same token until someone approves it
    if (p === '/api/device/claim' && req.method === 'GET') {
        const auth = await authenticate(db, req);
        if (auth) {
            const d = await db.prepare('SELECT label FROM devices WHERE id = ?')
                .bind(auth.deviceId).first();
            return json({ status: 'approved', account_id: auth.accountId,
                          device_id: auth.deviceId, label: d && d.label });
        }
        const token = bearer(req);
        if (!token) return json({ error: 'unauthorized' }, 401);
        const row = await db.prepare('SELECT expires_at FROM pairing_claims WHERE token_hash = ?')
            .bind(await sha256(token)).first();
        /* 404, not 401, so the client can tell "keep waiting" apart from "that code died,
         * show a fresh one" without parsing prose. */
        if (!row || row.expires_at < now()) return json({ status: 'expired' }, 404);
        return json({ status: 'pending', expires_at: row.expires_at }, 202);
    }

    // a device that is already signed in lets it in
    if (p === '/api/device/approve' && req.method === 'POST') {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        const code = String(body.code || '').replace(/\D/g, '');
        if (code.length !== 6) return json({ error: 'bad code' }, 400);
        const hash = await sha256(code);

        /* ⛔ CONSUME THE CLAIM BEFORE MINTING ANYTHING. THE DELETE IS THE LOCK.
         *
         * This used to read SELECT -> issueDevice -> DELETE across three un-transacted
         * round trips. Two approvals of one code that interleave BOTH pass the SELECT,
         * and both then call issueDevice with the same token_hash; devices.token_hash is
         * UNIQUE, so the loser got a raw D1 constraint error as a bodyless 500. There was
         * no try/catch either, so the failure was unreadable to the client.
         *
         * The existing test "the same code cannot be approved twice" ran the two calls
         * SEQUENTIALLY. It passed, and said nothing at all about concurrency — a check
         * that runs, passes, and does not test the thing it is believed to establish.
         * tests/approve-race.test.js now fires them with Promise.all.
         *
         * `RETURNING` makes the delete atomic and hands back the row in one statement, so
         * exactly one caller can be holding it. No row returned means someone else got
         * there first, or the code never existed — the client cannot tell those apart and
         * must not be able to. */
        let row = null;
        try {
            const del = await db.prepare(
                'DELETE FROM pairing_claims WHERE code_hash = ? RETURNING *')
                .bind(hash).first();
            row = del || null;
        } catch (e) {
            /* RETURNING needs SQLite 3.35+. D1 is well past it, but a thrown DELETE here
             * must not read as "bad code" — that would tell a user their code expired
             * when the database hiccuped. */
            return json({ error: 'could not approve, try again' }, 503);
        }
        if (!row || row.expires_at < now()) {
            return json({ error: 'invalid or expired code' }, 404);
        }

        let dev;
        try {
            dev = await issueDevice(db, auth.accountId, row.platform, row.label_hint,
                                    row.token_hash);
        } catch (e) {
            /* The claim is already gone and cannot be put back safely, so say so plainly
             * rather than 500ing. The new device's poll will report expired and it will
             * show a fresh code — recoverable, and honest about what happened. */
            return json({ error: e && e.tooMany
                ? 'this account already has the most devices it can hold; remove one first'
                : 'the code was consumed but the device could not be added, ask for a new code' },
                409);
        }
        /* Echo what joined. The one attack this flow cannot structurally prevent is being
         * talked into approving a stranger's device, and the only defense against that is
         * the user seeing WHAT they just let in. */
        return json({ status: 'approved', device_id: dev.device_id, label: dev.label,
                      platform: row.platform || null });
    }

    // ── recover ───────────────────────────────────────────────────────────────────
    if (p === '/api/account/recover' && req.method === 'POST') {
        const key = normalizeRecoveryKey(body.recovery_key);
        if (key.length !== RECOVERY_CHARS) return json({ error: 'bad recovery key' }, 400);
        const candidate = await sha256(key);
        const row = await db.prepare(
            'SELECT id, recovery_key_hash FROM accounts WHERE recovery_key_hash = ? ' +
            'AND deleted_at IS NULL').bind(candidate).first();
        if (!row || !sameHash(row.recovery_key_hash, candidate)) {
            return json({ error: 'no account for that key' }, 404);
        }
        /* A NEW device token, never the existing ones. Holding the recovery key proves
         * you can get in; it does not entitle you to what the other devices carry. */
        let dev;
        try { dev = await issueDevice(db, row.id, body.platform, body.label); }
        catch (e) {
            if (e && e.tooMany) {
                return json({ error: 'this account already has the most devices it can hold' }, 409);
            }
            throw e;
        }
        return json({ account_id: row.id, ...dev });
    }

    // ── devices ───────────────────────────────────────────────────────────────────
    if (p === '/api/devices' && req.method === 'GET') {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        const { results } = await db.prepare(
            'SELECT id, label, platform, created_at, last_seen FROM devices ' +
            'WHERE account_id = ? ORDER BY created_at').bind(auth.accountId).all();
        return json({
            devices: (results || []).map((d) => ({ ...d, current: d.id === auth.deviceId })),
        });
    }
    if (p.startsWith('/api/devices/') && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        const id = p.slice('/api/devices/'.length);
        if (req.method === 'PATCH') {
            const label = String(body.label || '').trim().slice(0, 40);
            if (!label) return json({ error: 'label required' }, 400);
            const r = await db.prepare(
                'UPDATE devices SET label = ? WHERE id = ? AND account_id = ?')
                .bind(label, id, auth.accountId).run();
            if (!r.meta.changes) return json({ error: 'no such device' }, 404);
            return json({ status: 'renamed', id, label });
        }
        /* Revoking the device you are holding is sign-out, and it is allowed on purpose:
         * the alternative is a user who cannot leave from the only device they have. */
        const r = await db.prepare('DELETE FROM devices WHERE id = ? AND account_id = ?')
            .bind(id, auth.accountId).run();
        if (!r.meta.changes) return json({ error: 'no such device' }, 404);
        return json({ status: 'revoked', id, was_current: id === auth.deviceId });
    }

    // ── regenerate the recovery key ───────────────────────────────────────────────
    if (p === '/api/account/recovery-key' && req.method === 'POST') {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        const recovery = newRecoveryKey();
        await db.prepare('UPDATE accounts SET recovery_key_hash = ? WHERE id = ?')
            .bind(await sha256(normalizeRecoveryKey(recovery)), auth.accountId).run();
        return json({ recovery_key: recovery });
    }

    // ── delete everything ─────────────────────────────────────────────────────────
    if (p === '/api/account' && req.method === 'DELETE') {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        /* Real deletion, immediately. For an app like this that is a feature, not a
         * checkbox. The children go explicitly because D1 does not enforce
         * ON DELETE CASCADE unless foreign keys are enabled on the connection. */
        await db.batch([
            db.prepare('DELETE FROM watch WHERE account_id = ?').bind(auth.accountId),
            db.prepare('DELETE FROM favorites WHERE account_id = ?').bind(auth.accountId),
            db.prepare('DELETE FROM settings WHERE account_id = ?').bind(auth.accountId),
            /* ⚠ ADDED WITH THE STATS TABLES. "Deletion is real" is a claim this file
             * makes out loud, and a new table missing from this list makes it false
             * without anything failing. Add a table, add it here. */
            db.prepare('DELETE FROM watch_time WHERE account_id = ?').bind(auth.accountId),
            db.prepare('DELETE FROM genre_time WHERE account_id = ?').bind(auth.accountId),
            db.prepare('DELETE FROM devices WHERE account_id = ?').bind(auth.accountId),
            db.prepare('DELETE FROM accounts WHERE id = ?').bind(auth.accountId),
        ]);
        return json({ status: 'deleted' });
    }

    // ── sync: pull ────────────────────────────────────────────────────────────────
    if (p === '/api/sync' && req.method === 'GET') {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        const since = Number(q.get('since') || 0) || 0;
        const out = { now: now(), since };
        for (const [table, spec] of Object.entries(SYNCED)) {
            const { results } = await db.prepare(
                `SELECT * FROM ${table} WHERE account_id = ? AND updated_at > ? ` +
                'ORDER BY updated_at').bind(auth.accountId, since).all();
            out[table] = (results || []).map((r) => {
                const o = { [spec.key]: r[spec.key], updated_at: r.updated_at,
                            deleted: !!r.deleted };
                /* A tombstone carries NO payload. Shipping the old title and cover
                 * alongside deleted:true only invites a client to render it. */
                if (!r.deleted) for (const c of spec.cols) o[c] = r[c];
                return o;
            });
        }
        const { results: st } = await db.prepare(
            'SELECT key, value, updated_at FROM settings WHERE account_id = ? AND updated_at > ?')
            .bind(auth.accountId, since).all();
        out.settings = st || [];
        return json(out);
    }

    // ── sync: push ────────────────────────────────────────────────────────────────
    if (p === '/api/sync' && req.method === 'POST') {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        /* ⚠ THE SERVER STAMPS THE TIME, NEVER THE CLIENT. Phone clocks lie, and one
         * device with a fast clock would otherwise win every conflict forever.
         *
         * ⛔ AND A PUSH OF UNCHANGED CONTENT MUST NOT MOVE updated_at. Every upsert below
         * carries `WHERE <row> IS NOT excluded.<row>`, so re-sending a row the server
         * already has is a no-op rather than a new version.
         *
         * THE CLIENTS DEPEND ON THIS. Neither app tracks which rows it changed -- there
         * is no dirty flag on a favorite in either store -- so the engine pushes a full
         * snapshot and lets the server decide what actually differs. Without the WHERE,
         * one device syncing would re-stamp every row it owns, and the OTHER device would
         * then re-download the whole account on its next pull, forever. `IS NOT` and not
         * `!=` because `NULL != NULL` is NULL, which is falsy, which would make every
         * row with an empty column look changed every time. */
        const stamp = now();
        const stmts = [];
        let count = 0;

        /* ⛔ COUNT BEFORE WRITING. One request cannot carry more than MAX_ROWS_PER_PUSH
         * rows of a kind, and an account cannot hold more than MAX_ROWS_PER_ACCOUNT. The
         * second check is one query for the whole push, not one per row. It counts every
         * pushed row as if it were new, which only matters to an account within one push
         * of the ceiling, and no real library is. */
        for (const table of Object.keys(SYNCED)) {
            if (Array.isArray(body[table]) && body[table].length > MAX_ROWS_PER_PUSH) {
                return json({ error: 'too many rows in one request', kind: table,
                              limit: MAX_ROWS_PER_PUSH }, 413);
            }
        }
        if ((Array.isArray(body.watch) && body.watch.length)
            || (Array.isArray(body.favorites) && body.favorites.length)) {
            const have = await db.prepare(
                'SELECT (SELECT COUNT(*) FROM watch WHERE account_id = ?1) AS watch, ' +
                '(SELECT COUNT(*) FROM favorites WHERE account_id = ?1) AS favorites')
                .bind(auth.accountId).first();
            for (const table of Object.keys(SYNCED)) {
                const incoming = Array.isArray(body[table]) ? body[table].length : 0;
                if (incoming && Number((have && have[table]) || 0) + incoming > MAX_ROWS_PER_ACCOUNT) {
                    return json({ error: 'this account is full', kind: table,
                                  limit: MAX_ROWS_PER_ACCOUNT }, 413);
                }
            }
        }

        for (const [table, spec] of Object.entries(SYNCED)) {
            const rows = Array.isArray(body[table]) ? body[table] : [];
            for (const row of rows) {
                const id = row && typeof row === 'object' ? cleanId(row[spec.key]) : null;
                if (!id) continue;
                count++;
                if (row.deleted) {
                    /* ⛔ A DELETE IS A TOMBSTONE, NEVER A DELETE. Remove the row and the
                     * other device never hears about it, pushes the item straight back,
                     * and the app reads as having ignored you. Payload columns are
                     * nulled so the tombstone carries nothing. */
                    stmts.push(db.prepare(
                        `INSERT INTO ${table} (account_id, ${spec.key}, updated_at, deleted) ` +
                        'VALUES (?, ?, ?, 1) ' +
                        `ON CONFLICT(account_id, ${spec.key}) DO UPDATE SET ` +
                        'updated_at = excluded.updated_at, deleted = 1, ' +
                        spec.cols.map((c) => `${c} = NULL`).join(', ') +
                        ` WHERE ${table}.deleted = 0`)
                        .bind(auth.accountId, String(id), stamp));
                } else {
                    const cols = spec.cols;
                    stmts.push(db.prepare(
                        `INSERT INTO ${table} (account_id, ${spec.key}, ${cols.join(', ')}, ` +
                        'updated_at, deleted) ' +
                        `VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, 0) ` +
                        `ON CONFLICT(account_id, ${spec.key}) DO UPDATE SET ` +
                        cols.map((c) => `${c} = excluded.${c}`).join(', ') +
                        ', updated_at = excluded.updated_at, deleted = 0' +
                        ` WHERE ${table}.deleted = 1 OR ` +
                        cols.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(' OR '))
                        .bind(auth.accountId, String(id),
                              ...cols.map((c) => CLEAN[table][c](row[c])), stamp));
                }
            }
        }
        for (const s of (Array.isArray(body.settings) ? body.settings : []).slice(0, 40)) {
            if (!s || typeof s !== 'object' || !SETTING_KEY.test(String(s.key || ''))) continue;
            count++;
            stmts.push(db.prepare(
                'INSERT INTO settings (account_id, key, value, updated_at) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value, ' +
                'updated_at = excluded.updated_at WHERE settings.value IS NOT excluded.value')
                .bind(auth.accountId, String(s.key),
                      text(s.value, 100), stamp));
        }

        /* ── THE COUNTERS ─────────────────────────────────────────────────────────
         * ⛔ MAX, NOT ASSIGNMENT, AND KEYED BY DEVICE. Two reasons, both load-bearing:
         *
         *   the device is in the key   because last-write-wins on a running total
         *                              DELETES TIME -- the phone has 400s for today, the
         *                              desktop has 900s, the later push wins and the 400
         *                              is gone. Per-device rows SUMmed at read is a
         *                              G-Counter and needs no coordination.
         *   MAX rather than assignment because a device whose localStorage is cleared
         *                              restarts its own counter at zero, and assignment
         *                              would let that erase what it had already
         *                              contributed. A counter only ever goes up.
         *
         * updated_at moves only when the value actually rises -- the same no-churn rule
         * as every other upsert in this file. */
        for (const row of (Array.isArray(body.watch_time) ? body.watch_time : []).slice(-MAX_DAYS_PER_PUSH)) {
            const day = row && typeof row === 'object' && validDay(row.day);
            if (!day) continue;
            const secs = whole(row.seconds, 0, 86400) || 0;
            if (!secs) continue;
            count++;
            stmts.push(db.prepare(
                'INSERT INTO watch_time (account_id, device_id, day, seconds, updated_at) ' +
                'VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT(account_id, device_id, day) DO UPDATE SET ' +
                'seconds = MAX(watch_time.seconds, excluded.seconds), ' +
                'updated_at = excluded.updated_at ' +
                'WHERE excluded.seconds > watch_time.seconds')
                .bind(auth.accountId, auth.deviceId, day, secs, stamp));
        }
        for (const row of (Array.isArray(body.genre_time) ? body.genre_time : []).slice(0, MAX_GENRES_PER_DEVICE)) {
            const genre = row && typeof row === 'object' ? text(row.genre, 40) : null;
            if (!genre) continue;
            const secs = whole(row.seconds, 0, 4e9) || 0;
            if (!secs) continue;
            count++;
            stmts.push(db.prepare(
                'INSERT INTO genre_time (account_id, device_id, genre, seconds, updated_at) ' +
                'VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT(account_id, device_id, genre) DO UPDATE SET ' +
                'seconds = MAX(genre_time.seconds, excluded.seconds), ' +
                'updated_at = excluded.updated_at ' +
                'WHERE excluded.seconds > genre_time.seconds')
                .bind(auth.accountId, auth.deviceId, genre, secs, stamp));
        }

        /* Sweep expired tombstones here rather than on a cron: this is the only moment we
         * know an account is active, and it costs one statement. 180 days is his number,
         * and the asymmetry is the whole point — a tombstone kept too LONG costs a row,
         * one expired too EARLY resurrects a delete on a device that was offline. */
        for (const table of Object.keys(SYNCED)) {
            stmts.push(db.prepare(
                `DELETE FROM ${table} WHERE account_id = ? AND deleted = 1 AND updated_at < ?`)
                .bind(auth.accountId, stamp - TOMBSTONE_MS));
        }

        if (stmts.length) await db.batch(stmts);
        return json({ status: 'ok', applied: count, now: stamp });
    }

    // ── stats: watch time and genre analysis ──────────────────────────────────────
    if (p === '/api/stats' && req.method === 'GET') {
        const auth = await authenticate(db, req);
        if (!auth) return json({ error: 'unauthorized' }, 401);

        /* SUMmed across devices, which is the entire point of the per-device rows.
         * Capped at 365 days so the response cannot grow without bound. */
        const { results: days } = await db.prepare(
            'SELECT day, SUM(seconds) AS seconds FROM watch_time WHERE account_id = ? ' +
            'GROUP BY day ORDER BY day DESC LIMIT 365').bind(auth.accountId).all();
        const { results: genres } = await db.prepare(
            'SELECT genre, SUM(seconds) AS seconds FROM genre_time WHERE account_id = ? ' +
            'GROUP BY genre ORDER BY seconds DESC LIMIT 40').bind(auth.accountId).all();
        const { results: shows } = await db.prepare(
            'SELECT anime_id, title, title_english, episodes_watched, total_episodes ' +
            'FROM watch WHERE account_id = ? AND deleted = 0').bind(auth.accountId).all();

        /* Episode counts are DERIVED here rather than stored. What is stored is the LIST
         * of episodes watched; a stored count beside it would be a second source of truth
         * that can disagree with the first. */
        let episodes = 0;
        const ranked = [];
        for (const r of (shows || [])) {
            let n = 0;
            try {
                const a = JSON.parse(r.episodes_watched || '[]');
                if (Array.isArray(a)) n = a.length;
            } catch (e) { /* a malformed list counts as none */ }
            episodes += n;
            ranked.push({ anime_id: r.anime_id, title: r.title_english || r.title,
                          episodes_watched: n, total_episodes: r.total_episodes });
        }
        ranked.sort((a, b) => b.episodes_watched - a.episodes_watched);

        const dayRows = (days || []).map((d) => ({ day: d.day, seconds: d.seconds || 0 }));
        const total = dayRows.reduce((n, d) => n + d.seconds, 0);
        /* "Today" is the DEVICE's today, passed in, not the Worker's. The day boundary
         * belongs to the person watching: a 1am session filed by a UTC edge lands on the
         * wrong day and the stats screen looks wrong to the only person who can check. */
        const today = String(q.get('today') || '');
        const todayRow = dayRows.find((d) => d.day === today);

        return json({
            total_seconds: total,
            today_seconds: todayRow ? todayRow.seconds : 0,
            days: dayRows,
            genres: (genres || []).map((g) => ({ genre: g.genre, seconds: g.seconds || 0 })),
            episodes_watched: episodes,
            shows_started: ranked.length,
            top_shows: ranked.slice(0, 10),
        });
    }

    return null;    // not an accounts route; the caller keeps looking
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type, authorization',
            'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'cache-control': 'no-store',
        },
    });
}
