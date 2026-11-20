import { isHebrew } from '../i18n';

/**
 * Read a reply aloud. The server picks a voice by the text's language (Hebrew: Piper, then Gemini TTS; English: Kokoro);
 * when it has none, the browser's speechSynthesis reads it with a voice in the same language.
 * Returns false only when nothing can speak at all. Pressing again stops.
 */
let playing: HTMLAudioElement | null = null;
let playingUrl: string | null = null;
let playingKey: string | null = null;
let serverVoice: boolean | null = null;
const listeners = new Set<(activeKey: string | null) => void>();

function notify(key: string | null) {
  playingKey = key;
  listeners.forEach((fn) => fn(key));
}

export function subscribeSpeaking(fn: (activeKey: string | null) => void) {
  listeners.add(fn);
  fn(playingKey);
  return () => { listeners.delete(fn); };
}

export function stopSpeaking() {
  if (playing) {
    playing.pause();
    playing = null;
  }
  if (playingUrl) {
    URL.revokeObjectURL(playingUrl);
    playingUrl = null;
  }
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (synth?.speaking) synth.cancel();
  notify(null);
}

export function plainForSpeech(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/\[(?:file|msg):[^\]]+\]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

export function speak(text: string, opts: { key?: string; lang?: 'he' | 'en'; agentId?: string; voice?: string } = {}): boolean {
  const targetKey = opts.key || 'voice';
  if (playingKey && playingKey === targetKey) {
    stopSpeaking();
    return true;
  }
  stopSpeaking();
  const plain = plainForSpeech(text);
  if (!plain) return false;
  const lang = opts.lang ?? (isHebrew(plain) ? 'he' : 'en');
  if (serverVoice === false && !opts.voice) return browserSpeak(plain, lang, targetKey);
  notify(targetKey);
  void (async () => {
    try {
      const response = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: plain, lang, agentId: opts.agentId, voice: opts.voice }),
      });
      if (!response.ok) throw new Error(String(response.status));
      serverVoice = true;
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      playing = audio;
      playingUrl = url;
      const cleanup = () => {
        if (playing === audio) playing = null;
        if (playingUrl === url) { URL.revokeObjectURL(url); playingUrl = null; }
        if (playingKey === targetKey) notify(null);
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      await audio.play();
    } catch {
      if (lang === 'en') serverVoice = false;
      if (!browserSpeak(plain, lang, targetKey)) notify(null);
    }
  })();
  return true;
}

function browserSpeak(plain: string, lang: 'he' | 'en', key: string): boolean {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
  const utterance = new SpeechSynthesisUtterance(plain);
  const name = localStorage.getItem('la-voice');
  const chosen = localStorage.getItem('la-voice-lang');
  const voices = synth.getVoices();
  const picked = name && name !== 'default' ? voices.find((row) => row.name === name) : undefined;
  const fits = (voice?: SpeechSynthesisVoice) => voice && voice.lang.toLowerCase().startsWith(lang === 'he' ? 'he' : 'en');
  const voice = fits(picked) ? picked : voices.find((row) => fits(row));
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || (lang === 'he' ? 'he-IL' : chosen && chosen !== 'auto' ? chosen : 'en-US');
  utterance.onend = () => { if (playingKey === key) notify(null); };
  utterance.onerror = () => { if (playingKey === key) notify(null); };
  notify(key);
  synth.speak(utterance);
  return true;
}
