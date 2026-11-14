// YASA PRESENTS
package com.yasa.animate;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Downloads an update and hands it to Android's installer.
 *
 * WHAT THIS REFUSES, AND WHY (2026-11-12).
 * This method is called from the page with an address the page read out of a network
 * answer. It used to download WHATEVER address it was given, over any scheme, following
 * any redirect, and offer the result to the installer. Android would refuse a file
 * carrying this app's package name and somebody else's signature, but it would happily
 * offer to install a file with a DIFFERENT package name as a new app, under a dialog the
 * user reached by tapping UPDATE NOW inside ANI-MATE.
 *
 *   1. The address must be an https download from this project's own release page.
 *   2. Redirects are followed by hand, and each hop must be https on github.com or
 *      *.githubusercontent.com (where GitHub keeps release files).
 *   3. Every hop has a connect and a read timeout. The first one had them; the hops
 *      after a redirect did not, and a host that accepted the connection and then said
 *      nothing held the thread, and the dialog, for good.
 *   4. Before the installer is called, the file must be an APK of THIS package, signed
 *      with the SAME certificate as the copy that is running.
 *   5. The file lives in its own folder of the cache, and the file provider exposes
 *      that folder and nothing else (res/xml/file_paths.xml). It used to expose the
 *      whole of external storage and the whole cache.
 *
 * IF THE SIGNING KEY IS EVER ROTATED, rule 4 refuses the update that carries the new key,
 * with a message, and that release has to be installed by hand. Android's own installer
 * understands a rotation; this check deliberately does not try to.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstaller extends Plugin {

    /** Compared in lower case. GitHub treats owner and repository names that way too. */
    private static final String RELEASE_PREFIX =
        "https://github.com/yasadevstudio/ani-mate/releases/download/";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 60000;
    private static final int MAX_REDIRECTS = 5;
    /** No build of this app is near this. A file past it is not one of ours. */
    private static final long MAX_APK_BYTES = 300L * 1024 * 1024;

    /** One download at a time. A second tap must not start a second writer on the file. */
    private final AtomicBoolean busy = new AtomicBoolean(false);

    static boolean isReleaseDownload(String url) {
        return url != null && url.toLowerCase(Locale.ROOT).startsWith(RELEASE_PREFIX);
    }

    static boolean isAllowedHop(URL url) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) return false;
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        return host.equals("github.com") || host.endsWith(".githubusercontent.com");
    }

    private static HttpURLConnection open(URL url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestProperty("Accept", "application/octet-stream");
        conn.setRequestProperty("User-Agent", "ANI-MATE-Android");
        /* By hand, so every hop is checked. Left to itself the connection follows a
         * redirect to wherever it points. */
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        return conn;
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    /** SHA-256 of each certificate a package is signed with. Empty when none can be read. */
    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) throws Exception {
        Set<String> out = new HashSet<>();
        if (info == null) return out;
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            sigs = info.signingInfo.getApkContentsSigners();
        }
        if (sigs == null || sigs.length == 0) sigs = info.signatures;
        if (sigs == null) return out;
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        for (Signature s : sigs) {
            if (s != null) out.add(hex(sha.digest(s.toByteArray())));
        }
        return out;
    }

    @SuppressWarnings("deprecation")
    private static int signerFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
    }

    /**
     * Null when the file is this app, signed as this app is. Otherwise the reason, in
     * words that can be shown to the user.
     */
    @SuppressWarnings("deprecation")
    private String whyNotOurs(File apk) {
        try {
            PackageManager pm = getContext().getPackageManager();
            String mine = getContext().getPackageName();

            PackageInfo theirs = pm.getPackageArchiveInfo(apk.getAbsolutePath(), signerFlags());
            if (theirs == null) return "the download is not an Android package";
            if (!mine.equals(theirs.packageName)) return "the download is a different app";

            Set<String> theirSigners = signers(theirs);
            if (theirSigners.isEmpty()) {
                /* Some Android versions do not fill in the newer field for a file that
                 * is not installed. The older field is still filled in. */
                PackageInfo again = pm.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
                theirSigners = signers(again);
            }
            Set<String> mySigners = signers(pm.getPackageInfo(mine, signerFlags()));
            if (theirSigners.isEmpty() || mySigners.isEmpty()) return "the download's signature could not be read";
            if (!theirSigners.equals(mySigners)) return "the download is not signed by the makers of this app";
            return null;
        } catch (Exception e) {
            return "the download could not be checked";
        }
    }

    @PluginMethod()
    public void downloadAndInstall(PluginCall call) {
        final String downloadUrl = call.getString("url");
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            call.reject("Missing url parameter");
            return;
        }
        if (!isReleaseDownload(downloadUrl)) {
            call.reject("Update refused: not a download from this app's release page");
            return;
        }
        if (!busy.compareAndSet(false, true)) {
            call.reject("An update is already downloading");
            return;
        }

        // Run download on background thread
        new Thread(() -> {
            File apkFile = null;
            HttpURLConnection conn = null;
            boolean handedOver = false;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    call.reject("Download failed: no room to store the update");
                    return;
                }
                apkFile = new File(dir, "ani-mate-update.apk");
                if (apkFile.exists() && !apkFile.delete()) {
                    call.reject("Download failed: the previous update file is in the way");
                    return;
                }

                URL url = new URL(downloadUrl);
                int status = 0;
                for (int hop = 0; ; hop++) {
                    if (!isAllowedHop(url)) {
                        call.reject("Update refused: the download was redirected somewhere unexpected");
                        return;
                    }
                    conn = open(url);
                    conn.connect();
                    status = conn.getResponseCode();
                    if (status != 301 && status != 302 && status != 303 && status != 307 && status != 308) break;
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (location == null || location.isEmpty() || hop >= MAX_REDIRECTS) {
                        call.reject("Download failed: too many redirects");
                        return;
                    }
                    url = new URL(url, location);          // a relative Location is allowed
                }

                if (status != 200) {
                    call.reject("Download failed: HTTP " + status);
                    return;
                }

                long total = conn.getContentLengthLong();
                if (total > MAX_APK_BYTES) {
                    call.reject("Update refused: the download is too large to be this app");
                    return;
                }

                long downloaded = 0;
                int lastPercent = 0;
                try (InputStream in = conn.getInputStream();
                     OutputStream out = new FileOutputStream(apkFile)) {
                    byte[] buf = new byte[8192];
                    int len;
                    while ((len = in.read(buf)) != -1) {
                        out.write(buf, 0, len);
                        downloaded += len;
                        if (downloaded > MAX_APK_BYTES) {
                            call.reject("Update refused: the download is too large to be this app");
                            return;
                        }

                        // Emit progress events (every 5%)
                        if (total > 0) {
                            int percent = (int) ((downloaded * 100) / total);
                            if (percent >= lastPercent + 5) {
                                lastPercent = percent;
                                JSObject progress = new JSObject();
                                progress.put("percent", percent);
                                progress.put("downloaded", downloaded);
                                progress.put("total", total);
                                notifyListeners("downloadProgress", progress);
                            }
                        }
                    }
                    out.flush();
                }

                // Verify file exists and has size
                if (!apkFile.exists() || apkFile.length() < 1000) {
                    call.reject("Download failed: file empty or missing");
                    return;
                }
                if (total > 0 && apkFile.length() != total) {
                    call.reject("Download failed: the connection dropped before the end");
                    return;
                }

                String refusal = whyNotOurs(apkFile);
                if (refusal != null) {
                    call.reject("Update refused: " + refusal);
                    return;
                }

                // Trigger install via intent
                Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    apkFile
                );

                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                handedOver = true;                     // the installer reads the file from here on
                getActivity().runOnUiThread(() -> {
                    try {
                        getContext().startActivity(intent);
                        JSObject result = new JSObject();
                        result.put("success", true);
                        call.resolve(result);
                    } catch (Exception e) {
                        call.reject("Install failed: " + e.getMessage());
                    }
                });

            } catch (Exception e) {
                call.reject("Download failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                /* A file that was refused, or only half arrived, is not left behind. */
                if (!handedOver && apkFile != null && apkFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    apkFile.delete();
                }
                busy.set(false);
            }
        }).start();
    }
}
