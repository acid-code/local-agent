package com.localagent.app.approvals

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.localagent.app.MainActivity
import com.localagent.app.R
import com.localagent.app.model.ApprovalItem

/** Native approval notifications: one per pending approval, with buttons that act through the approval endpoint. */
object ApprovalNotifier {
    const val CHANNEL = "approvals"
    const val EXTRA_APPROVAL_ID = "com.localagent.app.APPROVAL_ID"
    const val ACTION_DECIDE = "com.localagent.app.action.DECIDE_APPROVAL"
    const val EXTRA_DECISION = "decision"
    private const val PREF_NOTIFIED = "approvals_notified"
    private const val LEGACY_SUMMARY_ID = 1001

    private fun prefs(context: Context) = context.getSharedPreferences("local-agent-native", Context.MODE_PRIVATE)

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Actions an agent wants to run and is waiting for you to approve or deny."
            },
        )
    }

    private fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Bring the shade in line with what the server says is pending. Posts only new ones; clears decided ones. */
    fun sync(context: Context, pending: List<ApprovalItem>, post: Boolean) {
        val already = prefs(context).getStringSet(PREF_NOTIFIED, emptySet()).orEmpty()
        val plan = ApprovalPolicy.plan(pending, already)
        val nm = NotificationManagerCompat.from(context)
        nm.cancel(LEGACY_SUMMARY_ID) // the old "N approvals waiting" notification with no buttons
        plan.cancel.forEach { nm.cancel(ApprovalPolicy.notificationId(it)) }
        // In the foreground the app shows approvals itself; mark them seen so they are not posted later.
        if (post && canPost(context)) {
            ensureChannel(context)
            plan.post.forEach { show(context, it) }
        }
        prefs(context).edit().putStringSet(PREF_NOTIFIED, plan.notified).apply()
    }

    fun cancel(context: Context, approvalId: String) {
        NotificationManagerCompat.from(context).cancel(ApprovalPolicy.notificationId(approvalId))
    }

    fun openIntent(context: Context, approvalId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_APPROVAL_ID, approvalId)
        }
        return PendingIntent.getActivity(
            context, ApprovalPolicy.notificationId(approvalId), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun decideIntent(context: Context, approvalId: String, decision: String): PendingIntent {
        // Explicit intent to our own non-exported receiver; immutable so nothing else can rewrite it.
        val intent = Intent(context, ApprovalActionReceiver::class.java).apply {
            action = ACTION_DECIDE
            putExtra(EXTRA_APPROVAL_ID, approvalId)
            putExtra(EXTRA_DECISION, decision)
        }
        val code = ApprovalPolicy.notificationId(approvalId) * 2 + if (decision == "approve") 1 else 0
        return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun riskLabel(risk: String) = when (risk) {
        "high" -> "High risk"
        "medium" -> "Medium risk"
        "low" -> "Low risk"
        else -> "Safe"
    }

    fun show(context: Context, item: ApprovalItem) {
        if (!canPost(context)) return
        val where = listOfNotNull(item.agentName, item.sessionTitle).joinToString(" · ")
        val what = item.summary.ifBlank { ApprovalPolicy.cleanReason(item.reason) }
        val title = "${riskLabel(item.risk)} · ${item.toolName}"
        val big = buildString {
            append(what)
            val why = ApprovalPolicy.cleanReason(item.reason)
            if (why.isNotBlank() && why != what) append("\n").append(why)
            if (ApprovalPolicy.needsConfirm(item.risk)) append("\nOpen to review and confirm.")
        }
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_approval)
            .setContentTitle(title)
            .setContentText(what)
            .setSubText(where.ifBlank { null })
            .setStyle(NotificationCompat.BigTextStyle().bigText(big))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(openIntent(context, item.id))
            .addAction(
                NotificationCompat.Action.Builder(0, "Deny", decideIntent(context, item.id, "deny"))
                    .setAuthenticationRequired(true).build(),
            )
        if (ApprovalPolicy.oneTapAllowed(item.risk)) {
            builder.addAction(
                NotificationCompat.Action.Builder(0, "Approve", decideIntent(context, item.id, "approve"))
                    .setAuthenticationRequired(true).build(),
            )
        } else {
            builder.addAction(NotificationCompat.Action.Builder(0, "Review", openIntent(context, item.id)).build())
        }
        runCatching { NotificationManagerCompat.from(context).notify(ApprovalPolicy.notificationId(item.id), builder.build()) }
    }

    /** Replace an approval's notification with a short result line that goes away on its own. */
    fun showResult(context: Context, approvalId: String, text: String, ok: Boolean) {
        if (!canPost(context)) return
        ensureChannel(context)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_approval)
            .setContentTitle(text)
            .setContentIntent(openIntent(context, approvalId))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setAutoCancel(true)
            .setTimeoutAfter(if (ok) 4_000 else 30_000)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(ApprovalPolicy.notificationId(approvalId), n) }
    }
}
