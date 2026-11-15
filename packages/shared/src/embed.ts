import { hebrewVariants } from './hebrew.js';

/** Deterministic feature-hash embeddings. Used when Gemini Embedding is closed or unset. */

export function hashEmbed(text: string, dim = 256): Float32Array {
  const vector = new Float32Array(dim);
  // Any script; Hebrew words lose their glued-on prefixes (הבית → בית) so forms of one word share a bucket.
  const tokens = (text.toLowerCase().replace(/[\u0591-\u05C7]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 1)
    .map((token) => (/[\u05D0-\u05EA]/.test(token) ? hebrewVariants(token).at(-1)! : token));
  const grams = tokens.length ? tokens : [text.slice(0, 48).toLowerCase() || 'empty'];
  for (let index = 0; index < grams.length; index += 1) {
    const gram = grams[index + 1] ? `${grams[index]}_${grams[index + 1]}` : grams[index]!;
    const hash = fnv(gram);
    vector[hash % dim] += hash & 1024 ? 1 : -1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dim; index += 1) vector[index] /= norm;
  return vector;
}

export function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom ? dot / denom : 0;
}

export function topK<T>(
  items: T[],
  vector: (item: T) => ArrayLike<number>,
  query: ArrayLike<number>,
  k: number,
): { item: T; score: number }[] {
  return items
    .map((item) => ({ item, score: cosine(vector(item), query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function fnv(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
