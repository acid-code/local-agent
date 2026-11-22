package com.localagent.app.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

/** Relative timestamps matching the web chat list (`now`, `5m`, `2h`, `3d`, or `Nov 12`). */
object SessionTime {
    private val dateFmt = DateTimeFormatter.ofPattern("MMM d", Locale.ENGLISH)

    fun relative(iso: String, nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        if (iso.isBlank()) return ""
        val then = parseIso(iso) ?: return ""
        val minutes = ((nowMs - then) / 60000.0).roundToInt()
        if (minutes < 1) return "now"
        if (minutes < 60) return "${minutes}m"
        val hours = (minutes / 60.0).roundToInt()
        if (hours < 24) return "${hours}h"
        val days = (hours / 24.0).roundToInt()
        if (days < 7) return "${days}d"
        return Instant.ofEpochMilli(then).atZone(zone).format(dateFmt)
    }

    fun parseIso(iso: String): Long? = runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
}
