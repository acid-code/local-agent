package com.localagent.app.live

import org.junit.Assert.assertEquals
import org.junit.Test

class LiveSyncTest {
    data class M(val id: String, val role: String, val content: String)
    private fun merge(local: List<M>, server: List<M>) = LiveSync.mergeSnapshot(local, server, { it.id }, { it.role }, { it.content })

    @Test fun backoffGrowsThenCaps() {
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 15000L, 15000L), (0..5).map(LiveSync::backoffMs))
    }

    @Test fun runStartedElsewhereIsAdopted() {
        assertEquals(LiveSync.Action.AdoptRun("run_b", "running"), LiveSync.action("status", "run_b", "running", false, "run_a"))
        assertEquals(LiveSync.Action.None, LiveSync.action("status", "run_a", "running", false, "run_a"))
        assertEquals(LiveSync.Action.None, LiveSync.action("status", "run_b", "completed", false, "run_a"))
    }

    @Test fun otherRunsMessagesAndEndsUpdateTheChat() {
        assertEquals(LiveSync.Action.UpsertMessage, LiveSync.action("message", "run_b", null, true, "run_a"))
        assertEquals(LiveSync.Action.None, LiveSync.action("message", "run_a", null, true, "run_a"))
        assertEquals(LiveSync.Action.Reload, LiveSync.action("done", "run_b", null, false, "run_a"))
        assertEquals(LiveSync.Action.Reload, LiveSync.action("done", "run_b", null, false, null))
    }

    @Test fun reconnectSnapshotMergesWithoutLosingOlderPagesOrPendingSends() {
        val local = listOf(M("m1", "user", "a"), M("m2", "assistant", "b"), M("m3", "user", "c"), M("local_1", "user", "typed offline"), M("local_2", "user", "d"))
        val server = listOf(M("m2", "assistant", "b"), M("m3", "user", "c"), M("m4", "assistant", "missed reply"), M("m5", "user", "d"))
        assertEquals(listOf("m1", "m2", "m3", "m4", "m5", "local_1"), merge(local, server).map { it.id })
    }
}
