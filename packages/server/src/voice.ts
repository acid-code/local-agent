const WHISPER = process.env.WHISPER_URL || 'http://127.0.0.1:8091';
const KOKORO = process.env.KOKORO_URL || 'http://127.0.0.1:8880';

export const WHISPER_COMMAND = 'docker run -d --name local-agent-whisper --restart unless-stopped -p 8091:8000 fedirz/faster-whisper-server:latest-cpu';
export const KOKORO_COMMAND = 'docker run -d --name local-agent-kokoro --restart unless-stopped -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest';

export async function voiceStatus(fetchImpl: typeof fetch) {
  return { whisper: await up(fetchImpl, `${WHISPER}/v1/models`), kokoro: await up(fetchImpl, `${KOKORO}/v1/models`), whisperUrl: WHISPER, kokoroUrl: KOKORO };
}

export async function transcribe(fetchImpl: typeof fetch, audio: Buffer, mime: string): Promise<string> {
  if (!(await up(fetchImpl, `${WHISPER}/v1/models`))) {
    throw new Error(`faster-whisper is not running. Start it with: ${WHISPER_COMMAND}`);
  }
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), 'speech.webm');
  form.set('model', 'whisper-1');
  const response = await fetchImpl(`${WHISPER}/v1/audio/transcriptions`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Whisper returned ${response.status}.`);
  const json = await response.json() as { text?: string };
  return json.text || '';
}

export async function speak(fetchImpl: typeof fetch, text: string): Promise<{ bytes: Buffer; type: string }> {
  if (!(await up(fetchImpl, `${KOKORO}/v1/models`))) {
    throw new Error(`Kokoro is not running. Start it with: ${KOKORO_COMMAND}`);
  }
  const response = await fetchImpl(`${KOKORO}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', input: text.slice(0, 2000), voice: 'af_heart', response_format: 'mp3' }),
  });
  if (!response.ok) throw new Error(`Kokoro returned ${response.status}.`);
  return { bytes: Buffer.from(await response.arrayBuffer()), type: 'audio/mpeg' };
}

async function up(fetchImpl: typeof fetch, url: string) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(600) });
    return response.ok;
  } catch {
    return false;
  }
}
