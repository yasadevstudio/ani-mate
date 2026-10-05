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
 * WHY (measured 2026-08-25, on this machine, through Chromium):
 *   anidb.app answers 200 to a request from Chromium's network stack and 403 to every
 *   plain HTTP client — curl with a Firefox agent, curl with an Android Chrome agent,
 *   curl with full Accept/Referer headers all get the same 5.8 KB interstitial. There is
 *   no challenge to solve and no cookie to obtain; the gate is the TLS/HTTP2 fingerprint.
 *   CapacitorHttp is OkHttp, so it cannot pass. A Chromium WebView can, and does.
 *
 *   Proven before this class was written, by running the exact chain in a Chromium
 *   renderer with an Android user agent:
 *     origin load                              200, title "AniDB — Watch Anime Online..."
 *     fetch /api/frontend/anime/3880/episodes  200, 64,723 bytes, 1,175 episodes
 *     fetch /browse?q=one%20piece              200, 115,316 bytes
 *     fetch /api/frontend/episode/3512/languages 200, embed_url for eng and jpn
 *
 * HOW
 *   Navigate an off-screen WebView to the URL's origin, then run fetch() from inside that
 *   page. Same-origin, so no CORS, and no risk of the WebView treating a JSON response as
 *   a download the way navigating straight at the endpoint can.
 *
 * THE TRAP THIS CLASS EXISTS TO AVOID
 *   evaluateJavascript() does NOT await promises. Handing it an async IIFE returns the
 *   Promise's stringification, never the resolved value — which is exactly how the first
 *   version of this plugin failed: every fetch appeared to return nothing, the code fell
 *   through to direct navigation, and every request timed out. The async result is
 *   therefore parked on window.__wf and collected by a later synchronous read.
 */
@CapacitorPlugin(name = "WebFetch")
public class WebFetch extends Plugin {

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/126.0.0.0 Mobile Safari/537.36";

    private static final int DEFAULT_TIMEOUT_MS = 25000;
    private static final int POLL_MS = 250;

    @PluginMethod
    @SuppressLint("SetJavaScriptEnabled")
    public void fetch(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("Missing url parameter"); return; }

        final int timeoutMs = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        final String referer = call.getString("referer");

        final String origin;
        try {
            java.net.URL u = new java.net.URL(url);
            origin = u.getProtocol() + "://" + u.getHost() + "/";
        } catch (Exception e) { call.reject("Bad url: " + url); return; }

        getActivity().runOnUiThread(() -> {
            final AtomicBoolean done = new AtomicBoolean(false);
            final Handler handler = new Handler(Looper.getMainLooper());
            final WebView wv = new WebView(getContext());
            final boolean[] started = { false };
            final long deadline = System.currentTimeMillis() + timeoutMs;

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

            final Finisher finish = (status, body, mode) -> {
                if (!done.compareAndSet(false, true)) return;
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", body == null ? "" : body);
                r.put("finalUrl", wv.getUrl() == null ? url : wv.getUrl());
                r.put("mode", mode);
                try { wv.stopLoading(); wv.destroy(); } catch (Throwable ignored) { }
                call.resolve(r);
            };

            handler.postDelayed(() -> finish.done(0, "", "timeout"), timeoutMs);

            final Runnable[] pump = new Runnable[1];
            pump[0] = () -> {
                if (done.get()) return;
                if (System.currentTimeMillis() > deadline) { finish.done(0, "", "timeout"); return; }

                if (!started[0]) {
                    started[0] = true;
                    // Kick the fetch off and PARK the result on window.__wf.
                    // Nothing is returned here — evaluateJavascript cannot await.
                    String kick =
                        "window.__wf=null;" +
                        "(function(){fetch(" + jsStr(url) + ",{credentials:'include'})" +
                        ".then(function(r){return r.text().then(function(t){" +
                        "window.__wf=JSON.stringify({s:r.status,b:t});});})" +
                        ".catch(function(e){window.__wf=JSON.stringify({s:0,b:'',e:String(e)});});})();";
                    wv.evaluateJavascript(kick, null);
                    handler.postDelayed(pump[0], POLL_MS);
                    return;
                }

                // Synchronous read of the parked result. This is the part that works.
                // Three states must be distinguished, and "null" alone cannot do it:
                //   __none__  the kick never ran, or a navigation wiped the window —
                //             re-kick, otherwise this polls until the deadline for nothing
                //   __wait__  in flight
                //   anything else — the result
                wv.evaluateJavascript(
                    "(typeof window.__wf==='undefined')?'__none__':" +
                    "(window.__wf===null?'__wait__':window.__wf)", value -> {
                    if (done.get()) return;
                    String inner = unwrap(value);
                    if ("__none__".equals(inner)) {
                        started[0] = false;                          // navigation ate it; start over
                        handler.postDelayed(pump[0], POLL_MS);
                        return;
                    }
                    if (inner == null || inner.isEmpty() || "__wait__".equals(inner)) {
                        handler.postDelayed(pump[0], POLL_MS);      // still in flight
                        return;
                    }
                    int st = 0; String body = "";
                    try {
                        org.json.JSONObject o = new org.json.JSONObject(inner);
                        st = o.optInt("s", 0);
                        body = o.optString("b", "");
                    } catch (Throwable ignored) { }

                    if (st >= 200 && st < 400 && body.length() > 0) {
                        finish.done(st, body, "fetch");
                    } else {
                        // The origin answered but the endpoint did not. Report it rather
                        // than retrying blind — the caller's chain decides what happens next.
                        finish.done(st, body, "fetch");
                    }
                });
            };

            wv.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String u) {
                    handler.postDelayed(pump[0], POLL_MS);
                }
                @Override public void onReceivedError(WebView view,
                        android.webkit.WebResourceRequest req, android.webkit.WebResourceError err) {
                    // A 403 interstitial reports as a failed load while its script still
                    // runs, so this is never treated as fatal — the pump decides.
                    if (req != null && req.isForMainFrame()) handler.postDelayed(pump[0], POLL_MS * 4);
                }
            });

            Map<String, String> headers = new HashMap<>();
            headers.put("Accept-Language", "en-US,en;q=0.9");
            if (referer != null && !referer.isEmpty()) headers.put("Referer", referer);
            wv.loadUrl(origin, headers);
        });
    }

    /** Drop cookies so a challenged host re-solves from scratch. */
    @PluginMethod
    public void clearCookies(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            call.resolve();
        });
    }

    /** evaluateJavascript hands back a JSON-encoded value; unwrap one level. */
    private static String unwrap(String value) {
        if (value == null || value.equals("null")) return null;
        try {
            Object o = new org.json.JSONTokener(value).nextValue();
            return o == null ? null : o.toString();
        } catch (Throwable t) { return value; }
    }

    private static String jsStr(String s) {
        return org.json.JSONObject.quote(s == null ? "" : s);
    }

    private interface Finisher { void done(int status, String body, String mode); }
}
