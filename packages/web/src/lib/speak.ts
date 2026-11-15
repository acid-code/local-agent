/** Read a reply aloud with the browser's voices, using the voice and language picked in the status panel. */
export function speak(text: string) {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
  if (synth.speaking) { synth.cancel(); return true; }
  const plain = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[#*_`>|[\]]/g, '').slice(0, 4000);
  const utterance = new SpeechSynthesisUtterance(plain);
  const name = localStorage.getItem('la-voice');
  const lang = localStorage.getItem('la-voice-lang');
  const voice = name && name !== 'default' ? synth.getVoices().find((row) => row.name === name) : undefined;
  if (voice) utterance.voice = voice;
  if (lang && lang !== 'auto') utterance.lang = lang;
  synth.speak(utterance);
  return true;
}
