package com.localagent.app.ui

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.localagent.app.data.LocalAgentClient
import com.localagent.app.model.RemoteFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** The signed-in API client, provided once at the top of the app so message bodies can fetch the agent's files. */
val LocalAgentApi = staticCompositionLocalOf<LocalAgentClient?> { null }

private val FILE_TOKEN = Regex("\\[file:([A-Za-z0-9_\\-]+)(?:#[^\\]]*)?\\]")

/** Library file ids the reply mentions as [file:<id>] (in order, no duplicates). */
fun extractFileIds(raw: String): List<String> = FILE_TOKEN.findAll(raw).map { it.groupValues[1] }.distinct().toList()

/** The reply text without the raw [file:…] tokens (they are shown as file cards instead). */
fun stripFileTokens(raw: String): String = raw.replace(FILE_TOKEN, "").replace(Regex("[ \\t]+\\n"), "\n").replace(Regex("\\n{3,}"), "\n\n").trim()

private data class FileLook(val icon: ImageVector, val tint: Color, val label: String)

private fun lookOf(file: RemoteFile): FileLook {
    val ext = file.name.substringAfterLast('.', "").lowercase()
    return when {
        file.mime.startsWith("image/") -> FileLook(Icons.Default.Image, AccentBlue, ext.uppercase().ifBlank { "IMAGE" })
        ext in setOf("pptx", "ppt", "key") -> FileLook(Icons.Default.Slideshow, AccentAmber, "PRESENTATION")
        ext == "pdf" -> FileLook(Icons.Default.PictureAsPdf, AccentRed, "PDF")
        ext in setOf("xlsx", "xls", "csv") -> FileLook(Icons.Default.TableChart, AccentMint, ext.uppercase())
        ext in setOf("docx", "doc", "txt", "md") -> FileLook(Icons.Default.Description, AccentBlue, ext.uppercase())
        ext in setOf("zip", "tar", "gz", "7z") -> FileLook(Icons.Default.FolderZip, AccentViolet, ext.uppercase())
        else -> FileLook(Icons.Default.InsertDriveFile, AccentGold, ext.uppercase().ifBlank { "FILE" })
    }
}

private fun humanSize(bytes: Long): String = when {
    bytes <= 0 -> ""
    bytes >= 1_048_576 -> String.format("%.1f MB", bytes / 1_048_576f)
    bytes >= 1024 -> String.format("%d KB", bytes / 1024)
    else -> "$bytes B"
}

private fun uriFor(context: Context, file: File) = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

private fun openFile(context: Context, file: File, mime: String) {
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uriFor(context, file), mime)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(view)
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No app on this phone can open ${file.extension.uppercase()} files. Use Share or Save instead.", Toast.LENGTH_LONG).show()
    }
}

private fun shareFile(context: Context, file: File, mime: String) {
    val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uriFor(context, file))
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/** Copy into the phone's Downloads folder (Android 10+); older phones use Share. */
private fun saveToDownloads(context: Context, file: File, name: String, mime: String): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
    val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, mime)
        put(MediaStore.Downloads.RELATIVE_PATH, "Download/local-agent")
    }
    val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
    context.contentResolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } } ?: return false
    return true
}

private fun decodeThumb(file: File, maxWidth: Int = 900): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
    return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
}

private sealed interface FileState {
    data object Loading : FileState
    data object Missing : FileState
    data class Ready(val file: RemoteFile) : FileState
}

/** A tappable card for a file the agent made (slides, images, documents): preview, Open, Share and Save. */
@Composable
fun FileCard(id: String) {
    val client = LocalAgentApi.current ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var attempt by remember(id) { mutableIntStateOf(0) }
    var busy by remember(id) { mutableStateOf(false) }
    val state by produceState<FileState>(FileState.Loading, id, attempt) {
        value = FileState.Loading
        value = client.fileMeta(id)?.let { FileState.Ready(it) } ?: FileState.Missing
    }

    when (val s = state) {
        FileState.Loading -> Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Text("Loading file…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        FileState.Missing -> Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().clickable { attempt++ }) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Default.CloudOff, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f)) {
                    Text("File unavailable", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Text("Tap to retry", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.Default.Refresh, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        is FileState.Ready -> {
            val file = s.file
            val look = lookOf(file)
            val isImage = file.mime.startsWith("image/")
            val thumb by produceState<Bitmap?>(null, file.id) {
                if (isImage) value = runCatching { withContext(Dispatchers.IO) { decodeThumb(client.downloadFile(file.id, file.name)) } }.getOrNull()
            }
            fun withFile(action: (File) -> Unit) {
                if (busy) return
                busy = true
                scope.launch {
                    try {
                        action(client.downloadFile(file.id, file.name))
                    } catch (e: Exception) {
                        Toast.makeText(context, e.message ?: "Download failed", Toast.LENGTH_LONG).show()
                    } finally {
                        busy = false
                    }
                }
            }
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column {
                    thumb?.let { bmp ->
                        Image(
                            bitmap = bmp.asImageBitmap(),
                            contentDescription = file.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxWidth().heightIn(max = 200.dp).aspectRatio(bmp.width.toFloat() / bmp.height.coerceAtLeast(1)).clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp))
                                .clickable { withFile { openFile(context, it, file.mime) } },
                        )
                    }
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(look.tint.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                            Icon(look.icon, null, tint = look.tint, modifier = Modifier.size(24.dp))
                        }
                        Column(Modifier.weight(1f)) {
                            Text(file.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOf(look.label, humanSize(file.size)).filter { it.isNotBlank() }.joinToString(" · "),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                    Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilledTonalButton(onClick = { withFile { openFile(context, it, file.mime) } }, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Icon(Icons.Default.OpenInNew, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Open")
                        }
                        OutlinedButton(onClick = { withFile { shareFile(context, it, file.mime) } }, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Icon(Icons.Default.Share, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Share")
                        }
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            OutlinedButton(
                                onClick = {
                                    withFile {
                                        val ok = runCatching { saveToDownloads(context, it, file.name, file.mime) }.getOrDefault(false)
                                        Toast.makeText(context, if (ok) "Saved to Downloads/local-agent" else "Could not save", Toast.LENGTH_SHORT).show()
                                    }
                                },
                                modifier = Modifier.weight(1f),
                                contentPadding = PaddingValues(horizontal = 8.dp),
                            ) {
                                Icon(Icons.Default.Download, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Save")
                            }
                        }
                    }
                }
            }
        }
    }
}
