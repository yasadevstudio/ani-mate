// YASA PRESENTS
/**
 * ani-mate-budget.js: how many questions a source will take, kept in ONE place.
 *
 * ⛔ THIS FILE EXISTS BECAUSE THE APP WAS REFUSED BY ITS OWN CATALOG AND READ THE REFUSAL
 * AS "NOTHING FOUND". Measured 2026-11-12 from the developer's machine, with the request
 * the desktop server sends, back to back:
 *
 *     AllAnime  shows (search)          10 answered, the 11th refused: "try again in 8 seconds"
 *     AllAnime  show  (episode list)     6 answered, the 7th refused: "try again in 9 seconds"
 *
 * The two counts are separate: with search used up, an episode list still answered.
 * A refusal is not an HTTP error. It is HTTP 200 and
 *
 *     {"errors":[{"message":"Too many requests, please try again in 8 seconds."}],"data":...}
 *
 * One search in this app spent nine of the ten: the query itself and up to eight lookups
 * for titles AniList knew and AllAnime's list had not returned. So a second search inside
 * ten seconds was refused, the refusal parsed as JSON with no result list, and both apps
 * showed an empty page. Opening a show searches too. "Search came up empty, I tried again
 * and it worked" was this.
 *
 * WHAT IS HERE
 *
 *     create(limits)   a counter per kind of question. ask(kind, send, opts) runs `send`
 *                      when the source will take it:
 *                        need 'user'   someone is watching a spinner. Waits for room,
 *                                      and when the source refuses anyway (its count is
 *                                      per address; another device on the same network
 *                                      spends it too) waits the seconds it names and
 *                                      asks again. Gives up after `patienceMs`.
 *                        need 'spare'  the answer makes a result fuller and the result is
 *                                      whole without it. Asked only while the window has
 *                                      room to spare, never waited for. Resolves null
 *                                      when it was not asked.
 *     memo(opts)       what a source answered, for a few minutes. Searching for a show,
 *                      opening it and opening its next season ask for the same titles
 *                      again and again; this is what keeps that inside the count.
 *
 * ── HOW IT IS LOADED ──────────────────────────────────────────────────────────────────
 * The same arrangement as ani-mate-sync.js and ani-mate-franchise.js, and the same rule:
 *
 *     desktop   require()d by server/ani-mate-server.js
 *     phone     copied into mobile/www/js/ by `npm run sync:shared`, shipped in the APK,
 *               loaded before ani-mate-api.js
 *     node      require()d by tests/budget.test.js
 *
 * > RUN `npm run sync:shared` AFTER ANY EDIT, AND `npm run sync:verify` BEFORE A RELEASE.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AniMateBudget = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* max: what the source was measured to take in one window. spare: how full the window
     * may be for a lookup nobody is waiting on, which leaves the rest for the next thing
     * the user asks. The window is half a second longer than the ten the source's own
     * message implies, so a clock that disagrees slightly errs toward asking late. */
    const ALLANIME = {
        shows: { max: 10, spare: 7, windowMs: 10500 },
        show:  { max: 6,  spare: 4, windowMs: 10500 },
    };

    /* AniList says its limit in a header on every answer: x-ratelimit-limit: 30 (a
     * minute), read 2026-11-12, with x-ratelimit-remaining beside it. A refusal is HTTP
     * 429 with retry-after. Spare lookups stop at 20, which leaves ten a minute for what
     * someone is waiting on. */
    const ANILIST = {
        anilist: { max: 30, spare: 20, windowMs: 61000 },
    };

    /* After a question got no answer at all, how long the spare lookups leave the source
     * alone. A question someone is waiting on is still asked. */
    const QUIET_MS = 30000;

    class Refused extends Error {
        constructor(waitMs) {
            super('rate limited, ' + Math.ceil(waitMs / 1000) + 's to go');
            this.name = 'Refused';
            this.waitMs = waitMs;
        }
    }

    /**
     * The seconds a GraphQL answer asks us to wait, or 0 when it is not a refusal.
     * A refusal that names no number counts as ten.
     */
    function refusalSeconds(json) {
        const errors = json && Array.isArray(json.errors) ? json.errors : [];
        for (const e of errors) {
            const m = String((e && e.message) || '');
            if (!/too many requests/i.test(m)) continue;
            const n = /(\d+)\s*second/i.exec(m);
            return n ? Math.max(1, Number(n[1])) : 10;
        }
        return 0;
    }

    /**
     * @param {Object<string, {max:number, spare:number, windowMs:number}>} limits
     * @param {{ now?: () => number, sleep?: (ms:number) => Promise<void>, patienceMs?: number }} [env]
     *        `now` and `sleep` are the clock, replaceable so the tests do not wait.
     */
    function create(limits, env) {
        const now = (env && env.now) || Date.now;
        const sleep = (env && env.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const patienceMs = (env && env.patienceMs) || 12000;
        const state = {};
        for (const kind of Object.keys(limits)) {
            state[kind] = { max: limits[kind].max, spare: limits[kind].spare,
                            windowMs: limits[kind].windowMs, sent: [], restUntil: 0, quietUntil: 0 };
        }

        /** Milliseconds until the source will take another question of this kind. */
        function wait(kind) {
            const b = state[kind], t = now();
            while (b.sent.length && t - b.sent[0] >= b.windowMs) b.sent.shift();
            let w = Math.max(0, b.restUntil - t);
            if (b.sent.length >= b.max) w = Math.max(w, b.sent[0] + b.windowMs - t);
            return w;
        }

        /**
         * @param {string} kind    a key of `limits`
         * @param {() => Promise<any>} send   makes the request and resolves the parsed
         *        answer; rejects when there was no answer (a timeout, a challenge page)
         * @param {{ need?: string }} [opts]
         * @returns {Promise<any>} the answer, or null for a spare question not asked
         */
        async function ask(kind, send, opts) {
            const b = state[kind];
            if (!b) throw new Error('no budget named ' + kind);
            const spare = !!opts && opts.need === 'spare';
            const deadline = now() + patienceMs;
            let failures = 0;
            for (;;) {
                const w = wait(kind);
                if (spare) {
                    if (w > 0 || b.sent.length >= b.spare || now() < b.quietUntil) return null;
                } else if (w > 0) {
                    if (now() + w > deadline) throw new Refused(w);
                    await sleep(w + 50);
                    continue;
                }
                b.sent.push(now());
                let json;
                try {
                    json = await send();
                } catch (e) {
                    /* No answer at all. Once more for someone who is waiting; never for
                     * a spare lookup. And while the source is not answering, the spare
                     * lookups stop asking it: eight of them each waiting out a timeout
                     * is the slow way to learn what the first one already said. */
                    b.quietUntil = now() + QUIET_MS;
                    if (spare || ++failures > 1 || now() + 1000 > deadline) throw e;
                    await sleep(1000);
                    continue;
                }
                const secs = refusalSeconds(json);
                if (!secs) return json;
                b.restUntil = now() + secs * 1000 + 250;
                if (spare) throw new Refused(secs * 1000);
                /* 'user': the loop waits restUntil out, or gives up past the deadline. */
            }
        }

        /**
         * What the source itself says about its count, when it says (AniList does, in
         * headers). Its number is the truth: it includes what the page, the phone and
         * anything else on this address has sent. If it has fewer left than this
         * counter thinks, the difference is written in as spent now.
         * @param {string} kind
         * @param {{ limit?: number, remaining?: number }} hint
         */
        function note(kind, hint) {
            const b = state[kind];
            if (!b || !hint) return;
            if (hint.limit > 0 && hint.limit !== b.max) {
                b.spare = Math.max(1, Math.round(b.spare * hint.limit / b.max));
                b.max = hint.limit;
            }
            if (typeof hint.remaining === 'number' && hint.remaining >= 0) {
                wait(kind);                                   // drops what has left the window
                const used = b.max - hint.remaining;
                const t = now();
                while (b.sent.length < used) b.sent.push(t);
            }
        }

        return { ask, wait, note, _state: state };
    }

    /**
     * A small memory of answers that are lists of rows.
     * Rows are copied in and out, because callers write on what they are given.
     * @param {{ ttlMs: number, emptyTtlMs: number, keep: number, now?: () => number }} opts
     */
    function memo(opts) {
        const now = opts.now || Date.now;
        const map = new Map();
        const copy = (rows) => rows.map((r) => Object.assign({}, r));
        return {
            /** The remembered rows, or null when there are none or they are too old. */
            recall(key) {
                const hit = map.get(key);
                if (!hit) return null;
                if (now() - hit.at > (hit.rows.length ? opts.ttlMs : opts.emptyTtlMs)) {
                    map.delete(key);
                    return null;
                }
                return copy(hit.rows);
            },
            remember(key, rows) {
                map.delete(key);
                map.set(key, { at: now(), rows: copy(rows) });
                while (map.size > opts.keep) map.delete(map.keys().next().value);
            },
            get size() { return map.size; },
        };
    }

    return { ALLANIME, ANILIST, Refused, refusalSeconds, create, memo };
});
