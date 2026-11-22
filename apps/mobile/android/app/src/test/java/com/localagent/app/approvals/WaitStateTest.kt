package com.localagent.app.approvals

import com.localagent.app.model.WaitState
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WaitStateTest {
    @Test fun queueFromWaitInfoHidesForce() {
        val w = WaitState.of("Waiting for gemma4 to finish (queued).", JSONObject("""{"kind":"queue","behind":"gemma4","ahead":1,"since":"2026-11-22T13:00:00Z"}"""))
        assertTrue(w.queue)
        assertFalse(w.canForce)
        assertEquals("Queued behind gemma4", w.title)
        assertEquals("2026-11-22T13:00:00Z", w.sinceIso)
    }

    @Test fun queueFromDetailTextOnOlderServers() {
        val w = WaitState.of("Waiting for the uncensored llama-server model to finish in another chat (queued).", null)
        assertTrue(w.queue)
        assertEquals("Queued behind uncensored llama-server model", w.title)
        val two = WaitState.of("Waiting for qwen3 to finish (queued, 2 ahead).", null)
        assertEquals(2, two.ahead)
    }

    @Test fun memoryWaitKeepsForce() {
        val w = WaitState.of("Waiting for memory, 1 ahead", JSONObject("""{"ahead":1,"neededBytes":1,"availableBytes":0,"usedBytes":0,"budgetBytes":1,"reason":"x"}"""))
        assertFalse(w.queue)
        assertTrue(w.canForce)
        assertEquals("Waiting for memory", w.title)
    }
}
