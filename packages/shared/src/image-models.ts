/**
 * Local image models the setup site can download from Hugging Face and run with stable-diffusion.cpp.
 * Add more by appending to IMAGE_MODELS here, or at runtime through settings.imageGen.extraModels (same shape).
 */
export type ImageFileRole = 'model' | 'diffusion' | 'vae' | 'clip_l' | 't5xxl';

export interface ImageModelFile {
  role: ImageFileRole;
  /** Hugging Face repo id, e.g. "Green-Sky/SD-Turbo-GGUF". */
  repo: string;
  /** Path inside the repo. */
  file: string;
  /** Size in bytes, shown before download. */
  bytes: number;
  /** The repo needs a Hugging Face token (and accepting its licence on huggingface.co). */
  gated?: boolean;
}

export interface ImageModelSpec {
  id: string;
  name: string;
  blurb: string;
  speed: 'fast' | 'medium' | 'slow';
  files: ImageModelFile[];
  steps: number;
  cfg: number;
  size: number;
  sampler: string;
  /** Rough RAM needed while drawing. */
  ramGiB: number;
  licence: string;
}

export const IMAGE_MODELS: ImageModelSpec[] = [
  {
    id: 'sd-turbo', name: 'SD-Turbo', blurb: 'Default. One step at 512 px, fine on a CPU (roughly 10-40 s).', speed: 'fast',
    files: [{ role: 'model', repo: 'Green-Sky/SD-Turbo-GGUF', file: 'sd_turbo-f16-q8_0.gguf', bytes: 2_023_745_376 }],
    steps: 1, cfg: 1, size: 512, sampler: 'euler_a', ramGiB: 3, licence: 'Stability AI Community',
  },
  {
    id: 'sdxl-turbo', name: 'SDXL-Turbo', blurb: 'Sharper and better at composition. About twice as slow as SD-Turbo.', speed: 'medium',
    files: [{ role: 'model', repo: 'OlegSkutte/sdxl-turbo-GGUF', file: 'sd_xl_turbo_1.0.q8_0.gguf', bytes: 4_098_988_672 }],
    steps: 2, cfg: 1, size: 512, sampler: 'euler_a', ramGiB: 6, licence: 'Stability AI Community',
  },
  {
    id: 'flux-schnell', name: 'FLUX.1-schnell (Q4)', blurb: 'Quality, slow. Best prompt following and text in images; minutes per image on a CPU.', speed: 'slow',
    files: [
      { role: 'diffusion', repo: 'city96/FLUX.1-schnell-gguf', file: 'flux1-schnell-Q4_0.gguf', bytes: 6_770_707_360 },
      { role: 'vae', repo: 'black-forest-labs/FLUX.1-schnell', file: 'ae.safetensors', bytes: 335_304_388, gated: true },
      { role: 'clip_l', repo: 'comfyanonymous/flux_text_encoders', file: 'clip_l.safetensors', bytes: 246_144_152 },
      { role: 't5xxl', repo: 'comfyanonymous/flux_text_encoders', file: 't5xxl_fp8_e4m3fn.safetensors', bytes: 4_893_934_904 },
    ],
    steps: 4, cfg: 1, size: 512, sampler: 'euler', ramGiB: 14, licence: 'Apache-2.0',
  },
];

export const imageModelBytes = (spec: ImageModelSpec) => spec.files.reduce((sum, file) => sum + file.bytes, 0);
/** Local file name for a model file: the repo path's base name, which is unique across the catalog. */
export const imageFileName = (file: ImageModelFile) => file.file.split('/').pop() || file.file;
export const hfUrl = (file: ImageModelFile) => `https://huggingface.co/${file.repo}/resolve/main/${file.file.split('/').map(encodeURIComponent).join('/')}`;

export function imageCatalog(extra: ImageModelSpec[] = []): ImageModelSpec[] {
  const seen = new Set<string>();
  return [...IMAGE_MODELS, ...extra].filter((spec) => !seen.has(spec.id) && seen.add(spec.id));
}
