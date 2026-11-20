package com.localagent.app.data

import android.content.Context
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.util.Locale

class AudioPlayer(
    private val context: Context,
    private val client: LocalAgentClient,
) {
    private var mediaPlayer: MediaPlayer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var currentKey: String? = null

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
        }
    }

    fun stop() {
        runCatching {
            mediaPlayer?.stop()
            mediaPlayer?.release()
        }
        mediaPlayer = null
        runCatching { tts?.stop() }
        currentKey = null
    }

    fun speak(scope: CoroutineScope, key: String, text: String, agentId: String?, onState: (String?) -> Unit) {
        if (currentKey == key) {
            stop()
            onState(null)
            return
        }
        stop()
        val clean = text
            .replace(Regex("```[\\s\\S]*?```"), " ")
            .replace(Regex("\\[(?:file|msg):[^\\]]+]"), "")
            .replace(Regex("[#*_`>|\\[\\]]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(2000)
        if (clean.isBlank()) return

        currentKey = key
        onState(key)
        scope.launch {
            val bytes = client.fetchSpeechAudio(clean, agentId)
            if (bytes != null && bytes.isNotEmpty()) {
                playBytes(bytes, key, onState)
            } else {
                playLocalTts(clean, key, onState)
            }
        }
    }

    private fun playBytes(bytes: ByteArray, key: String, onState: (String?) -> Unit) {
        try {
            val file = File(context.cacheDir, "tts_${System.currentTimeMillis()}.audio")
            file.writeBytes(bytes)
            val player = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    runCatching { file.delete() }
                    if (currentKey == key) {
                        currentKey = null
                        onState(null)
                    }
                    release()
                }
                setOnErrorListener { mp, _, _ ->
                    runCatching { file.delete() }
                    mp.release()
                    if (currentKey == key) {
                        currentKey = null
                        onState(null)
                    }
                    true
                }
                prepare()
                start()
            }
            mediaPlayer = player
        } catch (_: Exception) {
            if (currentKey == key) {
                currentKey = null
                onState(null)
            }
        }
    }

    private fun playLocalTts(text: String, key: String, onState: (String?) -> Unit) {
        if (!ttsReady) {
            if (currentKey == key) {
                currentKey = null
                onState(null)
            }
            return
        }
        val isHebrew = text.any { it in '\u0590'..'\u05FF' }
        tts?.language = if (isHebrew) Locale("he", "IL") else Locale.US
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, key)
    }

    fun release() {
        stop()
        runCatching { tts?.shutdown() }
    }
}
