// YASA PRESENTS
/* cdp.js: the few lines every browser-driving suite needs, so they are written once.
 *
 *     const page = await require('./cdp').open(CDP, URL);
 *     const n = await page.evalJs('return document.title.length;');
 *     page.thrown        // every uncaught error and unhandled rejection the page has had
 *     await page.intercept('graphql.anilist.co', (request) => ({ status, headers, body }));
 *     page.on('Runtime.bindingCalled', (params) => { ... });      // any protocol event
 *     await page.close();
 *
 * It talks to a Chromium-family browser over its debugging port (the Chrome DevTools
 * Protocol) with nothing but Node's own fetch and WebSocket. scripts/test-dom.js starts
 * that browser with a new empty profile; nothing here attaches to a browser the user has
 * open.
 */
'use strict';

const settle = (ms) => new Promise(r => setTimeout(r, ms));

async function open(cdp, url) {
    const v = await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(4000) });
    if (!v.ok) throw new Error('no browser at ' + cdp + ' (HTTP ' + v.status + ')');
    const tab = await (await fetch(cdp + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let idc = 0;
    const pending = new Map();
    const thrown = [];
    const interceptors = [];
    const listeners = new Map();          // protocol event name -> [handler]
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method && listeners.has(m.method)) {
            for (const fn of listeners.get(m.method)) { try { fn(m.params || {}); } catch (e) { /* a suite's own handler */ } }
        }
        if (m.method === 'Fetch.requestPaused') {
            /* A request the page is making to an address a suite has claimed. The
             * handler answers in its place; with no answer the request goes ahead. */
            const p = m.params;
            const hit = interceptors.find((i) => p.request.url.indexOf(i.part) >= 0);
            Promise.resolve(hit ? hit.handler(p.request) : null).then((ans) => {
                if (!ans) return send('Fetch.continueRequest', { requestId: p.requestId });
                return send('Fetch.fulfillRequest', {
                    requestId: p.requestId, responseCode: ans.status || 200,
                    responseHeaders: ans.headers || [],
                    body: Buffer.from(String(ans.body || ''), 'utf8').toString('base64'),
                });
            }).catch(() => { /* the page went away mid-request */ });
            return;
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = (m.params && m.params.exceptionDetails) || {};
            thrown.push(((d.exception && d.exception.description) || d.text || 'unknown').split('\n')[0]);
        }
        if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id); pending.delete(m.id);
            m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        }
    };
    const send = (method, params = {}) => {
        const id = ++idc;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout: ' + method)); }, 60000);
        });
    };

    /** Run a function body in the page and return what it returns. `userGesture` is on,
     *  so a click or a play() made here counts as the user's, the way a real one would. */
    async function evalJs(body) {
        const r = await send('Runtime.evaluate', {
            expression: '(async () => { ' + body + ' })()',
            awaitPromise: true, returnByValue: true, userGesture: true,
        });
        if (r.exceptionDetails) {
            throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
        }
        return r.result && r.result.value;
    }

    /** Ask until the page answers truthy, or give up. Returns the last answer. */
    async function until(body, ms, every) {
        const stop = Date.now() + (ms || 15000);
        let last = null;
        while (Date.now() < stop) {
            last = await evalJs(body);
            if (last) return last;
            await settle(every || 250);
        }
        return last;
    }

    await send('Runtime.enable');
    /* Loaded AGAIN now that exceptions are recorded, so what it throws while starting
     * up is seen too. */
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await settle(1200);

    /** Answer the page's requests to any address containing `part` with what `handler`
     *  returns ({ status, headers: [{ name, value }], body }). For standing in for a
     *  service a suite must not depend on, or must be able to take away. */
    async function intercept(part, handler) {
        interceptors.push({ part, handler });
        await send('Fetch.enable', { patterns: interceptors.map((i) => ({ urlPattern: '*' + i.part + '*' })) });
    }

    /** Be told about a protocol event, such as a page calling a binding the suite added
     *  with Runtime.addBinding (how a suite stands in for something native). */
    function on(method, handler) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(handler);
    }

    return {
        evalJs, until, send, thrown, settle, intercept, on,
        async close() {
            try { ws.close(); } catch (e) { /* already closed */ }
            try { await fetch(cdp + '/json/close/' + tab.id); } catch (e) { /* tab already gone */ }
        },
    };
}

module.exports = { open, settle };
