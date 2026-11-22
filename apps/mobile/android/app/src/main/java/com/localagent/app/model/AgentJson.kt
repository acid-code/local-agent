package com.localagent.app.model

import org.json.JSONObject

/** Parse agent and session payloads from the server so unit tests can cover the fields the faces need. */
object AgentJson {
    fun persona(obj: JSONObject) = Persona(
        id = obj.getString("id"),
        name = obj.optString("name", "Assistant"),
        title = obj.optString("title", ""),
        description = obj.optString("description", ""),
        emoji = obj.optString("emoji", ""),
        accent = obj.optString("accent", "#E4B56A"),
        pinned = obj.optBoolean("pinned", false),
        hidden = obj.optBoolean("hidden", false),
        unread = obj.optInt("unread", 0),
        voiceReply = obj.optBoolean("voiceReply", false),
        voiceName = obj.optString("voiceName", ""),
        language = obj.optString("language", "auto"),
        avatarKind = obj.optString("avatarKind", "initials"),
        avatarRef = obj.optString("avatarRef", ""),
    )

    fun session(obj: JSONObject) = ChatSession(
        id = obj.getString("id"),
        agentId = obj.optString("agentId", "").takeIf { it.isNotBlank() && it != "null" },
        title = obj.optString("title", "").takeIf { it.isNotBlank() && it != "null" } ?: "New chat",
        modelPin = obj.optString("modelPin", "").takeIf { it.isNotBlank() && it != "null" },
        mode = obj.optString("mode", "chat"),
        updatedAt = obj.optString("updatedAt", ""),
        summary = obj.optString("summary", "").takeIf { it != "null" }.orEmpty(),
    )
}
