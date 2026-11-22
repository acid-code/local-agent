package com.localagent.app.live

/** Live sync rules for the open chat; mirrors packages/web/src/lib/live-sync.ts. Pure, so JVM tests cover it. */
object LiveSync {
    private val ACTIVE = setOf("running", "loading", "waiting", "paused", "awaiting_approval")

    sealed class Action {
        data class AdoptRun(val runId: String, val status: String) : Action()
        object UpsertMessage : Action()
        object Reload : Action()
        object None : Action()
    }

    /** Reconnect delay: 1s, 2s, 4s, 8s, then every 15s. */
    fun backoffMs(attempt: Int): Long = minOf(15_000L, 1000L shl attempt.coerceIn(0, 4))

    /** What the open chat does with one event of its feed; the run already streamed ([currentRunId]) handles its own. */
    fun action(type: String, runId: String?, status: String?, hasMessage: Boolean, currentRunId: String?): Action {
        val other = !runId.isNullOrBlank() && runId != currentRunId
        return when {
            type == "status" && other && status in ACTIVE -> Action.AdoptRun(runId!!, status!!)
            type == "message" && hasMessage && (other || runId.isNullOrBlank()) -> Action.UpsertMessage
            type == "done" && other -> Action.Reload
            else -> Action.None
        }
    }

    private fun isLocal(id: String) = id.startsWith("local")

    /** Reconnect snapshot: older pages stay, the server's newest page replaces the rest, unechoed local sends stay last. */
    fun <T> mergeSnapshot(local: List<T>, server: List<T>, id: (T) -> String, role: (T) -> String, content: (T) -> String): List<T> {
        if (server.isEmpty()) return local.filter { isLocal(id(it)) }
        val serverIds = server.map(id).toSet()
        val at = local.indexOfFirst { id(it) == id(server.first()) }
        val older = if (at >= 0) local.take(at).filterNot { id(it) in serverIds } else emptyList()
        val echoed = server.filter { role(it) == "user" }.map { content(it).trim() }.toSet()
        val pending = local.filter { isLocal(id(it)) && content(it).trim() !in echoed }
        return older + server + pending
    }
}
