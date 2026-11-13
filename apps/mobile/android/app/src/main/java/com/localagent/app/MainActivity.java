package com.localagent.app;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.BridgeActivity;

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
        getBridge().getWebView().addJavascriptInterface(new TokenBridge(), "LocalAgentAndroid");
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

    class TokenBridge {
        @JavascriptInterface
        public void saveNotificationToken(String url, String token) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit().putString("url", url).putString("token", token).apply();
        }
    }
}
