package com.localagent.app;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;

public class MainActivity extends BridgeActivity {
    static final String PREFS = "local-agent";
    private boolean bridgeAttached;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestMicAndNotifications();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(ApprovalWorker.class, 15, TimeUnit.MINUTES).build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "local-agent-approvals",
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        );
    }

    @Override
    public void onStart() {
        super.onStart();
        attachBridge();
        deliverShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverShare(intent);
    }

    private void requestMicAndNotifications() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.RECORD_AUDIO}, 1);
        }
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2);
        }
    }

    private void attachBridge() {
        if (bridgeAttached || getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        webView.addJavascriptInterface(new TokenBridge(), "LocalAgentAndroid");
        // Links with a download disposition (Save in the file viewer, attachments) go to the system Downloads folder.
        webView.setDownloadListener((url, userAgent, disposition, mime, length) ->
            enqueueDownload(url, URLUtil.guessFileName(url, disposition, mime), mime, userAgent));
        bridgeAttached = true;
    }

    private void deliverShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.isEmpty()) text = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null || text.isEmpty() || getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String target = "https://localhost/?share=" + Uri.encode(text);
        webView.post(() -> webView.loadUrl(target));
    }

    private static boolean webUrl(String url) {
        return url != null && (url.startsWith("https://") || url.startsWith("http://"));
    }

    private static String safeName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return clean.isEmpty() ? "download" : clean;
    }

    void enqueueDownload(String url, String name, String mime, String userAgent) {
        if (!webUrl(url)) return;
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            if (mime != null && !mime.isEmpty()) request.setMimeType(mime);
            request.setTitle(safeName(name));
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeName(name));
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            manager.enqueue(request);
            runOnUiThread(() -> Toast.makeText(this, "Saving " + safeName(name) + " to Downloads", Toast.LENGTH_SHORT).show());
        } catch (Exception error) {
            runOnUiThread(() -> Toast.makeText(this, "Could not save the file", Toast.LENGTH_SHORT).show());
        }
    }

    /** Fetch the file with the session cookie into the app cache, then hand it to another app. */
    void handOff(String url, String name, String mime, boolean share) {
        if (!webUrl(url)) return;
        new Thread(() -> {
            try {
                File dir = new File(getCacheDir(), "shared");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cache");
                File out = new File(dir, safeName(name));
                HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                if (connection.getResponseCode() >= 400) throw new IllegalStateException("http " + connection.getResponseCode());
                try (InputStream in = connection.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) os.write(buffer, 0, read);
                }
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", out);
                String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
                Intent intent = new Intent(share ? Intent.ACTION_SEND : Intent.ACTION_VIEW);
                if (share) {
                    intent.setType(type);
                    intent.putExtra(Intent.EXTRA_STREAM, uri);
                } else {
                    intent.setDataAndType(uri, type);
                }
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(intent, share ? "Share " + out.getName() : "Open " + out.getName());
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> {
                    try { startActivity(chooser); }
                    catch (ActivityNotFoundException missing) { Toast.makeText(this, "No app can open this file", Toast.LENGTH_SHORT).show(); }
                });
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(this, "Could not open the file", Toast.LENGTH_SHORT).show());
            }
        }).start();
    }

    class TokenBridge {
        @JavascriptInterface
        public void download(String url, String name, String mime) {
            enqueueDownload(url, name, mime, null);
        }

        @JavascriptInterface
        public void share(String url, String name, String mime) {
            handOff(url, name, mime, true);
        }

        @JavascriptInterface
        public void openWith(String url, String name, String mime) {
            handOff(url, name, mime, false);
        }

        @JavascriptInterface
        public void saveNotificationToken(String url, String token) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit().putString("url", url).putString("token", token).apply();
        }
    }
}
