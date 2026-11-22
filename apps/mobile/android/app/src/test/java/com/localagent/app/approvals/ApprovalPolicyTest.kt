package com.localagent.app.approvals

import com.localagent.app.model.ApprovalItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalPolicyTest {
    private fun item(id: String, risk: String = "medium") = ApprovalItem(id = id, runId = "r", toolName = "shell", reason = "", risk = risk)

    @Test fun highAndUnknownRiskAreNeverOneTap() {
        assertFalse(ApprovalPolicy.oneTapAllowed("high"))
        assertFalse(ApprovalPolicy.oneTapAllowed("weird"))
        assertTrue(ApprovalPolicy.needsConfirm("high"))
        assertTrue(ApprovalPolicy.oneTapAllowed("medium"))
        assertTrue(ApprovalPolicy.oneTapAllowed("low"))
    }

    @Test fun riskFallsBackToReasonPrefixThenHigh() {
        assertEquals("low", ApprovalPolicy.riskOf(null, "[low risk] write file"))
        assertEquals("medium", ApprovalPolicy.riskOf("medium", "[high risk] x"))
        assertEquals("high", ApprovalPolicy.riskOf("", "Start coding from this plan."))
        assertEquals("write file", ApprovalPolicy.cleanReason("[low risk] write file"))
    }

    @Test fun planPostsOnlyNewAndCancelsDecided() {
        val plan = ApprovalPolicy.plan(listOf(item("a"), item("b")), setOf("a", "gone"))
        assertEquals(listOf("b"), plan.post.map { it.id })
        assertEquals(setOf("gone"), plan.cancel)
        assertEquals(setOf("a", "b"), plan.notified)
        val again = ApprovalPolicy.plan(listOf(item("a"), item("b")), plan.notified)
        assertTrue(again.post.isEmpty())
        assertTrue(again.cancel.isEmpty())
    }

    @Test fun parsesServerPayloadIncludingNulls() {
        val list = ApprovalPolicy.parseList(
            """{"approvals":[{"id":"ap1","runId":"run1","toolName":"shell","reason":"[medium risk] rm","risk":"medium","summary":"rm -rf build","sessionId":"s1","sessionTitle":"Marketplace","agentName":null}]}""",
        )
        assertEquals(1, list.size)
        val a = list[0]
        assertEquals("medium", a.risk)
        assertEquals("rm -rf build", a.summary)
        assertEquals("s1", a.sessionId)
        assertEquals("Marketplace", a.sessionTitle)
        assertNull(a.agentName)
    }

    @Test fun oldServerWithoutRiskFieldStillWorks() {
        val a = ApprovalPolicy.parseList("""{"approvals":[{"id":"x","runId":"r","toolName":"git","reason":"push to origin"}]}""")[0]
        assertEquals("high", a.risk)
        assertNull(a.sessionId)
    }

    @Test fun notificationIdsAreStableAndDistinct() {
        assertEquals(ApprovalPolicy.notificationId("ap1"), ApprovalPolicy.notificationId("ap1"))
        assertTrue(ApprovalPolicy.notificationId("ap1") != ApprovalPolicy.notificationId("ap2"))
        assertTrue(ApprovalPolicy.notificationId("ap1") >= 10_000)
    }
}
