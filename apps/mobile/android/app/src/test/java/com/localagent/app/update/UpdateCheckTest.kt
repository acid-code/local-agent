package com.localagent.app.update

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckTest {
    private fun release(tag: String, vararg assets: String, draft: Boolean = false) = """
        {"tag_name":"$tag","html_url":"https://github.com/acid-code/local-agent/releases/tag/$tag","draft":$draft,"prerelease":false,
         "assets":[${assets.joinToString(",") { """{"name":"$it","browser_download_url":"https://github.com/acid-code/local-agent/releases/download/$tag/$it"}""" }}]}
    """.trimIndent()

    @Test fun parsesVersionCodeFromAssetName() {
        assertEquals(152L, UpdateCheck.versionCodeOf("local-agent-android-0.2.152.apk"))
        assertNull(UpdateCheck.versionCodeOf("local-agent-8adb200.apk"))
        assertNull(UpdateCheck.versionCodeOf("local-agent-0.2.190-setup.exe"))
    }

    @Test fun offersNewerApkAndIgnoresOldNamesAndDrafts() {
        val json = JSONArray("[" + listOf(
            release("main-ddd", "local-agent-android-0.2.160.apk", draft = true),
            release("main-ccc", "local-agent-0.2.190-setup.exe", "local-agent-android-0.2.152.apk"),
            release("main-bbb", "local-agent-android-0.2.150.apk"),
            release("main-8adb200", "local-agent-8adb200.apk"),
        ).joinToString(",") + "]")
        val result = UpdateCheck.decide(143, json)
        assertTrue(result is UpdateCheck.Result.Available)
        val r = (result as UpdateCheck.Result.Available).release
        assertEquals(152L, r.versionCode)
        assertEquals("0.2.152", r.versionName)
        assertEquals("main-ccc", r.tag)
        assertTrue(r.apkUrl.endsWith("/main-ccc/local-agent-android-0.2.152.apk"))
    }

    @Test fun upToDateWhenInstalledIsNewestOrNoVersionedApkExists() {
        val json = JSONArray("[" + release("main-ccc", "local-agent-android-0.2.152.apk") + "]")
        assertTrue(UpdateCheck.decide(152, json) is UpdateCheck.Result.UpToDate)
        assertTrue(UpdateCheck.decide(143, JSONArray("[" + release("main-8adb200", "local-agent-8adb200.apk") + "]")) is UpdateCheck.Result.UpToDate)
    }
}
