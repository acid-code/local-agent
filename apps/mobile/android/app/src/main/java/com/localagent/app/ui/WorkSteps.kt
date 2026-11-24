package com.localagent.app.ui

import com.localagent.app.model.ApprovalItem
import com.localagent.app.model.ChatMessage
import java.time.Instant
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Copilot-style work groups, ported from packages/web/src/lib/work-steps.ts so the phone
 * shows the same Thought / Read / Ran / Edited grouping the web does. Pure Kotlin, JVM-tested.
 */
object WorkSteps {
    enum class Icon { Edit, Read, Think, Command, Search, Web, Memory, Agent, Container, Tool }

    sealed class Row {
        abstract val id: String
        data class Step(
            override val id: String,
            val icon: Icon,
            val verb: String,
            val target: String,
            val files: List<String>,
            val durationMs: Long?,
            val args: Map<String, Any?>?,
            val output: String,
            val failed: Boolean,
            val pending: Boolean,
            val toolName: String,
            val callId: String?,
        ) : Row()
        data class Thought(override val id: String, val text: String) : Row()
        data class Narration(override val id: String, val text: String) : Row()
    }

    data class Group(
        val id: String,
        val rows: List<Row>,
        val stepCount: Int,
        val durationMs: Long?,
        val runIds: List<String>,
    )

    sealed class Item {
        abstract val key: String
        data class Message(val message: ChatMessage) : Item() {
            override val key: String get() = message.id
        }
        data class Work(val group: Group) : Item() {
            override val key: String get() = group.id
        }
    }

    data class Described(val icon: Icon, val verb: String, val target: String, val files: List<String>)

    fun describeStep(name: String, args: Map<String, Any?>?): Described {
        val a = args ?: emptyMap()
        val path = str(a["path"]).ifBlank { str(a["file"]).ifBlank { str(a["filePath"]) } }
        return when (name) {
            "write_file", "create_file", "edit_file", "apply_patch", "str_replace" ->
                Described(Icon.Edit, if (name == "create_file") "Created" else "Edited", if (path.isNotEmpty()) base(path) else "", if (path.isNotEmpty()) listOf(path) else emptyList())
            "read_file" ->
                Described(Icon.Read, "Read", if (path.isNotEmpty()) base(path) else "", if (path.isNotEmpty()) listOf(path) else emptyList())
            "list_dir" ->
                Described(Icon.Read, "Listed", path.ifBlank { "." }, emptyList())
            "shell", "run_command", "terminal" ->
                Described(Icon.Command, "Ran", clip(str(a["command"]).split('\n').firstOrNull().orEmpty()), emptyList())
            "web_search" ->
                Described(Icon.Search, "Searched the web for", clip(str(a["query"])), emptyList())
            "kb_search", "search_chats", "recall" ->
                Described(Icon.Search, "Searched", clip(str(a["query"]).ifBlank { str(a["q"]) }), emptyList())
            "web_fetch" ->
                Described(Icon.Web, "Fetched", clip(str(a["url"]).replace(Regex("^https?://"), "")), emptyList())
            "remember", "memory_file" ->
                Described(Icon.Memory, "Saved to memory", clip(str(a["content"]).ifBlank { str(a["text"]) }, 60), emptyList())
            "grep" ->
                Described(Icon.Search, "Searched files for", clip(str(a["pattern"])), emptyList())
            "glob" ->
                Described(Icon.Search, "Matched files", clip(str(a["pattern"])), emptyList())
            "set_focus" ->
                Described(Icon.Think, "Focus", clip(str(a["focus"])), emptyList())
            "enter_plan_mode" ->
                Described(Icon.Think, "Entered plan mode", clip(str(a["goal"]).ifBlank { str(a["reason"]) }), emptyList())
            "exit_plan_mode" ->
                Described(Icon.Think, "Exited plan mode", clip(str(a["summary"])), emptyList())
            "spawn_agent" -> {
                val role = str(a["role"]).ifBlank { "helper" }
                Described(Icon.Agent, "Spawned $role", clip(str(a["why"]).ifBlank { str(a["goal"]).ifBlank { str(a["task"]) } }), emptyList())
            }
            "consult_agent" ->
                Described(Icon.Agent, "Asked", str(a["agent"]).ifBlank { str(a["name"]).ifBlank { "a helper" } }, emptyList())
            "docker_ps", "docker_inspect", "docker_run", "docker_rm" -> {
                val verb = when (name) {
                    "docker_run" -> "Started container"
                    "docker_rm" -> "Removed container"
                    else -> "Checked containers"
                }
                Described(Icon.Container, verb, str(a["image"]).ifBlank { str(a["name"]).ifBlank { str(a["id"]) } }, emptyList())
            }
            else -> Described(
                Icon.Tool,
                "Used ${name.replace('_', ' ')}",
                if (path.isNotEmpty()) base(path) else clip(str(a["action"]).ifBlank { str(a["query"]) }),
                if (path.isNotEmpty()) listOf(path) else emptyList(),
            )
        }
    }

    fun group(messages: List<ChatMessage>): List<Item> {
        val out = mutableListOf<Item>()
        var current: MutableList<ChatMessage>? = null
        fun flush() {
            val msgs = current ?: return
            out.add(Item.Work(buildGroup(msgs)))
            current = null
        }
        for (message in messages) {
            if (isWork(message)) {
                if (current == null) current = mutableListOf()
                current!!.add(message)
            } else {
                flush()
                out.add(Item.Message(message))
            }
        }
        flush()
        return out
    }

    fun formatDuration(ms: Long?): String {
        if (ms == null) return ""
        val s = (ms / 1000.0).roundToInt()
        if (s < 1) return "${max(1, ms)}ms"
        if (s < 60) return "${s}s"
        val m = s / 60
        if (m < 60) return "${m}m ${((s % 60).toString().padStart(2, '0'))}s"
        return "${m / 60}h ${m % 60}m"
    }

    fun diffStats(diffs: List<String>): Pair<Int, Int> {
        var added = 0
        var removed = 0
        for (diff in diffs) {
            for (line in diff.split('\n')) {
                if (line.startsWith("+++") || line.startsWith("---")) continue
                if (line.startsWith("+")) added += 1
                else if (line.startsWith("-")) removed += 1
            }
        }
        return added to removed
    }

    fun headerTitle(group: Group, live: Boolean): String {
        val n = group.stepCount
        val duration = formatDuration(group.durationMs)
        return when {
            live -> "Working · $n steps so far"
            n == 1 && duration.isNotBlank() -> "Completed 1 step in $duration"
            n == 1 -> "Completed 1 step"
            duration.isNotBlank() -> "Completed $n steps in $duration"
            else -> "Completed $n steps"
        }
    }

    /** The approval that belongs on this pending step, if any. */
    fun approvalFor(step: Row.Step, approvals: List<ApprovalItem>): ApprovalItem? {
        val callId = step.callId?.takeIf { it.isNotBlank() }
        if (callId != null) {
            val exact = approvals.firstOrNull { approval ->
                val id = approval.toolCallId
                id.isNotBlank() && (id == callId || step.id == id || step.id.endsWith(":$id"))
            }
            if (exact != null) return exact
        }
        if (!step.pending) return null
        return approvals.firstOrNull { it.toolCallId.isBlank() && it.toolName == step.toolName }
    }

    fun parseArgs(raw: String?): Map<String, Any?>? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        return runCatching {
            val obj = org.json.JSONObject(text)
            obj.keys().asSequence().associateWith { key -> obj.opt(key).takeUnless { it == org.json.JSONObject.NULL } }
        }.getOrNull()
    }

    private fun isWork(m: ChatMessage) = m.role == "tool" || (m.role == "assistant" && m.toolCalls.isNotEmpty())

    private fun buildGroup(msgs: List<ChatMessage>): Group {
        val rows = mutableListOf<Row>()
        val results = mutableMapOf<String, ChatMessage>()
        for (m in msgs) if (m.role == "tool" && !m.toolCallId.isNullOrBlank()) results[m.toolCallId!!] = m
        val used = mutableSetOf<String>()
        for (m in msgs) {
            if (m.role == "assistant") {
                val thinking = m.thinking?.trim().orEmpty()
                if (thinking.isNotEmpty()) rows.add(Row.Thought(id = "${m.id}:think", text = thinking))
                if (m.content.trim().isNotEmpty()) rows.add(Row.Narration(id = "${m.id}:say", text = m.content.trim()))
                m.toolCalls.forEachIndexed { i, call ->
                    val args = parseArgs(call.arguments)
                    val result = call.id?.let { results[it] }
                    if (result != null) used.add(result.id)
                    val d = describeStep(call.name, args)
                    val start = time(m.createdAt)
                    val end = time(result?.createdAt)
                    val output = result?.content.orEmpty()
                    rows.add(
                        Row.Step(
                            id = "${m.id}:${call.id ?: i}",
                            icon = d.icon,
                            verb = d.verb,
                            target = d.target,
                            files = d.files,
                            durationMs = if (start != null && end != null) max(0, end - start) else null,
                            args = args,
                            output = output,
                            pending = result == null,
                            failed = Regex("^(error|denied|blocked|failed)\\b", RegexOption.IGNORE_CASE).containsMatchIn(output.trim()),
                            toolName = call.name,
                            callId = call.id,
                        ),
                    )
                }
            } else if (m.role == "tool" && m.id !in used) {
                val d = describeStep(m.toolName ?: "tool", null)
                val output = m.content
                rows.add(
                    Row.Step(
                        id = m.id,
                        icon = d.icon,
                        verb = d.verb,
                        target = d.target,
                        files = d.files,
                        durationMs = null,
                        args = null,
                        output = output,
                        pending = false,
                        failed = Regex("^(error|denied|blocked|failed)\\b", RegexOption.IGNORE_CASE).containsMatchIn(output.trim()),
                        toolName = m.toolName ?: "tool",
                        callId = m.toolCallId,
                    ),
                )
            }
        }
        val first = time(msgs.firstOrNull()?.createdAt)
        val last = time(msgs.lastOrNull()?.createdAt)
        return Group(
            id = "work-${msgs.firstOrNull()?.id ?: "x"}",
            rows = rows,
            stepCount = rows.count { it is Row.Step },
            durationMs = if (first != null && last != null) max(0, last - first) else null,
            runIds = msgs.mapNotNull { it.runId?.takeIf { id -> id.isNotBlank() } }.distinct(),
        )
    }

    private fun str(value: Any?): String = value as? String ?: ""
    private fun base(p: String): String = p.trimEnd('/').substringAfterLast('/').ifBlank { p }
    private fun clip(text: String, n: Int = 90): String = if (text.length > n) text.take(n - 1) + "…" else text
    private fun time(iso: String?): Long? {
        if (iso.isNullOrBlank()) return null
        return runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
    }
}

