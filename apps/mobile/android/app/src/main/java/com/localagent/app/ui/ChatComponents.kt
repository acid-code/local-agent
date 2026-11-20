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
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.localagent.app.model.*

@Composable
fun PersonaAvatar(persona: Persona, sizeDp: Int) {
    val tint = hexToColor(persona.accent)
    Box(
        modifier = Modifier
            .size(sizeDp.dp)
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.22f))
            .border(1.5.dp, tint, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        val glyph = persona.emoji.ifBlank { persona.name.take(1).uppercase() }
        Text(glyph, fontSize = (sizeDp * 0.44f).sp, fontWeight = FontWeight.Bold, color = tint)
    }
}

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
) {
    val context = LocalContext.current
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
                    Text(
                        msg.content.take(2000),
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
        return
    }

    val isUser = msg.role == "user"
    if (isUser) {
        // Grok-style crisp right-aligned pill for user messages.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp),
                modifier = Modifier.widthIn(max = 310.dp),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    FormattedMessageBody(msg.content)
                }
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
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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
                onClick = {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("message", msg.content))
                },
                modifier = Modifier.size(28.dp),
            ) {
                Icon(Icons.Default.ContentCopy, contentDescription = "Copy", modifier = Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onSpeak, modifier = Modifier.size(28.dp)) {
                Icon(
                    if (isSpeaking) Icons.Default.StopCircle else Icons.Default.VolumeUp,
                    contentDescription = "Speak",
                    modifier = Modifier.size(16.dp),
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
            ThinkingAccordion(thinking = thinking, defaultExpanded = true, label = if (text.isBlank()) "Thinking…" else "Reasoning")
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
                Text(thinking, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

@Composable
private fun FormattedMessageBody(raw: String) {
    val parts = remember(raw) { raw.split("```") }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        parts.forEachIndexed { index, part ->
            if (part.isBlank()) return@forEachIndexed
            if (index % 2 == 1) {
                val code = part.substringAfter('\n', part).trimEnd()
                Surface(color = MaterialTheme.colorScheme.background, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(code, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.padding(10.dp))
                }
            } else {
                Text(part.trim(), style = MaterialTheme.typography.bodyMedium, lineHeight = 22.sp)
            }
        }
    }
}

@Composable
fun MemoryWaitCard(detail: String, onRecheck: () -> Unit, onForce: () -> Unit, onCancel: () -> Unit) {
    Surface(
        color = AccentGold.copy(alpha = 0.14f),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().border(1.dp, AccentGold.copy(alpha = 0.5f), RoundedCornerShape(14.dp)),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Waiting for memory", fontWeight = FontWeight.SemiBold, color = AccentGold)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRecheck, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) { Text("Re-check") }
                Button(onClick = onForce, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) { Text("Force run") }
                TextButton(onClick = onCancel) { Text("Cancel", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@Composable
fun ApprovalCard(item: ApprovalItem, onApprove: () -> Unit, onDeny: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(14.dp)),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Approval needed · ${item.toolName}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text(item.reason, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onDeny) { Text("Deny") }
                Button(onClick = onApprove) { Text("Approve") }
            }
        }
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
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth().navigationBarsPadding()) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            IconButton(onClick = onVoice) { Icon(Icons.Default.Mic, contentDescription = "Voice input") }
            OutlinedTextField(
                value = draft,
                onValueChange = onDraftChange,
                placeholder = { Text("Message…") },
                maxLines = 5,
                shape = RoundedCornerShape(22.dp),
                modifier = Modifier.weight(1f),
            )
            if (isStreaming) {
                FilledIconButton(
                    onClick = onStop,
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Icon(Icons.Default.Stop, contentDescription = "Stop") }
            } else {
                FilledIconButton(onClick = onSend, enabled = draft.isNotBlank()) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
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
    refreshing: Boolean,
    pullingStatus: String?,
    onDismiss: () -> Unit,
    onSelect: (String?) -> Unit,
    onRefresh: () -> Unit,
    onPull: (String) -> Unit,
) {
    var pullName by remember { mutableStateOf("gpt-oss:20b") }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
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
