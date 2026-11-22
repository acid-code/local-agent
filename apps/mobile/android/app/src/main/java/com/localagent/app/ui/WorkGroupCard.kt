package com.localagent.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.localagent.app.model.ApprovalItem

/**
 * Live, collapsible Copilot-style work group. The open/closed state is remembered by group id
 * so a stream update does not remount and flicker. Live groups start open and collapse when the
 * run finishes. The live dot is static (no pulse).
 */
@Composable
fun WorkGroupCard(
    group: WorkSteps.Group,
    live: Boolean,
    liveThought: String? = null,
    diffs: List<String> = emptyList(),
    approvals: List<ApprovalItem> = emptyList(),
    focusApprovalId: String? = null,
    onApprove: (String) -> Unit = {},
    onDeny: (String) -> Unit = {},
) {
    var open by remember(group.id) { mutableStateOf(live) }
    LaunchedEffect(live) { open = live }
    val chevron by animateFloatAsState(if (open) 90f else 0f, label = "work-chevron")
    val title = remember(group.stepCount, group.durationMs, live) { WorkSteps.headerTitle(group, live) }
    val stats = remember(diffs) { if (diffs.isEmpty()) null else WorkSteps.diffStats(diffs) }
    val stepApprovals = remember(group.rows, approvals) {
        val used = mutableSetOf<String>()
        buildMap<String, ApprovalItem> {
            for (row in group.rows) {
                if (row is WorkSteps.Row.Step) {
                    val leftover = approvals.filter { it.id !in used }
                    val found = WorkSteps.approvalFor(row, leftover) ?: continue
                    used += found.id
                    put(row.id, found)
                }
            }
        }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .clickable { open = !open }
                .padding(vertical = 6.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Default.ChevronRight,
                contentDescription = if (open) "Collapse work" else "Expand work",
                modifier = Modifier.size(18.dp).rotate(chevron),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (live) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(AccentMint),
                )
            }
            Text(
                title,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (stats != null && (stats.first > 0 || stats.second > 0)) {
                Text(
                    "+${stats.first}",
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = DiffAddText,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "-${stats.second}",
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = DiffDelText,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
        AnimatedVisibility(visible = open) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                group.rows.forEach { row ->
                    when (row) {
                        is WorkSteps.Row.Narration -> {
                            MarkdownBody(row.text, Modifier.padding(vertical = 6.dp, horizontal = 4.dp))
                        }
                        is WorkSteps.Row.Thought -> ThoughtRow(row)
                        is WorkSteps.Row.Step -> {
                            StepRow(row)
                            val approval = stepApprovals[row.id]
                            if (approval != null) {
                                Box(Modifier.padding(start = 22.dp, top = 6.dp, bottom = 8.dp)) {
                                    ApprovalCard(
                                        item = approval,
                                        highlighted = approval.id == focusApprovalId,
                                        onApprove = { onApprove(approval.id) },
                                        onDeny = { onDeny(approval.id) },
                                    )
                                }
                            }
                        }
                    }
                }
                if (!liveThought.isNullOrBlank()) {
                    LiveThoughtRow(liveThought)
                }
            }
        }
    }
}

@Composable
private fun ThoughtRow(row: WorkSteps.Row.Thought) {
    var open by remember(row.id) { mutableStateOf(false) }
    val words = row.text.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.size
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { open = !open }
                .padding(vertical = 6.dp, horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Default.Psychology, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Thought", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text("$words words", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AnimatedVisibility(open) {
            Text(
                row.text,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 28.dp, end = 4.dp, bottom = 8.dp),
            )
        }
    }
}

@Composable
private fun LiveThoughtRow(text: String) {
    var open by remember { mutableStateOf(false) }
    val tail = text.trim().replace(Regex("\\s+"), " ")
    val preview = if (tail.length > 120) "…" + tail.takeLast(119) else tail
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { open = !open }
                .padding(vertical = 6.dp, horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Default.Psychology, null, Modifier.size(16.dp), tint = AccentGold)
            Text("Thinking…", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = AccentGold)
            Text(preview, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        AnimatedVisibility(open) {
            Text(
                text,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 28.dp, end = 4.dp, bottom = 8.dp),
            )
        }
    }
}

@Composable
private fun StepRow(step: WorkSteps.Row.Step) {
    var open by remember(step.id) { mutableStateOf(false) }
    val icon = stepIcon(step.icon)
    val argsText = step.args?.let { org.json.JSONObject(it).toString(2) }.orEmpty()
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { open = !open }
                .padding(vertical = 6.dp, horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                icon,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = when {
                    step.failed -> AccentRed
                    step.pending -> AccentGold
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            Text(step.verb, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            if (step.target.isNotBlank() && step.files.isEmpty()) {
                Text(
                    step.target,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            step.files.take(3).forEach { file ->
                Row(
                    Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Icon(Icons.Default.InsertDriveFile, null, Modifier.size(11.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(file.substringAfterLast('/'), style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), maxLines = 1)
                }
            }
            Spacer(Modifier.weight(1f))
            val time = if (step.pending) "running…" else WorkSteps.formatDuration(step.durationMs)
            if (time.isNotBlank()) {
                Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        AnimatedVisibility(open) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 28.dp, end = 4.dp, bottom = 8.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f))
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (argsText.isNotBlank()) {
                    Text("Input", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(argsText.take(4000), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 15.sp))
                }
                if (step.output.isNotBlank()) {
                    val label = if (step.icon == WorkSteps.Icon.Edit && Regex("^[-+@]", RegexOption.MULTILINE).containsMatchIn(step.output)) "Diff" else "Output"
                    Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val shown = if (step.output.length > 6000) step.output.take(6000) + "\n…" else step.output
                    Text(shown, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 15.sp))
                }
                if (argsText.isBlank() && step.output.isBlank()) {
                    Text("No details were recorded for this step.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

private fun stepIcon(icon: WorkSteps.Icon): ImageVector = when (icon) {
    WorkSteps.Icon.Edit -> Icons.Default.Edit
    WorkSteps.Icon.Read -> Icons.Default.Description
    WorkSteps.Icon.Think -> Icons.Default.Psychology
    WorkSteps.Icon.Command -> Icons.Default.Terminal
    WorkSteps.Icon.Search -> Icons.Default.Search
    WorkSteps.Icon.Web -> Icons.Default.Language
    WorkSteps.Icon.Memory -> Icons.Default.AutoAwesome
    WorkSteps.Icon.Agent -> Icons.Default.People
    WorkSteps.Icon.Container -> Icons.Default.Inventory2
    WorkSteps.Icon.Tool -> Icons.Default.Build
}

/** A live work group shown before any tool-call messages have arrived. */
fun livePlaceholderGroup(): WorkSteps.Group = WorkSteps.Group(
    id = "work-live",
    rows = emptyList(),
    stepCount = 0,
    durationMs = null,
    runIds = emptyList(),
)
