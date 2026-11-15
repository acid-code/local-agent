import { isHebrew } from '../i18n';

/**
 * Read a reply aloud. The server picks a voice by the text's language (Hebrew: Piper, then Gemini TTS; English: Kokoro);
 * when it has none, the browser's speechSynthesis reads it with a voice in the same language.
 * Returns false only when nothing can speak at all. Pressing again stops.
 */
let playing: HTMLAudioElement | null = null;
let serverVoice: boolean | null = null;

export function plainForSpeech(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/\[(?:file|msg):[^\]]+\]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

export function speak(text: string): boolean {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (playing) { playing.pause(); playing = null; return true; }
  if (synth?.speaking) { synth.cancel(); return true; }
  const plain = plainForSpeech(text);
  const lang = isHebrew(plain) ? 'he' : 'en';
  if (serverVoice === false) return browserSpeak(plain, lang);
  void (async () => {
    try {
      const response = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ text: plain, lang }) });
      if (!response.ok) throw new Error(String(response.status));
      serverVoice = true;
      const audio = new Audio(URL.createObjectURL(await response.blob()));
      playing = audio;
      audio.onended = () => { if (playing === audio) playing = null; };
      await audio.play();
    } catch {
      // 503 = no server voice for this language; remember for English only (Hebrew may come up when Piper starts).
      if (lang === 'en') serverVoice = false;
      browserSpeak(plain, lang);
    }
  })();
  return true;
}

function browserSpeak(plain: string, lang: 'he' | 'en'): boolean {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
  const utterance = new SpeechSynthesisUtterance(plain);
  const name = localStorage.getItem('la-voice');
  const chosen = localStorage.getItem('la-voice-lang');
  const voices = synth.getVoices();
  const picked = name && name !== 'default' ? voices.find((row) => row.name === name) : undefined;
  // The picked voice only when it speaks this text's language; otherwise any voice that does.
  const fits = (voice?: SpeechSynthesisVoice) => voice && voice.lang.toLowerCase().startsWith(lang === 'he' ? 'he' : 'en');
  const voice = fits(picked) ? picked : voices.find((row) => fits(row));
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || (lang === 'he' ? 'he-IL' : chosen && chosen !== 'auto' ? chosen : 'en-US');
  synth.speak(utterance);
  return true;
}
