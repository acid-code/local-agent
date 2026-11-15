import { isHebrewText } from '@local-agent/shared';
import { PIPER_URL } from './ocr.js';
import { PIPER_VOICES } from './service-images.js';

const WHISPER = process.env.WHISPER_URL || 'http://127.0.0.1:8091';
const KOKORO = process.env.KOKORO_URL || 'http://127.0.0.1:8880';

export const WHISPER_COMMAND = 'docker run -d --name local-agent-whisper --restart unless-stopped -p 8091:8000 fedirz/faster-whisper-server:latest-cpu';
export const KOKORO_COMMAND = 'docker run -d --name local-agent-kokoro --restart unless-stopped -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest';

export async function voiceStatus(fetchImpl: typeof fetch) {
  return {
    whisper: await up(fetchImpl, `${WHISPER}/v1/models`), kokoro: await up(fetchImpl, `${KOKORO}/v1/models`), piper: await up(fetchImpl, `${PIPER_URL}/health`),
    geminiTts: Boolean(process.env.GEMINI_API_KEY), whisperUrl: WHISPER, kokoroUrl: KOKORO, piperUrl: PIPER_URL,
  };
}

/** An error the browser can act on: 503 + code no_stt means "no speech model here, use dictation or set one up". */
export class VoiceError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string, readonly hint?: string) { super(message); }
}

/** language: 'he' / 'en' as a hint, or undefined to let Whisper detect it (it handles Hebrew either way). */
export async function transcribe(fetchImpl: typeof fetch, audio: Buffer, mime: string, language?: string): Promise<string> {
  if (!audio.length) throw new VoiceError('No audio arrived. Hold the mic button while you speak.', 400, 'empty');
  if (!(await up(fetchImpl, `${WHISPER}/v1/models`))) {
    throw new VoiceError('No speech-to-text model is running on this machine.', 503, 'no_stt', `Start Whisper from Setup (Voice) or run: ${WHISPER_COMMAND}`);
  }
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), 'speech.webm');
  form.set('model', 'whisper-1');
  if (language === 'he' || language === 'en') form.set('language', language);
  let response: Response;
  try { response = await fetchImpl(`${WHISPER}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) }); }
  catch { throw new VoiceError('Whisper did not answer in time.', 504, 'stt_timeout'); }
  if (!response.ok) throw new VoiceError(`Whisper could not transcribe that (HTTP ${response.status}).`, 502, 'stt_failed');
  const json = await response.json() as { text?: string };
  return json.text || '';
}

/**
 * Text-to-speech, voice picked by the text's language. Hebrew: Piper (local, he_IL voice), then Gemini TTS when a key
 * is set. English: Kokoro, then Piper's English voice, then Gemini. When nothing is up the 503 tells the browser to
 * use its own speechSynthesis.
 */
export async function speak(fetchImpl: typeof fetch, text: string, opts: { lang?: 'he' | 'en'; geminiKey?: string } = {}): Promise<{ bytes: Buffer; type: string; engine: string }> {
  const lang = opts.lang ?? (isHebrewText(text) ? 'he' : 'en');
  const input = text.slice(0, 2000);
  const piper = async (voice: string) => {
    const response = await fetchImpl(PIPER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: input, voice }), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new VoiceError(`Piper could not speak that (HTTP ${response.status}).`, 502, 'tts_failed');
    return { bytes: Buffer.from(await response.arrayBuffer()), type: 'audio/wav', engine: `piper:${voice}` };
  };
  const key = opts.geminiKey ?? process.env.GEMINI_API_KEY;
  if (lang === 'he') {
    if (await up(fetchImpl, `${PIPER_URL}/health`)) return piper(PIPER_VOICES.he);
    if (key) return geminiTts(fetchImpl, key, input);
    throw new VoiceError('No Hebrew voice is running on this machine.', 503, 'no_tts', 'Start Piper voices on the Containers page, or add a Gemini key. The browser voice is used meanwhile.');
  }
  if (await up(fetchImpl, `${KOKORO}/v1/models`)) {
    const response = await fetchImpl(`${KOKORO}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input, voice: 'af_heart', response_format: 'mp3' }),
    });
    if (!response.ok) throw new VoiceError(`Kokoro could not speak that (HTTP ${response.status}).`, 502, 'tts_failed');
    return { bytes: Buffer.from(await response.arrayBuffer()), type: 'audio/mpeg', engine: 'kokoro' };
  }
  if (await up(fetchImpl, `${PIPER_URL}/health`)) return piper(PIPER_VOICES.en);
  if (key) return geminiTts(fetchImpl, key, input);
  throw new VoiceError('No text-to-speech model is running on this machine.', 503, 'no_tts', `Start Kokoro from Setup (Voice) or run: ${KOKORO_COMMAND}`);
}

/** Gemini TTS returns 24 kHz 16-bit mono PCM; wrap it in a WAV header. */
async function geminiTts(fetchImpl: typeof fetch, key: string, text: string) {
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } } }),
  });
  const json = await response.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[]; error?: { message?: string } };
  const data = json.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData?.data;
  if (!response.ok || !data) throw new VoiceError(json.error?.message || `Gemini could not speak that (HTTP ${response.status}).`, 502, 'tts_failed');
  return { bytes: pcmToWav(Buffer.from(data, 'base64'), 24_000), type: 'audio/wav', engine: `gemini:${model}` };
}

export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function up(fetchImpl: typeof fetch, url: string) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(600) });
    return response.ok;
  } catch {
    return false;
  }
}
