package com.localagent.app.ui

import android.graphics.BitmapFactory
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.localagent.app.model.Persona
import kotlin.math.PI
import kotlin.math.cos

/** Whole-face motion. Lists stay [None]; the active or thinking persona may float or nod. */
enum class FaceMotion { None, Idle, Thinking }

@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        val resolver = context.contentResolver
        val anim = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        val trans = Settings.Global.getFloat(resolver, Settings.Global.TRANSITION_ANIMATION_SCALE, 1f)
        anim == 0f || trans == 0f
    }
}

/**
 * Persona face matching the web `Face` component: blob shapes (or a built-in / uploaded face),
 * clipped to a circle. [motion] is a whole-face transform only (no per-eye blinks) and is skipped
 * when the user prefers reduced motion.
 */
@Composable
fun PersonaAvatar(
    persona: Persona,
    sizeDp: Int,
    motion: FaceMotion = FaceMotion.None,
    modifier: Modifier = Modifier,
) {
    val look = remember(persona.id, persona.name, persona.accent, persona.avatarKind, persona.avatarRef) {
        FaceSpec.resolve(persona)
    }
    val reduced = rememberReducedMotion()
    val effective = if (reduced) FaceMotion.None else motion
    val delayMs = ((look as? FaceSpec.Look.Blob)?.floatDelaySec ?: 0.0).times(1000).toInt()
    val faceModifier = modifier
        .size(sizeDp.dp)
        .faceMotion(effective, delayMs)
        .clip(CircleShape)

    when (look) {
        is FaceSpec.Look.Upload -> UploadedFace(agentId = look.agentId, accent = look.accent, sizeDp = sizeDp, fallback = persona, modifier = faceModifier)
        is FaceSpec.Look.Builtin -> BuiltinFace(look = look, modifier = faceModifier)
        is FaceSpec.Look.Blob -> BlobFace(look = look, modifier = faceModifier)
        is FaceSpec.Look.Letter -> LetterFace(glyph = look.glyph, accent = look.accent, sizeDp = sizeDp, modifier = faceModifier)
    }
}

@Composable
private fun Modifier.faceMotion(motion: FaceMotion, delayMs: Int): Modifier {
    if (motion == FaceMotion.None) return this
    val duration = if (motion == FaceMotion.Thinking) 1350 else 3800
    val transition = rememberInfiniteTransition(label = "persona-face")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = duration, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
            initialStartOffset = StartOffset(delayMs.coerceAtLeast(0)),
        ),
        label = "persona-face-phase",
    )
    val wave = easePeak(phase)
    val tyFrac = if (motion == FaceMotion.Thinking) -0.047f * wave else -0.034f * wave
    val scaleX = if (motion == FaceMotion.Thinking) 1f - 0.03f * wave else 1f - 0.015f * wave
    val scaleY = if (motion == FaceMotion.Thinking) 1f + 0.04f * wave else 1f + 0.02f * wave
    val rot = if (motion == FaceMotion.Thinking) -2f + 5f * wave else 0f
    return graphicsLayer {
        transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, 0.56f)
        translationY = size.height * tyFrac
        this.scaleX = scaleX
        this.scaleY = scaleY
        rotationZ = rot
    }
}

/** 0 at the ends, 1 at the midpoint, with a cosine ease so it matches CSS ease-in-out. */
private fun easePeak(t: Float): Float {
    val phase = if (t <= 0.5f) t * 2f else (1f - t) * 2f
    return (1f - cos(PI.toFloat() * phase)) / 2f
}

@Composable
private fun BlobFace(look: FaceSpec.Look.Blob, modifier: Modifier) {
    val fill = hexToColor(look.accent)
    val ink = hexToColor(FaceSpec.INK, Color(0xFF16181B))
    val pathData = look.path
    Canvas(modifier) {
        val scale = size.minDimension / FaceSpec.VIEWBOX
        scale(scale, scale, pivot = Offset.Zero) {
            val body = PathParser().parsePathString(pathData).toPath()
            drawPath(body, color = fill)
            val eyeW = 5.8f
            val eyeH = 13f
            val rx = CornerRadius(2.9f, 2.9f)
            fun eye(cx: Float, cy: Float) {
                val rect = Rect(cx - eyeW / 2f, cy - eyeH / 2f, cx + eyeW / 2f, cy + eyeH / 2f)
                val path = Path().apply { addRoundRect(RoundRect(rect, rx)) }
                drawPath(path, color = ink)
            }
            eye(look.leftEye, look.eyeY)
            eye(look.rightEye, look.eyeY)
        }
    }
}

@Composable
private fun BuiltinFace(look: FaceSpec.Look.Builtin, modifier: Modifier) {
    val fill = hexToColor(look.accent)
    val hair = hexToColor(look.hair)
    val ink = hexToColor(FaceSpec.BUILTIN_INK, Color(0xFF1A140C))
    val hairPath = "M14 30c2-14 10-20 18-20s16 6 18 20v6H14z"
    Canvas(modifier) {
        val scale = size.minDimension / FaceSpec.VIEWBOX
        scale(scale, scale, pivot = Offset.Zero) {
            drawCircle(fill, radius = 30f, center = Offset(32f, 32f))
            drawPath(PathParser().parsePathString(hairPath).toPath(), color = hair)
            drawCircle(ink, radius = 2.2f, center = Offset(24f, 34f))
            drawCircle(ink, radius = 2.2f, center = Offset(40f, 34f))
            val smile = Path().apply {
                moveTo(26f, 44f)
                cubicTo(28.4f, 47f, 35.6f, 47f, 38f, 44f)
            }
            drawPath(smile, color = ink, style = Stroke(width = 2f, cap = StrokeCap.Round))
        }
    }
}

@Composable
private fun UploadedFace(agentId: String, accent: String, sizeDp: Int, fallback: Persona, modifier: Modifier) {
    val client = LocalAgentApi.current
    var bitmap by remember(agentId) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    var failed by remember(agentId) { mutableStateOf(false) }
    LaunchedEffect(agentId, client) {
        val bytes = client?.loadAvatarBytes(agentId)
        if (bytes == null || bytes.isEmpty()) {
            failed = true
            return@LaunchedEffect
        }
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        if (bmp == null) failed = true else bitmap = bmp.asImageBitmap()
    }
    val image = bitmap
    if (image != null) {
        Image(bitmap = image, contentDescription = null, contentScale = ContentScale.Crop, modifier = modifier)
    } else if (failed) {
        val blob = FaceSpec.resolve(fallback.copy(avatarKind = "initials", avatarRef = ""))
        if (blob is FaceSpec.Look.Blob) BlobFace(look = blob, modifier = modifier)
        else LetterFace(glyph = FaceSpec.initials(fallback.name), accent = accent, sizeDp = sizeDp, modifier = modifier)
    } else {
        Box(modifier.background(hexToColor(accent).copy(alpha = 0.35f)))
    }
}

@Composable
private fun LetterFace(glyph: String, accent: String, sizeDp: Int, modifier: Modifier) {
    val tint = hexToColor(accent)
    Box(
        modifier = modifier.background(tint.copy(alpha = 0.22f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, fontSize = (sizeDp * 0.44f).sp, fontWeight = FontWeight.Bold, color = tint)
    }
}

