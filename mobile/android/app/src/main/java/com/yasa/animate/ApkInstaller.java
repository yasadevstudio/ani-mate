package com.yasa.animate;

import android.content.Intent;
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
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstaller extends Plugin {

    @PluginMethod()
    public void downloadAndInstall(PluginCall call) {
        String downloadUrl = call.getString("url");
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            call.reject("Missing url parameter");
            return;
        }

        // Run download on background thread
        new Thread(() -> {
            try {
                File cacheDir = getContext().getCacheDir();
                File apkFile = new File(cacheDir, "ani-mate-update.apk");

                // Delete old file if exists
                if (apkFile.exists()) {
                    apkFile.delete();
                }

                // Download with redirect following
                HttpURLConnection conn = (HttpURLConnection) new URL(downloadUrl).openConnection();
                conn.setRequestProperty("Accept", "application/octet-stream");
                conn.setRequestProperty("User-Agent", "ANI-MATE-Android");
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.connect();

                // Handle manual redirects (some servers need this)
                int status = conn.getResponseCode();
                int redirects = 0;
                while ((status == 301 || status == 302 || status == 303 || status == 307) && redirects < 5) {
                    String redirect = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = (HttpURLConnection) new URL(redirect).openConnection();
                    conn.setRequestProperty("Accept", "application/octet-stream");
                    conn.setRequestProperty("User-Agent", "ANI-MATE-Android");
                    conn.setInstanceFollowRedirects(true);
                    conn.connect();
                    status = conn.getResponseCode();
                    redirects++;
                }

                if (status != 200) {
                    conn.disconnect();
                    call.reject("Download failed: HTTP " + status);
                    return;
                }

                long total = conn.getContentLength();
                InputStream in = conn.getInputStream();
                FileOutputStream out = new FileOutputStream(apkFile);

                byte[] buf = new byte[8192];
                long downloaded = 0;
                int len;
                int lastPercent = 0;

                while ((len = in.read(buf)) != -1) {
                    out.write(buf, 0, len);
                    downloaded += len;

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
                out.close();
                in.close();
                conn.disconnect();

                // Verify file exists and has size
                if (!apkFile.exists() || apkFile.length() < 1000) {
                    call.reject("Download failed: file empty or missing");
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
            }
        }).start();
    }
}
