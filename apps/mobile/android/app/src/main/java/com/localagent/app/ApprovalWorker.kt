package com.localagent.app

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.localagent.app.approvals.ApprovalApi
import com.localagent.app.approvals.ApprovalNotifier
import java.util.concurrent.TimeUnit

/**
 * Background check for approvals while the app is closed. Posts one actionable notification per new pending
 * approval and clears the ones that were decided elsewhere. While something is pending it re-checks every
 * 2 minutes so decided ones disappear quickly; otherwise the 15-minute periodic job is the floor Android allows.
 */
class ApprovalWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val api = ApprovalApi(applicationContext)
        if (!api.signedIn) return Result.success()
        return try {
            val pending = api.pending()
            ApprovalNotifier.sync(applicationContext, pending, post = !AppVisibility.foreground)
            if (pending.isNotEmpty()) scheduleFollowUp(applicationContext)
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        fun scheduleFollowUp(context: Context) {
            val req = OneTimeWorkRequestBuilder<ApprovalWorker>().setInitialDelay(2, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniqueWork("local-agent-approvals-followup", ExistingWorkPolicy.REPLACE, req)
        }
    }
}

/** Set by MainActivity; the worker does not post notifications while the app is on screen. */
object AppVisibility {
    @Volatile var foreground: Boolean = false
}
