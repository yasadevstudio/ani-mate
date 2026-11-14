/* Every route in AUTH_MINTS must resolve to a real handler.
 *
 * ⛔ THIS IS THE TEST THAT WOULD HAVE CAUGHT IT. AUTH_MINTS listed
 * '/api/device/pair' and '/api/device/pair-code' — measured 2026-11-09, each string
 * occurred exactly ONCE in the whole worker, inside that Set. They were never routes.
 * The two endpoints that actually hand out device tokens, POST /api/device/claim and
 * POST /api/device/approve, were therefore on RL_READ: 120 a minute on credential
 * minting instead of 10.
 *
 * Nothing about reading the limiter code revealed that. The Set was syntactically fine,
 * the limiter worked, and the names were plausible. The only thing that distinguishes a
 * route from a plausible string is asking the router.
 */
import { AUTH_MINTS, isMint, isAccountPath } from '../src/index.js';
import { handleAccounts } from '../src/accounts.js';
import { makeD1, req } from './d1.mjs';

export const name = 'auth-mints';

export async function run(t) {
    const env = { DB: makeD1() };

    t.ok(AUTH_MINTS.size > 0, 'AUTH_MINTS is not empty (' + AUTH_MINTS.size + ' entries)');

    for (const entry of AUTH_MINTS) {
        const [method, path] = entry.split(' ');
        t.ok(!!method && !!path, 'entry parses as "METHOD /path": ' + JSON.stringify(entry));

        /* handleAccounts returns null for a path it does not own — index.js relies on
         * that to keep one router. A null here means the entry names nothing. */
        const r = await handleAccounts(req(method, path, { body: {} }), env, path, new URLSearchParams());
        t.ok(r !== null && r !== undefined,
             method + ' ' + path + ' resolves to a handler'
             + (r ? ' (' + r.status + ')' : ' — NOTHING HANDLES THIS PATH'));

        /* And index.js has to be willing to dispatch it in the first place. This asks
         * the router's OWN function. It used to be the prefix table typed out again
         * here, which tested this file's copy of the table and not the router. */
        t.ok(isAccountPath(path), method + ' ' + path + ' is a path the router hands to accounts.js');
    }

    // ── the dead names must stay dead ────────────────────────────────────────────
    for (const dead of ['/api/device/pair', '/api/device/pair-code']) {
        const r = await handleAccounts(req('POST', dead, { body: {} }), env, dead, new URLSearchParams());
        t.ok(r === null,
             'the old phantom route ' + dead + ' still resolves to nothing — '
             + 'if this ever starts passing, add it to AUTH_MINTS');
        t.ok(!isMint('POST', dead), dead + ' is no longer claimed as a mint');
    }

    // ── the bucket choice, and the one method that must NOT be throttled ─────────
    t.ok(isMint('POST', '/api/device/claim'), 'POST /api/device/claim is a mint');
    t.ok(!isMint('GET', '/api/device/claim'),
         'GET /api/device/claim is NOT a mint — it is the new device polling for '
         + 'approval, and on the 10/min bucket a normal pairing would throttle itself');
    t.ok(isMint('POST', '/api/device/approve'), 'POST /api/device/approve is a mint');
    t.ok(!isMint('GET', '/api/sync') && !isMint('POST', '/api/sync'),
         '/api/sync stays on RL_READ — a device syncing often is a device working');
    t.ok(!isMint('POST', '/api/play'), '/api/play has its own bucket, not this one');

    /* Every route that mints a credential should be IN the set. Derived from the
     * handlers rather than asserted by hand, so a new mint added to accounts.js without
     * a limiter entry fails here. */
    const MINTS_BY_DESIGN = ['POST /api/account', 'POST /api/account/recover',
                             'POST /api/account/recovery-key', 'POST /api/device/claim',
                             'POST /api/device/approve'];
    for (const m of MINTS_BY_DESIGN) {
        t.ok(AUTH_MINTS.has(m), m + ' is covered by the tight bucket');
    }
}
