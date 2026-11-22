package com.localagent.app.model

import org.json.JSONObject

/**
 * What a waiting run waits for (mirrors waitStateOf in packages/shared/src/wait-state.ts):
 *  - QUEUE:  another chat holds the large model; this one starts when that finishes. No Force run:
 *            loading a second large model next to the first freezes the mini PC.
 *  - MEMORY: the RAM (MemAvailable) admission wait; Force run is offered behind a confirm.
 */
data class WaitState(
    val queue: Boolean,
    val title: String,
    val detail: String,
    val behind: String?,
    val ahead: Int,
    val sinceIso: String?,
) {
    val canForce: Boolean get() = !queue

    companion object {
        private val QUEUE = Regex("^Waiting for (.+?) to finish(?: in another chat)? \\(queued(?:, (\\d+) ahead)?\\)", RegexOption.IGNORE_CASE)

        fun of(detail: String?, waitInfo: JSONObject?): WaitState {
            val text = detail.orEmpty().trim()
            val info = waitInfo?.takeIf { it.optString("kind") == "queue" }
            val match = if (info == null) QUEUE.find(text) else null
            if (info != null || match != null) {
                val behind = (info?.optString("behind")?.takeIf { it.isNotBlank() } ?: match?.groupValues?.get(1))
                    ?.removePrefix("the ")?.ifBlank { null }
                val ahead = maxOf(1, info?.optInt("ahead", 1) ?: match?.groupValues?.get(2)?.toIntOrNull() ?: 1)
                return WaitState(
                    queue = true,
                    title = if (behind != null) "Queued behind $behind" else "Queued",
                    detail = if (ahead > 1) "$ahead chats are ahead of this one. It starts on its own when they finish."
                    else "Another chat is using the large model. This one starts on its own when that finishes.",
                    behind = behind,
                    ahead = ahead,
                    sinceIso = info?.optString("since")?.ifBlank { null },
                )
            }
            return WaitState(false, "Waiting for memory", text.ifBlank { "Waiting for available RAM (MemAvailable)…" }, null, 0, null)
        }
    }
}
