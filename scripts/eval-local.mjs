#!/usr/bin/env node
// Golden checks against a local Ollama. Skips cleanly when Ollama is down.
import fs from 'node:fs';
import path from 'node:path';

const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const golden = JSON.parse(fs.readFileSync(path.resolve('personas/golden.json'), 'utf8'));
const planner = golden.cases.find((item) => item.persona === 'planner');

let tags;
try {
  const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(String(response.status));
  tags = await response.json();
} catch {
  console.log('Ollama is not running. Local persona eval skipped.');
  process.exit(0);
}

const name = tags.models?.[0]?.name;
if (!name) {
  console.log('Ollama has no models. Local persona eval skipped.');
  process.exit(0);
}

const response = await fetch(`${host}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: name,
    stream: false,
    format: 'json',
    messages: [{ role: 'user', content: `${planner.input.content} Reply as JSON {"items":["..."]}.` }],
  }),
});
if (!response.ok) {
  console.error(`Ollama chat failed (${response.status}).`);
  process.exit(1);
}
const body = await response.json();
const parsed = JSON.parse(body.message?.content || '{}');
if (!Array.isArray(parsed.items) || !parsed.items.length) {
  console.error('Planner output did not match the plan contract.');
  process.exit(1);
}
console.log(`Local eval passed on ${name}.`);
