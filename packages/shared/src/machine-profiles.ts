/**
 * Setup-wizard defaults per machine: which model fills each role, which runtime to use and how to set up the iGPU.
 * Sizes are Ollama download sizes (Q4_K_M unless noted). "measured" marks what was run on a real box; everything
 * else comes from model cards and public reports and is labelled untested in docs/models-and-runtimes.md.
 */
export type ProfileRole = 'fast' | 'main' | 'hebrew' | 'coder' | 'vision' | 'embed' | 'image';
export interface RoleModel { role: ProfileRole; model: string; sizeGiB: number; why: string; alt?: string; resident?: boolean; measured?: boolean }
export interface MachineInfo { cpu: string; gpu?: string; ramGiB: number; gttGiB?: number }
export interface RuntimeAdvice { pick: 'ollama-vulkan' | 'ollama-cpu' | 'llamacpp-vulkan' | 'ollama-rocm'; why: string; env: Record<string, string>; host: string[] }
export interface MachineProfile {
  id: string; title: string; ramCapGiB: number; roles: RoleModel[]; runtime: RuntimeAdvice; notes: string[];
  match: (machine: MachineInfo) => boolean;
}

const VULKAN_ENV = { OLLAMA_VULKAN: '1', OLLAMA_IGPU_ENABLE: '1', GGML_VK_VISIBLE_DEVICES: '0', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_CONTEXT_LENGTH: '16384', OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_KEEP_ALIVE: '15m' };
// Let the iGPU map up to 40 GiB of system RAM through GTT (pages are 4 KiB): 40 * 262144.
const GTT_HOST = [
  'BIOS: UMA Frame Buffer Size = 2G (or "Auto"). Keep the carve-out small; the iGPU borrows the rest through GTT, so the CPU keeps the RAM when the GPU is idle.',
  'echo "options ttm pages_limit=10485760 page_pool_size=10485760" | sudo tee /etc/modprobe.d/amdgpu-gtt.conf  # 40 GiB GTT',
  'echo "options amdgpu gttsize=40960" | sudo tee -a /etc/modprobe.d/amdgpu-gtt.conf  # older kernels',
  'sudo update-initramfs -u && sudo reboot',
  'sudo usermod -aG render,video ollama  # the service user needs /dev/dri/renderD128',
  'sudo apt install mesa-vulkan-drivers vulkan-tools && vulkaninfo --summary | grep -i radv',
];

export const MACHINE_PROFILES: MachineProfile[] = [
  {
    id: 'ryzen-780m-48g',
    title: 'Mini PC: Ryzen 7 8745HS + Radeon 780M, 48 GB DDR5 (Glorlin TG105 and similar)',
    ramCapGiB: 40,
    match: (m) => (/8745H|8845H|8840H|7840H|7940H|780M|Phoenix|Hawk Point/i.test(`${m.cpu} ${m.gpu ?? ''}`)) && m.ramGiB >= 40 && m.ramGiB <= 64,
    roles: [
      { role: 'main', model: 'gemma4:26b-a4b', sizeGiB: 18, resident: true, why: 'MoE with 3.8B active parameters, so it decodes about as fast as a 4B model; text + image input, 256K context, tools. The Gemma family wrote the cleanest Hebrew in our test.', alt: 'qwen3.6:35b-a3b (23 GB) as main if you mostly code' },
      { role: 'hebrew', model: 'gemma4:26b-a4b', sizeGiB: 0, resident: true, why: 'Same model as main: Gemma had zero code-switching in our Hebrew test (gemma3:4b, 8/8 prompts) while Qwen3 leaked English. Gemini wins when a key is set.', alt: 'Gemini 2.5 Flash (cloud) when GEMINI_API_KEY is set' },
      { role: 'fast', model: 'gemma3:4b', sizeGiB: 3.3, resident: true, measured: true, why: 'Small, quick, decent Hebrew (measured on the box) and vision; titles, summaries, short replies and the Hebrew polish pass.', alt: 'gemma4:e4b' },
      { role: 'coder', model: 'qwen3.6:35b-a3b', sizeGiB: 23, why: 'Strongest agentic coder that fits; 3B active, ~20 t/s reported on a 780M (Vulkan, Q8). Loaded on demand: the RAM queue swaps it with main, both together pass the 40 GB cap.', alt: 'qwen3.6:35b-a3b-coding, or qwen3-coder:30b (19 GB)' },
      { role: 'vision', model: 'gemma4:26b-a4b', sizeGiB: 0, resident: true, why: 'Main model reads images, documents and handwriting itself, so handwriting OCR costs no extra RAM. Tesseract (eng+heb) handles printed text first.', alt: 'gemma3:4b (measured: English handwriting perfect, Hebrew partial)' },
      { role: 'embed', model: 'embeddinggemma', sizeGiB: 0.6, resident: true, why: 'Multilingual (100+ languages incl. Hebrew) 768-dim embeddings for the library; nomic-embed-text is English-first.', alt: 'nomic-embed-text' },
      { role: 'image', model: 'sdxl-turbo', sizeGiB: 4.1, why: 'stable-diffusion.cpp Vulkan build on the iGPU; sharper than SD-Turbo, still seconds per image on a 780M.', alt: 'flux-schnell (12 GB, slow) for text in images' },
    ],
    runtime: {
      pick: 'ollama-vulkan',
      why: 'Ollama is what local-agent drives (pulls, RAM queue, vision, tools) and its Vulkan backend is the same llama.cpp/RADV path that works on the 780M. ROCm does not support gfx1103 (needs HSA_OVERRIDE_GFX_VERSION, crashes reported). Decode is memory-bandwidth bound, so the iGPU mainly speeds up prompt reading (~3x) and frees the CPU; run the bench to confirm on the real box.',
      env: VULKAN_ENV,
      host: GTT_HOST,
    },
    notes: [
      'RAM cap 40 GB: main (18) + fast (3.3) + embed (0.6) stay loaded (~22 GB + KV cache); the coder (23) swaps in for code turns.',
      'Do not keep gemma4:26b-a4b and qwen3.6:35b-a3b loaded together: ~41 GB plus KV cache passes the cap.',
      'Ollama 0.32.10+ had a Vulkan regression on the 780M for models over ~18 GB (ErrorDeviceLost); raising GTT as above fixed it for others. If it still fails, pin the model to CPU (num_gpu 0) or use llama.cpp server (Vulkan) through the OpenAI-compatible provider.',
    ],
  },
  {
    id: 'generic-32g', title: '32 GB machine, CPU or small iGPU', ramCapGiB: 24,
    match: (m) => m.ramGiB >= 24 && m.ramGiB < 40,
    roles: [
      { role: 'main', model: 'gemma4:26b-a4b-it-qat', sizeGiB: 16, resident: true, why: 'QAT 4-bit MoE: the largest Hebrew-capable model that leaves room.' },
      { role: 'hebrew', model: 'gemma4:26b-a4b-it-qat', sizeGiB: 0, resident: true, why: 'Same as main.' },
      { role: 'fast', model: 'gemma3:4b', sizeGiB: 3.3, resident: true, measured: true, why: 'Measured Hebrew quality on a CPU box.' },
      { role: 'coder', model: 'qwen3-coder:30b', sizeGiB: 19, why: 'On demand; swaps with main.' },
      { role: 'vision', model: 'gemma3:4b', sizeGiB: 0, resident: true, measured: true, why: 'Handwriting fallback after Tesseract.' },
      { role: 'embed', model: 'embeddinggemma', sizeGiB: 0.6, resident: true, why: 'Multilingual embeddings.' },
      { role: 'image', model: 'sd-turbo', sizeGiB: 2, why: 'CPU-friendly.' },
    ],
    runtime: { pick: 'ollama-cpu', why: 'No reliable GPU path assumed; run the bench to check.', env: { OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' }, host: [] },
    notes: [],
  },
  {
    id: 'generic-16g', title: '16 GB machine', ramCapGiB: 10,
    match: (m) => m.ramGiB < 24,
    roles: [
      { role: 'main', model: 'gemma3:4b', sizeGiB: 3.3, resident: true, measured: true, why: 'Best Hebrew of the small models we measured.' },
      { role: 'hebrew', model: 'gemma3:4b', sizeGiB: 0, resident: true, measured: true, why: 'Same as main; the Hebrew polish pass helps here.' },
      { role: 'fast', model: 'gemma3:1b', sizeGiB: 0.8, resident: true, measured: true, why: 'Fast; adds English preambles sometimes (polish pass catches most).' },
      { role: 'coder', model: 'qwen2.5-coder:7b', sizeGiB: 4.7, why: 'On demand.' },
      { role: 'vision', model: 'gemma3:4b', sizeGiB: 0, resident: true, measured: true, why: 'Handwriting fallback.' },
      { role: 'embed', model: 'nomic-embed-text', sizeGiB: 0.3, resident: true, why: 'Small.' },
      { role: 'image', model: 'sd-turbo', sizeGiB: 2, why: 'CPU-friendly.' },
    ],
    runtime: { pick: 'ollama-cpu', why: 'Small RAM; keep it simple.', env: {}, host: [] },
    notes: [],
  },
];

export function profileFor(machine: MachineInfo): MachineProfile {
  return MACHINE_PROFILES.find((profile) => profile.match(machine)) ?? MACHINE_PROFILES[MACHINE_PROFILES.length - 1]!;
}

/** Models resident at once must fit the cap (with ~15% for KV cache and the server). */
export function residentGiB(profile: MachineProfile) {
  const seen = new Set<string>();
  return profile.roles.filter((row) => row.resident && !seen.has(row.model) && seen.add(row.model)).reduce((sum, row) => sum + row.sizeGiB, 0);
}

/** The auto-model map the wizard writes (roles the app routes by). */
export function autoMapFor(profile: MachineProfile) {
  const get = (role: ProfileRole) => profile.roles.find((row) => row.role === role)?.model ?? '';
  return { fast: get('fast'), main: get('main'), coder: get('coder'), thinking: get('coder'), embed: get('embed') };
}
