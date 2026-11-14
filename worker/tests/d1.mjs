/* A D1 binding backed by real SQLite, for worker tests.
 *
 * ⛔ WHY A REAL ENGINE AND NOT A MOCK. The two things these suites exist to check are a
 * UNIQUE constraint firing and `DELETE ... RETURNING` consuming exactly one row. A hand
 * written mock returns whatever its author expected, so it would confirm the fix by
 * construction and prove nothing. node:sqlite is the same engine D1 runs.
 *
 * The surface mirrors what worker/src/accounts.js actually calls — measured, not guessed:
 *     prepare().bind().first() / .all() / .run()      7 / 7 / 8 uses
 *     prepare().first() with no bind                  used
 *     db.batch([...])                                 2 uses
 *     db.exec(sql)                                    1 use
 *     result.meta.changes                             2 uses
 * Anything else throws by design: an undefined method that resolves to undefined is how
 * a suite passes while the code under test never ran.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, '..');

class Stmt {
    constructor(db, sql, hooks) { this.db = db; this.sql = sql; this.args = []; this.hooks = hooks; }
    bind(...args) { this.args = args; return this; }

    /* Two hook points, and the SECOND one is the one that matters.
     *
     * ⛔ node:sqlite IS SYNCHRONOUS. A statement runs to completion without yielding, so
     * a hook that parks BEFORE the statement cannot reproduce the window the old approve
     * handler lost — caller A would never get past its own SELECT, and the interleave
     * case PASSED against the broken code. The race lives AFTER a read returns and
     * BEFORE the following write lands, which is `after`. */
    async #before() {
        if (this.hooks && this.hooks.before) await this.hooks.before(this.sql, this.args);
    }
    async #after(result) {
        if (this.hooks && this.hooks.after) await this.hooks.after(this.sql, this.args, result);
    }
    #stmt() { return this.db.prepare(this.sql); }

    async first(col) {
        await this.#before();
        const rows = this.#stmt().all(...this.args);
        const r = rows.length ? rows[0] : null;
        await this.#after(r);
        if (r && col !== undefined) return r[col];
        return r;
    }
    async all() {
        await this.#before();
        const results = this.#stmt().all(...this.args);
        await this.#after(results);
        return { results, success: true };
    }
    async run() {
        await this.#before();
        const info = this.#stmt().run(...this.args);
        const out = { success: true,
                      meta: { changes: Number(info.changes || 0),
                              last_row_id: Number(info.lastInsertRowid || 0) } };
        await this.#after(out);
        return out;
    }
}

export function makeD1(hooks) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    /* schema.sql is the deployed schema; migrations/ are applied on top in name order,
     * exactly as they were against the live D1. Reading them rather than restating the
     * DDL means a column added to the real schema cannot be missing here. */
    db.exec(readFileSync(join(WORKER, 'schema.sql'), 'utf8'));
    for (const f of readdirSync(join(WORKER, 'migrations')).sort()) {
        if (!f.endsWith('.sql')) continue;
        try { db.exec(readFileSync(join(WORKER, 'migrations', f), 'utf8')); }
        catch (e) {
            /* A migration that is already folded into schema.sql re-adds a column and
             * errors. That is expected; a missing FILE is not. */
            if (!/duplicate column|already exists/i.test(String(e.message))) throw e;
        }
    }
    return {
        _sqlite: db,
        prepare: (sql) => new Stmt(db, sql, hooks),
        async batch(stmts) {
            const out = [];
            db.exec('BEGIN');
            try {
                for (const s of stmts) out.push(await s.run());
                db.exec('COMMIT');
            } catch (e) { db.exec('ROLLBACK'); throw e; }
            return out;
        },
        async exec(sql) { db.exec(sql); return { count: 0, duration: 0 }; },
    };
}

/** A Request the worker will accept, with a JSON body and an optional bearer token.
 *  It says it speaks sync protocol 2, as the engine does, unless `v` says otherwise
 *  (`v: null` sends none, which is what the first engine did). */
export function req(method, path, { body, token, v = 2 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    if (v !== null && !/[?&]v=/.test(path)) path += (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + v;
    return new Request('https://example.invalid' + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}
