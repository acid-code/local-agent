package com.localagent.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.localagent.app.model.ChatSession
import com.localagent.app.model.Persona

internal fun previewPersonas(): List<Persona> = listOf(
    Persona(id = "ag_coder", name = "Coder", title = "Writes and fixes code", accent = "#9ec0e0", avatarKind = "initials", avatarRef = "blob-5"),
    Persona(id = "ag_research", name = "Researcher", title = "Finds and checks facts", accent = "#9dccb4", avatarKind = "initials", avatarRef = "blob-2"),
    Persona(id = "ag_assistant", name = "Assistant", title = "Your everyday helper", accent = "#e4b56a", avatarKind = "initials", avatarRef = "blob-0"),
)

@Preview(name = "Face gallery — dark", showBackground = true, backgroundColor = 0xFF000000, widthDp = 360)
@Composable
fun FaceGalleryPreviewDark() {
    LocalAgentTheme(dark = true) { FaceGalleryPreviewBody() }
}

@Preview(name = "Face gallery — light", showBackground = true, backgroundColor = 0xFFF7F7F5, widthDp = 360)
@Composable
fun FaceGalleryPreviewLight() {
    LocalAgentTheme(dark = false) { FaceGalleryPreviewBody() }
}

@Composable
private fun FaceGalleryPreviewBody() {
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Personas", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                previewPersonas().forEach { p ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        PersonaAvatar(p, 52)
                        Text(p.name, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
            Text("Built-in faces", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FaceSpec.HAIR.keys.forEach { id ->
                    PersonaAvatar(Persona(id = id, name = id, accent = "#e4b56a", avatarKind = "builtin", avatarRef = id), 36)
                }
            }
        }
    }
}

@Preview(name = "Chats screen — dark", showBackground = true, backgroundColor = 0xFF000000, widthDp = 390, heightDp = 760)
@Composable
fun ChatsScreenPreviewDark() {
    val personas = previewPersonas()
    LocalAgentTheme(dark = true) {
        ChatsScreen(
            state = AppUiState(
                checkingAuth = false,
                authenticated = true,
                personas = personas,
                sessions = listOf(
                    ChatSession(id = "s1", agentId = personas[2].id, title = "make me a script for the weekly backup", updatedAt = "2026-11-22T16:10:00Z", summary = "Drafted a backup script in package.json"),
                    ChatSession(id = "s2", agentId = personas[0].id, title = "Fix the Android faces", updatedAt = "2026-11-22T14:00:00Z", summary = "Coder"),
                    ChatSession(id = "s3", agentId = personas[1].id, title = "Latest local LLM news", updatedAt = "2026-11-21T09:00:00Z"),
                ),
                currentSession = ChatSession(id = "s1", agentId = personas[2].id, title = "make me a script for the weekly backup"),
            ),
            contentPadding = PaddingValues(0.dp),
            onOpenSession = {},
            onOpenPersona = {},
            onNewChat = {},
            onDelete = {},
        )
    }
}
