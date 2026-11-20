package com.localagent.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.localagent.app.model.Persona
import kotlinx.coroutines.launch

@Composable
fun LocalAgentApp(vm: ChatViewModel, onVoiceDictation: () -> Unit) {
    val state by vm.ui.collectAsState()
    var showSettings by remember { mutableStateOf(false) }

    when {
        state.checkingAuth -> {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                    Text("Connecting to local-agent…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        !state.authenticated -> ConnectScreen(state = state, onConnect = vm::connectAndLogin)
        showSettings -> SettingsScreen(
            state = state,
            onBack = { showSettings = false },
            onRefreshModels = vm::refreshModels,
            onPullModel = vm::pullModel,
            onSaveSearx = vm::saveSearxngUrl,
            onAutoDetectSearx = vm::autoDetectSearxng,
            onToggleVoice = vm::togglePersonaVoice,
            onSignOut = { showSettings = false; vm.signOut() },
        )
        else -> MainChatShell(
            state = state,
            vm = vm,
            onOpenSettings = { showSettings = true },
            onVoiceDictation = onVoiceDictation,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainChatShell(
    state: AppUiState,
    vm: ChatViewModel,
    onOpenSettings: () -> Unit,
    onVoiceDictation: () -> Unit,
) {
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var showModelSheet by remember { mutableStateOf(false) }
    var showContextSheet by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }

    LaunchedEffect(state.snackbar) {
        val msg = state.snackbar ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(msg)
        vm.consumeSnackbar()
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = MaterialTheme.colorScheme.surface,
                modifier = Modifier.width(310.dp),
            ) {
                Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("local-agent", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                        IconButton(onClick = { scope.launch { drawerState.close() }; vm.startNewChat() }) {
                            Icon(Icons.Default.AddComment, contentDescription = "New chat")
                        }
                        IconButton(onClick = { scope.launch { drawerState.close() }; onOpenSettings() }) {
                            Icon(Icons.Default.Settings, contentDescription = "Settings")
                        }
                    }

                    OutlinedTextField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        placeholder = { Text("Search chats…") },
                        singleLine = true,
                        leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                    )

                    LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(vertical = 8.dp)) {
                        item {
                            Text("PERSONAS", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                        }
                        items(state.personas, key = { it.id }) { persona ->
                            NavigationDrawerItem(
                                selected = state.activePersona?.id == persona.id,
                                onClick = { scope.launch { drawerState.close() }; vm.openPersona(persona.id) },
                                icon = { PersonaAvatar(persona, 30) },
                                label = {
                                    Column {
                                        Text(persona.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                                        if (persona.title.isNotBlank()) {
                                            Text(persona.title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                },
                                badge = if (persona.unread > 0) { { Badge { Text("${persona.unread}") } } } else null,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 2.dp),
                            )
                        }

                        item {
                            Spacer(Modifier.height(8.dp))
                            Text("RECENT CHATS", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                        }
                        val filteredSessions = state.sessions.filter {
                            searchQuery.isBlank() || it.title.contains(searchQuery, ignoreCase = true)
                        }
                        items(filteredSessions, key = { it.id }) { session ->
                            NavigationDrawerItem(
                                selected = state.currentSession?.id == session.id,
                                onClick = { scope.launch { drawerState.close() }; vm.openSession(session.id) },
                                icon = { Icon(Icons.Default.ChatBubbleOutline, null, Modifier.size(18.dp)) },
                                label = { Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                badge = {
                                    IconButton(onClick = { vm.deleteChat(session.id) }, modifier = Modifier.size(28.dp)) {
                                        Icon(Icons.Default.DeleteOutline, contentDescription = "Delete chat", modifier = Modifier.size(16.dp))
                                    }
                                },
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 1.dp),
                            )
                        }
                    }

                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.AccountCircle, null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(8.dp))
                        Text(state.username.ifBlank { "Owner" }, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        TextButton(onClick = { scope.launch { drawerState.close() }; onOpenSettings() }) { Text("System") }
                    }
                }
            }
        },
    ) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            containerColor = MaterialTheme.colorScheme.background,
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(Icons.Default.Menu, contentDescription = "Open menu")
                        }
                    },
                    title = {
                        val persona = state.activePersona
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (persona != null) PersonaAvatar(persona, 30)
                            Column {
                                Text(persona?.name ?: "Chat", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                val pinnedName = state.currentSession?.modelPin?.let { pin -> state.models.firstOrNull { it.id == pin }?.name } ?: "Auto"
                                Text(pinnedName, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                            }
                        }
                    },
                    actions = {
                        ModeTogglePill(coderMode = state.coderMode, onToggle = vm::setCoderMode)
                        Spacer(Modifier.width(4.dp))
                        state.breakdown?.let { bd ->
                            ContextRingChip(breakdown = bd, onClick = { showContextSheet = true })
                        }
                        IconButton(onClick = {
                            val on = vm.toggleVoiceMode()
                            if (on && !state.isStreaming) onVoiceDictation()
                        }) {
                            Icon(
                                Icons.Default.Headphones,
                                contentDescription = if (state.voiceMode) "Voice mode ON" else "Voice mode",
                                tint = if (state.voiceMode) AccentGold else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(onClick = { showModelSheet = true }) {
                            Icon(Icons.Default.Tune, contentDescription = "Models")
                        }
                    },
                )
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
                val listState = rememberLazyListState()
                val visibleMessages = remember(state.messages) {
                    state.messages.filter { it.role == "user" || it.role == "assistant" || it.role == "tool" }
                }

                LaunchedEffect(visibleMessages.size, state.streamingText.length) {
                    if (visibleMessages.isNotEmpty() || state.streamingText.isNotBlank()) {
                        val last = (visibleMessages.size + (if (state.streamingText.isNotBlank() || state.streamingThinking.isNotBlank()) 1 else 0) - 1).coerceAtLeast(0)
                        listState.animateScrollToItem(last)
                    }
                }

                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (visibleMessages.isEmpty() && !state.isStreaming) {
                        item { EmptyWelcomeCard(persona = state.activePersona, onPickPrompt = { vm.setDraft(it) }) }
                    }

                    items(visibleMessages, key = { it.id }) { msg ->
                        MessageBubble(
                            msg = msg,
                            persona = msg.agentId?.let { id -> state.personas.firstOrNull { it.id == id } },
                            isSpeaking = state.speakingId == msg.id,
                            onSpeak = { vm.speakMessage(msg.id, msg.content, msg.agentId) },
                        )
                    }

                    if (state.streamingThinking.isNotBlank() || state.streamingText.isNotBlank()) {
                        item(key = "streaming_live") {
                            StreamingBubble(persona = state.activePersona, thinking = state.streamingThinking, text = state.streamingText)
                        }
                    }

                    if (state.steps.isNotEmpty() && (state.coderMode || state.isStreaming)) {
                        item(key = "decision_timeline") {
                            CursorTimelineCard(steps = state.steps, live = state.isStreaming)
                        }
                    }

                    if (state.coderMode || state.edits.isNotEmpty()) {
                        items(state.edits, key = { "edit_${it.id}" }) { edit ->
                            MobileDiffCard(
                                edit = edit,
                                kept = edit.id in state.keptEditIds,
                                onKeep = { vm.keepEdit(edit.id) },
                                onRevert = { vm.revertEdit(edit.id) },
                            )
                        }
                    }

                    if (state.runStatus == "waiting") {
                        item(key = "wait_memory") {
                            MemoryWaitCard(
                                detail = state.statusDetail.ifBlank { "Waiting for available RAM (MemAvailable)…" },
                                onRecheck = vm::recheckMemoryNow,
                                onForce = { vm.controlRun("force") },
                                onCancel = { vm.controlRun("stop") },
                            )
                        }
                    }

                    items(state.approvals, key = { it.id }) { approval ->
                        ApprovalCard(
                            item = approval,
                            onApprove = { vm.decideApproval(approval.id, "approve") },
                            onDeny = { vm.decideApproval(approval.id, "deny") },
                        )
                    }

                    if (state.isStreaming && state.runStatus != "waiting" && state.streamingText.isBlank() && state.streamingThinking.isBlank()) {
                        item(key = "typing") {
                            Row(Modifier.padding(vertical = 6.dp, horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                Text(state.statusDetail.ifBlank { "Working…" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }

                    if (!state.runError.isNullOrBlank()) {
                        item(key = "run_error") {
                            Surface(color = MaterialTheme.colorScheme.error.copy(alpha = 0.14f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                                Text(state.runError, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }

                state.breakdown?.let { bd ->
                    MobileContextNudge(
                        percent = bd.percent,
                        onCompact = vm::compactCurrentChat,
                        onHandoff = vm::handoffCurrentChat,
                    )
                }

                ComposerBar(
                    draft = state.draft,
                    isStreaming = state.isStreaming,
                    onDraftChange = vm::setDraft,
                    onSend = vm::sendCurrentMessage,
                    onStop = { vm.controlRun("stop") },
                    onVoice = onVoiceDictation,
                )
            }
        }
    }

    if (showModelSheet) {
        ModelPickerSheet(
            models = state.models,
            currentPin = state.currentSession?.modelPin,
            refreshing = state.refreshingModels,
            pullingStatus = state.pullingStatus,
            onDismiss = { showModelSheet = false },
            onSelect = { id -> vm.pinModel(id); showModelSheet = false },
            onRefresh = vm::refreshModels,
            onPull = vm::pullModel,
        )
    }

    if (showContextSheet && state.breakdown != null) {
        ContextBreakdownSheet(breakdown = state.breakdown!!, onDismiss = { showContextSheet = false })
    }
}

@Composable
private fun EmptyWelcomeCard(persona: Persona?, onPickPrompt: (String) -> Unit) {
    val starters = listOf(
        "Summarize my latest notes and priorities",
        "Search the web for the latest news on local LLMs",
        "Help me plan my week step by step",
    )
    Column(
        Modifier.fillMaxWidth().padding(vertical = 32.dp, horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (persona != null) PersonaAvatar(persona, 60)
        Text(persona?.let { "Chat with ${it.name}" } ?: "Start a conversation", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        if (!persona?.description.isNullOrBlank()) {
            Text(persona!!.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(6.dp))
        starters.forEach { prompt ->
            OutlinedCard(onClick = { onPickPrompt(prompt) }, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Text(prompt, modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
