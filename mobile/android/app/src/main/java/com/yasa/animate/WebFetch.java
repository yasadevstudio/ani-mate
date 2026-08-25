package com.yasa.animate;

import android.annotation.SuppressLint;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * WebFetch — fetch a URL through Android's own WebView instead of OkHttp.
 *
 * WHY THIS EXISTS (2026-08-25)
 *   Every source ANI-MATE can use is gated behind a browser check. Measured this day:
 *     anidb.app          403 Cloudflare "Just a moment..."
 *     api.allanime.day   403 Cloudflare "Just a moment..."
 *     animepahe.su       200 DDoS-Guard interstitial, not the payload
 *     animeheaven.me     200 real page, results rendered by JS
 *   Headers change nothing — a Firefox agent, an Android Chrome agent and full
 *   Accept/Referer headers all return the same interstitial. Cloudflare is checking the
 *   TLS and HTTP/2 fingerprint, which no plain HTTP client reproduces.
 *
 *   Desktop solved this in v0.4.5 with Electron's net module on session.defaultSession.
 *   CapacitorHttp is OkHttp and gets the same 403 curl does, so that fix could never
 *   have worked on Android. This is the Android equivalent.
 *
 * HOW IT WORKS
 *   1. Navigate an off-screen WebView to the URL's ORIGIN. That is what clears the
 *      challenge, and the shared CookieManager keeps cf_clearance afterwards, so only
 *      the first request per host pays for it.
 *   2. Run fetch() from inside that page. Same-origin, so no CORS, and — unlike
 *      navigating straight at a JSON endpoint — no risk of the WebView treating an
 *      application/json response as a download instead of a document.
 *   3. If the in-page fetch fails (some hosts refuse XHR from their own origin),
 *      fall back to navigating directly and reading the rendered document.
 *
 * Returns { status, body, finalUrl, mode } where mode is "fetch" or "navigate".
 */
@CapacitorPlugin(name = "WebFetch")
public class WebFetch extends Plugin {

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/126.0.0.0 Mobile Safari/537.36";

    private static final int DEFAULT_TIMEOUT_MS = 25000;
    private static final int POLL_MS = 400;

    @PluginMethod
    @SuppressLint("SetJavaScriptEnabled")
    public void fetch(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url parameter");
            return;
        }
        final boolean wantHtml = Boolean.TRUE.equals(call.getBoolean("html", false));
        final int timeoutMs = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        final String referer = call.getString("referer");

        final String origin;
        try {
            java.net.URL u = new java.net.URL(url);
            origin = u.getProtocol() + "://" + u.getHost() + "/";
        } catch (Exception e) {
            call.reject("Bad url: " + url);
            return;
        }

        getActivity().runOnUiThread(() -> {
            final AtomicBoolean done = new AtomicBoolean(false);
            final Handler handler = new Handler(Looper.getMainLooper());
            final WebView wv = new WebView(getContext());
            final boolean[] triedInPageFetch = { false };

            WebSettings s = wv.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setUserAgentString(UA);
            s.setBlockNetworkImage(true);
            s.setLoadsImagesAutomatically(false);
            s.setMediaPlaybackRequiresUserGesture(true);

            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setAcceptThirdPartyCookies(wv, true);

            final Runnable destroy = () -> {
                try { wv.stopLoading(); wv.destroy(); } catch (Throwable ignored) { }
            };

            final Finisher finish = (status, body, mode) -> {
                if (!done.compareAndSet(false, true)) return;
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", body == null ? "" : body);
                r.put("finalUrl", wv.getUrl() == null ? url : wv.getUrl());
                r.put("mode", mode);
                destroy.run();
                call.resolve(r);
            };

            // Hard stop. Without this a host that never finishes loading hangs the call.
            handler.postDelayed(() -> finish.done(0, "", "timeout"), timeoutMs);

            final Runnable[] poll = new Runnable[1];
            poll[0] = () -> {
                if (done.get()) return;
                // Is the challenge still up? Read title + a slice of text to decide.
                wv.evaluateJavascript(
                    "(function(){try{return JSON.stringify({t:document.title||''," +
                    "b:(document.body?document.body.innerText:'').slice(0,600)});}" +
                    "catch(e){return JSON.stringify({t:'',b:''});}})()",
                    value -> {
                        if (done.get()) return;
                        String probe = unwrap(value);
                        boolean challenge =
                            probe.contains("Just a moment") ||
                            probe.contains("Attention Required") ||
                            probe.contains("Checking your browser") ||
                            probe.contains("Verifying you are human") ||
                            probe.contains("DDoS-Guard");

                        if (challenge) {                       // still interstitial — wait
                            handler.postDelayed(poll[0], POLL_MS);
                            return;
                        }

                        if (!triedInPageFetch[0]) {
                            triedInPageFetch[0] = true;
                            // Same-origin fetch from inside the cleared page.
                            String js =
                                "(async function(){try{" +
                                "var r=await fetch(" + jsStr(url) + ",{credentials:'include'," +
                                "headers:{'Accept':" + jsStr(wantHtml
                                    ? "text/html,application/xhtml+xml,*/*;q=0.8"
                                    : "application/json, text/plain, */*") + "}});" +
                                "var t=await r.text();" +
                                "return JSON.stringify({ok:true,s:r.status,b:t});" +
                                "}catch(e){return JSON.stringify({ok:false,s:0,b:''});}})()";
                            wv.evaluateJavascript(js, res -> {
                                if (done.get()) return;
                                String inner = unwrap(res);
                                int st = 0;
                                String body = "";
                                boolean ok = false;
                                try {
                                    org.json.JSONObject o = new org.json.JSONObject(inner);
                                    ok = o.optBoolean("ok", false);
                                    st = o.optInt("s", 0);
                                    body = o.optString("b", "");
                                } catch (Throwable ignored) { }

                                if (ok && st >= 200 && st < 400 && body.length() > 0) {
                                    finish.done(st, body, "fetch");
                                } else {
                                    // Host refused the in-page request — navigate at it
                                    // directly and read whatever renders.
                                    Map<String, String> h2 = new HashMap<>();
                                    h2.put("Accept", wantHtml
                                        ? "text/html,application/xhtml+xml,*/*;q=0.8"
                                        : "application/json, text/plain, */*");
                                    h2.put("Accept-Language", "en-US,en;q=0.9");
                                    if (referer != null && !referer.isEmpty()) h2.put("Referer", referer);
                                    wv.loadUrl(url, h2);
                                    handler.postDelayed(poll[0], POLL_MS * 2);
                                }
                            });
                            return;
                        }

                        // Fallback path: we navigated directly, read the document.
                        String extractor = wantHtml
                            ? "document.documentElement.outerHTML"
                            : "(document.body?document.body.innerText:'')";
                        wv.evaluateJavascript("(function(){try{return " + extractor +
                                              ";}catch(e){return '';}})()", docVal -> {
                            if (done.get()) return;
                            String doc = unwrapRaw(docVal);
                            if (doc != null && doc.trim().length() > 0) finish.done(200, doc, "navigate");
                            else handler.postDelayed(poll[0], POLL_MS);
                        });
                    });
            };

            wv.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String u) {
                    handler.postDelayed(poll[0], POLL_MS);
                }
            });

            Map<String, String> headers = new HashMap<>();
            headers.put("Accept-Language", "en-US,en;q=0.9");
            if (referer != null && !referer.isEmpty()) headers.put("Referer", referer);
            wv.loadUrl(origin, headers);
        });
    }

    /** Drop challenge cookies so the next request re-solves from scratch. */
    @PluginMethod
    public void clearCookies(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            call.resolve();
        });
    }

    // evaluateJavascript hands back a JSON-encoded value. Unwrap one level to the
    // inner JSON text; on anything unexpected return "" so callers just retry.
    private static String unwrap(String value) {
        String r = unwrapRaw(value);
        return r == null ? "" : r;
    }

    private static String unwrapRaw(String value) {
        if (value == null || value.equals("null")) return null;
        try {
            Object o = new org.json.JSONTokener(value).nextValue();
            return o == null ? null : o.toString();
        } catch (Throwable t) {
            return value;
        }
    }

    /** Quote a Java string as a JS string literal. */
    private static String jsStr(String s) {
        return org.json.JSONObject.quote(s == null ? "" : s);
    }

    private interface Finisher {
        void done(int status, String body, String mode);
    }
}
