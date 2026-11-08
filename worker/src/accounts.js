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
    await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now(), row.id).run();
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

export async function handleAccounts(req, env, p, q) {
    const db = env.DB;
    if (!db) return json({ error: 'sync is not configured on this deployment' }, 503);
    const body = req.method === 'POST' || req.method === 'PATCH'
        ? await req.json().catch(() => ({})) : {};

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

        await db.prepare('DELETE FROM pairing_codes WHERE token_hash = ? OR expires_at < ?')
            .bind(tokenHash, now()).run();

        /* Six digits across a handful of live claims collides essentially never, but
         * "essentially never" is not a reason to let an INSERT throw in a user's face. */
        let code = null;
        for (let i = 0; i < 8 && !code; i++) {
            const c = newPairCode();
            const taken = await db.prepare('SELECT 1 FROM pairing_codes WHERE code_hash = ?')
                .bind(await sha256(c)).first();
            if (!taken) code = c;
        }
        if (!code) return json({ error: 'could not allocate a code, try again' }, 503);

        await db.prepare(
            'INSERT INTO pairing_codes (code_hash, token_hash, platform, label_hint, ' +
            'created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(await sha256(code), tokenHash, body.platform || null,
                  body.label ? String(body.label).slice(0, 40) : null,
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
        const row = await db.prepare('SELECT expires_at FROM pairing_codes WHERE token_hash = ?')
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
        const row = await db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?')
            .bind(hash).first();
        if (!row || row.expires_at < now()) {
            await db.prepare('DELETE FROM pairing_codes WHERE code_hash = ?').bind(hash).run();
            return json({ error: 'invalid or expired code' }, 404);
        }
        const dev = await issueDevice(db, auth.accountId, row.platform, row.label_hint,
                                     row.token_hash);
        await db.prepare('DELETE FROM pairing_codes WHERE code_hash = ?').bind(hash).run();
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
        const dev = await issueDevice(db, row.id, body.platform, body.label);
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

        for (const [table, spec] of Object.entries(SYNCED)) {
            const rows = Array.isArray(body[table]) ? body[table] : [];
            for (const row of rows) {
                const id = row && row[spec.key];
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
                              ...cols.map((c) => (row[c] === undefined ? null : row[c])), stamp));
                }
            }
        }
        for (const s of (Array.isArray(body.settings) ? body.settings : [])) {
            if (!s || !s.key) continue;
            count++;
            stmts.push(db.prepare(
                'INSERT INTO settings (account_id, key, value, updated_at) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value, ' +
                'updated_at = excluded.updated_at WHERE settings.value IS NOT excluded.value')
                .bind(auth.accountId, String(s.key),
                      s.value === undefined || s.value === null ? null : String(s.value), stamp));
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
