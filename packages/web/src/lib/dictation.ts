/** Browser speech recognition (Chrome/Edge: webkitSpeechRecognition). Used when the server has no Whisper. */
interface RecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export function browserDictationSupported() {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Start dictation. Returns stop(); final text arrives through onText. */
export function startDictation(onText: (text: string) => void, onError: (message: string) => void): () => void {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) { onError('This browser has no built-in dictation.'); return () => undefined; }
  const rec = new Ctor();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (event) => {
    let text = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) if (event.results[i]!.isFinal) text += event.results[i]![0].transcript;
    if (text.trim()) onText(text.trim());
  };
  rec.onerror = (event) => {
    const reason = event.error === 'not-allowed' ? 'Microphone permission was denied.' : event.error === 'network' ? 'Browser dictation needs an internet connection.' : event.error === 'no-speech' ? 'No speech heard.' : `Dictation stopped (${event.error}).`;
    onError(reason);
  };
  try { rec.start(); } catch (error) { onError(error instanceof Error ? error.message : 'Could not start dictation.'); }
  return () => { try { rec.stop(); } catch { /* already stopped */ } };
}
