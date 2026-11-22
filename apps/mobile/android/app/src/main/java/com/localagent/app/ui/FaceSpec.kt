package com.localagent.app.ui

import com.localagent.app.model.Persona

/**
 * The web face gallery, kept in one place so Android draws the same shapes, colours and
 * eye positions as `packages/web/src/components/Face.tsx`.
 */
object FaceSpec {
    /** Hair colours for the built-in "people" faces (nova, oak, …). */
    val HAIR: Map<String, String> = mapOf(
        "nova" to "#f4f0e6",
        "oak" to "#6b4a2e",
        "iris" to "#2a2340",
        "moss" to "#1e3a2f",
        "ember" to "#3a2418",
        "tide" to "#16324a",
        "flint" to "#2c3138",
        "luma" to "#efe6c9",
    )

    val PALETTE: List<String> = listOf(
        "#e4b56a", "#9dccb4", "#9ec0e0", "#e39486", "#d7b4e8",
        "#ffb08a", "#7cc59a", "#b89cf0", "#56b4e9", "#f2a65a",
    )

    /** Simple flat shapes with two pill eyes (no mouth). ViewBox is 0 0 64 64. */
    val BLOB_PATHS: List<String> = listOf(
        "M46.7 52.5L41.5 55.5Q32.0 61.0 22.5 55.5L17.3 52.5Q7.8 47.0 7.8 36.0L7.8 30.0Q7.8 19.0 17.3 13.5L22.5 10.5Q32.0 5.0 41.5 10.5L46.7 13.5Q56.2 19.0 56.2 30.0L56.2 36.0Q56.2 47.0 46.7 52.5Z",
        "M5 37C5 23 17 13 33 13s26 8 26 21-11 21-28 21S5 50 5 37z",
        "M36.0 15.6L53.6 39.2Q61.4 49.6 48.5 51.1L19.3 54.6Q6.4 56.2 11.5 44.2L23.1 17.2Q28.2 5.2 36.0 15.6Z",
        "M32 7c14.4 0 25 10.6 25 25S46.4 57 32 57 7 46.4 7 32 17.6 7 32 7z",
        "M40.9 12.5L49.7 18.9Q58.6 25.3 55.2 35.8L51.9 46.2Q48.5 56.7 37.5 56.7L26.5 56.7Q15.5 56.7 12.1 46.2L8.8 35.8Q5.4 25.3 14.3 18.9L23.1 12.5Q32.0 6.0 40.9 12.5Z",
        "M38.8 55.2L21.6 53.9Q7.6 52.7 8.8 38.8L10.1 21.6Q11.3 7.6 25.2 8.8L42.4 10.1Q56.4 11.3 55.2 25.2L53.9 42.4Q52.7 56.4 38.8 55.2Z",
    )

    /** Eye centres per shape: a little up and to the right, so every face looks the same way. */
    val EYES: List<Triple<Float, Float, Float>> = listOf(
        Triple(35f, 45f, 27f),
        Triple(37f, 48f, 27f),
        Triple(31f, 41f, 36f),
        Triple(35f, 45f, 27f),
        Triple(35f, 45f, 29f),
        Triple(35f, 45f, 27f),
    )

    const val INK = "#16181b"
    const val BUILTIN_INK = "#1a140c"
    const val VIEWBOX = 64f

    /** Same unsigned 32-bit hash as the web `Face` component. */
    fun hash(text: String): Long {
        var h = 0L
        for (ch in text) {
            h = (h * 31L + ch.code) and 0xFFFFFFFFL
        }
        return h
    }

    fun accentFor(id: String?, name: String, accent: String?): String {
        val raw = accent?.trim().orEmpty()
        if (HEX.matches(raw)) return raw
        val seed = hash(id?.takeIf { it.isNotBlank() } ?: name)
        return PALETTE[(seed % PALETTE.size).toInt()]
    }

    fun resolve(persona: Persona): Look {
        val accent = accentFor(persona.id, persona.name, persona.accent)
        val kind = persona.avatarKind.trim().lowercase()
        val ref = persona.avatarRef.trim()
        if (kind == "upload" && persona.id.isNotBlank() && ref.isNotBlank()) {
            return Look.Upload(agentId = persona.id, accent = accent)
        }
        if (kind == "builtin" && HAIR.containsKey(ref)) {
            return Look.Builtin(id = ref, hair = HAIR.getValue(ref), accent = accent)
        }
        val seed = hash(persona.id.ifBlank { persona.name })
        val blobMatch = BLOB_REF.matchEntire(ref)
        val shape = if (blobMatch != null) {
            blobMatch.groupValues[1].toInt() % BLOB_PATHS.size
        } else {
            (seed % BLOB_PATHS.size).toInt()
        }
        if (persona.name.isBlank() && persona.id.isBlank() && blobMatch == null && persona.accent.isBlank()) {
            return Look.Letter(glyph = "?", accent = accent)
        }
        val eyes = EYES[shape]
        return Look.Blob(
            shape = shape,
            path = BLOB_PATHS[shape],
            leftEye = eyes.first,
            rightEye = eyes.second,
            eyeY = eyes.third,
            accent = accent,
            blinkDelaySec = (seed % 37L) / 10.0,
            floatDelaySec = (seed % 29L) / 10.0,
        )
    }

    fun initials(name: String): String {
        val letters = name.split(Regex("\\s+")).filter { it.isNotBlank() }.take(2).map { it.first().uppercaseChar() }
        return if (letters.isEmpty()) "A" else letters.joinToString("")
    }

    sealed class Look {
        abstract val accent: String

        data class Blob(
            val shape: Int,
            val path: String,
            val leftEye: Float,
            val rightEye: Float,
            val eyeY: Float,
            override val accent: String,
            val blinkDelaySec: Double,
            val floatDelaySec: Double,
        ) : Look()

        data class Builtin(
            val id: String,
            val hair: String,
            override val accent: String,
        ) : Look()

        data class Upload(
            val agentId: String,
            override val accent: String,
        ) : Look()

        data class Letter(
            val glyph: String,
            override val accent: String,
        ) : Look()
    }

    private val HEX = Regex("^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
    private val BLOB_REF = Regex("^blob-(\\d)$")
}
