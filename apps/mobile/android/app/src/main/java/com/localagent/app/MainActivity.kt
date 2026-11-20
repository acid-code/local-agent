package com.localagent.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognizerIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.localagent.app.ui.ChatViewModel
import com.localagent.app.ui.LocalAgentApp
import com.localagent.app.ui.LocalAgentTheme
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {
    private val vm: ChatViewModel by viewModels()

    private val speechLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val spoken = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
        if (!spoken.isNullOrBlank()) {
            vm.onDictationResult(spoken)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requestRuntimePermissions()
        scheduleApprovalPoll()
        consumeShareIntent(intent)

        setContent {
            LocalAgentTheme {
                LocalAgentApp(
                    vm = vm,
                    onVoiceDictation = { launchVoiceInput() },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumeShareIntent(intent)
    }

    private fun consumeShareIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val shared = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (!shared.isNullOrBlank()) vm.appendSharedText(shared)
        }
    }

    private fun launchVoiceInput() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak your message…")
        }
        runCatching { speechLauncher.launch(intent) }
    }

    private fun requestRuntimePermissions() {
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.RECORD_AUDIO
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), 42)
        }
    }

    private fun scheduleApprovalPoll() {
        val req = PeriodicWorkRequestBuilder<ApprovalWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "local-agent-approvals",
            ExistingPeriodicWorkPolicy.KEEP,
            req,
        )
    }
}
