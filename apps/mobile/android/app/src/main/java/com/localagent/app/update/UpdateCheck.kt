package com.localagent.app.update

import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL

/**
 * Android update check against GitHub releases. CI names the APK local-agent-android-<versionName>.apk,
 * where versionName is 0.2.<versionCode>, so the newest release with such an asset tells us the newest
 * versionCode. Older releases (local-agent-<sha>.apk) carry no version and are ignored.
 */
object UpdateCheck {
    const val RELEASES_API = "https://api.github.com/repos/acid-code/local-agent/releases?per_page=20"
    private val APK = Regex("""^local-agent-android-(\d+)\.(\d+)\.(\d+)\.apk$""")

    data class Release(val versionCode: Long, val versionName: String, val tag: String, val apkUrl: String, val pageUrl: String)

    sealed interface Result {
        data class UpToDate(val current: Long, val latest: Release?) : Result
        data class Available(val release: Release) : Result
        data class Failed(val message: String) : Result
    }

    fun versionCodeOf(assetName: String): Long? = APK.matchEntire(assetName)?.groupValues?.get(3)?.toLongOrNull()

    /** Newest published (not draft, not prerelease) release that has a versioned APK. */
    fun newestApk(releases: JSONArray): Release? {
        var best: Release? = null
        for (i in 0 until releases.length()) {
            val r = releases.optJSONObject(i) ?: continue
            if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue
            val assets = r.optJSONArray("assets") ?: continue
            for (j in 0 until assets.length()) {
                val a = assets.optJSONObject(j) ?: continue
                val name = a.optString("name")
                val code = versionCodeOf(name) ?: continue
                val url = a.optString("browser_download_url")
                if (!url.startsWith("https://github.com/")) continue
                if (best == null || code > best.versionCode) {
                    best = Release(code, name.removePrefix("local-agent-android-").removeSuffix(".apk"), r.optString("tag_name"), url, r.optString("html_url"))
                }
            }
        }
        return best
    }

    fun decide(currentVersionCode: Long, releases: JSONArray): Result {
        val latest = newestApk(releases)
        return if (latest != null && latest.versionCode > currentVersionCode) Result.Available(latest) else Result.UpToDate(currentVersionCode, latest)
    }

    /** Blocking; call off the main thread. */
    fun check(currentVersionCode: Long): Result = try {
        val connection = URL(RELEASES_API).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.setRequestProperty("Accept", "application/vnd.github+json")
        connection.setRequestProperty("User-Agent", "local-agent-android")
        connection.connectTimeout = 12_000
        connection.readTimeout = 15_000
        val code = connection.responseCode
        if (code != 200) Result.Failed("GitHub returned HTTP $code")
        else decide(currentVersionCode, JSONArray(connection.inputStream.bufferedReader().use { it.readText() }))
    } catch (error: Exception) {
        Result.Failed(error.message ?: "network error")
    }

}
