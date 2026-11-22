package com.localagent.app.approvals

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Handles Approve / Deny taps on a notification. Not exported: only our own PendingIntents reach it. */
class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ApprovalNotifier.ACTION_DECIDE) return
        val id = intent.getStringExtra(ApprovalNotifier.EXTRA_APPROVAL_ID) ?: return
        val decision = intent.getStringExtra(ApprovalNotifier.EXTRA_DECISION) ?: return
        if (decision != "approve" && decision != "deny") return
        val app = context.applicationContext
        val pending = goAsync()
        scope.launch {
            try {
                val api = ApprovalApi(app)
                // Re-check the risk on the server before a one-tap approve; a high-risk action always needs the app.
                if (decision == "approve") {
                    val current = runCatching { api.pending().firstOrNull { it.id == id } }.getOrNull()
                    if (current == null) { ApprovalNotifier.showResult(app, id, "Already decided", ok = true); return@launch }
                    if (!ApprovalPolicy.oneTapAllowed(current.risk)) { ApprovalNotifier.show(app, current); return@launch }
                }
                when (val out = api.decide(id, decision)) {
                    ApprovalApi.Outcome.Done -> ApprovalNotifier.showResult(app, id, if (decision == "approve") "Approved" else "Denied", ok = true)
                    ApprovalApi.Outcome.AlreadyDecided -> ApprovalNotifier.showResult(app, id, "Already decided", ok = true)
                    is ApprovalApi.Outcome.Failed -> ApprovalNotifier.showResult(app, id, "Not sent: ${out.message}. Tap to open.", ok = false)
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
