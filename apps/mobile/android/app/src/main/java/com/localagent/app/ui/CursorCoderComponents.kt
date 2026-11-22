package com.localagent.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.localagent.app.model.*

/** Segmented Grok-Chat / Cursor-Coder mode switch pill in the mobile top bar. */
@Composable
fun ModeTogglePill(coderMode: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(999.dp))
            .padding(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ModeSeg("Chat", selected = !coderMode) { onToggle(false) }
        ModeSeg("Code", selected = coderMode) { onToggle(true) }
    }
}

@Composable
private fun ModeSeg(label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (selected) MaterialTheme.colorScheme.primary else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Cursor-style expandable decision path & live tool-call timeline on mobile. */
@Composable
fun CursorTimelineCard(steps: List<RunStep>, live: Boolean) {
    val visible = remember(steps) { steps.filter { it.kind in setOf("routing", "tool", "model", "contract") } }
    if (visible.isEmpty()) return
    var expanded by remember(live) { mutableStateOf(live) }
    var openStepId by remember { mutableStateOf<String?>(null) }
    val active = visible.firstOrNull { it.status == "running" }
    val toolCount = visible.count { it.kind == "tool" }

    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .border(
                1.dp,
                if (live) AccentGold.copy(alpha = 0.55f) else MaterialTheme.colorScheme.outline,
                RoundedCornerShape(14.dp),
            ),
    ) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Default.Memory, null, Modifier.size(16.dp), tint = if (live) AccentGold else AccentMint)
                Text(
                    active?.let { "Running ${it.name}…" } ?: "Decision path · ${visible.size} steps ($toolCount tools)",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(18.dp))
            }
            AnimatedVisibility(expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    visible.forEach { step ->
                        val isOpen = openStepId == step.id
                        val dotColor = when (step.status) {
                            "running" -> AccentGold
                            "failed" -> AccentRed
                            else -> AccentMint
                        }
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth().clickable { openStepId = if (isOpen) null else step.id },
                        ) {
                            Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                    Box(Modifier.size(7.dp).clip(CircleShape).background(dotColor))
                                    Text(
                                        if (step.kind == "routing" && step.output.isNotBlank()) step.output.take(64) else step.name,
                                        style = MaterialTheme.typography.bodySmall,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (step.latencyMs > 0) {
                                        val msLabel = if (step.latencyMs >= 1000) "${"%.1f".format(step.latencyMs / 1000f)}s" else "${step.latencyMs}ms"
                                        Text(msLabel, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                if (isOpen && (step.output.isNotBlank() || !step.error.isNullOrBlank())) {
                                    Text(
                                        (step.error ?: step.output).take(900),
                                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
                                        color = if (!step.error.isNullOrBlank()) AccentRed else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Cursor-style syntax-colored inline diff review card with 1-tap Keep / Revert on mobile. */
@Composable
fun MobileDiffCard(
    edit: EditDiff,
    kept: Boolean,
    onKeep: () -> Unit,
    onRevert: () -> Unit,
) {
    val lines = remember(edit.diff) { edit.diff.lines() }
    val added = remember(lines) { lines.count { it.startsWith("+") && !it.startsWith("+++") } }
    val removed = remember(lines) { lines.count { it.startsWith("-") && !it.startsWith("---") } }
    var open by remember(edit.id, kept, edit.revertedAt) { mutableStateOf(edit.revertedAt == null && !kept) }

    val shape = RoundedCornerShape(14.dp)
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = shape,
        modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outline, shape),
    ) {
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f))
                    .clickable { open = !open }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Icon(Icons.Default.Code, null, Modifier.size(15.dp), tint = AccentBlue)
                Text(edit.label, style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text("+$added", style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = DiffAddText, fontWeight = FontWeight.Bold)
                Text("-$removed", style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = DiffDelText, fontWeight = FontWeight.Bold)
            }
            AnimatedVisibility(open) {
                Column(Modifier.fillMaxWidth().background(Color(0xFF07080A)).padding(vertical = 4.dp)) {
                    lines.take(80).forEach { line ->
                        val (bg, fg) = when {
                            line.startsWith("@@") -> DiffHunkBg to DiffHunkText
                            line.startsWith("+") && !line.startsWith("+++") -> DiffAddBg to DiffAddText
                            line.startsWith("-") && !line.startsWith("---") -> DiffDelBg to DiffDelText
                            else -> Color.Transparent to MaterialTheme.colorScheme.onSurfaceVariant
                        }
                        Text(
                            line.ifEmpty { " " },
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp),
                            color = fg,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 10.dp, vertical = 1.dp),
                        )
                    }
                    if (lines.size > 80) {
                        Text("… ${lines.size - 80} more lines", style = MaterialTheme.typography.labelSmall, color = DiffHunkText, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when {
                    edit.revertedAt != null -> Text("Reverted", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    kept -> Text("Kept", style = MaterialTheme.typography.labelSmall, color = AccentMint, fontWeight = FontWeight.SemiBold)
                    else -> {
                        FilledTonalButton(
                            onClick = onKeep,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
                            modifier = Modifier.height(32.dp),
                            colors = ButtonDefaults.filledTonalButtonColors(contentColor = AccentMint),
                        ) { Text("Keep") }
                        OutlinedButton(
                            onClick = onRevert,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
                            modifier = Modifier.height(32.dp),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = AccentRed),
                        ) { Text("Revert") }
                    }
                }
            }
        }
    }
}

/** Smart Context Auto-Nudge banner when context >= 80%. */
@Composable
fun MobileContextNudge(
    percent: Int,
    onCompact: () -> Unit,
    onHandoff: () -> Unit,
) {
    if (percent < 80) return
    Surface(
        color = AccentGold.copy(alpha = 0.14f),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .border(1.dp, AccentGold.copy(alpha = 0.4f), RoundedCornerShape(14.dp)),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Context $percent%", style = MaterialTheme.typography.labelMedium, color = AccentGold, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            TextButton(onClick = onCompact, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)) { Text("Compact") }
            Button(onClick = onHandoff, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp)) { Text("New chat") }
        }
    }
}
