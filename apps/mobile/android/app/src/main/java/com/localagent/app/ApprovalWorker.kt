package com.localagent.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApprovalWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences("local-agent-native", Context.MODE_PRIVATE)
        val base = prefs.getString("server_url", "")?.trimEnd('/') ?: ""
        val token = prefs.getString("bearer_token", "") ?: ""
        val cookie = prefs.getString("la_session_cookie", "") ?: ""
        if (base.isBlank() || (token.isBlank() && cookie.isBlank())) return Result.success()

        return try {
            val client = OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(8, TimeUnit.SECONDS)
                .build()
            val builder = Request.Builder().url("$base/api/approvals")
            if (token.isNotBlank()) builder.header("Authorization", "Bearer $token")
            if (cookie.isNotBlank()) builder.header("Cookie", cookie)

            client.newCall(builder.build()).execute().use { resp ->
                if (!resp.isSuccessful) return Result.success()
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("approvals")
                    ?: return Result.success()
                if (arr.length() == 0) return Result.success()
                val first = arr.getJSONObject(0)
                val title = if (arr.length() == 1) "Approval needed" else "${arr.length()} approvals waiting"
                val text = "${first.optString("toolName", "tool")}: ${first.optString("reason", "")}"
                postNotification(title, text)
            }
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    private fun postNotification(title: String, body: String) {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channelId = "approvals"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(channelId, "Approvals", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val intent = Intent(applicationContext, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            applicationContext,
            1,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(applicationContext, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        manager.notify(1001, notification)
    }
}
