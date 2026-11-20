package com.localagent.app.data

import android.content.Context
import com.localagent.app.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val statusCode: Int, message: String) : IOException(message)

class LocalAgentClient(context: Context) {
    private val prefs = context.getSharedPreferences("local-agent-native", Context.MODE_PRIVATE)
    private val cacheDir = File(context.filesDir, "transcript-cache").apply { mkdirs() }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    var baseUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(value) {
            val cleaned = value.trim().trimEnd('/')
            prefs.edit().putString("server_url", cleaned).apply()
            // Also keep WorkManager ApprovalWorker prefs in sync
            prefs.edit().putString("url", cleaned).apply()
        }

    var bearerToken: String
        get() = prefs.getString("bearer_token", "") ?: ""
        set(value) {
            prefs.edit().putString("bearer_token", value.trim()).apply()
        }

    private var sessionCookie: String
        get() = prefs.getString("la_session_cookie", "") ?: ""
        set(value) {
            prefs.edit().putString("la_session_cookie", value).apply()
        }

    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            cookies.firstOrNull { it.name == "la_session" }?.let { c ->
                sessionCookie = if (c.value.isBlank()) "" else "${c.name}=${c.value}"
            }
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val raw = sessionCookie
            if (raw.isBlank()) return emptyList()
            val parts = raw.split("=", limit = 2)
            if (parts.size != 2) return emptyList()
            return listOf(
                Cookie.Builder()
                    .name(parts[0])
                    .value(parts[1])
                    .domain(url.host)
                    .path("/")
                    .build()
            )
        }
    }

    private val http = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val req = chain.request().newBuilder()
            val token = bearerToken
            if (token.isNotBlank()) req.header("Authorization", "Bearer $token")
            chain.proceed(req.build())
        }
        .build()

    private val sseHttp = http.newBuilder()
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    private fun url(path: String): String {
        val root = baseUrl.trimEnd('/')
        if (root.isBlank()) throw ApiException(0, "Server URL is not set.")
        return "$root$path"
    }

    private suspend fun requestJson(
        method: String,
        path: String,
        body: JSONObject? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url(path))
        val reqBody = body?.toString()?.toRequestBody(jsonType)
            ?: if (method == "POST" || method == "PATCH" || method == "PUT") "{}".toRequestBody(jsonType) else null
        builder.method(method, reqBody)
        http.newCall(builder.build()).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val msg = runCatching { JSONObject(raw).optString("error") }.getOrNull()
                    ?.takeIf { it.isNotBlank() } ?: "HTTP ${resp.code}"
                throw ApiException(resp.code, msg)
            }
            if (raw.isBlank()) JSONObject() else JSONObject(raw)
        }
    }

    suspend fun checkHealth(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val resp = requestJson("GET", "/api/health")
            resp.optBoolean("ok", true)
        }.getOrDefault(false)
    }

    suspend fun me(): AuthMe {
        val json = requestJson("GET", "/api/auth/me")
        return AuthMe(
            authenticated = json.optBoolean("authenticated", false),
            username = json.optString("username", ""),
            displayName = json.optString("displayName", ""),
            role = json.optString("role", "owner"),
            needsSetup = json.optBoolean("needsSetup", false),
        )
    }

    suspend fun login(username: String, password: String): AuthMe {
        requestJson("POST", "/api/auth/login", JSONObject().apply {
            put("username", username.trim())
            put("password", password)
        })
        return me()
    }

    suspend fun logout() {
        runCatching { requestJson("POST", "/api/auth/logout") }
        sessionCookie = ""
    }

    suspend fun listAgents(): List<Persona> {
        val json = requestJson("GET", "/api/agents")
        val arr = json.optJSONArray("agents") ?: JSONArray()
        return List(arr.length()) { i -> parsePersona(arr.getJSONObject(i)) }
    }

    suspend fun openAgentChat(agentId: String): ChatSession {
        val json = requestJson("POST", "/api/agents/$agentId/open-chat")
        return parseSession(json.getJSONObject("session"))
    }

    suspend fun updateAgentVoice(agentId: String, voiceReply: Boolean, voiceName: String = ""): Persona {
        val json = requestJson("PATCH", "/api/agents/$agentId", JSONObject().apply {
            put("voiceReply", voiceReply)
            put("voiceName", voiceName)
        })
        return parsePersona(json.getJSONObject("agent"))
    }

    suspend fun listSessions(): List<ChatSession> {
        val json = requestJson("GET", "/api/sessions?limit=60")
        val arr = json.optJSONArray("sessions") ?: JSONArray()
        return List(arr.length()) { i -> parseSession(arr.getJSONObject(i)) }
    }

    suspend fun createSession(agentId: String?): ChatSession {
        val json = requestJson("POST", "/api/sessions", JSONObject().apply {
            if (!agentId.isNullOrBlank()) put("agentId", agentId)
            put("title", "New chat")
        })
        return parseSession(json.getJSONObject("session"))
    }

    suspend fun deleteSession(sessionId: String) {
        requestJson("DELETE", "/api/sessions/$sessionId")
    }

    suspend fun patchSessionModelPin(sessionId: String, modelPin: String?) {
        requestJson("PATCH", "/api/sessions/$sessionId", JSONObject().apply {
            put("modelPin", modelPin ?: JSONObject.NULL)
        })
    }

    suspend fun getSession(sessionId: String): SessionDetail {
        return try {
            val json = requestJson("GET", "/api/sessions/$sessionId?limit=150")
            saveCachedSession(sessionId, json)
            parseSessionDetail(json)
        } catch (e: IOException) {
            loadCachedSession(sessionId)?.let { parseSessionDetail(it) } ?: throw e
        }
    }

    suspend fun sendMessage(sessionId: String, content: String, agentId: String?): String {
        val json = requestJson("POST", "/api/sessions/$sessionId/messages", JSONObject().apply {
            put("content", content)
            if (!agentId.isNullOrBlank()) put("agentId", agentId)
        })
        return json.getJSONObject("run").getString("id")
    }

    suspend fun controlRun(runId: String, action: String) {
        requestJson("POST", "/api/runs/$runId/control", JSONObject().apply {
            put("action", action)
        })
    }

    suspend fun recheckMemory() {
        runCatching { requestJson("POST", "/api/memory/recheck") }
    }

    suspend fun revertEdit(editId: String) {
        requestJson("POST", "/api/edits/$editId/revert", JSONObject())
    }

    suspend fun compactSession(sessionId: String): Pair<Int, ContextBreakdown?> {
        val json = requestJson("POST", "/api/sessions/$sessionId/compact", JSONObject())
        return json.optInt("compactedMessages", 0) to parseBreakdown(json.optJSONObject("breakdown"))
    }

    suspend fun handoffSession(sessionId: String): ChatSession {
        val json = requestJson("POST", "/api/sessions/$sessionId/handoff", JSONObject())
        return parseSession(json.getJSONObject("session"))
    }

    suspend fun listUsableModels(): List<UsableModel> {
        val json = requestJson("GET", "/api/models/usable")
        val out = mutableListOf<UsableModel>()
        for (key in listOf("local", "cloud", "dev")) {
            val arr = json.optJSONArray(key) ?: continue
            for (i in 0 until arr.length()) {
                val m = arr.getJSONObject(i)
                out.add(
                    UsableModel(
                        id = m.getString("id"),
                        name = m.getString("name"),
                        local = m.optBoolean("local", key == "local"),
                        disabled = m.optBoolean("disabled", false),
                        reason = m.optString("reason", "").takeIf { it.isNotBlank() },
                    )
                )
            }
        }
        return out
    }

    suspend fun scanModels(): List<UsableModel> {
        runCatching { requestJson("POST", "/api/models/scan") }
        return listUsableModels()
    }

    suspend fun startPullModel(modelName: String): String {
        val json = requestJson("POST", "/api/setup/actions/pull-model/run", JSONObject().apply {
            put("confirm", true)
            put("model", modelName.trim())
        })
        return json.getJSONObject("job").getString("id")
    }

    suspend fun getJob(jobId: String): Pair<String, String> {
        val json = requestJson("GET", "/api/jobs/$jobId").getJSONObject("job")
        val status = json.optString("status", "running")
        val lastLine = json.optString("output", "").trim().lines().lastOrNull().orEmpty()
        return status to lastLine
    }

    suspend fun listApprovals(runId: String? = null): List<ApprovalItem> {
        val json = requestJson("GET", "/api/approvals")
        val arr = json.optJSONArray("approvals") ?: JSONArray()
        return List(arr.length()) { i ->
            val a = arr.getJSONObject(i)
            ApprovalItem(
                id = a.getString("id"),
                runId = a.getString("runId"),
                toolName = a.optString("toolName", "tool"),
                reason = a.optString("reason", ""),
            )
        }.filter { runId == null || it.runId == runId }
    }

    suspend fun decideApproval(id: String, decision: String) {
        requestJson("POST", "/api/approvals/$id", JSONObject().apply {
            put("decision", decision)
        })
    }

    suspend fun getSettings(): ServerSettings {
        val s = requestJson("GET", "/api/settings").optJSONObject("settings") ?: JSONObject()
        return ServerSettings(
            searxngUrl = s.optString("searxngUrl", ""),
            geminiTier = s.optString("geminiTier", "free"),
        )
    }

    suspend fun patchSearxngUrl(url: String) {
        requestJson("PATCH", "/api/settings", JSONObject().apply {
            put("searxngUrl", url.trim())
        })
    }

    suspend fun testSearxng(url: String): Pair<Boolean, String> {
        val json = requestJson("POST", "/api/settings/searxng/test", JSONObject().apply {
            put("url", url.trim())
        })
        return json.optBoolean("ok", false) to (json.optString("url", "").ifBlank { json.optString("detail", "") })
    }

    suspend fun fetchSpeechAudio(text: String, agentId: String? = null): ByteArray? = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("text", text.take(2000))
            if (!agentId.isNullOrBlank()) put("agentId", agentId)
        }.toString().toRequestBody(jsonType)
        val req = Request.Builder().url(url("/api/voice/speak")).post(body).build()
        runCatching {
            http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.bytes() else null
            }
        }.getOrNull()
    }

    fun streamRun(runId: String, onEvent: (JSONObject) -> Unit, onClosed: () -> Unit): EventSource {
        val req = Request.Builder()
            .url(url("/api/runs/$runId/events"))
            .header("Accept", "text/event-stream")
            .build()
        return EventSources.createFactory(sseHttp).newEventSource(req, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                runCatching { JSONObject(data) }.onSuccess(onEvent)
            }

            override fun onClosed(eventSource: EventSource) = onClosed()
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) = onClosed()
        })
    }

    private fun saveCachedSession(sessionId: String, json: JSONObject) {
        runCatching {
            File(cacheDir, "${sessionId.replace(Regex("[^a-zA-Z0-9_-]"), "_")}.json").writeText(json.toString())
        }
    }

    private fun loadCachedSession(sessionId: String): JSONObject? {
        return runCatching {
            val file = File(cacheDir, "${sessionId.replace(Regex("[^a-zA-Z0-9_-]"), "_")}.json")
            if (file.exists()) JSONObject(file.readText()) else null
        }.getOrNull()
    }

    private fun parsePersona(obj: JSONObject) = Persona(
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
    )

    private fun parseSession(obj: JSONObject) = ChatSession(
        id = obj.getString("id"),
        agentId = obj.optString("agentId", "").takeIf { it.isNotBlank() },
        title = obj.optString("title", "New chat"),
        modelPin = obj.optString("modelPin", "").takeIf { it.isNotBlank() && it != "null" },
        mode = obj.optString("mode", "chat"),
        updatedAt = obj.optString("updatedAt", ""),
    )

    fun parseMessage(obj: JSONObject) = ChatMessage(
        id = obj.optString("id", "msg"),
        role = obj.optString("role", "assistant"),
        content = obj.optString("content", ""),
        agentId = obj.optString("agentId", "").takeIf { it.isNotBlank() && it != "null" },
        thinking = obj.optString("thinking", "").takeIf { it.isNotBlank() && it != "null" },
        routingNote = obj.optString("routingNote", "").takeIf { it.isNotBlank() && it != "null" },
        toolName = obj.optString("toolName", "").takeIf { it.isNotBlank() && it != "null" },
        createdAt = obj.optString("createdAt", ""),
    )

    fun parseBreakdown(obj: JSONObject?) = obj?.let {
        ContextBreakdown(
            budget = it.optInt("budget", 1),
            used = it.optInt("used", 0),
            remaining = it.optInt("remaining", 0),
            outputReserve = it.optInt("outputReserve", 2048),
            systemPrompt = it.optInt("systemPrompt", 0),
            personaAndTools = it.optInt("personaAndTools", 0),
            memory = it.optInt("memory", 0),
            history = it.optInt("history", 0),
            files = it.optInt("files", 0),
        )
    }

    fun parseStep(obj: JSONObject): RunStep {
        val outAny = obj.opt("output")
        val outStr = when (outAny) {
            null, JSONObject.NULL -> ""
            is JSONObject -> outAny.optString("reason", "").ifBlank { outAny.toString().take(800) }
            else -> outAny.toString().take(800)
        }
        return RunStep(
            id = obj.optString("id", "step"),
            kind = obj.optString("kind", "tool"),
            name = obj.optString("name", "step"),
            status = obj.optString("status", "completed"),
            latencyMs = obj.optInt("latencyMs", 0),
            output = outStr,
            error = obj.optString("error", "").takeIf { it.isNotBlank() && it != "null" },
        )
    }

    private fun parseSessionDetail(json: JSONObject): SessionDetail {
        val session = parseSession(json.getJSONObject("session"))
        val arr = json.optJSONArray("messages") ?: JSONArray()
        val messages = List(arr.length()) { i -> parseMessage(arr.getJSONObject(i)) }
        val editsArr = json.optJSONArray("edits") ?: JSONArray()
        val edits = List(editsArr.length()) { i ->
            val e = editsArr.getJSONObject(i)
            EditDiff(
                id = e.optString("id", ""),
                label = e.optString("label", "edit"),
                diff = e.optString("diff", ""),
                revertedAt = e.optString("revertedAt", "").takeIf { it.isNotBlank() && it != "null" },
            )
        }
        val activeRun = json.optJSONObject("activeRun")
        val liveObj = json.optJSONObject("live")
        val live = liveObj?.let {
            LiveStreamSnapshot(
                text = it.optString("text", ""),
                thinking = it.optString("thinking", ""),
                status = it.optString("status", ""),
                detail = it.optString("detail", ""),
            )
        }
        return SessionDetail(
            session = session,
            messages = messages,
            edits = edits,
            activeRunId = activeRun?.optString("id")?.takeIf { it.isNotBlank() },
            activeRunStatus = activeRun?.optString("status")?.takeIf { it.isNotBlank() },
            live = live,
            breakdown = parseBreakdown(json.optJSONObject("breakdown")),
        )
    }
}
