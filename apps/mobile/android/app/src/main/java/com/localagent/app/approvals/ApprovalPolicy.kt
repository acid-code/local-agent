package com.localagent.app.approvals

import com.localagent.app.model.ApprovalItem
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure rules for approvals on the phone, kept free of Android types so they are unit-tested on the JVM.
 *  - High-risk (or unlabeled) actions are never one-tap: the notification only offers Review and Deny,
 *    and the app asks for an explicit confirm before approving.
 *  - Each pending approval gets one notification, posted once; it is removed when the approval is gone.
 */
object ApprovalPolicy {
    private val TAG = Regex("^\\[(safe|low|medium|high) risk]", RegexOption.IGNORE_CASE)

    fun riskOf(serverRisk: String?, reason: String): String {
        val r = serverRisk?.lowercase()?.trim()
        if (r in setOf("safe", "low", "medium", "high")) return r!!
        return TAG.find(reason.trim())?.groupValues?.get(1)?.lowercase() ?: "high"
    }

    fun oneTapAllowed(risk: String): Boolean = risk == "safe" || risk == "low" || risk == "medium"

    fun needsConfirm(risk: String): Boolean = !oneTapAllowed(risk)

    /** The reason without the "[x risk]" prefix the engine adds. */
    fun cleanReason(reason: String): String = reason.replace(TAG, "").trim()

    data class Plan(val post: List<ApprovalItem>, val cancel: Set<String>, val notified: Set<String>)

    /** Which notifications to post (new pending ids) and cancel (ids no longer pending). */
    fun plan(pending: List<ApprovalItem>, alreadyNotified: Set<String>): Plan {
        val ids = pending.map { it.id }.toSet()
        return Plan(
            post = pending.filter { it.id !in alreadyNotified },
            cancel = alreadyNotified - ids,
            notified = ids,
        )
    }

    /** Stable per-approval notification id, away from the summary id. */
    fun notificationId(approvalId: String): Int = 10_000 + (approvalId.hashCode() and 0x7fffffff) % 1_000_000

    fun parse(json: JSONObject): ApprovalItem {
        val reason = json.optString("reason", "")
        return ApprovalItem(
            id = json.getString("id"),
            runId = json.optString("runId", ""),
            toolName = json.optString("toolName", "tool"),
            reason = reason,
            risk = riskOf(json.optString("risk", "").ifBlank { null }, reason),
            summary = json.optString("summary", ""),
            sessionId = json.str("sessionId"),
            sessionTitle = json.str("sessionTitle"),
            agentName = json.str("agentName"),
            createdAt = json.optString("createdAt", ""),
        )
    }

    private fun JSONObject.str(key: String): String? = if (!has(key) || isNull(key)) null else optString(key, "").ifBlank { null }

    fun parseList(body: String): List<ApprovalItem> {
        val arr = JSONObject(body).optJSONArray("approvals") ?: JSONArray()
        return List(arr.length()) { i -> parse(arr.getJSONObject(i)) }
    }
}
