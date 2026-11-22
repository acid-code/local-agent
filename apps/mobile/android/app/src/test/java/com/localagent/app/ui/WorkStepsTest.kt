package com.localagent.app.ui

import com.localagent.app.model.ApprovalItem
import com.localagent.app.model.ChatMessage
import com.localagent.app.model.ToolCall
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkStepsTest {
    private fun at(s: Int) = java.time.Instant.parse("2026-11-22T12:00:00Z").plusSeconds(s.toLong()).toString()

    private val messages = listOf(
        ChatMessage(id = "u1", role = "user", content = "fix the bug", createdAt = at(0)),
        ChatMessage(
            id = "a1", role = "assistant", content = "Let me look at the file first.",
            thinking = "The bug is probably in Chat.tsx", createdAt = at(1), runId = "r1",
            toolCalls = listOf(ToolCall(id = "c1", name = "read_file", arguments = """{"path":"packages/web/src/pages/Chat.tsx"}""")),
        ),
        ChatMessage(id = "t1", role = "tool", content = "export function Chat() {}", toolCallId = "c1", toolName = "read_file", createdAt = at(3), runId = "r1"),
        ChatMessage(
            id = "a2", role = "assistant", content = "", createdAt = at(4), runId = "r1",
            toolCalls = listOf(
                ToolCall(id = "c2", name = "write_file", arguments = """{"path":"src/a.ts","content":"x"}"""),
                ToolCall(id = "c3", name = "shell", arguments = """{"command":"npm test\necho done"}"""),
            ),
        ),
        ChatMessage(id = "t2", role = "tool", content = "ok", toolCallId = "c2", toolName = "write_file", createdAt = at(5), runId = "r1"),
        ChatMessage(id = "t3", role = "tool", content = "Error: 1 failed", toolCallId = "c3", toolName = "shell", createdAt = at(65), runId = "r1"),
        ChatMessage(id = "a3", role = "assistant", content = "Fixed it.", createdAt = at(70), runId = "r1"),
    )

    @Test
    fun groupsToolWorkBetweenTheUserMessageAndTheFinalAnswer() {
        val items = WorkSteps.group(messages)
        assertEquals(listOf("message", "work", "message"), items.map { if (it is WorkSteps.Item.Work) "work" else "message" })
        val group = (items[1] as WorkSteps.Item.Work).group
        assertEquals(3, group.stepCount)
        assertEquals(listOf("thought", "narration", "step", "step", "step"), group.rows.map { row ->
            when (row) {
                is WorkSteps.Row.Thought -> "thought"
                is WorkSteps.Row.Narration -> "narration"
                is WorkSteps.Row.Step -> "step"
            }
        })
        assertEquals(64_000L, group.durationMs)
        assertEquals(listOf("r1"), group.runIds)
        val steps = group.rows.filterIsInstance<WorkSteps.Row.Step>()
        assertEquals(
            listOf(
                "Read|Chat.tsx|packages/web/src/pages/Chat.tsx|2000|false",
                "Edited|a.ts|src/a.ts|1000|false",
                "Ran|npm test||61000|true",
            ),
            steps.map { "${it.verb}|${it.target}|${it.files.joinToString(",")}|${it.durationMs}|${it.failed}" },
        )
    }

    @Test
    fun marksACallWithoutAResultAsPending() {
        val group = (WorkSteps.group(
            listOf(
                ChatMessage(
                    id = "a", role = "assistant", content = "",
                    toolCalls = listOf(ToolCall(id = "x", name = "web_search", arguments = """{"query":"local llm news"}""")),
                ),
            ),
        ).first() as WorkSteps.Item.Work).group
        val step = group.rows.first() as WorkSteps.Row.Step
        assertEquals("Searched the web for", step.verb)
        assertEquals("local llm news", step.target)
        assertTrue(step.pending)
        assertEquals("x", step.callId)
        assertEquals("web_search", step.toolName)
    }

    @Test
    fun describesUnknownToolsAndFormatsDurationsAndDiffs() {
        val d = WorkSteps.describeStep("github_create_issue", mapOf("action" to "create"))
        assertEquals(WorkSteps.Icon.Tool, d.icon)
        assertEquals("Used github create issue", d.verb)
        assertEquals("create", d.target)
        assertEquals("45s", WorkSteps.formatDuration(45_000))
        assertEquals("2m 05s", WorkSteps.formatDuration(125_000))
        assertEquals("", WorkSteps.formatDuration(null))
        assertEquals(2 to 1, WorkSteps.diffStats(listOf("--- a/x\n+++ b/x\n@@\n-old\n+new\n+more\n context")))
    }

    @Test
    fun liveHeaderAndCompletedHeaderMatchTheWebCopy() {
        val live = WorkSteps.Group(id = "work-a", rows = emptyList(), stepCount = 3, durationMs = 64_000, runIds = listOf("r1"))
        assertEquals("Working · 3 steps so far", WorkSteps.headerTitle(live, live = true))
        assertEquals("Completed 3 steps in 1m 04s", WorkSteps.headerTitle(live, live = false))
        val one = live.copy(stepCount = 1, durationMs = 45_000)
        assertEquals("Completed 1 step in 45s", WorkSteps.headerTitle(one, live = false))
    }

    @Test
    fun attachesTheWaitingApprovalToThePendingStep() {
        val group = (WorkSteps.group(
            listOf(
                ChatMessage(
                    id = "a", role = "assistant", content = "",
                    toolCalls = listOf(
                        ToolCall(id = "c1", name = "read_file", arguments = """{"path":"a.ts"}"""),
                        ToolCall(id = "c2", name = "shell", arguments = """{"command":"ls node_modules 2>/dev/null | wc -l"}"""),
                    ),
                ),
                ChatMessage(id = "t1", role = "tool", content = "ok", toolCallId = "c1", toolName = "read_file"),
            ),
        ).first() as WorkSteps.Item.Work).group
        val steps = group.rows.filterIsInstance<WorkSteps.Row.Step>()
        assertEquals(false, steps[0].pending)
        assertEquals(true, steps[1].pending)
        val approval = ApprovalItem(
            id = "ap1", runId = "r1", toolName = "shell", reason = "[medium risk] Shell command",
            toolCallId = "c2", summary = "ls node_modules 2>/dev/null | wc -l",
        )
        assertNull(WorkSteps.approvalFor(steps[0], listOf(approval)))
        assertEquals("ap1", WorkSteps.approvalFor(steps[1], listOf(approval))?.id)
    }
}
