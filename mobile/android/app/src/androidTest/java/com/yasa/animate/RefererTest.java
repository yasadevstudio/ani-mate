// YASA PRESENTS
package com.yasa.animate;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * WHICH REFERER ACTUALLY LEAVES THE PHONE. A measurement, on a real Android WebView with
 * Capacitor's own bridge in it.
 *
 * WHY THIS TEST EXISTS
 *   Video hosts refuse a segment request that does not carry their player page as its
 *   Referer. On the phone the player (hls.js) asks for segments with XMLHttpRequest and
 *   calls setRequestHeader('Referer', ...). Whether that header survives was argued from
 *   a reading of Capacitor's source on 2026-11-12, twice, with two different answers,
 *   and never measured. This is the measurement.
 *
 * WHAT IT DOES
 *   Starts the app's real activity (so the WebView is the one Capacitor configures, with
 *   CapacitorHttp enabled exactly as capacitor.config.json says), then asks an address
 *   that answers with the headers it received, four ways:
 *
 *     xhr            XMLHttpRequest GET + setRequestHeader('Referer')   what hls.js does
 *     fetchHeader    fetch(url, { headers: { Referer } })
 *     fetchReferrer  fetch(url, { referrer, referrerPolicy: 'unsafe-url' })
 *     native         Capacitor.Plugins.CapacitorHttp.get({ headers: { Referer } })
 *                    what window.AniMateNativeHlsLoader (hls-loader-fix.js) does
 *
 *   and reports, for each, the Referer the far end saw. It asserts only that the
 *   measurement happened; the answer is printed, because the answer is the point:
 *
 *     adb shell am instrument -w -e class com.yasa.animate.RefererTest \
 *         com.yasa.animate.test/androidx.test.runner.AndroidJUnitRunner
 *     adb logcat -d -s RefererTest
 *
 *   The echo address is https://httpbin.org/headers, or the `echo` argument. It has to be
 *   HTTPS: the app does not allow cleartext, so a server on the development machine
 *   cannot be used. Nothing of the user's is sent; the test header is a made-up address.
 *
 *   `-e echo local` uses an echo inside this test instead (for a device with no network).
 *   That one is plain HTTP on 127.0.0.1, so it only works in a build that permits
 *   cleartext to the loopback address. This app's builds do not.
 *
 *   THE EASIER WAY, since 2026-11-14: scripts/phone-referer-check.js runs the same
 *   measurement in the app's page on a phone, in a build signed with the release key
 *   (scripts/build-phone-signed.sh --inspect), so nothing has to be uninstalled. This
 *   test needs a debug build, which a phone that has the released app will not take.
 */
@RunWith(AndroidJUnit4.class)
public class RefererTest {

    private static final String TAG = "RefererTest";
    private static final String REFERER = "https://stream.example/player";

    private static String script(String echo) {
        String q = org.json.JSONObject.quote(echo);
        String r = org.json.JSONObject.quote(REFERER);
        return "window.__rt=null;(async function(){var ECHO=" + q + ",REF=" + r + ",out={};"
            + "out.origin=location.origin;"
            + "out.native=!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());"
            + "out.httpPlugin=!!(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.CapacitorHttp);"
            + "out.xhrIsNative=/\\[native code\\]/.test(Function.prototype.toString.call(window.XMLHttpRequest));"
            + "out.fetchIsNative=/\\[native code\\]/.test(Function.prototype.toString.call(window.fetch));"
            + "out.secondLoader=typeof window.AniMateNativeHlsLoader;"
            + "out.xhr=await new Promise(function(res){try{var x=new XMLHttpRequest();x.open('GET',ECHO+'?via=xhr',true);"
            + "var se=null;try{x.setRequestHeader('Referer',REF);}catch(e){se=String(e);}"
            + "x.timeout=40000;x.onload=function(){res({status:x.status,body:x.responseText,setError:se});};"
            + "x.onerror=function(){res({error:'onerror',setError:se});};x.ontimeout=function(){res({error:'timeout',setError:se});};"
            + "x.send();}catch(e){res({error:String(e)});}});"
            + "out.fetchHeader=await fetch(ECHO+'?via=fetch-header',{headers:{Referer:REF}})"
            + ".then(function(r){return r.text().then(function(t){return{status:r.status,body:t};});}).catch(function(e){return{error:String(e)};});"
            + "out.fetchReferrer=await fetch(ECHO+'?via=fetch-referrer',{referrer:REF,referrerPolicy:'unsafe-url'})"
            + ".then(function(r){return r.text().then(function(t){return{status:r.status,body:t};});}).catch(function(e){return{error:String(e)};});"
            + "try{out.nativeGet=await window.Capacitor.Plugins.CapacitorHttp.get({url:ECHO+'?via=native',headers:{Referer:REF}})"
            + ".then(function(r){return{status:r.status,body:typeof r.data==='string'?r.data:JSON.stringify(r.data)};});}"
            + "catch(e){out.nativeGet={error:String(e)};}"
            + "window.__rt=JSON.stringify(out);})().catch(function(e){window.__rt=JSON.stringify({fatal:String(e)});});";
    }

    /** A one-purpose HTTP server: answers every request with the headers it received, in
     *  the shape httpbin does ({"headers":{...}}), and allows any page to read the answer. */
    private static java.net.ServerSocket startLocalEcho() throws Exception {
        final java.net.ServerSocket server = new java.net.ServerSocket(0, 16, java.net.InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try (java.net.Socket sock = server.accept()) {
                    java.io.BufferedReader in = new java.io.BufferedReader(
                        new java.io.InputStreamReader(sock.getInputStream(), java.nio.charset.StandardCharsets.ISO_8859_1));
                    String first = in.readLine();
                    org.json.JSONObject headers = new org.json.JSONObject();
                    String line;
                    while ((line = in.readLine()) != null && line.length() > 0) {
                        int c = line.indexOf(':');
                        if (c > 0) headers.put(line.substring(0, c).trim(), line.substring(c + 1).trim());
                    }
                    boolean preflight = first != null && first.startsWith("OPTIONS");
                    byte[] body = (preflight ? "" : new org.json.JSONObject().put("headers", headers).put("line", first).toString())
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    String head = "HTTP/1.1 " + (preflight ? "204 No Content" : "200 OK") + "\r\n"
                        + "Content-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n"
                        + "Access-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\n"
                        + "Content-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
                    java.io.OutputStream out = sock.getOutputStream();
                    out.write(head.getBytes(java.nio.charset.StandardCharsets.ISO_8859_1));
                    out.write(body);
                    out.flush();
                } catch (Throwable ignored) { /* the next request gets its own try */ }
            }
        }, "referer-echo");
        t.setDaemon(true);
        t.start();
        return server;
    }

    /** The Referer the echo saw, out of one of the four answers. */
    private static String refererOf(org.json.JSONObject answer) {
        if (answer == null) return "(no answer)";
        if (answer.has("error")) {
            return "(failed: " + answer.optString("error") + (answer.isNull("setError") ? "" : ", setRequestHeader threw " + answer.optString("setError")) + ")";
        }
        try {
            org.json.JSONObject headers = new org.json.JSONObject(answer.optString("body")).getJSONObject("headers");
            java.util.Iterator<String> it = headers.keys();
            while (it.hasNext()) {
                String k = it.next();
                if (k.equalsIgnoreCase("referer")) return headers.getString(k);
            }
            return "(none)";
        } catch (Throwable t) {
            return "(unreadable answer, HTTP " + answer.optInt("status") + ")";
        }
    }

    @Test
    public void whichRefererLeavesThePhone() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String wanted = args.getString("echo", "https://httpbin.org/headers");
        java.net.ServerSocket local = null;
        if ("local".equals(wanted)) {
            local = startLocalEcho();
            wanted = "http://127.0.0.1:" + local.getLocalPort() + "/headers";
        }
        final String echo = wanted;
        final long limitMs = Long.parseLong(args.getString("limitMs", "240000"));
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<String> out = new AtomicReference<>(null);
        final AtomicReference<String> note = new AtomicReference<>("the activity never gave up its WebView");
        final Handler main = new Handler(Looper.getMainLooper());

        /* Named by the APP's package, not by class alone: left to work the package out,
         * the launcher asked for com.yasa.animate.test/...MainActivity, which is this
         * test's own package and has no such activity. */
        android.content.Intent start = new android.content.Intent(android.content.Intent.ACTION_MAIN)
            .setClassName(InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName(),
                          MainActivity.class.getName());
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(start)) {
            final long deadline = System.currentTimeMillis() + limitMs;
            final WebView[] holder = new WebView[1];
            final boolean[] kicked = { false };
            final Runnable[] pump = new Runnable[1];
            pump[0] = () -> {
                if (latch.getCount() == 0) return;
                if (System.currentTimeMillis() > deadline) { latch.countDown(); return; }
                WebView wv = holder[0];
                if (wv == null) { main.postDelayed(pump[0], 500); return; }
                if (!kicked[0]) {
                    // Wait until Capacitor's bridge is in the page; before that the patch is not there either.
                    wv.evaluateJavascript("(!!(window.Capacitor&&window.Capacitor.Plugins))+'|'+document.readyState", v -> {
                        note.set("waiting for the page: " + v);
                        if (v != null && v.contains("true|") && (v.contains("complete") || v.contains("interactive"))) {
                            kicked[0] = true;
                            wv.evaluateJavascript(script(echo), null);
                        }
                        main.postDelayed(pump[0], 700);
                    });
                    return;
                }
                wv.evaluateJavascript("(typeof window.__rt==='undefined')?'__none__':(window.__rt===null?'__wait__':window.__rt)", value -> {
                    if (latch.getCount() == 0) return;
                    String inner;
                    try {
                        Object o = new org.json.JSONTokener(value).nextValue();
                        inner = o == null ? null : o.toString();
                    } catch (Throwable t) { inner = value; }
                    if (inner == null || "__wait__".equals(inner)) { note.set("the four requests are out"); main.postDelayed(pump[0], 700); return; }
                    if ("__none__".equals(inner)) { kicked[0] = false; main.postDelayed(pump[0], 700); return; }   // the page reloaded
                    out.set(inner);
                    latch.countDown();
                });
            };
            scenario.onActivity(activity -> {
                try { holder[0] = activity.getBridge().getWebView(); }
                catch (Throwable t) { note.set("no bridge: " + t); }
                main.postDelayed(pump[0], 1500);
            });
            latch.await(limitMs + 10000, TimeUnit.MILLISECONDS);
        }

        if (local != null) { try { local.close(); } catch (Throwable ignored) { /* closing */ } }
        String raw = out.get();
        assertNotNull("No measurement: " + note.get(), raw);
        org.json.JSONObject j = new org.json.JSONObject(raw);
        assertTrue("The page failed before measuring: " + raw, !j.has("fatal"));

        StringBuilder sb = new StringBuilder();
        sb.append("echo: ").append(echo).append('\n');
        sb.append("sent Referer: ").append(REFERER).append('\n');
        sb.append("page origin: ").append(j.optString("origin")).append('\n');
        sb.append("native platform: ").append(j.optBoolean("native")).append(", CapacitorHttp plugin: ").append(j.optBoolean("httpPlugin")).append('\n');
        sb.append("XMLHttpRequest is the browser's own: ").append(j.optBoolean("xhrIsNative"))
          .append(", fetch is the browser's own: ").append(j.optBoolean("fetchIsNative")).append('\n');
        sb.append("second loader (AniMateNativeHlsLoader): ").append(j.optString("secondLoader")).append('\n');
        sb.append("ARRIVED via xhr + setRequestHeader:  ").append(refererOf(j.optJSONObject("xhr"))).append('\n');
        sb.append("ARRIVED via fetch + header:          ").append(refererOf(j.optJSONObject("fetchHeader"))).append('\n');
        sb.append("ARRIVED via fetch + referrer option: ").append(refererOf(j.optJSONObject("fetchReferrer"))).append('\n');
        sb.append("ARRIVED via CapacitorHttp.get:       ").append(refererOf(j.optJSONObject("nativeGet"))).append('\n');
        for (String line : sb.toString().split("\n")) Log.i(TAG, line);
        Log.i(TAG, "RAW " + raw);

        Bundle b = new Bundle();
        b.putString("referer_measurement", sb.toString());
        InstrumentationRegistry.getInstrumentation().sendStatus(0, b);
    }
}
