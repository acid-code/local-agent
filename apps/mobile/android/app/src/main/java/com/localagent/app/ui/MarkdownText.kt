package com.localagent.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private sealed interface Block {
    data class Paragraph(val text: String) : Block
    data class Heading(val level: Int, val text: String) : Block
    data class Item(val marker: String, val text: String, val indent: Int) : Block
    data class Quote(val text: String) : Block
    data class Table(val rows: List<List<String>>) : Block
    data object Rule : Block
    data class Code(val text: String) : Block
}

private val HEBREW = Regex("[\\u0590-\\u05FF]")
private val LATIN = Regex("[A-Za-z]")
private val ITEM = Regex("^(\\s*)([-*•]|\\d{1,3}[.)])\\s+(.*)$")
private val LINK = Regex("^\\[([^\\]]+)]\\(([^)\\s]+)\\)")

/** Right-to-left when Hebrew letters outnumber Latin ones, so bullets and alignment flip with the language. */
private fun isRtl(text: String): Boolean = HEBREW.findAll(text).count() > LATIN.findAll(text).count()

private fun splitRow(line: String): List<String> =
    line.trim().trim('|').split('|').map { it.trim() }

private fun parseBlocks(raw: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val parts = raw.split("```")
    parts.forEachIndexed { index, part ->
        if (index % 2 == 1) {
            blocks += Block.Code(part.substringAfter('\n', part).trimEnd())
            return@forEachIndexed
        }
        val para = StringBuilder()
        fun flush() { if (para.isNotBlank()) blocks += Block.Paragraph(para.toString().trim()); para.clear() }
        val lines = part.lines()
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val t = line.trim()
            when {
                t.isEmpty() -> flush()
                Regex("^#{1,4}\\s+.+").matches(t) -> { flush(); blocks += Block.Heading(t.takeWhile { it == '#' }.length, t.trimStart('#').trim()) }
                Regex("^([-*_])\\1{2,}$").matches(t.replace(" ", "")) -> { flush(); blocks += Block.Rule }
                t.startsWith(">") -> { flush(); blocks += Block.Quote(t.trimStart('>').trim()) }
                t.startsWith("|") && t.count { it == '|' } >= 2 -> {
                    flush()
                    val rows = mutableListOf<List<String>>()
                    while (i < lines.size && lines[i].trim().startsWith("|")) {
                        val row = lines[i].trim()
                        if (!Regex("^\\|?[\\s:|-]+\\|?$").matches(row)) rows += splitRow(row)
                        i++
                    }
                    i--
                    if (rows.isNotEmpty()) blocks += Block.Table(rows)
                }
                ITEM.matches(line) -> {
                    flush()
                    val m = ITEM.matchEntire(line)!!
                    val marker = m.groupValues[2].let { if (it[0].isDigit()) it else "•" }
                    blocks += Block.Item(marker, m.groupValues[3], (m.groupValues[1].length / 2).coerceAtMost(3))
                }
                else -> { if (para.isNotEmpty()) para.append('\n'); para.append(t) }
            }
            i++
        }
        flush()
    }
    return blocks
}

private fun inline(src: String, link: Color, codeBg: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < src.length) {
        val rest = src.substring(i)
        when {
            rest.startsWith("**") && src.indexOf("**", i + 2) > i + 2 -> {
                val end = src.indexOf("**", i + 2)
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(inline(src.substring(i + 2, end), link, codeBg)) }
                i = end + 2
            }
            rest.startsWith("`") && src.indexOf('`', i + 1) > i + 1 -> {
                val end = src.indexOf('`', i + 1)
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, fontSize = 13.sp)) { append(" ${src.substring(i + 1, end)} ") }
                i = end + 1
            }
            rest.startsWith("*") && !rest.startsWith("**") && rest.length > 2 && !rest[1].isWhitespace() && src.indexOf('*', i + 1) > i + 1 -> {
                val end = src.indexOf('*', i + 1)
                withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inline(src.substring(i + 1, end), link, codeBg)) }
                i = end + 1
            }
            rest.startsWith("[") && LINK.containsMatchIn(rest) -> {
                val m = LINK.find(rest)!!
                withStyle(SpanStyle(color = link, textDecoration = TextDecoration.Underline)) { append(m.groupValues[1]) }
                i += m.value.length
            }
            else -> { append(src[i]); i++ }
        }
    }
}

/** Markdown for chat replies on the phone: headings, bold/italic/code, lists, quotes, tables and code blocks; Hebrew flips to right-to-left per block. */
@Composable
fun MarkdownBody(raw: String, modifier: Modifier = Modifier) {
    val blocks = remember(raw) { parseBlocks(raw) }
    val link = MaterialTheme.colorScheme.secondary
    val codeBg = MaterialTheme.colorScheme.surfaceVariant
    val body = MaterialTheme.typography.bodyMedium.copy(lineHeight = 23.sp, textDirection = TextDirection.Content)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block ->
            when (block) {
                is Block.Paragraph -> BlockDirection(block.text) { Text(inline(block.text, link, codeBg), style = body) }
                is Block.Heading -> BlockDirection(block.text) {
                    Text(
                        inline(block.text, link, codeBg),
                        style = when (block.level) {
                            1 -> MaterialTheme.typography.titleLarge
                            2 -> MaterialTheme.typography.titleMedium
                            else -> MaterialTheme.typography.titleSmall
                        }.copy(fontWeight = FontWeight.Bold, textDirection = TextDirection.Content),
                        modifier = Modifier.padding(top = if (block.level <= 2) 6.dp else 2.dp),
                    )
                }
                is Block.Item -> BlockDirection(block.text) {
                    Row(Modifier.fillMaxWidth().padding(start = (block.indent * 14).dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(block.marker, style = body, color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.Bold, modifier = Modifier.widthIn(min = 14.dp))
                        Text(inline(block.text, link, codeBg), style = body, modifier = Modifier.weight(1f))
                    }
                }
                is Block.Quote -> BlockDirection(block.text) {
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.tertiary, RoundedCornerShape(2.dp)))
                        Text(inline(block.text, link, codeBg), style = body.copy(fontStyle = FontStyle.Italic), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    }
                }
                is Block.Table -> BlockDirection(block.rows.flatten().joinToString(" ")) {
                    Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                        Column {
                            block.rows.forEachIndexed { r, cells ->
                                Row(
                                    Modifier.fillMaxWidth().background(if (r == 0) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent).padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.Top,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    cells.forEach { cell ->
                                        Text(
                                            inline(cell, link, codeBg),
                                            style = MaterialTheme.typography.bodySmall.copy(textDirection = TextDirection.Content),
                                            fontWeight = if (r == 0) FontWeight.Bold else FontWeight.Normal,
                                            modifier = Modifier.weight(1f),
                                        )
                                    }
                                }
                                if (r < block.rows.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
                            }
                        }
                    }
                }
                Block.Rule -> HorizontalDivider(color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(vertical = 4.dp))
                is Block.Code -> CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    val ctx = LocalContext.current
                    var codeCopied by remember(block.text) { mutableStateOf(false) }
                    LaunchedEffect(codeCopied) {
                        if (codeCopied) {
                            kotlinx.coroutines.delay(1500)
                            codeCopied = false
                        }
                    }
                    Surface(color = MaterialTheme.colorScheme.background, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                        Box(Modifier.fillMaxWidth()) {
                            Text(
                                block.text,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                modifier = Modifier.padding(start = 10.dp, top = 10.dp, bottom = 10.dp, end = 38.dp),
                            )
                            IconButton(
                                onClick = {
                                    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                    cm.setPrimaryClip(ClipData.newPlainText("code", block.text))
                                    codeCopied = true
                                },
                                modifier = Modifier.align(Alignment.TopEnd).size(32.dp),
                            ) {
                                Icon(
                                    if (codeCopied) Icons.Default.Check else Icons.Default.ContentCopy,
                                    contentDescription = "Copy code",
                                    modifier = Modifier.size(14.dp),
                                    tint = if (codeCopied) AccentMint else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BlockDirection(sample: String, content: @Composable () -> Unit) {
    val dir = if (isRtl(sample)) LayoutDirection.Rtl else LayoutDirection.Ltr
    CompositionLocalProvider(LocalLayoutDirection provides dir) { content() }
}
