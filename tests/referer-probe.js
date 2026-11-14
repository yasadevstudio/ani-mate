// YASA PRESENTS
/* referer-probe.js: ONE measurement, used in two places.
 *
 * The question: when the player asks a video host for a segment and sets the stream's
 * Referer on the request, which Referer does the host actually see?
 *
 *     tests/dom-phone.test.js            runs it in a desktop browser, in a page that has
 *                                        Capacitor's own request patch loaded
 *     scripts/phone-referer-check.js     runs it on a real phone, in the app's own page
 *
 * It asks an address that answers with the headers it received ({"headers":{...}}, the
 * shape httpbin.org/headers uses) four ways:
 *
 *     xhr            XMLHttpRequest GET + setRequestHeader('Referer')     what hls.js does
 *     fetchHeader    fetch(url, { headers: { Referer } })
 *     nativeGet      Capacitor.Plugins.CapacitorHttp.get({ headers })     what the phone's
 *                                                                         second loader does
 *     (and xhr also sets a User-Agent, the one header Capacitor does carry across, so a
 *      header that IS let through is seen next to one that is not)
 *
 * probeBody() is the text of a function body: it is evaluated in the page. Nothing in it
 * may refer to anything outside itself.
 */
'use strict';

const REFERER = 'https://stream.example/player';
const AGENT = 'AniMateRefererProbe/1';

function probeBody(echo, referer) {
    const E = JSON.stringify(echo), R = JSON.stringify(referer || REFERER), A = JSON.stringify(AGENT);
    return `
        const ECHO = ${E}, REF = ${R}, AGENT = ${A}, out = {};
        const native = (f) => /\\[native code\\]/.test(Function.prototype.toString.call(f));
        out.page = location.href;
        out.capacitor = !!(window.Capacitor && window.Capacitor.Plugins);
        out.platform = window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : null;
        out.xhrIsBrowsersOwn = native(window.XMLHttpRequest);
        out.fetchIsBrowsersOwn = native(window.fetch);
        out.secondLoader = typeof window.AniMateNativeHlsLoader;
        const sep = ECHO.indexOf('?') >= 0 ? '&' : '?';
        out.xhr = await new Promise((res) => {
            try {
                const x = new XMLHttpRequest();
                x.open('GET', ECHO + sep + 'via=xhr', true);
                let refused = null;
                try { x.setRequestHeader('Referer', REF); } catch (e) { refused = String(e); }
                try { x.setRequestHeader('User-Agent', AGENT); } catch (e) { /* the browser's own XHR refuses this one too */ }
                x.timeout = 40000;
                x.onload = () => res({ status: x.status, body: x.responseText, refused });
                x.onerror = () => res({ error: 'onerror', refused });
                x.ontimeout = () => res({ error: 'timeout', refused });
                x.send();
            } catch (e) { res({ error: String(e) }); }
        });
        out.fetchHeader = await fetch(ECHO + sep + 'via=fetch-header', { headers: { Referer: REF } })
            .then((r) => r.text().then((t) => ({ status: r.status, body: t }))).catch((e) => ({ error: String(e) }));
        const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
        if (!plugin) out.nativeGet = { error: 'no CapacitorHttp plugin in this page' };
        else {
            try {
                const r = await plugin.get({ url: ECHO + sep + 'via=native', headers: { Referer: REF } });
                out.nativeGet = { status: r.status, body: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
            } catch (e) { out.nativeGet = { error: String(e && e.message || e) }; }
        }
        return out;`;
}

/** One header the echo saw, out of one answer; a sentence when there was no answer. */
function header(answer, name) {
    if (!answer) return '(no answer)';
    if (answer.error) return '(failed: ' + answer.error + ')';
    try {
        const headers = JSON.parse(answer.body).headers || {};
        const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
        return k ? String(headers[k]) : '(none)';
    } catch (e) { return '(unreadable answer, HTTP ' + answer.status + ')'; }
}
const seen = (answer) => header(answer, 'referer');

/** The measurement as lines a person reads. */
function lines(out, referer) {
    const want = referer || REFERER;
    const mark = (v) => (v === want ? '   <- the stream\'s' : '');
    const x = seen(out.xhr), f = seen(out.fetchHeader), n = seen(out.nativeGet);
    return [
        'page                         ' + out.page,
        'Capacitor in the page        ' + out.capacitor + (out.platform ? ' (' + out.platform + ')' : ''),
        'XMLHttpRequest               ' + (out.xhrIsBrowsersOwn ? 'the browser\'s own' : 'replaced (Capacitor\'s patch)'),
        'fetch                        ' + (out.fetchIsBrowsersOwn ? 'the browser\'s own' : 'replaced (Capacitor\'s patch)'),
        'the Referer the player sets  ' + want,
        'ARRIVED, xhr + setRequestHeader      ' + x + mark(x),
        'ARRIVED, fetch + header              ' + f + mark(f),
        'ARRIVED, CapacitorHttp.get           ' + n + mark(n),
        'User-Agent set on the same xhr       ' + header(out.xhr, 'user-agent') + (header(out.xhr, 'user-agent') === AGENT ? '   <- carried across' : ''),
    ];
}

module.exports = { REFERER, AGENT, probeBody, seen, header, lines };
