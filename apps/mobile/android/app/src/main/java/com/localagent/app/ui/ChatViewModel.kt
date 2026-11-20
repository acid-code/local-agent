package com.localagent.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.localagent.app.data.AudioPlayer
import com.localagent.app.data.LocalAgentClient
import com.localagent.app.model.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.sse.EventSource

data class AppUiState(
    val checkingAuth: Boolean = true,
    val authenticated: Boolean = false,
    val username: String = "",
    val role: String = "owner",
    val serverUrl: String = "",
    val authError: String? = null,
    val connecting: Boolean = false,
    val personas: List<Persona> = emptyList(),
    val sessions: List<ChatSession> = emptyList(),
    val currentSession: ChatSession? = null,
    val messages: List<ChatMessage> = emptyList(),
    val edits: List<EditDiff> = emptyList(),
    val keptEditIds: Set<String> = emptySet(),
    val steps: List<RunStep> = emptyList(),
    val coderMode: Boolean = false,
    val models: List<UsableModel> = emptyList(),
    val refreshingModels: Boolean = false,
    val pullingStatus: String? = null,
    val activeRunId: String? = null,
    val runStatus: String = "",
    val statusDetail: String = "",
    val streamingText: String = "",
    val streamingThinking: String = "",
    val runError: String? = null,
    val approvals: List<ApprovalItem> = emptyList(),
    val breakdown: ContextBreakdown? = null,
    val draft: String = "",
    val speakingId: String? = null,
    val voiceMode: Boolean = false,
    val snackbar: String? = null,
    val searxngUrl: String = "",
    val searxngStatus: String? = null,
) {
    val activePersona: Persona?
        get() = currentSession?.agentId?.let { id -> personas.firstOrNull { it.id == id } } ?: personas.firstOrNull()

    val isStreaming: Boolean
        get() = runStatus in setOf("running", "loading", "waiting", "paused", "awaiting_approval")
}

class ChatViewModel(application: Application) : AndroidViewModel(application) {
    val client = LocalAgentClient(application.applicationContext)
    private val audio = AudioPlayer(application.applicationContext, client)
    private val _ui = MutableStateFlow(AppUiState(serverUrl = client.baseUrl))
    val ui: StateFlow<AppUiState> = _ui.asStateFlow()

    private var eventSource: EventSource? = null
    private var memoryPollJob: Job? = null

    init {
        if (client.baseUrl.isNotBlank()) checkSession()
        else _ui.update { it.copy(checkingAuth = false, authenticated = false) }
    }

    fun consumeSnackbar() = _ui.update { it.copy(snackbar = null) }
    fun setDraft(text: String) = _ui.update { it.copy(draft = text) }
    fun setCoderMode(on: Boolean) = _ui.update { it.copy(coderMode = on) }
    fun keepEdit(id: String) = _ui.update { it.copy(keptEditIds = it.keptEditIds + id) }

    fun revertEdit(id: String) {
        viewModelScope.launch {
            runCatching { client.revertEdit(id) }
                .onSuccess {
                    _ui.update { it.copy(snackbar = "Reverted edit") }
                    _ui.value.currentSession?.id?.let { openSession(it) }
                }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message ?: "Revert failed") } }
        }
    }

    fun compactCurrentChat() {
        val sid = _ui.value.currentSession?.id ?: return
        viewModelScope.launch {
            runCatching { client.compactSession(sid) }
                .onSuccess { (count, bd) ->
                    _ui.update { it.copy(breakdown = bd ?: it.breakdown, snackbar = if (count > 0) "Compacted $count messages" else "Chat is already compact") }
                }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message ?: "Compact failed") } }
        }
    }

    fun handoffCurrentChat() {
        val sid = _ui.value.currentSession?.id ?: return
        viewModelScope.launch {
            runCatching { client.handoffSession(sid) }
                .onSuccess { fresh ->
                    refreshSessions()
                    openSession(fresh.id)
                    _ui.update { it.copy(snackbar = "Continued in fresh chat") }
                }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message ?: "Handoff failed") } }
        }
    }

    fun toggleVoiceMode(): Boolean {
        val next = !_ui.value.voiceMode
        _ui.update { it.copy(voiceMode = next, snackbar = if (next) "Voice-first mode ON" else "Voice-first mode OFF") }
        if (!next) audio.stop()
        return next
    }

    fun onDictationResult(text: String) {
        if (text.isBlank()) return
        appendSharedText(text)
        if (_ui.value.voiceMode && !_ui.value.isStreaming) {
            sendCurrentMessage()
        }
    }

    fun appendSharedText(text: String) {
        if (text.isBlank()) return
        _ui.update { it.copy(draft = if (it.draft.isBlank()) text.trim() else "${it.draft}\n${text.trim()}") }
    }

    fun checkSession() {
        viewModelScope.launch {
            _ui.update { it.copy(checkingAuth = true, authError = null) }
            runCatching { client.me() }
                .onSuccess { me ->
                    if (me.authenticated) {
                        _ui.update {
                            it.copy(
                                checkingAuth = false,
                                authenticated = true,
                                username = me.displayName.ifBlank { me.username },
                                role = me.role,
                                serverUrl = client.baseUrl,
                            )
                        }
                        loadWorkspace()
                    } else {
                        _ui.update { it.copy(checkingAuth = false, authenticated = false, serverUrl = client.baseUrl) }
                    }
                }
                .onFailure { err ->
                    _ui.update { it.copy(checkingAuth = false, authenticated = false, authError = err.message ?: "Server unreachable") }
                }
        }
    }

    fun connectAndLogin(url: String, username: String, password: String, token: String) {
        viewModelScope.launch {
            val normalized = normalizeUrl(url)
            if (normalized.isBlank()) {
                _ui.update { it.copy(authError = "Enter your server URL (e.g. http://100.x.x.x:8787)") }
                return@launch
            }
            _ui.update { it.copy(connecting = true, authError = null) }
            client.baseUrl = normalized
            client.bearerToken = token.trim()

            runCatching {
                if (!client.checkHealth()) error("Server did not answer at $normalized")
                val me = if (token.isNotBlank()) client.me() else client.login(username, password)
                if (!me.authenticated) error("Sign-in failed. Check credentials or token.")
                me
            }.onSuccess { me ->
                _ui.update {
                    it.copy(
                        connecting = false,
                        checkingAuth = false,
                        authenticated = true,
                        username = me.displayName.ifBlank { me.username },
                        role = me.role,
                        serverUrl = normalized,
                    )
                }
                loadWorkspace()
            }.onFailure { err ->
                _ui.update { it.copy(connecting = false, authError = err.message ?: "Connection failed") }
            }
        }
    }

    fun signOut() {
        closeStream()
        audio.stop()
        viewModelScope.launch {
            client.logout()
            client.bearerToken = ""
            _ui.update { AppUiState(checkingAuth = false, authenticated = false, serverUrl = client.baseUrl) }
        }
    }

    fun loadWorkspace() {
        viewModelScope.launch {
            val agents = runCatching { client.listAgents().filterNot { it.hidden } }.getOrDefault(emptyList())
            val sessions = runCatching { client.listSessions() }.getOrDefault(emptyList())
            val models = runCatching { client.listUsableModels() }.getOrDefault(emptyList())
            val settings = runCatching { client.getSettings() }.getOrNull()
            _ui.update {
                it.copy(
                    personas = agents,
                    sessions = sessions,
                    models = models,
                    searxngUrl = settings?.searxngUrl ?: it.searxngUrl,
                )
            }
            val targetId = _ui.value.currentSession?.id ?: sessions.firstOrNull()?.id
            when {
                targetId != null -> openSession(targetId)
                agents.isNotEmpty() -> openPersona(agents.first().id)
            }
            if (models.none { it.local }) retryModelsUntilReady()
        }
    }

    private fun retryModelsUntilReady() {
        viewModelScope.launch {
            repeat(8) {
                delay(3500)
                val found = runCatching { client.listUsableModels() }.getOrDefault(emptyList())
                if (found.any { it.local }) {
                    _ui.update { it.copy(models = found) }
                    return@launch
                }
            }
        }
    }

    fun openPersona(personaId: String) {
        viewModelScope.launch {
            runCatching { client.openAgentChat(personaId) }
                .onSuccess { session -> refreshSessions(); openSession(session.id) }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun startNewChat(personaId: String? = _ui.value.activePersona?.id) {
        viewModelScope.launch {
            runCatching { client.createSession(personaId) }
                .onSuccess { session -> refreshSessions(); openSession(session.id) }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun deleteChat(sessionId: String) {
        viewModelScope.launch {
            runCatching { client.deleteSession(sessionId) }
                .onSuccess {
                    val remaining = runCatching { client.listSessions() }.getOrDefault(emptyList())
                    _ui.update { it.copy(sessions = remaining, snackbar = "Chat deleted") }
                    if (_ui.value.currentSession?.id == sessionId) {
                        val next = remaining.firstOrNull()
                        if (next != null) openSession(next.id)
                        else _ui.update { it.copy(currentSession = null, messages = emptyList(), breakdown = null) }
                    }
                }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun openSession(sessionId: String) {
        closeStream()
        viewModelScope.launch {
            runCatching { client.getSession(sessionId) }
                .onSuccess { detail ->
                    _ui.update {
                        val p = it.personas.firstOrNull { a -> a.id == detail.session.agentId }
                        val autoCoder = detail.session.mode == "code" || detail.edits.isNotEmpty() || (p?.name?.contains("coder", true) == true)
                        it.copy(
                            currentSession = detail.session,
                            messages = detail.messages,
                            edits = detail.edits,
                            steps = emptyList(),
                            coderMode = autoCoder,
                            breakdown = detail.breakdown,
                            activeRunId = detail.activeRunId,
                            runStatus = detail.live?.status?.ifBlank { detail.activeRunStatus ?: "" } ?: (detail.activeRunStatus ?: ""),
                            statusDetail = detail.live?.detail ?: "",
                            streamingText = detail.live?.text ?: "",
                            streamingThinking = detail.live?.thinking ?: "",
                            runError = null,
                            approvals = emptyList(),
                        )
                    }
                    if (!detail.activeRunId.isNullOrBlank()) attachStream(detail.activeRunId)
                }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message ?: "Failed to open chat") } }
        }
    }

    fun sendCurrentMessage() {
        val text = _ui.value.draft.trim()
        if (text.isBlank()) return
        if (_ui.value.isStreaming) {
            _ui.update { it.copy(snackbar = "A reply is still running. Tap Stop first.") }
            return
        }
        viewModelScope.launch {
            val session = _ui.value.currentSession ?: runCatching {
                client.createSession(_ui.value.activePersona?.id)
            }.getOrNull() ?: return@launch

            val optimistic = ChatMessage(id = "local_${System.currentTimeMillis()}", role = "user", content = text, agentId = session.agentId)
            _ui.update {
                it.copy(
                    currentSession = session,
                    draft = "",
                    runError = null,
                    streamingText = "",
                    streamingThinking = "",
                    statusDetail = "",
                    messages = it.messages + optimistic,
                )
            }
            runCatching { client.sendMessage(session.id, text, session.agentId) }
                .onSuccess { runId ->
                    _ui.update { it.copy(activeRunId = runId, runStatus = "running") }
                    attachStream(runId)
                    refreshSessions()
                }
                .onFailure { err ->
                    _ui.update {
                        it.copy(
                            draft = text,
                            messages = it.messages.filterNot { m -> m.id == optimistic.id },
                            snackbar = err.message ?: "Could not send message",
                        )
                    }
                }
        }
    }

    private fun attachStream(runId: String) {
        closeStream()
        eventSource = client.streamRun(
            runId = runId,
            onEvent = { json ->
                when (json.optString("type")) {
                    "snapshot" -> {
                        val runObj = json.optJSONObject("run")
                        val status = runObj?.optString("status", "") ?: ""
                        val detail = json.optString("statusDetail", "")
                        val effectiveStatus = if (status == "running" && detail.contains("Waiting for memory", true)) "waiting" else status
                        val stepsArr = json.optJSONArray("steps")
                        val parsedSteps = if (stepsArr != null) List(stepsArr.length()) { i -> client.parseStep(stepsArr.getJSONObject(i)) } else null
                        _ui.update { s ->
                            s.copy(
                                runStatus = effectiveStatus,
                                statusDetail = detail.ifBlank { s.statusDetail },
                                streamingText = json.optString("streaming", "").ifBlank { s.streamingText },
                                streamingThinking = json.optString("thinking", "").ifBlank { s.streamingThinking },
                                steps = parsedSteps ?: s.steps,
                                runError = if (status == "failed") runObj?.optString("error", "Run failed") else s.runError,
                            )
                        }
                        if (effectiveStatus == "waiting") startMemoryRecheckLoop()
                        if (status in setOf("completed", "failed", "stopped", "interrupted")) {
                            closeStream()
                            _ui.value.currentSession?.id?.let { openSession(it) }
                        }
                    }
                    "step" -> {
                        val stepObj = json.optJSONObject("step")
                        if (stepObj != null) {
                            val parsed = client.parseStep(stepObj)
                            _ui.update { s -> s.copy(steps = s.steps.filterNot { it.id == parsed.id } + parsed) }
                        }
                    }
                    "token" -> {
                        val chunk = json.optString("text", "")
                        if (chunk.isNotEmpty()) _ui.update { it.copy(streamingText = it.streamingText + chunk, runStatus = "running") }
                    }
                    "thinking" -> {
                        val chunk = json.optString("text", "")
                        if (chunk.isNotEmpty()) _ui.update { it.copy(streamingThinking = it.streamingThinking + chunk) }
                    }
                    "message" -> {
                        val msg = json.optJSONObject("message")?.let(client::parseMessage) ?: return@streamRun
                        _ui.update { s ->
                            s.copy(
                                messages = s.messages.filterNot { it.id == msg.id || it.id.startsWith("local_") } + msg,
                                streamingText = "",
                                streamingThinking = "",
                            )
                        }
                        if (msg.role == "assistant" && msg.content.isNotBlank()) {
                            val speaker = _ui.value.personas.firstOrNull { it.id == msg.agentId }
                            if (speaker?.voiceReply == true || _ui.value.voiceMode) speakMessage(msg.id, msg.content, speaker?.id)
                        }
                    }
                    "context" -> client.parseBreakdown(json.optJSONObject("breakdown"))?.let { bd ->
                        _ui.update { it.copy(breakdown = bd) }
                    }
                    "status" -> {
                        val st = json.optString("status", "")
                        val detail = json.optString("detail", "")
                        _ui.update { it.copy(runStatus = st, statusDetail = detail) }
                        if (st == "waiting") startMemoryRecheckLoop() else stopMemoryRecheckLoop()
                        if (st == "awaiting_approval") refreshApprovals(runId)
                    }
                    "approval" -> refreshApprovals(runId)
                    "error" -> _ui.update { it.copy(runError = json.optString("message", "The reply failed.")) }
                    "done" -> {
                        val runObj = json.optJSONObject("run")
                        val finalStatus = runObj?.optString("status", "completed") ?: "completed"
                        closeStream()
                        _ui.update {
                            it.copy(
                                runStatus = finalStatus,
                                statusDetail = "",
                                runError = if (finalStatus == "failed") runObj?.optString("error", "Failed") else it.runError,
                            )
                        }
                        _ui.value.currentSession?.id?.let { openSession(it) }
                        refreshSessions()
                    }
                }
            },
            onClosed = { stopMemoryRecheckLoop() },
        )
    }

    private fun startMemoryRecheckLoop() {
        if (memoryPollJob?.isActive == true) return
        memoryPollJob = viewModelScope.launch {
            while (_ui.value.runStatus == "waiting") {
                delay(5000)
                client.recheckMemory()
            }
        }
    }

    private fun stopMemoryRecheckLoop() {
        memoryPollJob?.cancel()
        memoryPollJob = null
    }

    private fun closeStream() {
        stopMemoryRecheckLoop()
        eventSource?.cancel()
        eventSource = null
    }

    fun controlRun(action: String) {
        val id = _ui.value.activeRunId ?: return
        viewModelScope.launch {
            runCatching { client.controlRun(id, action) }
                .onSuccess {
                    if (action == "stop") _ui.update { it.copy(snackbar = "Stopped") }
                    if (action == "force") _ui.update { it.copy(snackbar = "Forcing run past memory wait…") }
                }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun recheckMemoryNow() {
        viewModelScope.launch {
            client.recheckMemory()
            _ui.update { it.copy(snackbar = "Re-checked memory") }
        }
    }

    private fun refreshApprovals(runId: String) {
        viewModelScope.launch {
            val list = runCatching { client.listApprovals(runId) }.getOrDefault(emptyList())
            _ui.update { it.copy(approvals = list) }
        }
    }

    fun decideApproval(id: String, decision: String) {
        viewModelScope.launch {
            _ui.update { it.copy(approvals = it.approvals.filterNot { a -> a.id == id }) }
            runCatching { client.decideApproval(id, decision) }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun pinModel(modelId: String?) {
        val sessionId = _ui.value.currentSession?.id ?: return
        viewModelScope.launch {
            runCatching { client.patchSessionModelPin(sessionId, modelId) }
                .onSuccess { _ui.update { s -> s.copy(currentSession = s.currentSession?.copy(modelPin = modelId)) } }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun refreshModels() {
        viewModelScope.launch {
            _ui.update { it.copy(refreshingModels = true) }
            runCatching { client.scanModels() }
                .onSuccess { models ->
                    _ui.update { it.copy(models = models, refreshingModels = false, snackbar = "${models.count { m -> m.local }} local models found") }
                }
                .onFailure { e -> _ui.update { it.copy(refreshingModels = false, snackbar = e.message) } }
        }
    }

    fun pullModel(modelName: String) {
        val trimmed = modelName.trim()
        if (trimmed.isBlank()) return
        viewModelScope.launch {
            _ui.update { it.copy(pullingStatus = "Starting pull for $trimmed…") }
            runCatching { client.startPullModel(trimmed) }
                .onSuccess { jobId ->
                    while (true) {
                        delay(1500)
                        val (st, line) = runCatching { client.getJob(jobId) }.getOrDefault("failed" to "Connection lost")
                        _ui.update { it.copy(pullingStatus = line.ifBlank { "Pulling $trimmed…" }) }
                        if (st != "running") {
                            if (st == "completed") {
                                val models = runCatching { client.scanModels() }.getOrDefault(_ui.value.models)
                                _ui.update { it.copy(models = models, pullingStatus = null, snackbar = "$trimmed ready") }
                            } else {
                                _ui.update { it.copy(pullingStatus = null, snackbar = "Pull failed: $line") }
                            }
                            break
                        }
                    }
                }
                .onFailure { e -> _ui.update { it.copy(pullingStatus = null, snackbar = e.message) } }
        }
    }

    fun togglePersonaVoice(personaId: String, enabled: Boolean) {
        viewModelScope.launch {
            runCatching { client.updateAgentVoice(personaId, enabled) }
                .onSuccess { updated ->
                    _ui.update { s -> s.copy(personas = s.personas.map { if (it.id == personaId) updated else it }) }
                }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun saveSearxngUrl(url: String) {
        viewModelScope.launch {
            runCatching { client.patchSearxngUrl(url) }
                .onSuccess { _ui.update { it.copy(searxngUrl = url.trim(), snackbar = "Saved SearXNG URL") } }
                .onFailure { e -> _ui.update { it.copy(snackbar = e.message) } }
        }
    }

    fun autoDetectSearxng(current: String) {
        viewModelScope.launch {
            _ui.update { it.copy(searxngStatus = "Testing…") }
            runCatching { client.testSearxng(current) }
                .onSuccess { (ok, res) ->
                    if (ok && res.startsWith("http")) {
                        client.patchSearxngUrl(res)
                        _ui.update { it.copy(searxngUrl = res, searxngStatus = "Connected: $res", snackbar = "SearXNG detected") }
                    } else {
                        _ui.update { it.copy(searxngStatus = res.ifBlank { "No SearXNG answered" }) }
                    }
                }
                .onFailure { e -> _ui.update { it.copy(searxngStatus = e.message) } }
        }
    }

    fun speakMessage(key: String, text: String, agentId: String?) {
        audio.speak(viewModelScope, key, text, agentId) { activeKey ->
            _ui.update { it.copy(speakingId = activeKey) }
        }
    }

    private fun refreshSessions() {
        viewModelScope.launch {
            val sessions = runCatching { client.listSessions() }.getOrDefault(_ui.value.sessions)
            val personas = runCatching { client.listAgents().filterNot { it.hidden } }.getOrDefault(_ui.value.personas)
            _ui.update { it.copy(sessions = sessions, personas = personas) }
        }
    }

    private fun normalizeUrl(raw: String): String {
        val t = raw.trim().trimEnd('/')
        if (t.isBlank()) return ""
        return if (t.startsWith("http://") || t.startsWith("https://")) t else "http://$t"
    }

    override fun onCleared() {
        closeStream()
        audio.release()
        super.onCleared()
    }
}
