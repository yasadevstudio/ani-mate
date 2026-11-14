/* Drive the REAL page in a REAL browser and read the DOM.
 *
 *   npm run test:dom
 *
 * That is scripts/test-dom.js: it makes a temp folder of seeded data, starts this repo's
 * server on it and a headless browser with a new empty profile, runs this file, and
 * removes all of it afterwards. Use it.
 *
 * To point this file at a server and a browser of your own instead, set ANIMATE_UI_URL,
 * ANIMATE_CDP and ANIMATE_DATA_DIR. ⚠ Start that browser with its own --user-data-dir.
 * The command that used to be printed here had none: where the browser is already
 * running it hands the address to the running one and exits, so there is no debugging
 * port and a tab has been opened in the user's own session. It also copied the user's
 * real library into /tmp to serve as test data.
 *
 * ⛔ WHY THIS IS NOT OPTIONAL. Three of the 2026-11-09 defects were invisible to every
 * function-level test and showed up only here:
 *
 *   - the season strip drew TWO chips labeled "S1", the second being the final season,
 *     because seasonLabel checked "Part N" before "Final Season"
 *   - "+1 more" HID a season, because BEASTARS FINAL SEASON Part 2 is ONA on AniList
 *   - the page did not render AT ALL after a refactor: a 404 on a new script route left
 *     FR null and the first call threw out of the top-level IIFE
 *
 * A unit test cannot see a label collision, a toggle, or a page that never booted. The
 * shipped code already says as much about a 2026-10-13 state bug: "Caught by driving the
 * real UI — no function-level test can see it."
 *
 * ⚠ SKIPS WITH EXIT 2 when no CDP browser or server is reachable, and says so. It does
 * not report success — a suite that passes when it ran nothing is the exact failure this
 * work was about.
 *
 * ⛔ AND IT REFUSES TO RUN AGAINST THE USER'S OWN DATA DIRECTORY. The favorites half of
 * this suite WRITES. Pointing it at ~/.config/ani-mate/data would star things in a real
 * library.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP = process.env.ANIMATE_CDP || 'http://localhost:9223';
const UI = process.env.ANIMATE_UI_URL || 'http://localhost:7899/';
const DATA = process.env.ANIMATE_DATA_DIR || '';
const REAL_DATA = path.join(os.homedir(), '.config', 'ani-mate', 'data');

let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok    ' + m); }
                       else { fails++; console.log('  FAIL  ' + m); } };
const skip = (why) => {
    console.log('\n  SKIP — ' + why);
    console.log('  This suite is the only one that sees the rendered page. See the header'
              + ' for how to start the two processes it needs.\n');
    process.exit(2);
};

if (DATA && path.resolve(DATA) === path.resolve(REAL_DATA)) {
    console.error('\n  REFUSING TO RUN: ANIMATE_DATA_DIR is the real library at ' + REAL_DATA
        + '.\n  The favorites cases write. Copy the JSON files somewhere disposable.\n');
    process.exit(1);
}

let ws, idc = 0;
const pending = new Map();
/* Everything the page throws while this suite drives it (uncaught errors and unhandled
 * rejections). A handler that throws leaves the DOM exactly as it was, which most
 * DOM assertions read as "nothing changed" and some read as a pass. */
const thrown = [];
const send = (method, params = {}) => {
    const id = ++idc;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout: ' + method)); }, 45000);
    });
};
async function evalJs(expr) {
    const r = await send('Runtime.evaluate', {
        expression: '(async () => { ' + expr + ' })()',
        awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
        throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    }
    return r.result && r.result.value;
}
const settle = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    try { const r = await fetch(UI, { signal: AbortSignal.timeout(4000) });
          if (!r.ok) throw new Error('HTTP ' + r.status); }
    catch (e) { skip('no ANI-MATE server at ' + UI + ' (' + e.message + ')'); }

    let tab;
    try {
        const v = await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(4000) });
        if (!v.ok) throw new Error('HTTP ' + v.status);
        tab = await (await fetch(CDP + '/json/new?' + encodeURIComponent(UI),
                                 { method: 'PUT' })).json();
    } catch (e) { skip('no CDP browser at ' + CDP + ' (' + e.message + ')'); }

    try {
        ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.method === 'Runtime.exceptionThrown') {
                const d = (m.params && m.params.exceptionDetails) || {};
                thrown.push(((d.exception && d.exception.description) || d.text || 'unknown').split('\n')[0]);
            }
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id); pending.delete(m.id);
                m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
            }
        };
        await send('Runtime.enable');
        /* Load the page AGAIN now that exceptions are being recorded, so anything it
         * throws while starting up is seen too. */
        await send('Page.enable');
        await send('Page.reload', { ignoreCache: true });
        await settle(1500);

        for (let i = 0; i < 40; i++) {
            if (await evalJs("return !!document.getElementById('results-container')")) break;
            await settle(400);
        }

        /* ── the page booted at all ──────────────────────────────────────────────── */
        const boot = await evalJs(`
            return {
                container: !!document.getElementById('results-container'),
                /* By CLASS. This asked for an element with the ID player-splash-ver;
                 * there is none (it is a class), so the line below always printed
                 * "(no version element)" and nobody noticed. */
                ver: (document.querySelector('.player-splash-ver') || {}).textContent || '',
                shared: typeof AniMateFranchise !== 'undefined' && !!AniMateFranchise,
                tabs: document.querySelectorAll('[data-tab]').length,
            };`);
        console.log('\n  ' + (boot.ver || '(no version element)').trim()
            + '   shared module loaded: ' + boot.shared);
        ok(boot.container, 'the page rendered its results container');
        ok(boot.shared, 'ani-mate-franchise.js loaded — if this fails the server route is '
            + 'missing and franchise features silently switch off');
        ok(boot.tabs > 0, 'the tab bar rendered (' + boot.tabs + ' tabs)');
        ok(/^v\d+\.\d+\.\d+/.test((boot.ver || '').trim()),
           'the splash states a version: ' + JSON.stringify((boot.ver || '').trim()));
        await settle(1500);
        ok(thrown.length === 0, 'the page threw nothing while starting up'
            + (thrown.length ? ': ' + JSON.stringify(thrown.slice(0, 3)) : ''));

        /* ── FAVS: one card per franchise, and the card is season 1 ──────────────── */
        await evalJs(`
            const t = [...document.querySelectorAll('[data-tab],button,.tab')]
                .find(x => /favs|favorites/i.test(x.textContent || x.dataset.tab || ''));
            if (t) t.click();
            return !!t;`);
        await settle(2500);

        const favs = await evalJs(`
            const c = document.getElementById('results-container');
            return {
                groups: [...c.querySelectorAll('.franchise-group')].map(g => ({
                    fid: g.dataset.franchise,
                    card: (g.querySelector('.franchise-parent .result-title') || {}).textContent,
                    members: [...g.querySelectorAll('.franchise-entry .result-title')]
                               .map(x => x.textContent),
                })),
                loose: [...c.querySelectorAll(':scope > .result-card')]
                         .map(x => (x.querySelector('.result-title') || {}).textContent),
            };`);
        console.log('\n  FAVS: ' + favs.groups.length + ' franchise cards, '
            + favs.loose.length + ' loose');
        for (const g of favs.groups) console.log('    [' + g.members.length + '] ' + g.card);

        ok(favs.groups.length >= 1, 'FAVS groups at least one franchise');

        /* ── text that is markup stays text ──────────────────────────────────────────
         * scripts/test-dom.js seeds a favorite and a history row whose name, id, episode
         * label, mode and franchise id are all pieces of HTML. If any of them is written
         * into the page as HTML, the page gains an <img src="animate-dom-probe"> and its
         * error handler sets window.__probeRan. */
        if (process.env.ANIMATE_DOM_SEEDED === '1') {
            const probe = async (where) => {
                const r = await evalJs(`
                    return { ran: window.__probeRan || 0,
                             imgs: document.querySelectorAll('img[src*="animate-dom-probe"]').length };`);
                ok(r.ran === 0 && r.imgs === 0,
                   where + ': a title, id and label made of markup were drawn as text'
                   + (r.ran || r.imgs ? ' (handler ran: ' + r.ran + ', injected images: ' + r.imgs + ')' : ''));
            };
            ok(favs.loose.some(l => /^Probe <img /.test(l || '')),
               'FAVS shows the seeded row with its markup visible as characters');
            await probe('FAVS');

            const hist = await evalJs(`
                return [...document.querySelectorAll('#history-list .history-item')]
                    .map(x => ({ title: (x.querySelector('.history-title') || {}).textContent,
                                 meta: (x.querySelector('.history-meta') || {}).textContent }));`);
            ok(hist.some(h => /^Probe <img /.test(h.title || '')),
               'WATCH HISTORY shows the seeded row (' + hist.length + ' rows)');
            ok(hist.some(h => /<B>SUB<\/B>/.test(h.meta || '')),
               'and its mode, which is a <b> tag, is shown as characters');
            await probe('WATCH HISTORY');

            await evalJs(`
                const t = document.querySelector('[data-tab="continue"]');
                if (t) t.click();
                return !!t;`);
            await settle(1500);
            const cont = await evalJs(`
                return [...document.querySelectorAll('#results-container .result-card .result-title')]
                    .map(x => x.textContent);`);
            ok(cont.some(t => /^Probe <img /.test(t || '')), 'CONTINUE shows the seeded row (' + cont.length + ' cards)');
            await probe('CONTINUE');

            /* The English-title switch on the search tab called a function that did not
             * exist. Nothing was drawn wrong; the handler simply threw. */
            const before = thrown.length;
            await evalJs(`
                const t = document.querySelector('[data-tab="search"]');
                if (t) t.click();
                const sw = document.getElementById('english-title-toggle');
                sw.click();
                await new Promise(r => setTimeout(r, 300));
                sw.click();
                return true;`);
            await settle(600);
            ok(thrown.length === before, 'the English-title switch on the search tab throws nothing'
                + (thrown.length > before ? ': ' + JSON.stringify(thrown.slice(before)) : ''));

            // back to FAVS for the cases below
            await evalJs(`
                const t = document.querySelector('[data-tab="favs"]');
                if (t) t.click();
                return !!t;`);
            await settle(2000);
        }
        for (const g of favs.groups) {
            ok(!/\b(?:Season\s*[2-9]|[2-9](?:nd|rd|th)\s+Season|Final Season)\b/i.test(g.card || ''),
               'the card is a first season, not a later one: ' + JSON.stringify(g.card));
        }
        const beast = favs.groups.find(g => /beastars/i.test(g.card || ''));
        if (beast) {
            ok(!favs.loose.some(l => /beastars/i.test(l || '')),
               'no loose Beastars card alongside its group');
        }

        /* ── the season strip, from a LATER season ───────────────────────────────── */
        const target = favs.groups.find(g => g.members.length >= 3) || favs.groups[0];
        if (!target) { ok(false, 'no franchise group to open'); throw new Error('nothing to open'); }

        const clicked = await evalJs(`
            const g = [...document.querySelectorAll('.franchise-group')]
                .find(x => (x.querySelector('.franchise-parent .result-title')||{}).textContent
                           === ${JSON.stringify(target.card)});
            if (!g) return null;
            const entries = g.querySelector('.franchise-entries');
            if (entries) entries.style.display = 'block';
            const rows = [...g.querySelectorAll('.franchise-entry')];
            const t = rows[rows.length - 1] || rows[0];     // the LAST season, not the first
            if (!t) return null;
            t.click();
            return (t.querySelector('.result-title')||{}).textContent;`);
        console.log('\n  opened the LAST season of "' + target.card + '": '
            + JSON.stringify(clicked));
        await settle(7000);

        const strip = await evalJs(`
            const nav = document.getElementById('season-nav');
            const el = document.getElementById('season-strip');
            const chips = el ? [...el.querySelectorAll('.season-chip')] : [];
            return {
                navDisplay: nav ? getComputedStyle(nav).display : 'none',
                labels: chips.map(c => (c.querySelector('.chip-eps')
                    ? c.textContent.replace(c.querySelector('.chip-eps').textContent, '')
                    : c.textContent).trim()),
                titles: chips.map(c => c.dataset.title || null),
                active: chips.filter(c => c.classList.contains('active')).length,
                more: chips.filter(c => c.classList.contains('season-more')).length,
                moreText: (chips.find(c => c.classList.contains('season-more')) || {}).textContent || '',
            };`);
        console.log('  nav display: ' + strip.navDisplay + '   chips: '
            + JSON.stringify(strip.labels));

        ok(strip.navDisplay !== 'none',
           'THE SEASON NAV IS VISIBLE from a later season — the reported bug was no nav at all');
        ok(strip.labels.length >= 2, 'the strip has ' + strip.labels.length + ' chips');
        const seasonLabels = strip.labels.filter((l, i) => !strip.titles[i] === false);
        ok(new Set(seasonLabels).size === seasonLabels.length,
           'every chip label is DISTINCT: ' + JSON.stringify(seasonLabels));
        ok(strip.active === 1, 'exactly one chip is marked active (' + strip.active + ')');
        ok(new Set(strip.titles).size === strip.titles.length, 'no season appears twice');

        /* ⛔ "NO '+N MORE'" WAS THE WRONG ASSERTION AND IT FAILED ON CORRECT CODE.
         * The toggle exists for films, OVAs and spinoffs and SHOULD hide them — on Tokyo
         * Revengers it was hiding "Tokyo Revengers: Chibi Reve", an ONA chibi short.
         * The rule is not "hide nothing", it is "never hide something that names itself a
         * season", which is what let BEASTARS FINAL SEASON Part 2 fall off the spine. */
        if (strip.more > 0) {
            const hidden = await evalJs(`
                const el = document.getElementById('season-strip');
                const more = el.querySelector('.season-more');
                if (!more) return [];
                more.click();
                await new Promise(r => setTimeout(r, 600));
                return [...el.querySelectorAll('.season-chip:not(.season-more)')]
                    .map(c => c.dataset.title);`);
            const newly = hidden.filter(t => strip.titles.indexOf(t) < 0);
            console.log('  behind "+' + strip.more + ' more": ' + JSON.stringify(newly));
            const MARKER = /\b(?:\d+\s*(?:st|nd|rd|th)\s+Season|Season\s*\d+|Part\s*\d+|Cour\s*\d+|Final Season)\b/i;
            const wrongly = newly.filter(t => MARKER.test(t || ''));
            ok(wrongly.length === 0,
               'nothing that NAMES itself a season is hidden behind the toggle'
               + (wrongly.length ? ' — hidden: ' + JSON.stringify(wrongly) : ''));
            /* ⛔ AND THE BUTTON MUST DELIVER WHAT IT SAYS. The check above passes on an
             * EMPTY list, which is exactly what a dead button produces: it used to be
             * drawn when every row was already on screen, read "+3 more", revealed
             * nothing, and this suite called that a pass. */
            const promised = parseInt((strip.moreText.match(/\+(\d+)/) || [])[1], 10) || 0;
            ok(promised > 0 && newly.length === promised,
               '"' + strip.moreText.trim() + '" revealed exactly ' + promised
               + ' more (it revealed ' + newly.length + ')');
        } else {
            ok(true, 'nothing is behind a "+N more" toggle');
        }

        /* ── navigate to another season, and the nav survives ───────────────────── */
        const jumped = await evalJs(`
            const el = document.getElementById('season-strip');
            const other = [...el.querySelectorAll('.season-chip:not(.season-more)')]
                .find(c => !c.classList.contains('active'));
            if (!other) return null;
            const want = other.dataset.title;
            other.click();
            return want;`);
        await settle(7000);
        const after = await evalJs(`
            const el = document.getElementById('season-strip');
            const chips = el ? [...el.querySelectorAll('.season-chip')] : [];
            return {
                active: (chips.find(c => c.classList.contains('active')) || { dataset: {} })
                          .dataset.title,
                count: chips.length,
                navDisplay: (n => n ? getComputedStyle(n).display : 'none')
                            (document.getElementById('season-nav')),
            };`);
        console.log('  jumped to ' + JSON.stringify(jumped) + ' -> active '
            + JSON.stringify(after.active) + ', ' + after.count + ' chips');
        ok(after.active === jumped, 'clicking a chip navigated to that season');
        ok(after.navDisplay !== 'none' && after.count === strip.labels.length,
           'and the nav is STILL complete on the season we landed on — '
           + '"navigate to any season from any season"');

        /* ── the star is a FRANCHISE action ──────────────────────────────────────── */
        /* Writes, which is why the real data directory is refused above. */
        const before = await evalJs("const d = await (await fetch('/favorites')).json();"
                                  + " return (d.favorites || []).length;");
        const starred = await evalJs(`
            const tb = [...document.querySelectorAll('[data-tab],button,.tab')]
                .find(x => /search/i.test(x.textContent || x.dataset.tab || ''));
            if (tb) tb.click();
            const box = document.getElementById('search-input')
                     || document.querySelector('input[type=search], input[type=text]');
            if (!box) return { err: 'no search box' };
            box.value = 'mushoku tensei';
            box.dispatchEvent(new Event('input', { bubbles: true }));
            const form = box.closest('form');
            if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            else box.dispatchEvent(new KeyboardEvent('keydown',
                     { key: 'Enter', keyCode: 13, bubbles: true }));
            return { ok: true };`);
        if (starred.err) {
            ok(false, 'could not reach the search box: ' + starred.err);
        } else {
            await settle(12000);
            const found = await evalJs(`
                const c = document.getElementById('results-container');
                const star = c.querySelector('.fav-star:not(.active)');
                if (!star) return { err: 'no unstarred result to click' };
                const name = star.dataset.favName;
                star.click();
                return { name };`);
            if (found.err) {
                console.log('  (search returned nothing starrable — upstream flake)');
            } else {
                await settle(15000);
                const now = await evalJs("const d = await (await fetch('/favorites')).json();"
                                       + " return (d.favorites || []).length;");
                console.log('\n  starred "' + found.name + '": favorites ' + before
                    + ' -> ' + now);
                ok(now > before, 'starring wrote to favorites');
                ok(now - before >= 2, 'ONE tap starred MULTIPLE seasons (' + (now - before)
                    + ' added) — "it should fav all seasons of it, not just one"');
            }
        }
        /* ── CLEAR HISTORY, last, because it empties what the cases above read ────── */
        if (process.env.ANIMATE_DOM_SEEDED === '1') {
            const cleared = await evalJs(`
                window.confirm = () => true;
                const had = (await (await fetch('/history')).json()).forge.length;
                document.getElementById('clear-history-btn').click();
                await new Promise(r => setTimeout(r, 1500));
                const left = (await (await fetch('/history')).json()).forge.length;
                const asGet = (await fetch('/history/clear')).status;
                return { had, left, asGet,
                         panel: (document.querySelector('#history-list .no-results') || {}).textContent || '' };`);
            ok(cleared.had > 0 && cleared.left === 0,
               'CLEAR HISTORY emptied the history on the server (' + cleared.had + ' -> ' + cleared.left + ')');
            ok(/No watch history/i.test(cleared.panel), 'and the panel says so');
            ok(cleared.asGet !== 200,
               'the same address as a GET clears nothing (HTTP ' + cleared.asGet + ')');
        }

        ok(thrown.length === 0, 'the page threw nothing during the whole run'
            + (thrown.length ? ': ' + JSON.stringify(thrown.slice(0, 5)) : ''));
    } catch (e) {
        ok(false, 'THREW: ' + (e && e.message || e));
    } finally {
        try { ws && ws.close(); } catch (e) { /* closing a closed socket */ }
        try { await fetch(CDP + '/json/close/' + tab.id); } catch (e) { /* tab already gone */ }
    }

    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    process.exit(fails ? 1 : 0);
})();
