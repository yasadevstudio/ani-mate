/* Two approvals of the same pairing code, CONCURRENTLY.
 *
 * ⛔ THE OLD TEST RAN THEM SEQUENTIALLY AND PASSED.
 * "the same code cannot be approved twice" — await one, await the other, assert the
 * second 404s. True, and silent about the thing it was believed to establish. The
 * handler was:
 *
 *     SELECT the claim  ->  issueDevice()  ->  DELETE the claim
 *
 * three un-transacted round trips. Interleaved, BOTH callers pass the SELECT and both
 * call issueDevice with the same token_hash; devices.token_hash is UNIQUE, so the loser
 * got a raw constraint error as a bodyless 500. Sequential calls can never produce that
 * interleaving, so the suite was structurally incapable of seeing it.
 *
 * Every case here fires with Promise.all and asserts the OUTCOME: exactly one device.
 */
import { handleAccounts } from '../src/accounts.js';
import { makeD1, req } from './d1.mjs';

export const name = 'approve-race';

const Q = new URLSearchParams();
const call = (env, method, path, opts) =>
    handleAccounts(req(method, path, opts), env, path, Q);

async function bootstrap(hooks) {
    const env = { DB: makeD1(hooks) };
    // an account with one signed-in device
    const created = await (await call(env, 'POST', '/api/account',
        { body: { platform: 'linux', label: 'desktop' } })).json();
    // a second device asks to join
    const newToken = 'tok-' + 'b'.repeat(40);
    const claim = await (await call(env, 'POST', '/api/device/claim',
        { token: newToken, body: { platform: 'android', label: 'phone' } })).json();
    return { env, created, newToken, claim };
}

const deviceCount = (env, accountId) =>
    env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ?')
        .get(accountId).n;
const claimCount = (env) =>
    env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM pairing_claims').get().n;

export async function run(t) {
    // ── sanity: the fixture is what the race needs ───────────────────────────────
    {
        const { env, created, claim } = await bootstrap();
        t.ok(!!created.account_id, 'an account was created');
        t.ok(!!created.device_token, 'with a device token for the approver');
        t.ok(/^\d{6}$/.test(String(claim.code)), 'the joining device got a 6-digit code: '
            + claim.code);
        t.eq(deviceCount(env, created.account_id), 1, 'one device before any approval');
        t.eq(claimCount(env), 1, 'one live pairing claim');
    }

    // ── the race, with no interleaving hook: still must hold ─────────────────────
    {
        const { env, created, claim } = await bootstrap();
        const both = await Promise.all([
            call(env, 'POST', '/api/device/approve',
                 { token: created.device_token, body: { code: claim.code } }),
            call(env, 'POST', '/api/device/approve',
                 { token: created.device_token, body: { code: claim.code } }),
        ]);
        const codes = both.map(r => r.status).sort();
        const bodies = await Promise.all(both.map(r => r.json()));
        t.eq(codes.filter(c => c === 200).length, 1,
             'exactly ONE approval succeeded (statuses: ' + codes.join(', ') + ')');
        t.eq(codes.filter(c => c >= 500).length, 0,
             'and nothing 500ed — the loser got a readable status, not a raw D1 error');
        t.eq(deviceCount(env, created.account_id), 2,
             'the account has exactly 2 devices, not 3 and not a failed insert');
        t.eq(claimCount(env), 0, 'the claim was consumed exactly once');
        /* `codes` is SORTED and `bodies` is not, so indexing one by the other picked the
         * winner's body whenever the second call won, and the assertion failed on
         * correct code. Find the loser by its own status. */
        const loser = bodies[both.findIndex(r => r.status !== 200)];
        t.ok(!!(loser && loser.error), 'the loser carries an error field: '
            + JSON.stringify(loser && loser.error));
    }

    // ── the race, forced to interleave AT THE WINDOW ────────────────────────────
    /* ⛔ THIS IS THE CASE THAT DISTINGUISHES THE TWO IMPLEMENTATIONS, AND THE FIRST
     * VERSION OF IT DID NOT.
     *
     * It parked BEFORE the claim statement, which with a synchronous SQLite engine means
     * caller A never got past its own read — so the sequence degenerated to B-then-A and
     * the case PASSED against the pre-fix handler. Verified by running it against that
     * handler: the only thing that failed was a hit-count assertion of mine.
     *
     * The window is AFTER the statement that reads the claim and BEFORE the write that
     * follows it. Park there and the two implementations diverge:
     *
     *   OLD (SELECT -> issueDevice -> DELETE): A parks holding a live row. B's SELECT
     *        sees the same live row, B mints a device, B deletes. A resumes and calls
     *        issueDevice with the SAME token_hash -> UNIQUE violation on devices, which
     *        the old handler did not catch at all.
     *   NEW (DELETE ... RETURNING -> issueDevice): A's delete has already consumed the
     *        row before it parks. B's delete returns nothing and B 404s. One winner.
     */
    {
        let parked = null, hits = 0, armed = false;
        const CLAIM_READ = (sql) => /pairing_claims/i.test(sql) && /code_hash/i.test(sql)
                                 && !/INSERT/i.test(sql);
        const hooks = {
            after: async (sql) => {
                if (!armed || !CLAIM_READ(sql)) return;
                hits++;
                if (hits === 1) await new Promise(r => { parked = r; });
            },
        };
        const { env, created, claim } = await bootstrap(hooks);
        armed = true;
        const a = call(env, 'POST', '/api/device/approve',
                       { token: created.device_token, body: { code: claim.code } });
        /* ⚠ WAIT ON THE CLOCK, NOT ON A NUMBER OF TURNS. This was 50 setImmediate turns,
         * and the handler reaches the claim only after two SHA-256 digests that run on
         * the thread pool. On a loaded machine 50 turns pass before the first digest
         * returns, and the suite failed with "the hook never fired" on correct code
         * (2026-11-12, load average 7 with a game open). */
        for (let i = 0; i < 3000 && parked === null; i++) await new Promise(r => setTimeout(r, 1));
        t.ok(parked !== null,
             'caller A is parked in the window between reading the claim and writing');
        if (parked === null) throw new Error('the interleave hook never fired — this suite '
            + 'cannot test concurrency without it, and must fail rather than skip');

        const b = call(env, 'POST', '/api/device/approve',
                       { token: created.device_token, body: { code: claim.code } });
        /* Let B run as far as it can get: until it has reached the same statement, or a
         * generous deadline. With the fixed handler B finishes here. */
        for (let i = 0; i < 3000 && hits < 2; i++) await new Promise(r => setTimeout(r, 1));
        t.ok(hits >= 2, 'caller B reached the same point while A was parked (hits: '
            + hits + ') — this is the interleaving a sequential test cannot produce');

        parked();
        const settled = await Promise.allSettled([a, b]);
        const threw = settled.filter(x => x.status === 'rejected');
        t.eq(threw.length, 0, 'neither caller threw out of the handler'
            + (threw.length ? ' [' + threw.map(x => String(x.reason && x.reason.message)).join(' | ') + ']' : ''));
        const st = settled.filter(x => x.status === 'fulfilled').map(x => x.value.status);
        t.eq(st.filter(c => c === 200).length, 1,
             'interleaved at the window: exactly one 200 (' + st.join(', ') + ')');
        t.eq(st.filter(c => c >= 500).length, 0, 'interleaved: no 500');
        t.eq(deviceCount(env, created.account_id), 2, 'interleaved: exactly 2 devices');
        t.eq(claimCount(env), 0, 'interleaved: claim consumed exactly once');
    }

    // ── five at once ─────────────────────────────────────────────────────────────
    {
        const { env, created, claim } = await bootstrap();
        const all = await Promise.all(Array.from({ length: 5 }, () =>
            call(env, 'POST', '/api/device/approve',
                 { token: created.device_token, body: { code: claim.code } })));
        const st = all.map(r => r.status);
        t.eq(st.filter(c => c === 200).length, 1,
             'five concurrent approvals, one winner (' + st.join(', ') + ')');
        t.eq(st.filter(c => c >= 500).length, 0, 'five concurrent approvals, no 500');
        t.eq(deviceCount(env, created.account_id), 2, 'still exactly 2 devices');
    }

    // ── a wrong code must not consume a real claim ───────────────────────────────
    {
        const { env, created, claim } = await bootstrap();
        const wrong = String((Number(claim.code) + 1) % 1000000).padStart(6, '0');
        const r = await call(env, 'POST', '/api/device/approve',
                             { token: created.device_token, body: { code: wrong } });
        t.eq(r.status, 404, 'a wrong code is 404');
        t.eq(claimCount(env), 1,
             'and the REAL claim survives — a delete-first design must not consume the '
             + 'row it did not match');
        const ok = await call(env, 'POST', '/api/device/approve',
                              { token: created.device_token, body: { code: claim.code } });
        t.eq(ok.status, 200, 'so the right code still works afterwards');
    }

    // ── an expired claim ─────────────────────────────────────────────────────────
    {
        const { env, created, claim } = await bootstrap();
        env.DB._sqlite.prepare('UPDATE pairing_claims SET expires_at = ?').run(1);
        const r = await call(env, 'POST', '/api/device/approve',
                             { token: created.device_token, body: { code: claim.code } });
        t.eq(r.status, 404, 'an expired claim is 404');
        t.eq(deviceCount(env, created.account_id), 1, 'and no device was minted');
    }

    // ── unauthenticated ──────────────────────────────────────────────────────────
    {
        const { env, claim } = await bootstrap();
        const r = await call(env, 'POST', '/api/device/approve', { body: { code: claim.code } });
        t.eq(r.status, 401, 'approving without a device token is 401');
        t.eq(claimCount(env), 1, 'and the claim is untouched');
    }

    // ── two DIFFERENT codes approved at once must both work ──────────────────────
    {
        const { env, created, claim: c1 } = await bootstrap();
        const t2 = 'tok-' + 'c'.repeat(40);
        const c2 = await (await call(env, 'POST', '/api/device/claim',
            { token: t2, body: { platform: 'win32' } })).json();
        t.eq(claimCount(env), 2, 'two live claims, for two different joining devices');
        /* Different rows, fired together: both must succeed. A lock that is too coarse
         * would make one of them 404, which is the failure a delete-first fix could
         * introduce. This case used to approve ONE code, sequentially, under this title. */
        const both = await Promise.all([
            call(env, 'POST', '/api/device/approve',
                 { token: created.device_token, body: { code: c1.code } }),
            call(env, 'POST', '/api/device/approve',
                 { token: created.device_token, body: { code: c2.code } }),
        ]);
        const st = both.map(r => r.status);
        t.eq(st.filter(c => c === 200).length, 2,
             'two different codes approved at the same time both succeed (' + st.join(', ') + ')');
        t.eq(deviceCount(env, created.account_id), 3, 'three devices after both approvals');
        t.eq(claimCount(env), 0, 'and both claims were consumed');
    }
}
