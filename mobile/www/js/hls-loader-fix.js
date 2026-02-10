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
