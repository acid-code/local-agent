package com.localagent.app.model

import com.localagent.app.ui.SessionTime
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneOffset

class AgentJsonTest {
    @Test
    fun parsesFaceFieldsFromTheAgentsApi() {
        val persona = AgentJson.persona(
            JSONObject(
                """{"id":"ag_coder","name":"Coder","title":"Writes and fixes code","accent":"#9ec0e0",
                    "avatarKind":"initials","avatarRef":"blob-5","emoji":"","pinned":true}""",
            ),
        )
        assertEquals("ag_coder", persona.id)
        assertEquals("Coder", persona.name)
        assertEquals("#9ec0e0", persona.accent)
        assertEquals("initials", persona.avatarKind)
        assertEquals("blob-5", persona.avatarRef)
        assertEquals(true, persona.pinned)
    }

    @Test
    fun parsesSessionSummaryAndUpdatedAt() {
        val session = AgentJson.session(
            JSONObject(
                """{"id":"ses_1","agentId":"ag_coder","title":"make me a script","mode":"chat",
                    "updatedAt":"2026-11-22T16:00:00Z","summary":"Added a package.json script"}""",
            ),
        )
        assertEquals("ses_1", session.id)
        assertEquals("ag_coder", session.agentId)
        assertEquals("Added a package.json script", session.summary)
        assertEquals("2026-11-22T16:00:00Z", session.updatedAt)
        assertNull(session.modelPin)
    }

    @Test
    fun relativeTimeMatchesTheWebChatList() {
        val now = 1_000_000_000_000L
        fun iso(deltaMs: Long) = java.time.Instant.ofEpochMilli(now - deltaMs).toString()
        assertEquals("now", SessionTime.relative(iso(20_000), nowMs = now))
        assertEquals("5m", SessionTime.relative(iso(5 * 60_000L), nowMs = now))
        assertEquals("2h", SessionTime.relative(iso(2 * 60 * 60_000L), nowMs = now))
        assertEquals("3d", SessionTime.relative(iso(3 * 24 * 60 * 60_000L), nowMs = now))
        val late = java.time.Instant.parse("2026-11-22T16:00:00Z").toEpochMilli()
        assertEquals("Oct 4", SessionTime.relative("2026-10-04T12:00:00Z", nowMs = late, zone = ZoneOffset.UTC))
        assertEquals("", SessionTime.relative(""))
    }
}
