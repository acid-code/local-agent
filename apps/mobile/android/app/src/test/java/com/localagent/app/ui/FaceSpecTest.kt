package com.localagent.app.ui

import com.localagent.app.model.Persona
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FaceSpecTest {
    @Test
    fun hashMatchesTheWebUnsigned32BitAlgorithm() {
        // Vectors generated with the TypeScript hash in packages/web/src/components/Face.tsx
        assertEquals(3433796286L, FaceSpec.hash("Assistant"))
        assertEquals(65282053L, FaceSpec.hash("Coder"))
        assertEquals(4085100456L, FaceSpec.hash("Researcher"))
        assertEquals(2052559L, FaceSpec.hash("Auto"))
        assertEquals(94834725L, FaceSpec.hash("coder"))
        assertEquals(2091635592L, FaceSpec.hash("researcher"))
        assertEquals(1429828318L, FaceSpec.hash("assistant"))
        assertEquals(4214819048L, FaceSpec.hash("general"))
    }

    @Test
    fun defaultBlobShapeAndPaletteComeFromTheNameHashWhenNoAvatarRef() {
        val look = FaceSpec.resolve(Persona(id = "", name = "Assistant", accent = ""))
        assertTrue(look is FaceSpec.Look.Blob)
        look as FaceSpec.Look.Blob
        assertEquals(0, look.shape)
        assertEquals("#7cc59a", look.accent)
        assertEquals(FaceSpec.BLOB_PATHS[0], look.path)
        assertEquals(35f, look.leftEye)
        assertEquals(45f, look.rightEye)
        assertEquals(27f, look.eyeY)
    }

    @Test
    fun blobRefPinsTheGalleryShapeAndAccentIsKept() {
        val look = FaceSpec.resolve(
            Persona(id = "a1", name = "Coder", accent = "#9ec0e0", avatarKind = "initials", avatarRef = "blob-5"),
        )
        assertTrue(look is FaceSpec.Look.Blob)
        look as FaceSpec.Look.Blob
        assertEquals(5, look.shape)
        assertEquals("#9ec0e0", look.accent)
        assertEquals(FaceSpec.BLOB_PATHS[5], look.path)
    }

    @Test
    fun builtinHairFacesResolveByAvatarRef() {
        val look = FaceSpec.resolve(
            Persona(id = "p", name = "Nova", accent = "#e4b56a", avatarKind = "builtin", avatarRef = "nova"),
        )
        assertTrue(look is FaceSpec.Look.Builtin)
        look as FaceSpec.Look.Builtin
        assertEquals("nova", look.id)
        assertEquals("#f4f0e6", look.hair)
        assertEquals("#e4b56a", look.accent)
    }

    @Test
    fun uploadedFacesNeedAnIdAndRef() {
        val look = FaceSpec.resolve(
            Persona(id = "ag_1", name = "Me", accent = "#e4b56a", avatarKind = "upload", avatarRef = "face.png"),
        )
        assertTrue(look is FaceSpec.Look.Upload)
        assertEquals("ag_1", (look as FaceSpec.Look.Upload).agentId)
    }

    @Test
    fun letterFallbackOnlyWhenThereIsNoFaceData() {
        val look = FaceSpec.resolve(Persona(id = "", name = "", accent = "", avatarKind = "initials", avatarRef = ""))
        assertTrue(look is FaceSpec.Look.Letter)
        assertEquals("?", (look as FaceSpec.Look.Letter).glyph)
    }

    @Test
    fun initialsTakeUpToTwoLetters() {
        assertEquals("A", FaceSpec.initials(""))
        assertEquals("C", FaceSpec.initials("Coder"))
        assertEquals("SB", FaceSpec.initials("Study Buddy"))
    }
}
