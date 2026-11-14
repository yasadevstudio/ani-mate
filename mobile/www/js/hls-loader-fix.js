// YASA PRESENTS
// hls-loader-fix.js - Fix HLS.js + CapacitorHttp URL Interception
// CapacitorHttp patches XHR and rewrites response URLs to localhost/_capacitor_http_interceptor_
// This breaks HLS.js relative URL resolution for m3u8 manifests
// Fix: Custom loader that restores original request URL on responses

(function() {
    'use strict';

    // Only apply fix if running inside Capacitor
    if (!window.Capacitor) return;

    // Wait for HLS.js to be available
    function patchHls() {
        if (typeof Hls === 'undefined') return;

        const OriginalLoader = Hls.DefaultConfig.loader;

        class CapacitorFixLoader extends OriginalLoader {
            load(context, config, callbacks) {
                const originalSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function(response, stats, context, networkDetails) {
                    // Restore the original request URL so HLS.js resolves relative paths correctly
                    if (response && context && context.url) {
                        response.url = context.url;
                    }
                    originalSuccess(response, stats, context, networkDetails);
                };
                super.load(context, config, callbacks);
            }
        }

        // Override default loader globally
        Hls.DefaultConfig.loader = CapacitorFixLoader;

        // Store reference for manual use
        window.CapacitorFixLoader = CapacitorFixLoader;
    }

    // Try immediately, and also on DOMContentLoaded
    patchHls();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', patchHls);
    }
})();

/* ── A LOADER THAT CAN SEND A REFERER (2026-11-12) ─────────────────────────────────
 *
 * WHAT THIS IS FOR. Some stream hosts answer 403 unless the request carries the Referer
 * of the page the stream belongs to. The player asked hls.js to add that header with
 * xhrSetup -> xhr.setRequestHeader('Referer', ...).
 *
 * ⚠ WHAT FOLLOWS IS A READING OF CAPACITOR'S OWN CODE (android 8.0.2, the copy in
 * mobile/node_modules), NOT A MEASUREMENT ON A PHONE. Nobody has put a packet capture on
 * a device for this.
 *
 *   native-bridge.js, the XMLHttpRequest patch:
 *     open()              for a GET, rewrites the address to
 *                         https://localhost/_capacitor_http_interceptor_?u=<real address>
 *                         and calls the WebView's REAL open().
 *     setRequestHeader()  once the address is that interceptor address, calls the
 *                         WebView's REAL setRequestHeader(). "Referer" is a header a
 *                         real XMLHttpRequest refuses to set. Before open() there is no
 *                         address yet, the same branch is taken, and the real call
 *                         throws because the request is not open.
 *   WebViewLocalServer.java, handleCapacitorHttpRequest():
 *                         copies the headers of the WebView's request to the real
 *                         request. The Referer among them is the one the WebView chose:
 *                         the app's own page.
 *
 *   By that reading no order of calls can put the stream's Referer on an hls.js request
 *   through XMLHttpRequest on this version of Capacitor.
 *
 * WHAT THIS DOES ABOUT IT. CapacitorHttp.get() called DIRECTLY (not through the patched
 * XMLHttpRequest) is an ordinary native request and takes any header; it is how
 * ani-mate-net.js already fetches subtitle files from the same hosts. This is an hls.js
 * loader built on that call. The player uses it ONLY as a second attempt, after the
 * ordinary loader has failed to get the playlist or a first segment for a stream that
 * came with a referer, so a stream that plays today is not touched by it.
 *
 * Binary data arrives base64-encoded (HttpRequestHandler.java: ARRAY_BUFFER ->
 * readStreamAsBase64) and is decoded here. That costs time and memory per segment, which
 * is the price of the header; it is why this is the fallback and not the default.
 */
(function () {
    'use strict';
    const CapHttp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (!CapHttp) return;

    function fromBase64(b64) {
        const bin = atob(String(b64 || ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    /** @param getReferer () => string, read at request time so one loader class serves
     *                    whatever stream is playing. */
    window.AniMateNativeHlsLoader = function (getReferer) {
        return class NativeRefererLoader {
            constructor(config) {
                this.config = config;
                this.context = null;
                this.callbacks = null;
                this.timer = null;
                this.done = true;
                /* The shape hls.js reads its timing and bandwidth numbers from. */
                this.stats = {
                    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
                    loading: { start: 0, first: 0, end: 0 },
                    parsing: { start: 0, end: 0 },
                    buffering: { start: 0, first: 0, end: 0 },
                };
            }

            destroy() {
                this.finish();
                this.callbacks = null;
                this.config = null;
                this.context = null;
            }

            finish() {
                this.done = true;
                clearTimeout(this.timer);
                this.timer = null;
            }

            abort() {
                const wasLoading = !this.done;
                this.finish();
                if (wasLoading) {
                    this.stats.aborted = true;
                    if (this.callbacks && this.callbacks.onAbort) {
                        this.callbacks.onAbort(this.stats, this.context, null);
                    }
                }
            }

            load(context, config, callbacks) {
                this.context = context;
                this.callbacks = callbacks;
                this.done = false;
                const stats = this.stats;
                const started = self.performance.now();
                stats.loading.start = started;

                const policy = config && config.loadPolicy;
                const limit = (policy && policy.maxLoadTimeMs) || (config && config.timeout) || 20000;
                const binary = context.responseType === 'arraybuffer';

                const headers = Object.assign({}, context.headers || {});
                const referer = getReferer && getReferer();
                if (referer) headers.Referer = referer;
                if (context.rangeEnd) {
                    headers.Range = 'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1);
                }

                this.timer = setTimeout(() => {
                    if (this.done) return;
                    this.finish();
                    callbacks.onTimeout(stats, context, null);
                }, limit);

                CapHttp.get({
                    url: context.url,
                    headers,
                    responseType: binary ? 'arraybuffer' : 'text',
                    connectTimeout: limit,
                    readTimeout: limit,
                }).then((r) => {
                    if (this.done) return;                 // aborted or timed out meanwhile
                    this.finish();
                    const status = Number(r && r.status) || 0;
                    if (status < 200 || status >= 300) {
                        callbacks.onError({ code: status, text: 'HTTP ' + status }, context, null, stats);
                        return;
                    }
                    let data;
                    if (binary) data = fromBase64(r.data);
                    else data = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
                    const size = binary ? data.byteLength : data.length;
                    const now = self.performance.now();
                    /* When the first byte arrived is not something this call reports. If
                     * the whole wait were booked as "time to first byte", hls.js would
                     * read the download as instantaneous and choose the top quality on
                     * any connection. A quarter of the wait, capped, is booked instead. */
                    stats.loading.first = started + Math.min((now - started) / 4, 250);
                    stats.loading.end = now;
                    stats.loaded = stats.total = size;
                    stats.chunkCount = 1;
                    const span = Math.max(1, stats.loading.end - stats.loading.first);
                    stats.bwEstimate = (size * 8000) / span;
                    if (callbacks.onProgress) callbacks.onProgress(stats, context, data, null);
                    callbacks.onSuccess({ url: (r && r.url) || context.url, data, code: status },
                                        stats, context, null);
                }).catch((e) => {
                    if (this.done) return;
                    this.finish();
                    callbacks.onError({ code: 0, text: String((e && e.message) || e) }, context, null, stats);
                });
            }

            getCacheAge() { return null; }
            getResponseHeader() { return null; }
        };
    };
})();
