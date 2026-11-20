package com.localagent.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun ConnectScreen(
    state: AppUiState,
    onConnect: (url: String, user: String, pass: String, token: String) -> Unit,
) {
    var url by remember(state.serverUrl) { mutableStateOf(state.serverUrl.ifBlank { "http://100." }) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var useToken by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text("local-agent", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(6.dp))
            Text("Connect to your mini PC over LAN or Tailscale.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(22.dp))

            OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("Server URL") }, placeholder = { Text("http://100.x.x.x:8787") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = !useToken, onClick = { useToken = false }, label = { Text("Password") })
                Spacer(Modifier.width(8.dp))
                FilterChip(selected = useToken, onClick = { useToken = true }, label = { Text("API Token") })
            }
            Spacer(Modifier.height(12.dp))

            if (useToken) {
                OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Bearer Token (la_...)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            } else {
                OutlinedTextField(value = username, onValueChange = { username = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            }

            if (!state.authError.isNullOrBlank()) {
                Spacer(Modifier.height(12.dp))
                Text(state.authError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.height(20.dp))
            Button(
                onClick = { onConnect(url, username, password, if (useToken) token else "") },
                enabled = !state.connecting,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                if (state.connecting) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text("Sign in", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: AppUiState,
    onBack: () -> Unit,
    onRefreshModels: () -> Unit,
    onPullModel: (String) -> Unit,
    onSaveSearx: (String) -> Unit,
    onAutoDetectSearx: (String) -> Unit,
    onToggleVoice: (String, Boolean) -> Unit,
    onSignOut: () -> Unit,
) {
    var searxDraft by remember(state.searxngUrl) { mutableStateOf(state.searxngUrl) }
    var pullDraft by remember { mutableStateOf("gpt-oss:20b") }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("System & Settings") },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Connection", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(state.serverUrl, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    Text("Signed in as ${state.username}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = onSignOut) { Text("Sign out / Switch server") }
                }
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("Models (${state.models.count { it.local }} local)", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        TextButton(onClick = onRefreshModels, enabled = !state.refreshingModels) {
                            Text(if (state.refreshingModels) "Refreshing…" else "Refresh")
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(value = pullDraft, onValueChange = { pullDraft = it }, label = { Text("Pull model") }, singleLine = true, modifier = Modifier.weight(1f))
                        Button(onClick = { onPullModel(pullDraft) }, enabled = state.pullingStatus == null) { Text("Pull") }
                    }
                    if (!state.pullingStatus.isNullOrBlank()) {
                        Text(state.pullingStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("SearXNG Web Search URL", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    OutlinedTextField(value = searxDraft, onValueChange = { searxDraft = it }, placeholder = { Text("http://local-agent-searxng:8080") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { onSaveSearx(searxDraft) }) { Text("Save") }
                        OutlinedButton(onClick = { onAutoDetectSearx(searxDraft) }) { Text("Auto-detect") }
                    }
                    if (!state.searxngStatus.isNullOrBlank()) {
                        Text(state.searxngStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Per-persona voice replies", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    state.personas.forEach { persona ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            PersonaAvatar(persona, 28)
                            Spacer(Modifier.width(10.dp))
                            Text(persona.name, modifier = Modifier.weight(1f))
                            Switch(checked = persona.voiceReply, onCheckedChange = { onToggleVoice(persona.id, it) })
                        }
                    }
                }
            }
        }
    }
}
