package com.localagent.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class ApprovalWorker extends Worker {
    static final String CHANNEL = "approvals";

    public ApprovalWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        String base = prefs.getString("url", "");
        String token = prefs.getString("token", "");
        if (base == null || token == null || base.isEmpty() || token.isEmpty()) return Result.success();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(base + "/api/approvals").openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) return Result.retry();
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            JSONArray approvals = new JSONObject(body.toString()).optJSONArray("approvals");
            int count = approvals == null ? 0 : approvals.length();
            if (count > 0) notifyPending(count);
            return Result.success();
        } catch (Exception ignored) {
            return Result.retry();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void notifyPending(int count) {
        Context context = getApplicationContext();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Approvals", NotificationManager.IMPORTANCE_DEFAULT);
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(context, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            context,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        String text = count == 1 ? "1 approval is waiting on the mini PC." : count + " approvals are waiting on the mini PC.";
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("local-agent")
            .setContentText(text)
            .setContentIntent(pending)
            .setAutoCancel(true);
        manager.notify(42, builder.build());
    }
}
