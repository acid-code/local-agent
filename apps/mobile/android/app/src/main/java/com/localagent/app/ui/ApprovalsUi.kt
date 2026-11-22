package com.localagent.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.localagent.app.approvals.ApprovalPolicy
import com.localagent.app.model.ApprovalItem

@Composable
fun riskColor(risk: String): Color = when (risk) {
    "high" -> MaterialTheme.colorScheme.error
    "medium" -> AccentAmber
    "low" -> AccentBlue
    else -> AccentMint
}

@Composable
fun RiskChip(risk: String) {
    val c = riskColor(risk)
    Surface(color = c.copy(alpha = 0.16f), contentColor = c, shape = RoundedCornerShape(50)) {
        Text(
            when (risk) { "high" -> "High risk"; "medium" -> "Medium risk"; "low" -> "Low risk"; else -> "Safe" },
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/**
 * One pending approval: what will run, where it came from, and 48dp Deny / Approve buttons.
 * High-risk (and unlabeled) actions open a confirm dialog before anything is sent.
 */
@Composable
fun ApprovalCard(
    item: ApprovalItem,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    highlighted: Boolean = false,
    onOpenChat: (() -> Unit)? = null,
) {
    var confirming by remember(item.id) { mutableStateOf(false) }
    val border by animateColorAsState(
        if (highlighted) MaterialTheme.colorScheme.tertiary else riskColor(item.risk).copy(alpha = 0.45f),
        label = "approval-border",
    )
    val what = item.summary.ifBlank { ApprovalPolicy.cleanReason(item.reason) }
    val why = ApprovalPolicy.cleanReason(item.reason)
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(if (highlighted) 2.dp else 1.dp, border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RiskChip(item.risk)
                Text(item.toolName, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (onOpenChat != null && item.sessionId != null) {
                    IconButton(onClick = onOpenChat, modifier = Modifier.size(40.dp)) {
                        Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = "Open chat", modifier = Modifier.size(20.dp))
                    }
                }
            }
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Text(
                    what,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (why.isNotBlank() && why != what) {
                Text(why, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val where = listOfNotNull(item.agentName, item.sessionTitle).joinToString(" · ")
            if (where.isNotBlank()) {
                Text(where, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = onDeny,
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Icon(Icons.Default.Close, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Deny")
                }
                Button(
                    onClick = { if (ApprovalPolicy.needsConfirm(item.risk)) confirming = true else onApprove() },
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = if (item.risk == "high") ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError) else ButtonDefaults.buttonColors(),
                ) {
                    Icon(Icons.Default.Check, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp))
                    Text(if (ApprovalPolicy.needsConfirm(item.risk)) "Review…" else "Approve")
                }
            }
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            icon = { Icon(Icons.Default.WarningAmber, null, tint = MaterialTheme.colorScheme.error) },
            title = { Text("Approve a high-risk action?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("This leaves the mini PC or can't be undone. It runs as soon as you approve.")
                    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(10.dp)) {
                        Text(what, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(10.dp))
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = { confirming = false; onApprove() },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                ) { Text("Approve") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
        )
    }
}

@Composable
fun ApprovalsScreen(
    state: AppUiState,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onOpenChat: (ApprovalItem) -> Unit,
    onRefresh: () -> Unit,
    contentPadding: PaddingValues,
) {
    val listState = rememberLazyListState()
    val items = state.pendingApprovals
    LaunchedEffect(state.focusApprovalId, items.size) {
        val idx = items.indexOfFirst { it.id == state.focusApprovalId }
        if (idx >= 0) listState.animateScrollToItem(idx + 1)
    }
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = 16.dp, end = 16.dp,
            top = contentPadding.calculateTopPadding() + 8.dp,
            bottom = contentPadding.calculateBottomPadding() + 16.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item(key = "header") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Approvals", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                    Text(
                        when (items.size) { 0 -> "Nothing is waiting for you"; 1 -> "1 action is waiting"; else -> "${items.size} actions are waiting" },
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = onRefresh, modifier = Modifier.size(48.dp)) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
            }
        }
        if (items.isEmpty()) {
            item(key = "empty") {
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 56.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(Icons.Default.VerifiedUser, null, Modifier.size(48.dp), tint = AccentMint)
                    Text(if (state.approvalsLoaded) "All clear" else "Checking…", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "When an agent wants to run something that needs your OK, it shows up here and as a notification with Approve and Deny.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                    )
                }
            }
        }
        items(items, key = { it.id }) { item ->
            AnimatedVisibility(visible = true, enter = fadeIn(), exit = fadeOut()) {
                ApprovalCard(
                    item = item,
                    highlighted = item.id == state.focusApprovalId,
                    onApprove = { onApprove(item.id) },
                    onDeny = { onDeny(item.id) },
                    onOpenChat = { onOpenChat(item) },
                )
            }
        }
    }
}
