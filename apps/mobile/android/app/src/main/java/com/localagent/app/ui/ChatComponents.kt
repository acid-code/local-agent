package com.localagent.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.localagent.app.model.*

@Composable
fun ContextRingChip(breakdown: ContextBreakdown, onClick: () -> Unit) {
    val pct = breakdown.percent
    val ringColor = when {
        pct >= 85 -> AccentRed
        pct >= 65 -> AccentGold
        else -> AccentMint
    }
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Canvas(Modifier.size(18.dp)) {
            val stroke = Stroke(width = 2.6.dp.toPx(), cap = StrokeCap.Round)
            val pad = 1.5.dp.toPx()
            val arcSize = Size(size.width - pad * 2, size.height - pad * 2)
            drawArc(Color.Gray.copy(alpha = 0.28f), 0f, 360f, false, Offset(pad, pad), arcSize, style = stroke)
            drawArc(ringColor, -90f, 360f * (pct / 100f), false, Offset(pad, pad), arcSize, style = stroke)
        }
        Text("$pct%", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun MessageBubble(
    msg: ChatMessage,
    persona: Persona?,
    isSpeaking: Boolean,
    onSpeak: () -> Unit,
    onCopied: () -> Unit = {},
) {
    val context = LocalContext.current
    var copied by remember(msg.id) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            kotlinx.coroutines.delay(1500)
            copied = false
        }
    }
    fun copyMessage() {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("message", stripFileTokens(msg.content).ifBlank { msg.content }))
        copied = true
        onCopied()
    }
    if (msg.role == "tool") {
        var expanded by remember(msg.id) { mutableStateOf(false) }
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
        ) {
            Column(Modifier.padding(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Default.Build, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(msg.toolName ?: "Tool output", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(16.dp))
                }
                AnimatedVisibility(expanded) {
                    SelectionContainer {
                        Text(
                            msg.content.take(2000),
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                }
            }
        }
        return
    }

    val isUser = msg.role == "user"
    if (isUser) {
        // Grok-style crisp right-aligned pill for user messages, with text selection + Copy action.
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (!msg.routingNote.isNullOrBlank()) {
                Text(
                    msg.routingNote,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 6.dp),
                )
            }
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp),
                modifier = Modifier.widthIn(max = 310.dp),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    FormattedMessageBody(msg.content)
                }
            }
            IconButton(
                onClick = ::copyMessage,
                modifier = Modifier.size(32.dp),
            ) {
                Icon(
                    if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
                    contentDescription = "Copy message",
                    modifier = Modifier.size(15.dp),
                    tint = if (copied) AccentMint else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                )
            }
        }
        return
    }

    // Grok-style full-bleed editorial layout for assistant replies (no heavy card border).
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (persona != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PersonaAvatar(persona, 24)
                Text(persona.name, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            }
        }
        if (!msg.thinking.isNullOrBlank()) {
            ThinkingAccordion(thinking = msg.thinking, defaultExpanded = false)
        }
        FormattedMessageBody(msg.content)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (!msg.routingNote.isNullOrBlank()) {
                Text(
                    msg.routingNote,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            IconButton(
                onClick = ::copyMessage,
                modifier = Modifier.size(36.dp),
            ) {
                Icon(
                    if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
                    contentDescription = "Copy",
                    modifier = Modifier.size(16.dp),
                    tint = if (copied) AccentMint else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onSpeak, modifier = Modifier.size(36.dp)) {
                Icon(
                    if (isSpeaking) Icons.Default.StopCircle else Icons.Default.VolumeUp,
                    contentDescription = "Speak",
                    modifier = Modifier.size(17.dp),
                    tint = if (isSpeaking) AccentGold else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
fun StreamingBubble(persona: Persona?, thinking: String, text: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (persona != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PersonaAvatar(persona, 24)
                Text(persona.name, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            }
        }
        if (thinking.isNotBlank()) {
            ThinkingAccordion(thinking = thinking, defaultExpanded = false, label = if (text.isBlank()) "Thinking…" else "Reasoning")
        }
        if (text.isNotBlank()) FormattedMessageBody(text)
    }
}

@Composable
fun ThinkingAccordion(thinking: String, defaultExpanded: Boolean, label: String = "Reasoning") {
    var expanded by remember { mutableStateOf(defaultExpanded) }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Default.Psychology, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.primary)
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(16.dp))
            }
            AnimatedVisibility(visible = expanded, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                SelectionContainer {
                    Text(thinking, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun FormattedMessageBody(raw: String) {
    val fileIds = remember(raw) { extractFileIds(raw) }
    val text = remember(raw) { stripFileTokens(raw) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (text.isNotBlank()) {
            SelectionContainer {
                MarkdownBody(text)
            }
        }
        fileIds.forEach { id -> key(id) { FileCard(id) } }
    }
}

/** Queue or RAM wait. The queue has no Force run; the RAM wait asks before forcing. */
@Composable
fun MemoryWaitCard(wait: WaitState, onRecheck: () -> Unit, onForce: () -> Unit, onCancel: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(wait.sinceIso) { while (true) { now = System.currentTimeMillis(); kotlinx.coroutines.delay(1000) } }
    val waited = wait.sinceIso?.let { iso ->
        runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull()?.let { start ->
            val s = ((now - start) / 1000).coerceAtLeast(0)
            if (s < 60) "${s}s" else "${s / 60}m ${(s % 60).toString().padStart(2, '0')}s"
        }
    }
    val accent = if (wait.queue) AccentBlue else AccentGold
    Surface(
        color = accent.copy(alpha = 0.10f),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().border(1.dp, accent.copy(alpha = 0.4f), RoundedCornerShape(16.dp)),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (wait.queue) Icon(Icons.Default.HourglassTop, null, tint = accent, modifier = Modifier.size(18.dp))
                else Icon(Icons.Default.Memory, null, tint = accent, modifier = Modifier.size(18.dp))
                Text(wait.title, fontWeight = FontWeight.SemiBold, color = accent, style = MaterialTheme.typography.titleSmall)
            }
            Text(
                wait.detail + (waited?.let { " · waiting $it" } ?: ""),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!wait.queue) OutlinedButton(onClick = onRecheck, modifier = Modifier.heightIn(min = 44.dp)) { Text("Re-check") }
                if (wait.canForce) Button(onClick = { confirm = true }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Force run") }
                TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = 44.dp)) { Text("Cancel", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            icon = { Icon(Icons.Default.WarningAmber, null, tint = MaterialTheme.colorScheme.error) },
            title = { Text("Force run anyway?") },
            text = { Text("This loads the model even though there is not enough free RAM. If another large model is loaded, the mini PC can freeze until it is restarted.") },
            confirmButton = {
                Button(onClick = { confirm = false; onForce() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Force run") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
        )
    }
}

@Composable
fun ComposerBar(
    draft: String,
    isStreaming: Boolean,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onVoice: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Surface(color = scheme.background, modifier = Modifier.fillMaxWidth().navigationBarsPadding()) {
        Surface(
            color = scheme.surface,
            shape = RoundedCornerShape(22.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, scheme.outline),
            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 8.dp),
        ) {
            Row(
                Modifier.padding(start = 2.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                IconButton(onClick = onVoice, modifier = Modifier.size(44.dp)) {
                    Icon(Icons.Default.Mic, contentDescription = "Voice input", tint = scheme.onSurfaceVariant)
                }
                BasicTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    maxLines = 6,
                    textStyle = MaterialTheme.typography.bodyLarge.merge(TextStyle(color = scheme.onSurface)),
                    cursorBrush = SolidColor(scheme.tertiary),
                    modifier = Modifier.weight(1f).heightIn(min = 44.dp).padding(vertical = 10.dp, horizontal = 4.dp),
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (draft.isEmpty()) {
                                Text(
                                    if (isStreaming) "Steer without stopping…" else "Message",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = scheme.onSurfaceVariant,
                                )
                            }
                            inner()
                        }
                    },
                )
                if (isStreaming) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (draft.isNotBlank()) {
                            FilledIconButton(
                                onClick = onSend,
                                modifier = Modifier.size(40.dp),
                                colors = IconButtonDefaults.filledIconButtonColors(containerColor = scheme.tertiary, contentColor = scheme.onTertiary),
                            ) {
                                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Steer", modifier = Modifier.size(18.dp))
                            }
                        }
                        FilledIconButton(
                            onClick = onStop,
                            modifier = Modifier.size(40.dp),
                            colors = IconButtonDefaults.filledIconButtonColors(containerColor = scheme.error),
                        ) { Icon(Icons.Default.Stop, contentDescription = "Stop", modifier = Modifier.size(18.dp)) }
                    }
                } else {
                    FilledIconButton(
                        onClick = onSend, enabled = draft.isNotBlank(), modifier = Modifier.size(40.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = scheme.tertiary, contentColor = scheme.onTertiary),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelPickerSheet(
    models: List<UsableModel>,
    currentPin: String?,
    currentEffort: String?,
    refreshing: Boolean,
    pullingStatus: String?,
    onDismiss: () -> Unit,
    onSelect: (String?) -> Unit,
    onSelectEffort: (String?) -> Unit,
    onRefresh: () -> Unit,
    onPull: (String) -> Unit,
) {
    var pullName by remember { mutableStateOf("gpt-oss:20b") }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Thinking effort", style = MaterialTheme.typography.labelLarge)
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val efforts = listOf(
                    null to "Auto",
                    "off" to "Off",
                    "low" to "Low",
                    "medium" to "Med",
                    "high" to "High",
                )
                efforts.forEach { (value, label) ->
                    val selected = (currentEffort ?: "") == (value ?: "")
                    FilterChip(
                        selected = selected,
                        onClick = { onSelectEffort(value) },
                        label = { Text(label) },
                    )
                }
            }
            HorizontalDivider()
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Models", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                TextButton(onClick = onRefresh, enabled = !refreshing) {
                    Icon(Icons.Default.Refresh, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(if (refreshing) "Refreshing…" else "Refresh")
                }
            }
            ListItem(
                headlineContent = { Text("Auto (recommended)") },
                supportingContent = { Text("Picks the best model per turn") },
                trailingContent = if (currentPin == null) { { Icon(Icons.Default.Check, null, tint = MaterialTheme.colorScheme.primary) } } else null,
                modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable { onSelect(null) },
            )
            models.forEach { m ->
                ListItem(
                    headlineContent = { Text(m.name) },
                    supportingContent = { Text(if (m.local) "Local" else "Cloud${m.reason?.let { " · $it" } ?: ""}") },
                    trailingContent = if (currentPin == m.id) { { Icon(Icons.Default.Check, null, tint = MaterialTheme.colorScheme.primary) } } else null,
                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable(enabled = !m.disabled) { onSelect(m.id) },
                )
            }
            HorizontalDivider()
            Text("Pull Ollama model", style = MaterialTheme.typography.labelLarge)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = pullName, onValueChange = { pullName = it }, singleLine = true, placeholder = { Text("gpt-oss:20b") }, modifier = Modifier.weight(1f))
                Button(onClick = { onPull(pullName) }, enabled = pullingStatus == null && pullName.isNotBlank()) { Text("Pull") }
            }
            if (!pullingStatus.isNullOrBlank()) {
                Text(pullingStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.height(10.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContextBreakdownSheet(breakdown: ContextBreakdown, onDismiss: () -> Unit) {
    fun fmt(n: Int) = if (n >= 1000) String.format("%.1fk", n / 1000f) else "$n"
    val rows = listOf(
        Triple("System prompt", breakdown.systemPrompt, AccentBlue),
        Triple("Persona & tools", breakdown.personaAndTools, AccentViolet),
        Triple("Memory", breakdown.memory, AccentMint),
        Triple("History", breakdown.history, AccentGold),
        Triple("Files", breakdown.files, AccentAmber),
        Triple("Room left", breakdown.remaining, Color.Gray),
    )
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Context window", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text("${fmt(breakdown.used)} / ${fmt(breakdown.budget)} (${breakdown.percent}%)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(999.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
                val total = breakdown.budget.coerceAtLeast(1).toFloat()
                rows.take(5).forEach { (_, count, color) ->
                    val frac = (count / total).coerceIn(0f, 1f)
                    if (frac > 0.005f) Box(Modifier.fillMaxHeight().weight(frac).background(color))
                }
                val remFrac = (breakdown.remaining / total).coerceIn(0f, 1f)
                if (remFrac > 0.005f) Box(Modifier.fillMaxHeight().weight(remFrac))
            }
            rows.forEach { (label, tokens, color) ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.size(10.dp).clip(CircleShape).background(color))
                    Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Text(fmt(tokens), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            }
            Text("Output reserve: ${fmt(breakdown.outputReserve)} tokens", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
        }
    }
}
