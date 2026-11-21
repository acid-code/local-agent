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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

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
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
    val currentVersion = packageInfo.versionName ?: "unknown"
    var checkingUpdate by remember { mutableStateOf(false) }
    var updateStatus by remember { mutableStateOf("") }
    var releaseUrl by remember { mutableStateOf("") }

    fun checkForUpdate() {
        if (checkingUpdate) return
        checkingUpdate = true
        updateStatus = "Checking…"
        releaseUrl = ""
        scope.launch {
            try {
                val release = withContext(Dispatchers.IO) {
                    val connection = URL("https://api.github.com/repos/acid-code/local-agent/releases/latest").openConnection() as HttpURLConnection
                    connection.requestMethod = "GET"
                    connection.setRequestProperty("Accept", "application/vnd.github+json")
                    connection.setRequestProperty("User-Agent", "local-agent-android")
                    connection.connectTimeout = 12_000
                    connection.readTimeout = 12_000
                    if (connection.responseCode != 200) throw Exception("GitHub returned HTTP ${connection.responseCode}")
                    JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                }
                val tag = release.optString("tag_name")
                val url = release.optString("html_url")
                val latest = tag.removePrefix("main-").removePrefix("v")
                val currentNumber = currentVersion.substringAfterLast(".", "").toIntOrNull()
                val latestNumber = latest.substringAfterLast(".", "").toIntOrNull()
                val newer = if (currentNumber != null && latestNumber != null) latestNumber > currentNumber else tag != currentVersion
                releaseUrl = url
                updateStatus = if (newer) "Update available: $tag" else "You are up to date (v$currentVersion)"
            } catch (error: Exception) {
                updateStatus = "Update check failed: ${error.message ?: "unknown error"}"
            } finally {
                checkingUpdate = false
            }
        }
    }

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
                    Text("App", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text("local-agent for Android · v$currentVersion", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton(onClick = { checkForUpdate() }, enabled = !checkingUpdate) {
                        Text(if (checkingUpdate) "Checking…" else "Check for updates")
                    }
                    if (updateStatus.isNotBlank()) {
                        Text(updateStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (releaseUrl.isNotBlank()) {
                        TextButton(onClick = {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl)))
                        }) { Text("Open release") }
                    }
                }
            }

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
