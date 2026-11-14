// YASA PRESENTS
/* The sync engine against the real account handler, on real SQLite.
 *
 * ⛔ THIS SUITE EXISTS BECAUSE THE ENGINE HAD NO TEST IN THE REPO AT ALL. Sync was built
 * and measured on 2026-11-08 and every one of those suites stayed in a scratch folder.
 * On 2026-11-12 the engine was run again and it undid the user's own changes: a watched
 * mark, an un-star and a history removal each came back reverted two minutes later, on a
 * single device. Nothing in the repo could have said so.
 *
 * NOTHING HERE IS A PORT. The engine is server/ani-mate-sync.js, the server is
 * worker/src/index.js with worker/src/accounts.js behind it, and the database is
 * node:sqlite built from schema.sql. The two things written here are the device (two
 * arrays and a journal, which is all either app's store is) and the AniList stub.
 *
 * ⚠ EVERY CASE CHANGES A ROW BETWEEN A PUSH AND THE NEXT PULL. That is the window the
 * first suites never opened: they synced, changed something, synced, and compared, so the
 * engine's own echo always arrived to find the row exactly as it had left it.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/index.js';
import { makeD1 } from './d1.mjs';

export const name = 'sync-engine';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC = require(join(HERE, '..', '..', 'server', 'ani-mate-sync.js'));
const { create, shape, settingsAdapter } = SYNC;

const EDGE = 'https://edge.test';
const ANILIST = 'https://graphql.anilist.co';

/* One world: a database, a clock, an AniList, and a router that stands in for the network.
 * The clock only moves when the test moves it or a request is made, so every stamp the
 * server writes is ordered the way a real sequence of requests would order it. */
function makeWorld(opts = {}) {
    const hooks = { before: null };
    const env = { DB: makeD1({ before: async (sql, args) => { if (hooks.before) await hooks.before(sql, args); } }) };
    const world = {
        env, hooks,
        T: 1_800_000_000_000,
        anilist: opts.anilist || [],          // [{ id, romaji, english, synonyms }]
        anilistDown: false,
        anilistCalls: 0,
        api: opts.api,                        // override what /health reports
        advance(ms) { world.T += ms; },
        row(table, id) {
            return env.DB._sqlite.prepare(`SELECT * FROM ${table} WHERE anime_id = ?`).get(id) || null;
        },
        rows(table) { return env.DB._sqlite.prepare(`SELECT * FROM ${table} ORDER BY anime_id`).all(); },
    };
    world.fetch = async (u, init) => {
        const s = String(u);
        if (s.startsWith(ANILIST)) {
            world.anilistCalls++;
            if (world.anilistDown) return new Response('{}', { status: 429 });
            const { variables } = JSON.parse(init.body);
            const data = {};
            for (const k of Object.keys(variables)) {
                const term = String(variables[k]).toLowerCase();
                /* A fuzzy search, like the real one: anything sharing a word, most
                 * popular first, which here means list order. */
                const words = term.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
                const media = world.anilist.filter((m) =>
                    [m.romaji, m.english].concat(m.synonyms || []).some((t) =>
                        t && words.some((w) => t.toLowerCase().includes(w))))
                    .slice(0, 6)
                    .map((m) => ({ id: m.id, title: { romaji: m.romaji, english: m.english || null },
                                   synonyms: m.synonyms || [] }));
                data['q' + k.slice(1)] = { media };
            }
            return new Response(JSON.stringify({ data }), { status: 200 });
        }
        if (!s.startsWith(EDGE)) throw new Error('unexpected request to ' + s);
        world.advance(40);
        const url = new URL(s);
        if (world.api !== undefined && url.pathname === '/health') {
            return new Response(JSON.stringify({ ok: true, api: world.api }), { status: 200 });
        }
        return worker.fetch(new Request(s, init), env);
    };
    return world;
}

function memStore() {
    const m = new Map();
    return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), _m: m };
}

/* A device is what either app's store is: two lists and a journal of deletes. The user
 * actions below do what the apps' own routes do, in the same order (journal the key,
 * then remove the row). */
function makeDevice(world, platform) {
    const ls = new Map();
    const dev = {
        favs: [], hist: [], journal: { favorites: {}, watch: {} },
        failReads: false, applied: [],
        ls: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
        store: memStore(),
    };
    const read = (list) => { if (dev.failReads) throw new Error('disk read failed'); return list; };
    dev.engine = create({
        endpoint: EDGE, platform, store: dev.store, fetch: world.fetch,
        adapter: Object.assign({
            loadFavorites: async () => shape.favoritesOut(read(dev.favs)),
            loadWatch: async () => shape.watchOut(read(dev.hist)),
            loadDeleted: async () => JSON.parse(JSON.stringify(dev.journal)),
            applyFavorites: async (rows) => { dev.favs = shape.applyFavorites(dev.favs, rows); },
            applyWatch: async (rows) => { dev.hist = shape.applyWatch(dev.hist, rows); },
            saveIdentity: async (kind, updates) => {
                if (kind === 'favorites') dev.favs = shape.setIdentity(kind, dev.favs, updates);
                else dev.hist = shape.setIdentity(kind, dev.hist, updates);
            },
            clearDeleted: async (kind, keys) => { for (const k of keys) delete dev.journal[kind][k]; },
        }, settingsAdapter(dev.ls, (rows) => dev.applied.push(...rows))),
    });
    dev.star = (id, name, extra) => dev.favs.unshift(Object.assign(
        { id, name, episodes: 12, added: new Date(Date.now()).toISOString() }, extra || {}));
    dev.unstar = (id) => {
        dev.journal.favorites[shape.keyOfLocal('favorites', dev.favs, id)] = Date.now();
        dev.favs = dev.favs.filter((f) => String(f.id) !== String(id));
    };
    dev.play = (id, title, ep, extra) => {
        let h = dev.hist.find((x) => x.anime_id === id);
        if (!h) {
            h = { anime_id: id, title, episode: String(ep), quality: 'best', mode: 'sub',
                  episodes_watched: [], total_episodes: 12, playback_time: 0, playback_episode: String(ep) };
            dev.hist.unshift(h);
        }
        h.episode = String(ep);
        h.timestamp = new Date(Date.now()).toISOString();
        Object.assign(h, extra || {});
        return h;
    };
    dev.progress = (id, ep, secs) => {
        const h = dev.hist.find((x) => x.anime_id === id);
        h.playback_time = secs; h.playback_episode = String(ep);
    };
    dev.markWatched = (id, ep) => {
        const h = dev.hist.find((x) => x.anime_id === id);
        if (!h.episodes_watched.includes(String(ep))) h.episodes_watched.push(String(ep));
        h.playback_time = 0; h.playback_episode = null;
    };
    dev.forget = (id) => {
        dev.journal.watch[shape.keyOfLocal('watch', dev.hist, id)] = Date.now();
        dev.hist = dev.hist.filter((h) => h.anime_id !== id);
    };
    dev.watched = (id) => (dev.hist.find((x) => x.anime_id === id) || { episodes_watched: null }).episodes_watched;
    dev.sync = async () => { world.advance(120000); return dev.engine.sync(); };
    return dev;
}

async function account(world, dev) {
    const r = await dev.engine.createAccount(dev.label);
    return r.recovery_key;
}

export async function run(t) {
    const realNow = Date.now;
    let world = null;
    Date.now = () => (world ? world.T : realNow());
    /* crypto.subtle.timingSafeEqual is a Workers extension; recovery needs it. */
    const nodeCrypto = await import('node:crypto');
    const hadTse = typeof crypto.subtle.timingSafeEqual === 'function';
    if (!hadTse) crypto.subtle.timingSafeEqual = (a, b) => nodeCrypto.timingSafeEqual(a, b);

    try {
        // ── 1. the engine's own echo must not undo what changed since the push ───────
        {
            world = makeWorld();
            const d = makeDevice(world, 'electron');
            d.play('show-x', 'Show X', 5, { episodes_watched: ['1', '2', '3', '4'], playback_time: 600 });
            await account(world, d);
            t.ok(!!world.row('watch', 'show-x'), 'sign-up pushed the show');

            d.progress('show-x', 5, 700);
            await d.sync();
            t.eq(d.hist[0].playback_time, 700,
                 'a position saved after the push is still there after the next sync (was rolled back to 600)');

            d.markWatched('show-x', 5);
            await d.sync();                       // pushes the mark
            d.progress('show-x', 6, 300);
            d.markWatched('show-x', 6);           // changed AGAIN inside the echo window
            await d.sync();                       // the echo of the previous push arrives now
            t.ok(d.watched('show-x').includes('6'),
                 'episode 6 is still marked watched after the echo sync (it was erased before)');
            await d.sync(); await d.sync();
            t.ok(JSON.parse(world.row('watch', 'show-x').episodes_watched).includes('6'),
                 'and the server has it');

            d.star('fav-1', 'Fav One');
            await d.sync();                       // pushed
            d.unstar('fav-1');
            await d.sync();                       // echo of the star arrives
            t.eq(d.favs.length, 0, 'an un-starred show stays un-starred across the echo');
            t.eq(world.row('favorites', 'fav-1').deleted, 1, 'and the un-star reached the server as a tombstone');
            await d.sync(); await d.sync();
            t.eq(d.favs.length, 0, 'and it does not come back later');

            d.progress('show-x', 6, 900);
            await d.sync();
            d.forget('show-x');
            await d.sync();
            t.eq(d.hist.length, 0, 'a show removed from history stays removed across the echo');
            t.eq(world.row('watch', 'show-x').deleted, 1, 'and the removal reached the server');
            t.eq(Object.keys(d.journal.watch).length + Object.keys(d.journal.favorites).length, 0,
                 'the journal is empty once its deletes have been pushed');
        }

        // ── 2. two devices: changes travel, deletes travel, nothing is resurrected ───
        {
            world = makeWorld();
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'electron');
            a.play('s1', 'Show One', 3, { episodes_watched: ['1', '2'] });
            a.star('f1', 'Fav One');
            const key = await account(world, a);
            await b.engine.recover(key, 'second');
            t.eq(b.hist.length, 1, 'the second device received the history row');
            t.eq(b.favs.length, 1, 'and the favorite');

            b.markWatched('s1', 3);
            await b.sync(); await a.sync();
            t.ok(a.watched('s1').includes('3'), 'a watched mark made on B reaches A');

            a.unstar('f1');
            await a.sync(); await b.sync();
            t.eq(b.favs.length, 0, 'a favorite removed on A is removed on B');
            await b.sync(); await a.sync(); await b.sync();
            t.eq(a.favs.length + b.favs.length, 0, 'and neither device brings it back');

            /* The case tombstones exist for: B is holding the row, unchanged, when A's
             * delete lands. B must drop it, not push it back. */
            a.star('f2', 'Fav Two');
            await a.sync(); await b.sync();
            t.eq(b.favs.length, 1, 'B has the new favorite');
            a.unstar('f2');
            await a.sync(); await b.sync(); await a.sync();
            t.eq(a.favs.length + b.favs.length, 0, 'deleted on A, gone on B, and not pushed back by B');
        }

        // ── 3. both devices changed the same show: nothing watched is lost ───────────
        {
            world = makeWorld();
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'electron');
            a.play('s1', 'Show One', 1, { episodes_watched: ['1'] });
            const key = await account(world, a);
            await b.engine.recover(key, 'second');

            /* B goes offline and watches 2. A, later, watches 3 and 4 and syncs. */
            b.play('s1', 'Show One', 2); b.markWatched('s1', 2);
            world.advance(3600000);
            a.play('s1', 'Show One', 4); a.markWatched('s1', 3); a.progress('s1', 4, 500);
            await a.sync();
            await b.sync();                       // B meets A's newer row while holding its own change
            t.eq(JSON.stringify(b.watched('s1')), JSON.stringify(['1', '2', '3']),
                 'B keeps its own episode 2 AND gains A\'s episode 3');
            t.eq(b.hist[0].episode, '4', 'the resume point is the newer one (A watched later)');
            t.eq(b.hist[0].playback_time, 500, 'with its position, not a mix of the two');
            await a.sync();
            t.eq(JSON.stringify(a.watched('s1')), JSON.stringify(['1', '2', '3']),
                 'and A gains B\'s episode 2');
        }

        // ── 4. only a real delete deletes ────────────────────────────────────────────
        {
            world = makeWorld();
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'electron');
            for (let i = 1; i <= 100; i++) {
                world.advance(1000);
                a.play('h' + i, 'Show ' + i, 1, { episodes_watched: ['1'] });
            }
            const key = await account(world, a);
            await b.engine.recover(key, 'second');
            t.eq(b.hist.length, 100, 'B received all 100 rows');

            /* Show 101 pushes the oldest row off A's capped list. Nobody deleted it. */
            world.advance(1000);
            a.play('h101', 'Show 101', 1, { episodes_watched: ['1'] });
            a.hist = shape.applyWatch(a.hist, []);            // the cap, as the app applies it
            t.eq(a.hist.length, 100, 'A is back at the cap, the oldest row fell off');
            t.ok(!a.hist.some((h) => h.anime_id === 'h1'), 'the row that fell off is h1');
            await a.sync();
            t.eq(world.row('watch', 'h1').deleted, 0, 'the server row for h1 is NOT a tombstone');
            t.ok(!!world.row('watch', 'h101'), 'the new show was pushed');

            /* A file that fails to read is an error, not an empty library. */
            b.failReads = true;
            let threw = null;
            try { await b.sync(); } catch (e) { threw = e; }
            t.ok(!!threw, 'a failed local read makes the sync fail (' + (threw && threw.message) + ')');
            b.failReads = false;
            const tombs = world.rows('watch').filter((r) => r.deleted).length;
            t.eq(tombs, 0, 'and it deleted nothing on the account');
            await b.sync();
            t.eq(b.hist.length, 100, 'B still has a full list afterwards');
        }

        // ── 5. a push that commits after another device's pull is still delivered ────
        {
            world = makeWorld();
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'android');
            const key = await account(world, a);
            await b.engine.recover(key, 'phone');
            await a.sync(); await b.sync();

            a.star('late', 'Late Favorite');
            world.advance(120000);
            let release = null;
            world.hooks.before = async (sql) => {
                if (/INSERT INTO favorites/.test(sql) && !release) await new Promise((r) => { release = r; });
            };
            const pushing = a.engine.sync();                  // its write is now parked, already stamped
            for (let i = 0; i < 400 && !release; i++) await new Promise((r) => setImmediate(r));
            t.ok(!!release, 'A\'s push is parked between taking its stamp and writing');
            world.hooks.before = null;
            await b.engine.sync();                            // B pulls with a LATER clock and sees nothing
            t.eq(b.favs.length, 0, 'B pulled before the write landed and has nothing yet');
            release(); await pushing;
            await b.sync();
            t.eq(b.favs.length, 1, 'B gets it on its next sync (the cursor used to step over it for good)');
        }

        // ── 6. settings: unset is not a value ────────────────────────────────────────
        {
            world = makeWorld();
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'android');
            const EN = shape.SETTING_KEYS.prefer_english, AUTO = shape.SETTING_KEYS.autoplay;
            const key = await account(world, a);
            await a.sync(); await a.sync();
            t.eq(a.ls.getItem(EN), null,
                 'a toggle the user never touched is still unset after syncing (it was being written as false)');
            t.eq(world.env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0,
                 'and nothing was stored for it on the account');

            a.ls.setItem(AUTO, 'true');
            await a.sync();
            await b.engine.recover(key, 'phone');
            t.eq(b.ls.getItem(AUTO), 'true', 'a setting the user did change reaches a new device');
            t.ok(b.applied.some((r) => r.key === 'autoplay' && r.value === 'true'),
                 'and the app is told, so it can update its state and its checkbox');
            t.eq(b.ls.getItem(EN), null, 'while the untouched one stays unset there too');

            a.ls.setItem(AUTO, 'false');
            await a.sync();                       // pushed
            a.ls.setItem(AUTO, 'true');           // changed again inside the echo window
            await a.sync();
            t.eq(a.ls.getItem(AUTO), 'true', 'the echo of the earlier push does not flip a toggle back');
            await b.sync();
            t.eq(b.ls.getItem(AUTO), 'true', 'and the other device ends on the latest value');
        }

        // ── 7. one show, one row, whichever platform it was watched on ───────────────
        {
            world = makeWorld({ anilist: [
                { id: 1000, romaji: 'Shingeki no Kyojin', english: 'Attack on Titan' },
                { id: 20958, romaji: 'Shingeki no Kyojin Season 2', english: 'Attack on Titan Season 2' },
                { id: 21459, romaji: 'Boku no Hero Academia', english: 'My Hero Academia' },
                { id: 21856, romaji: 'Boku no Hero Academia 2', english: 'My Hero Academia Season 2' },
            ] });
            const desk = makeDevice(world, 'electron'), phone = makeDevice(world, 'android');
            /* The desktop knows the show by its AllAnime id and romaji name; the phone by
             * a hianime slug and the English name. Before this they were two rows. */
            desk.play('AA1b2c3', 'Shingeki no Kyojin Season 2', 3, { episodes_watched: ['1', '2'] });
            desk.star('AA9z', 'Boku no Hero Academia 2nd Season');
            const key = await account(world, desk);
            t.ok(!!world.row('watch', 'al:20958'), 'the desktop row is keyed by its AniList id on the account');
            t.ok(!world.row('watch', 'al:1000'),
                 'and NOT by season 1\'s id, which is the search\'s first hit for that title');
            t.ok(!!world.row('favorites', 'al:21856'),
                 '"2nd Season" and a trailing "2" are the same season: the favorite got the right id');

            world.advance(60000);                 // the phone is used an hour later, not in the same millisecond
            phone.play('attack-on-titan-season-2-777', 'Attack on Titan Season 2', 4, { episodes_watched: ['3'] });
            world.advance(60000);
            await phone.engine.recover(key, 'phone');
            t.eq(phone.hist.length, 1, 'the phone still has ONE row for the show, not two');
            t.eq(phone.hist[0].anime_id, 'attack-on-titan-season-2-777', 'under the id the phone can open');
            t.eq(JSON.stringify(phone.watched('attack-on-titan-season-2-777')), JSON.stringify(['1', '2', '3']),
                 'holding the episodes watched on both devices');
            t.eq(world.rows('watch').filter((r) => !r.deleted).length, 1, 'and the account holds one row for it');
            await desk.sync();
            t.eq(JSON.stringify(desk.watched('AA1b2c3')), JSON.stringify(['1', '2', '3']),
                 'the desktop row, still under its own id, gained the phone\'s episode');
            t.eq(desk.hist[0].episode, '4', 'and the phone\'s newer resume point');
            t.eq(phone.favs.length, 1, 'the favorite crossed over');
        }

        // ── 8. AniList down at first, answering later: the row is renamed, not doubled ─
        {
            world = makeWorld({ anilist: [{ id: 5, romaji: 'Cowboy Bebop', english: 'Cowboy Bebop' }] });
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'android');
            world.anilistDown = true;
            a.play('AAbebop', 'Cowboy Bebop', 2, { episodes_watched: ['1'] });
            const key = await account(world, a);
            t.ok(!!world.row('watch', 'AAbebop'), 'with AniList unreachable the row syncs under its local id');
            await b.engine.recover(key, 'phone');
            t.eq(b.hist.length, 1, 'the phone receives it');

            world.anilistDown = false;
            await a.sync();
            t.eq(world.row('watch', 'AAbebop').deleted, 1, 'once the id is known the old key is retired');
            t.ok(!!world.row('watch', 'al:5') && !world.row('watch', 'al:5').deleted, 'and the row lives on under the new one');
            await b.sync(); await b.sync();
            t.eq(b.hist.length, 1, 'the phone ends with one row for the show, not two');
            await a.sync(); await b.sync();
            t.eq(world.rows('watch').filter((r) => !r.deleted).length, 1, 'and so does the account');
        }

        // ── 8b. AniList down for BOTH first syncs, and each device has its own copy ───
        /* Found 2026-11-12 by the end-to-end suite, on a run where AniList was rate
         * limiting this address. Each device pushed its rows under its own ids, each
         * stored the other's as a second row, and when AniList came back the two copies
         * were never made one: the rule was "of two rows with one AniList id, the smaller
         * id keeps it", which is right for two rows the user made and wrong for a row
         * that only arrived by sync. Both devices showed the show twice for good, and
         * progress went to whichever copy that platform happened to play. */
        {
            world = makeWorld({ anilist: [
                { id: 5, romaji: 'Cowboy Bebop', english: 'Cowboy Bebop' },
                { id: 6, romaji: 'Trigun', english: 'Trigun' },
                { id: 19, romaji: 'Monster', english: 'Monster' },
            ] });
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'android');
            world.anilistDown = true;
            a.star('AAbebop', 'Cowboy Bebop'); a.star('AAtrigun', 'Trigun');
            a.play('AAbebop', 'Cowboy Bebop', 3, { episodes_watched: ['1', '2'] });
            const key = await account(world, a);
            world.advance(60000);
            b.star('cowboy-bebop-1281', 'Cowboy Bebop'); b.star('monster-19', 'Monster');
            b.play('cowboy-bebop-1281', 'Cowboy Bebop', 5, { episodes_watched: ['4', '5'] });
            world.advance(60000);
            await b.engine.recover(key, 'phone');
            await a.sync(); await b.sync();
            t.eq(a.favs.length, 4, 'with AniList unreachable, each device holds the other\'s copy as a second row');

            world.anilistDown = false;
            for (let i = 0; i < 3; i++) { await a.sync(); await b.sync(); }
            const ids = (list) => list.map((f) => String(f.id)).sort();
            const names = (list) => list.map((f) => f.name).sort();
            t.eq(JSON.stringify(names(a.favs)), JSON.stringify(['Cowboy Bebop', 'Monster', 'Trigun']),
                 'once AniList answers, the desktop is back to three favorites, one per show');
            t.eq(JSON.stringify(names(b.favs)), JSON.stringify(['Cowboy Bebop', 'Monster', 'Trigun']),
                 'and so is the phone');
            t.ok(ids(a.favs).includes('AAbebop') && ids(a.favs).includes('AAtrigun') && !ids(a.favs).includes('cowboy-bebop-1281'),
                 'the desktop kept ITS ids for the shows it had: ' + JSON.stringify(ids(a.favs)));
            t.ok(ids(b.favs).includes('cowboy-bebop-1281') && ids(b.favs).includes('monster-19') && !ids(b.favs).includes('AAbebop'),
                 'the phone kept ITS ids for the shows it had: ' + JSON.stringify(ids(b.favs)));
            t.eq(a.hist.length, 1, 'one history row on the desktop');
            t.eq(b.hist.length, 1, 'one on the phone');
            t.eq(a.hist[0] && a.hist[0].anime_id, 'AAbebop', 'under the id the desktop plays');
            t.eq(b.hist[0] && b.hist[0].anime_id, 'cowboy-bebop-1281', 'and the id the phone plays');
            t.eq(JSON.stringify((a.watched('AAbebop') || []).slice().sort()), JSON.stringify(['1', '2', '4', '5']),
                 'the desktop row holds what was watched on both');
            t.eq(JSON.stringify((b.watched('cowboy-bebop-1281') || []).slice().sort()), JSON.stringify(['1', '2', '4', '5']),
                 'and so does the phone\'s');
            const live = (table) => world.rows(table).filter((r) => !r.deleted).map((r) => r.anime_id).sort();
            t.eq(JSON.stringify(live('favorites')), JSON.stringify(['al:19', 'al:5', 'al:6']),
                 'the account holds each show once, under its AniList id: ' + JSON.stringify(live('favorites')));
            t.eq(JSON.stringify(live('watch')), JSON.stringify(['al:5']), 'and one watch row');

            /* And it stays that way: a change on one side lands on the other's single row. */
            world.advance(60000);
            b.play('cowboy-bebop-1281', 'Cowboy Bebop', 6);
            b.markWatched('cowboy-bebop-1281', 6);
            await b.sync(); await a.sync();
            t.ok((a.watched('AAbebop') || []).includes('6') && a.hist.length === 1,
                 'an episode watched on the phone afterwards shows on the desktop\'s one row');
        }

        // ── 9. a joining device with its own copy: folded, not doubled ───────────────
        {
            world = makeWorld({ anilist: [{ id: 5, romaji: 'Cowboy Bebop', english: 'Cowboy Bebop' }] });
            const a = makeDevice(world, 'electron'), b = makeDevice(world, 'android');
            a.play('AAbebop', 'Cowboy Bebop', 5, { episodes_watched: ['1', '2', '3', '4'] });
            const key = await account(world, a);
            /* The phone's own copy is not looked up yet when the account's row arrives. */
            b.play('cowboy-bebop-1281', 'Cowboy Bebop', 1, { episodes_watched: ['9'] });
            world.anilistDown = true;
            await b.engine.recover(key, 'phone');
            t.eq(b.hist.length, 2, 'while AniList is unreachable the phone briefly holds both copies');
            world.anilistDown = false;
            await b.sync();
            t.eq(b.hist.length, 1, 'and folds them into one as soon as its own copy is identified');
            t.eq(b.hist[0].anime_id, 'cowboy-bebop-1281', 'keeping the id the phone can open');
            t.eq(JSON.stringify(b.hist[0].episodes_watched), JSON.stringify(['1', '2', '3', '4', '9']),
                 'with every watched episode from both');
        }

        // ── 10. a server without accounts is named as such ───────────────────────────
        {
            world = makeWorld({ api: 1 });
            const d = makeDevice(world, 'electron');
            let err = null;
            try { await d.engine.createAccount('desk'); } catch (e) { err = e; }
            t.ok(!!err && err.code === 'no_backend',
                 'creating an account against an older server fails with a plain reason: '
                 + JSON.stringify(err && err.message));
            t.eq(d.engine.state().signedIn, false, 'and leaves the device signed out');
        }

        // ── 11. watch time is not lost between the tick and the sync ─────────────────
        {
            world = makeWorld();
            const d = makeDevice(world, 'electron');
            await account(world, d);
            for (let i = 0; i < 40; i++) d.engine.noteWatching(0.25, ['Action']);
            t.eq(d.engine.localStats().total_seconds, 10, 'forty quarter-second ticks are ten seconds');
            await d.sync();
            const wt = world.env.DB._sqlite.prepare('SELECT SUM(seconds) AS s FROM watch_time').get().s;
            t.eq(wt, 10, 'and all ten reach the account on the next sync');
        }
    } finally {
        Date.now = realNow;
        if (!hadTse) delete crypto.subtle.timingSafeEqual;
        world = null;
    }
}
