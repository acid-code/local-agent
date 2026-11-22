package com.localagent.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.localagent.app.model.Persona

@Composable
fun LocalAgentApp(vm: ChatViewModel, onVoiceDictation: () -> Unit) {
    val state by vm.ui.collectAsState()

    CompositionLocalProvider(LocalAgentApi provides vm.client) {
        when {
            state.checkingAuth -> {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        CircularProgressIndicator(color = MaterialTheme.colorScheme.tertiary, strokeWidth = 3.dp)
                        Text("Connecting to your mini PC…", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            !state.authenticated -> ConnectScreen(state = state, onConnect = vm::connectAndLogin)
            else -> AppShell(state = state, vm = vm, onVoiceDictation = onVoiceDictation)
        }
    }
}

/** Native app shell: one screen per bottom tab, no desktop menus. The bar hides while typing. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AppShell(state: AppUiState, vm: ChatViewModel, onVoiceDictation: () -> Unit) {
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(state.snackbar) {
        val msg = state.snackbar ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(msg)
        vm.consumeSnackbar()
    }
    val imeVisible = WindowInsets.isImeVisible

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            AnimatedVisibility(
                visible = !(imeVisible && state.tab == AppTab.Chat),
                enter = slideInVertically { it } + fadeIn(),
                exit = slideOutVertically { it } + fadeOut(),
            ) {
                BottomTabs(state = state, onSelect = vm::selectTab)
            }
        },
    ) { padding ->
        AnimatedContent(
            targetState = state.tab,
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "tab",
        ) { tab ->
            when (tab) {
                AppTab.Chat -> ChatScreen(state, vm, onVoiceDictation, Modifier.padding(bottom = padding.calculateBottomPadding()).consumeWindowInsets(PaddingValues(bottom = padding.calculateBottomPadding())))
                AppTab.Chats -> ChatsScreen(
                    state = state,
                    contentPadding = padding,
                    onOpenSession = { vm.openSession(it); vm.selectTab(AppTab.Chat) },
                    onOpenPersona = { vm.openPersona(it); vm.selectTab(AppTab.Chat) },
                    onNewChat = { vm.startNewChat(); vm.selectTab(AppTab.Chat) },
                    onDelete = vm::deleteChat,
                )
                AppTab.Approvals -> ApprovalsScreen(
                    state = state,
                    onApprove = { vm.decideApproval(it, "approve") },
                    onDeny = { vm.decideApproval(it, "deny") },
                    onOpenChat = vm::openApprovalChat,
                    onRefresh = vm::refreshPendingApprovals,
                    contentPadding = padding,
                )
                AppTab.System -> Box(Modifier.padding(bottom = padding.calculateBottomPadding()).consumeWindowInsets(PaddingValues(bottom = padding.calculateBottomPadding()))) {
                    SettingsScreen(
                        state = state,
                        onBack = { vm.selectTab(AppTab.Chat) },
                        onRefreshModels = vm::refreshModels,
                        onPullModel = vm::pullModel,
                        onSaveSearx = vm::saveSearxngUrl,
                        onAutoDetectSearx = vm::autoDetectSearxng,
                        onToggleVoice = vm::togglePersonaVoice,
                        onSignOut = { vm.signOut() },
                    )
                }
            }
        }
    }
}

@Composable
private fun BottomTabs(state: AppUiState, onSelect: (AppTab) -> Unit) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
        val itemColors = NavigationBarItemDefaults.colors(
            indicatorColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.18f),
            selectedIconColor = MaterialTheme.colorScheme.onSurface,
            selectedTextColor = MaterialTheme.colorScheme.onSurface,
        )
        NavigationBarItem(
            selected = state.tab == AppTab.Chat, onClick = { onSelect(AppTab.Chat) }, colors = itemColors,
            icon = { Icon(if (state.tab == AppTab.Chat) Icons.Filled.ChatBubble else Icons.Outlined.ChatBubbleOutline, null) },
            label = { Text("Chat") },
        )
        NavigationBarItem(
            selected = state.tab == AppTab.Chats, onClick = { onSelect(AppTab.Chats) }, colors = itemColors,
            icon = { Icon(if (state.tab == AppTab.Chats) Icons.Filled.Forum else Icons.Outlined.Forum, null) },
            label = { Text("Chats") },
        )
        NavigationBarItem(
            selected = state.tab == AppTab.Approvals, onClick = { onSelect(AppTab.Approvals) }, colors = itemColors,
            icon = {
                BadgedBox(badge = { if (state.pendingApprovals.isNotEmpty()) Badge { Text("${state.pendingApprovals.size}") } }) {
                    Icon(if (state.tab == AppTab.Approvals) Icons.Filled.VerifiedUser else Icons.Outlined.VerifiedUser, null)
                }
            },
            label = { Text("Approvals") },
        )
        NavigationBarItem(
            selected = state.tab == AppTab.System, onClick = { onSelect(AppTab.System) }, colors = itemColors,
            icon = { Icon(if (state.tab == AppTab.System) Icons.Filled.Settings else Icons.Outlined.Settings, null) },
            label = { Text("System") },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(state: AppUiState, vm: ChatViewModel, onVoiceDictation: () -> Unit, modifier: Modifier) {
    var showModelSheet by remember { mutableStateOf(false) }
    var showContextSheet by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier,
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            val persona = state.activePersona
            val thinking = state.isStreaming
            Surface(color = MaterialTheme.colorScheme.background, shadowElevation = 0.dp) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .height(56.dp)
                        .padding(start = 12.dp, end = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (persona != null) {
                        PersonaAvatar(
                            persona,
                            32,
                            motion = if (thinking) FaceMotion.Thinking else FaceMotion.Idle,
                        )
                    }
                    Column(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { showModelSheet = true }
                            .padding(horizontal = 2.dp, vertical = 2.dp),
                    ) {
                        Text(
                            state.currentSession?.title?.takeIf { it.isNotBlank() } ?: persona?.name ?: "New chat",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val pinnedName = state.currentSession?.modelPin?.let { pin -> state.models.firstOrNull { it.id == pin }?.name } ?: "Auto"
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                pinnedName,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            Icon(Icons.Default.ExpandMore, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    state.breakdown?.let { bd -> ContextRingChip(breakdown = bd, onClick = { showContextSheet = true }) }
                    IconButton(onClick = { vm.startNewChat() }, modifier = Modifier.size(40.dp)) {
                        Icon(Icons.Outlined.AddComment, contentDescription = "New chat")
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(40.dp)) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(if (state.coderMode) "Switch to chat mode" else "Switch to code mode") },
                                leadingIcon = { Icon(if (state.coderMode) Icons.AutoMirrored.Outlined.Chat else Icons.Outlined.Code, null) },
                                onClick = { menuOpen = false; vm.setCoderMode(!state.coderMode) },
                            )
                            DropdownMenuItem(
                                text = { Text(if (state.voiceMode) "Voice mode: on" else "Voice mode: off") },
                                leadingIcon = { Icon(Icons.Outlined.Headphones, null, tint = if (state.voiceMode) AccentGold else MaterialTheme.colorScheme.onSurfaceVariant) },
                                onClick = {
                                    menuOpen = false
                                    val on = vm.toggleVoiceMode()
                                    if (on && !state.isStreaming) onVoiceDictation()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Model…") },
                                leadingIcon = { Icon(Icons.Outlined.Tune, null) },
                                onClick = { menuOpen = false; showModelSheet = true },
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            val listState = rememberLazyListState()
            val visibleMessages = remember(state.messages) {
                state.messages.filter { it.role == "user" || it.role == "assistant" || it.role == "tool" }
            }
            val workItems = remember(visibleMessages) { WorkSteps.group(visibleMessages) }
            val lastWork = (workItems.lastOrNull() as? WorkSteps.Item.Work)?.group
            val liveWork = state.isStreaming && (lastWork != null || visibleMessages.lastOrNull()?.role == "user" || visibleMessages.isEmpty())
            val inlinedApprovalIds = remember(lastWork, state.approvals, liveWork) {
                if (!liveWork || lastWork == null) emptySet()
                else {
                    val used = mutableSetOf<String>()
                    lastWork.rows.filterIsInstance<WorkSteps.Row.Step>().mapNotNull { step ->
                        WorkSteps.approvalFor(step, state.approvals.filter { it.id !in used })?.also { used += it.id }?.id
                    }.toSet()
                }
            }
            val leftoverApprovals = state.approvals.filter { it.id !in inlinedApprovalIds }
            // Scroll when structure changes, not on every streamed token (that flicker-scrolled the list).
            val lastStepCount = lastWork?.stepCount ?: 0
            LaunchedEffect(workItems.size, lastStepCount, leftoverApprovals.size, state.isStreaming, state.runStatus) {
                val total = listState.layoutInfo.totalItemsCount
                if (total > 0) listState.animateScrollToItem(total - 1)
            }

            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                if (visibleMessages.isEmpty() && !state.isStreaming) {
                    item { EmptyWelcomeCard(persona = state.activePersona, onPickPrompt = { vm.setDraft(it) }) }
                }
                items(workItems, key = { it.key }) { item ->
                    when (item) {
                        is WorkSteps.Item.Message -> {
                            val msg = item.message
                            MessageBubble(
                                msg = msg,
                                persona = msg.agentId?.let { id -> state.personas.firstOrNull { it.id == id } },
                                isSpeaking = state.speakingId == msg.id,
                                onSpeak = { vm.speakMessage(msg.id, msg.content, msg.agentId) },
                            )
                        }
                        is WorkSteps.Item.Work -> {
                            val live = liveWork && item.group.id == lastWork?.id
                            WorkGroupCard(
                                group = item.group,
                                live = live,
                                liveThought = if (live) state.streamingThinking.takeIf { it.isNotBlank() } else null,
                                diffs = if (live || item.group.id == lastWork?.id) state.edits.map { it.diff } else emptyList(),
                                approvals = if (live) state.approvals else emptyList(),
                                focusApprovalId = state.focusApprovalId,
                                onApprove = { vm.decideApproval(it, "approve") },
                                onDeny = { vm.decideApproval(it, "deny") },
                            )
                        }
                    }
                }
                if (liveWork && lastWork == null) {
                    item(key = "work_live") {
                        WorkGroupCard(
                            group = livePlaceholderGroup(),
                            live = true,
                            liveThought = state.streamingThinking.takeIf { it.isNotBlank() },
                            approvals = state.approvals,
                            focusApprovalId = state.focusApprovalId,
                            onApprove = { vm.decideApproval(it, "approve") },
                            onDeny = { vm.decideApproval(it, "deny") },
                        )
                    }
                }
                if (state.streamingText.isNotBlank()) {
                    item(key = "streaming_live") {
                        StreamingBubble(
                            persona = state.activePersona,
                            thinking = if (liveWork) "" else state.streamingThinking,
                            text = state.streamingText,
                        )
                    }
                }
                if (state.coderMode || state.edits.isNotEmpty()) {
                    items(state.edits, key = { "edit_${it.id}" }) { edit ->
                        MobileDiffCard(edit = edit, kept = edit.id in state.keptEditIds, onKeep = { vm.keepEdit(edit.id) }, onRevert = { vm.revertEdit(edit.id) })
                    }
                }
                if (state.runStatus == "waiting") {
                    item(key = "wait_memory") {
                        MemoryWaitCard(
                            wait = state.wait ?: com.localagent.app.model.WaitState.of(state.statusDetail, null),
                            onRecheck = vm::recheckMemoryNow,
                            onForce = { vm.controlRun("force") },
                            onCancel = { vm.controlRun("stop") },
                        )
                    }
                }
                items(leftoverApprovals, key = { "approval_${it.id}" }) { approval ->
                    ApprovalCard(
                        item = approval,
                        highlighted = approval.id == state.focusApprovalId,
                        onApprove = { vm.decideApproval(approval.id, "approve") },
                        onDeny = { vm.decideApproval(approval.id, "deny") },
                    )
                }
                if (!state.runError.isNullOrBlank()) {
                    item(key = "run_error") {
                        Surface(color = MaterialTheme.colorScheme.error.copy(alpha = 0.12f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                            Text(state.runError, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(14.dp), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }

            state.breakdown?.let { bd -> MobileContextNudge(percent = bd.percent, onCompact = vm::compactCurrentChat, onHandoff = vm::handoffCurrentChat) }

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
        ContextBreakdownSheet(breakdown = state.breakdown, onDismiss = { showContextSheet = false })
    }
}

/** Full-screen chat list: personas on top, then chats with search. Replaces the desktop-style side drawer. */
@Composable
fun ChatsScreen(
    state: AppUiState,
    contentPadding: PaddingValues,
    onOpenSession: (String) -> Unit,
    onOpenPersona: (String) -> Unit,
    onNewChat: () -> Unit,
    onDelete: (String) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val filtered = state.sessions.filter { query.isBlank() || it.title.contains(query, ignoreCase = true) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = contentPadding.calculateTopPadding() + 8.dp, bottom = contentPadding.calculateBottomPadding() + 88.dp),
    ) {
        item(key = "head") {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Chats", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                FilledTonalButton(onClick = onNewChat, modifier = Modifier.heightIn(min = 44.dp), shape = RoundedCornerShape(14.dp)) {
                    Icon(Icons.Outlined.AddComment, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("New chat")
                }
            }
        }
        item(key = "search") {
            OutlinedTextField(
                value = query, onValueChange = { query = it },
                placeholder = { Text("Search chats") }, singleLine = true,
                leadingIcon = { Icon(Icons.Default.Search, null) },
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp).heightIn(min = 48.dp),
            )
        }
        if (state.personas.isNotEmpty()) {
            item(key = "personas") {
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(state.personas, key = { it.id }) { p -> PersonaTile(p, selected = state.activePersona?.id == p.id) { onOpenPersona(p.id) } }
                }
            }
        }
        item(key = "recent") {
            Text("Recent", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
        }
        items(filtered, key = { it.id }) { session ->
            val persona = state.personas.firstOrNull { it.id == session.agentId }
            val waiting = state.pendingApprovals.count { it.sessionId == session.id }
            val selected = state.currentSession?.id == session.id
            val preview = when {
                waiting > 0 -> "Waiting for your approval"
                session.summary.isNotBlank() -> session.summary
                else -> persona?.name.orEmpty()
            }
            val whenLabel = SessionTime.relative(session.updatedAt)
            var confirm by remember { mutableStateOf(false) }
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.background)
                    .clickable { onOpenSession(session.id) }
                    .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (persona != null) PersonaAvatar(persona, 36) else Icon(Icons.Outlined.ChatBubbleOutline, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val displayTitle = session.title.takeIf { it.isNotBlank() && it != "New chat" }
                            ?: persona?.name
                            ?: "Untitled chat"
                        Text(
                            displayTitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            fontWeight = FontWeight.Medium,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.weight(1f),
                        )
                        if (whenLabel.isNotBlank()) {
                            Text(whenLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (preview.isNotBlank()) {
                        Text(
                            preview,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (waiting > 0) AccentAmber else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                IconButton(onClick = { confirm = true }, modifier = Modifier.size(40.dp)) {
                    Icon(Icons.Outlined.DeleteOutline, contentDescription = "Delete chat", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (confirm) {
                    AlertDialog(
                        onDismissRequest = { confirm = false },
                        title = { Text("Delete this chat?") },
                        text = { Text(session.title) },
                        confirmButton = { TextButton(onClick = { confirm = false; onDelete(session.id) }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
                        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
                    )
                }
            }
        }
        if (filtered.isEmpty()) {
            item(key = "none") {
                Text(
                    if (state.sessions.isEmpty()) "No chats yet. Tap New chat to start one." else "No chat titles match “$query”.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(20.dp),
                )
            }
        }
    }
}

@Composable
private fun PersonaTile(persona: Persona, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier.width(72.dp).clip(RoundedCornerShape(16.dp)).clickable(onClick = onClick).padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BadgedBox(badge = { if (persona.unread > 0) Badge { Text("${persona.unread}") } }) {
            PersonaAvatar(persona, 52, motion = if (selected) FaceMotion.Idle else FaceMotion.None)
        }
        Text(
            persona.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
        Modifier.fillMaxWidth().padding(vertical = 40.dp, horizontal = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (persona != null) PersonaAvatar(persona, 72, motion = FaceMotion.Idle)
        Text(persona?.let { "Chat with ${it.name}" } ?: "Start a conversation", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        if (!persona?.description.isNullOrBlank()) {
            Text(persona!!.description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(8.dp))
        starters.forEach { prompt ->
            OutlinedCard(onClick = { onPickPrompt(prompt) }, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                Text(prompt, modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp), style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}
