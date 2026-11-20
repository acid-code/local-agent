package com.localagent.app.model

data class Persona(
    val id: String,
    val name: String,
    val title: String = "",
    val description: String = "",
    val emoji: String = "",
    val accent: String = "#E4B56A",
    val pinned: Boolean = false,
    val hidden: Boolean = false,
    val unread: Int = 0,
    val voiceReply: Boolean = false,
    val voiceName: String = "",
    val language: String = "auto",
)

data class ChatSession(
    val id: String,
    val agentId: String?,
    val title: String,
    val modelPin: String? = null,
    val mode: String = "chat",
    val updatedAt: String = "",
)

data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val agentId: String? = null,
    val thinking: String? = null,
    val routingNote: String? = null,
    val toolName: String? = null,
    val createdAt: String = "",
)

data class UsableModel(
    val id: String,
    val name: String,
    val local: Boolean,
    val disabled: Boolean = false,
    val reason: String? = null,
)

data class ContextBreakdown(
    val budget: Int,
    val used: Int,
    val remaining: Int,
    val outputReserve: Int,
    val systemPrompt: Int,
    val personaAndTools: Int,
    val memory: Int,
    val history: Int,
    val files: Int,
) {
    val percent: Int get() = if (budget > 0) ((used * 100L) / budget).toInt().coerceIn(0, 100) else 0
}

data class ApprovalItem(
    val id: String,
    val runId: String,
    val toolName: String,
    val reason: String,
)

data class LiveStreamSnapshot(
    val text: String = "",
    val thinking: String = "",
    val status: String = "",
    val detail: String = "",
)

data class EditDiff(
    val id: String,
    val label: String,
    val diff: String,
    val revertedAt: String? = null,
)

data class RunStep(
    val id: String,
    val kind: String,
    val name: String,
    val status: String,
    val latencyMs: Int = 0,
    val output: String = "",
    val error: String? = null,
)

data class SessionDetail(
    val session: ChatSession,
    val messages: List<ChatMessage>,
    val edits: List<EditDiff> = emptyList(),
    val activeRunId: String? = null,
    val activeRunStatus: String? = null,
    val live: LiveStreamSnapshot? = null,
    val breakdown: ContextBreakdown? = null,
)

data class AuthMe(
    val authenticated: Boolean,
    val username: String = "",
    val displayName: String = "",
    val role: String = "owner",
    val needsSetup: Boolean = false,
)

data class ServerSettings(
    val searxngUrl: String = "",
    val geminiTier: String = "free",
)

data class RemoteFile(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long = 0,
)
