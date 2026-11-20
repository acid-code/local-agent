package com.localagent.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val AccentGold = Color(0xFFE4B56A)
val AccentMint = Color(0xFF68C3A3)
val AccentRed = Color(0xFFE3786B)
val AccentBlue = Color(0xFF7C98F5)
val AccentViolet = Color(0xFFB794F4)
val AccentAmber = Color(0xFFF08C6B)
val DiffAddBg = Color(0x224ADE80)
val DiffAddText = Color(0xFF86EFAC)
val DiffDelBg = Color(0x22F87171)
val DiffDelText = Color(0xFFFCA5A5)
val DiffHunkBg = Color(0x227C98F5)
val DiffHunkText = Color(0xFF93C5FD)

/** Grok-inspired true AMOLED pitch-black dark theme for OLED phones. */
private val NightScheme = darkColorScheme(
    primary = Color(0xFFF5F6F8),
    onPrimary = Color(0xFF0A0A0C),
    secondary = AccentMint,
    onSecondary = Color(0xFF0A1914),
    tertiary = AccentGold,
    background = Color(0xFF000000),
    onBackground = Color(0xFFF3F4F6),
    surface = Color(0xFF101114),
    onSurface = Color(0xFFF3F4F6),
    surfaceVariant = Color(0xFF1A1C21),
    onSurfaceVariant = Color(0xFF9CA3AF),
    outline = Color(0xFF282B33),
    error = AccentRed,
    onError = Color(0xFF2B0E0B),
)

private val DayScheme = lightColorScheme(
    primary = Color(0xFFB57C28),
    onPrimary = Color.White,
    secondary = Color(0xFF2C7F63),
    onSecondary = Color.White,
    tertiary = Color(0xFF6D4CC9),
    background = Color(0xFFF7F7F5),
    onBackground = Color(0xFF17191E),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF17191E),
    surfaceVariant = Color(0xFFECEEF2),
    onSurfaceVariant = Color(0xFF555E6B),
    outline = Color(0xFFD5DAE2),
    error = Color(0xFFC64538),
    onError = Color.White,
)

@Composable
fun LocalAgentTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) NightScheme else DayScheme, content = content)
}

fun hexToColor(raw: String?, fallback: Color = AccentGold): Color {
    val hex = raw?.trim()?.removePrefix("#") ?: return fallback
    return runCatching {
        when (hex.length) {
            6 -> Color("FF$hex".toLong(16))
            8 -> Color(hex.toLong(16))
            else -> fallback
        }
    }.getOrDefault(fallback)
}
