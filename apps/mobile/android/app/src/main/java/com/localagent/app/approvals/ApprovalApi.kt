package com.localagent.app.approvals

import android.content.Context
import com.localagent.app.model.ApprovalItem
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Small blocking client for the background worker and notification buttons. It uses the same server URL and
 * session (cookie or bearer token) the app signed in with, and only the owner-checked approval endpoints.
 */
class ApprovalApi(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("local-agent-native", Context.MODE_PRIVATE)
    private val base get() = prefs.getString("server_url", "")?.trimEnd('/') ?: ""
    private val token get() = prefs.getString("bearer_token", "") ?: ""
    private val cookie get() = prefs.getString("la_session_cookie", "") ?: ""

    val signedIn: Boolean get() = base.isNotBlank() && (token.isNotBlank() || cookie.isNotBlank())

    private val http = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private fun request(path: String): Request.Builder {
        val b = Request.Builder().url("$base$path")
        if (token.isNotBlank()) b.header("Authorization", "Bearer $token")
        if (cookie.isNotBlank()) b.header("Cookie", cookie)
        return b
    }

    fun pending(): List<ApprovalItem> {
        http.newCall(request("/api/approvals").get().build()).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            return ApprovalPolicy.parseList(resp.body?.string().orEmpty())
        }
    }

    sealed class Outcome {
        object Done : Outcome()
        object AlreadyDecided : Outcome()
        data class Failed(val message: String) : Outcome()
    }

    fun decide(id: String, decision: String): Outcome {
        require(decision == "approve" || decision == "deny")
        val body = JSONObject().put("decision", decision).toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        return try {
            http.newCall(request("/api/approvals/$id").post(body).build()).execute().use { resp ->
                when {
                    resp.isSuccessful -> Outcome.Done
                    resp.code == 409 || resp.code == 404 -> Outcome.AlreadyDecided
                    resp.code == 401 -> Outcome.Failed("Signed out. Open the app to sign in.")
                    else -> Outcome.Failed("Server said HTTP ${resp.code}")
                }
            }
        } catch (e: IOException) {
            Outcome.Failed("Could not reach the mini PC")
        }
    }
}
