// YASA PRESENTS
/* What the account API will and will not store.
 *
 * An account costs nothing to create, so every one of these is something a stranger can
 * send. Before 2026-11-12 a push bound whatever arrived: any type, any length, any number
 * of rows. The same unchecked fields then came back out on every other device of the
 * account, and both apps drew some of them with innerHTML.
 *
 * Real handler, real SQLite, no network.
 */
import worker, { modeOf } from '../src/index.js';
import { handleAccounts } from '../src/accounts.js';
import { makeD1, req } from './d1.mjs';

export const name = 'sync-api';

const Q = new URLSearchParams();
const call = (env, method, path, opts) => handleAccounts(req(method, path, opts), env, path, Q);

async function fresh() {
    const env = { DB: makeD1() };
    const acct = await (await call(env, 'POST', '/api/account', { body: { platform: 'electron' } })).json();
    const push = (body) => call(env, 'POST', '/api/sync', { token: acct.device_token, body });
    const row = (table, id) => env.DB._sqlite.prepare(`SELECT * FROM ${table} WHERE anime_id = ?`).get(id);
    return { env, acct, push, row };
}

export async function run(t) {
    // ── the mode parameter ───────────────────────────────────────────────────────
    t.eq(modeOf('dub'), 'dub', 'dub is dub');
    t.eq(modeOf('sub'), 'sub', 'sub is sub');
    t.eq(modeOf('(.+)+!'), 'sub', 'anything else is sub, including a regular expression');
    t.eq(modeOf(undefined), 'sub', 'and nothing at all');

    // ── /health names what this server can do ────────────────────────────────────
    {
        const h = await (await worker.fetch(new Request('https://x.invalid/health'), {})).json();
        t.ok(h.api >= 2, '/health reports api ' + h.api + ' (2 means accounts exist)');
        t.ok(Array.isArray(h.features) && h.features.includes('sync'), 'and lists sync as a feature');
    }

    // ── fields are forced into the shape of their column ─────────────────────────
    {
        const { push, row } = await fresh();
        const r = await push({
            watch: [{
                anime_id: 'x', title: 'T'.repeat(5000), title_english: { not: 'a string' },
                episode: '<img src=x onerror=alert(1)>'.repeat(4), position: 'abc', duration: [1],
                mode: '(.+)+!', episodes_watched: 'not json', total_episodes: '?',
            }],
            favorites: [{
                anime_id: 'f', title: 123, episodes: '12', franchise_id: 'fp:' + 'z'.repeat(999),
                cover: 'javascript:alert(1)', added_at: 'yesterday',
            }],
        });
        t.eq(r.status, 200, 'a push full of wrong types is accepted, not a 500');
        const w = row('watch', 'x');
        t.eq(w.title.length, 300, 'a title is cut to 300 characters (sent 5000)');
        t.eq(w.title_english, null, 'an object where a string belongs becomes null');
        t.ok(w.episode.length <= 20, 'an episode label is at most 20 characters (got ' + w.episode.length + ')');
        t.eq(w.position, 0, 'a position that is not a number is 0');
        t.eq(w.duration, null, 'an array where a number belongs becomes null');
        t.eq(w.mode, null, 'a mode that is neither sub nor dub is null');
        t.eq(w.episodes_watched, '[]', 'a watched list that is not a list is an empty list');
        t.eq(w.total_episodes, null, "'?' is not an episode total");
        const f = row('favorites', 'f');
        t.eq(f.title, '123', 'a numeric title is stored as text');
        t.eq(f.episodes, 12, 'a numeric string count is stored as a number');
        t.eq(f.franchise_id.length, 200, 'a franchise id is cut to 200 characters');
        t.eq(f.cover, null, 'a cover that is not an http(s) address is dropped');
        t.eq(f.added_at, null, 'a date that is not a number is null');
    }
    {
        const { push, row } = await fresh();
        await push({ watch: [{ anime_id: 'w', title: 'Show', episode: '3', position: 61.5, mode: 'dub',
                               episodes_watched: JSON.stringify(['1', '2', { x: 1 }, 3]), total_episodes: 12 }] });
        const w = row('watch', 'w');
        t.eq(w.episodes_watched, '["1","2","3"]', 'a real watched list is kept, entries as short strings, objects dropped');
        t.eq(w.position, 61.5, 'a real position is kept exactly');
        t.eq(w.mode, 'dub', 'a real mode is kept');
        t.eq(w.total_episodes, 12, 'a real total is kept');
    }

    // ── ids ──────────────────────────────────────────────────────────────────────
    {
        const { push, env } = await fresh();
        const r = await push({ favorites: [{ anime_id: 'a'.repeat(201), title: 'x' }, { anime_id: { o: 1 }, title: 'y' },
                                           { title: 'no id' }, null, 'string', { anime_id: 'ok', title: 'z' }] });
        const j = await r.json();
        t.eq(j.applied, 1, 'only the row with a usable id is applied (an id over 200 characters, an object, none, null and a string are skipped)');
        t.eq(env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM favorites').get().n, 1, 'and one row is stored');
    }

    // ── ceilings ─────────────────────────────────────────────────────────────────
    {
        const { push, env } = await fresh();
        const many = Array.from({ length: 1001 }, (_, i) => ({ anime_id: 'f' + i, title: 't' }));
        const r = await push({ favorites: many });
        t.eq(r.status, 413, 'more than 1000 rows of one kind in one request is refused');
        t.eq(env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM favorites').get().n, 0, 'and nothing from it is stored');

        const big = await push({ favorites: [{ anime_id: 'big', title: 'x'.repeat(1100000) }] });
        t.eq(big.status, 413, 'a body over 1 MB is refused before it is parsed');

        for (let i = 0; i < 5; i++) {
            const part = Array.from({ length: 1000 }, (_, k) => ({ anime_id: 'r' + i + '-' + k, title: 't' }));
            const rr = await push({ favorites: part });
            if (i < 5) t.eq(rr.status, 200, 'batch ' + (i + 1) + ' of 1000 favorites is stored');
        }
        const over = await push({ favorites: [{ anime_id: 'one-more', title: 't' }] });
        t.eq(over.status, 413, 'an account holding 5000 favorites cannot take another');
    }
    {
        const { push, env, acct } = await fresh();
        await push({ watch_time: [{ day: '2026-11-12', seconds: 999999999 }, { day: '2026-13-99', seconds: 5 }],
                     genre_time: [{ genre: 'G'.repeat(90), seconds: 10 }, { genre: { a: 1 }, seconds: 10 }],
                     settings: [{ key: 'autoplay', value: 'true' }, { key: 'BAD KEY!', value: 'x' },
                                { key: 'nsfw', value: 'v'.repeat(500) }] });
        const wt = env.DB._sqlite.prepare('SELECT * FROM watch_time').all();
        t.eq(wt.length, 1, 'a day that is not a calendar day is not stored');
        t.eq(wt[0].seconds, 86400, 'a day cannot hold more than 86,400 seconds');
        const gt = env.DB._sqlite.prepare('SELECT * FROM genre_time').all();
        t.eq(gt.length, 1, 'a genre that is not text is not stored');
        t.eq(gt[0].genre.length, 40, 'and a genre name is cut to 40 characters');
        const st = env.DB._sqlite.prepare('SELECT key, value FROM settings ORDER BY key').all();
        t.eq(st.map((s) => s.key).join(','), 'autoplay,nsfw', 'a setting key that is not a plain identifier is not stored');
        t.eq(st[1].value.length, 100, 'and a setting value is cut to 100 characters');
        void acct;
    }

    // ── bodies that are valid JSON and not a request ─────────────────────────────
    {
        const env = { DB: makeD1() };
        const r = await handleAccounts(new Request('https://x.invalid/api/account?v=2',
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' }), env, '/api/account', Q);
        t.eq(r.status, 201, 'a body of `null` creates an account like an empty body does (it used to answer 500)');
        const r2 = await handleAccounts(new Request('https://x.invalid/api/account?v=2',
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2' }), env, '/api/account', Q);
        t.eq(r2.status, 201, 'and so does a body that does not parse');
    }

    // ── devices ──────────────────────────────────────────────────────────────────
    {
        const env = { DB: makeD1() };
        const realTse = crypto.subtle.timingSafeEqual;
        const nodeCrypto = await import('node:crypto');
        if (typeof realTse !== 'function') crypto.subtle.timingSafeEqual = (a, b) => nodeCrypto.timingSafeEqual(a, b);
        try {
            const acct = await (await call(env, 'POST', '/api/account',
                { body: { platform: 'Elec<tron>!', label: 'L'.repeat(90) } })).json();
            const d0 = env.DB._sqlite.prepare('SELECT platform, label FROM devices').get();
            t.eq(d0.platform, 'electron', 'a platform is reduced to lowercase letters and digits');
            t.eq(d0.label.length, 40, 'a device label is cut to 40 characters');
            let last = null;
            for (let i = 0; i < 25; i++) {
                last = await call(env, 'POST', '/api/account/recover',
                    { body: { recovery_key: acct.recovery_key, platform: 'android' } });
            }
            t.eq(last.status, 409, 'an account cannot hold more than 25 devices (the 26th is refused)');
            t.eq(env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 25, 'and exactly 25 exist');

            /* last_seen is stamped at most every ten minutes */
            env.DB._sqlite.prepare('UPDATE devices SET last_seen = 1').run();
            await call(env, 'GET', '/api/devices', { token: acct.device_token });
            const a = env.DB._sqlite.prepare('SELECT last_seen FROM devices WHERE id = ?').get(acct.device_id).last_seen;
            t.ok(a > 1, 'a stale last_seen is refreshed');
            env.DB._sqlite.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(a - 60000, acct.device_id);
            await call(env, 'GET', '/api/devices', { token: acct.device_token });
            const b = env.DB._sqlite.prepare('SELECT last_seen FROM devices WHERE id = ?').get(acct.device_id).last_seen;
            t.eq(b, a - 60000, 'one that is a minute old is left alone');
        } finally {
            if (typeof realTse !== 'function') delete crypto.subtle.timingSafeEqual;
        }
    }

    // ── a client that does not say which protocol it speaks is the first engine ────
    /* Measured 2026-11-13, the hour after this API went live: the first sync engine uses
     * these same routes with these same bodies. Let in, it made an account, synced, and
     * after one failed read of its own favorites removed three favorites from another
     * device on the account. It sends no `v`; every engine since sends `v=2`. */
    {
        const { env, acct, push, row } = await fresh();
        const accountsBefore = env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
        const old = await call(env, 'POST', '/api/account', { body: { platform: 'electron' }, v: null });
        const said = await old.json();
        t.eq(old.status, 426, 'making an account without `v` is refused with 426');
        t.ok(said.upgrade === true && /too old to sync/i.test(said.error || '') && said.needs === 2,
             'with a sentence the old panel shows as it is: ' + JSON.stringify(said.error));
        t.eq(env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, accountsBefore, 'and no account is made');
        t.eq((await call(env, 'POST', '/api/account', { body: {}, v: 1 })).status, 426, '`v=1` is refused too');
        t.eq((await call(env, 'POST', '/api/account', { body: {}, v: 3 })).status, 201, 'a later engine than this server knows is let in');

        /* A device that somehow holds a token (signed in by a current engine, then the
         * old window opened on the same data) gets nowhere either. */
        await push({ favorites: [{ anime_id: 'keepMe01', title: 'Keep Me' }] });
        t.ok(!!row('favorites', 'keepMe01'), 'a favorite pushed by the current engine is stored');
        const pull = await call(env, 'GET', '/api/sync?since=0', { token: acct.device_token, v: null });
        t.eq(pull.status, 426, 'the first engine cannot pull with a valid token');
        const del = await call(env, 'POST', '/api/sync', { token: acct.device_token, v: null,
                                                           body: { favorites: [{ anime_id: 'keepMe01', deleted: true }] } });
        t.eq(del.status, 426, 'and cannot push');
        t.ok(row('favorites', 'keepMe01') && !row('favorites', 'keepMe01').deleted, 'so the delete it would have sent does not happen');
        t.eq((await call(env, 'DELETE', '/api/account', { token: acct.device_token, v: null })).status, 426, 'nor can it delete the account');

        const h = await worker.fetch(new Request('https://x.invalid/health'), {});
        t.eq(h.status, 200, '/health is not an account route and asks for nothing');
        const routed = await worker.fetch(new Request('https://x.invalid/api/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env);
        t.eq(routed.status, 426, 'and the check holds through the router, not only in the handler');
    }

    // ── an error does not carry the exception text out ───────────────────────────
    {
        const boom = { DB: { prepare() { throw new Error('SECRET internal detail'); } } };
        const r = await worker.fetch(new Request('https://x.invalid/api/devices?v=2',
            { headers: { authorization: 'Bearer x' } }), boom);
        const body = await r.text();
        t.eq(r.status, 500, 'a thrown handler answers 500');
        t.ok(!/SECRET/.test(body), 'without the exception text in the body: ' + body);
    }
}
