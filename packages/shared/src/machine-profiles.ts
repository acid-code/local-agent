/**
 * Setup-wizard defaults per machine: which model fills each role, which runtime to use and how to set up the iGPU.
 * Sizes are Ollama download sizes (Q4_K_M unless noted). "measured" marks what was run on a real box; everything
 * else comes from model cards and public reports and is labelled untested in docs/models.md.
 */
export type ProfileRole = 'fast' | 'main' | 'hebrew' | 'coder' | 'vision' | 'embed' | 'image';
export interface RoleModel { role: ProfileRole; model: string; sizeGiB: number; why: string; alt?: string; resident?: boolean; measured?: boolean }
export interface MachineInfo { cpu: string; gpu?: string; ramGiB: number; gttGiB?: number }
export interface RuntimeAdvice { pick: 'ollama-vulkan' | 'ollama-cpu' | 'llamacpp-vulkan' | 'ollama-rocm'; why: string; env: Record<string, string>; host: string[] }
export interface MachineProfile {
  id: string; title: string; ramCapGiB: number; roles: RoleModel[]; runtime: RuntimeAdvice; notes: string[];
  match: (machine: MachineInfo) => boolean;
}

const VULKAN_ENV = { OLLAMA_HOST: '0.0.0.0:11434', OLLAMA_VULKAN: '1', OLLAMA_IGPU_ENABLE: '1', GGML_VK_VISIBLE_DEVICES: '0', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_CONTEXT_LENGTH: '32768', OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_KEEP_ALIVE: '15m' };
// Let the iGPU map ~38 GiB of system RAM through GTT on Ubuntu Server 26.04 LTS (pages are 4 KiB: 38 * 262144 = 9961472).
const GTT_HOST = [
  'OS: Ubuntu Server 26.04 LTS (recommended in README).',
  'BIOS: UMA Frame Buffer Size = Auto (or 2–4 GB). Keep the carve-out small; the iGPU borrows the rest through GTT.',
  'sudo sed -i \'s/^GRUB_CMDLINE_LINUX_DEFAULT="/&ttm.pages_limit=9961472 amdgpu.gttsize=38912 /\' /etc/default/grub',
  'sudo update-grub && sudo reboot',
  'cat /sys/class/drm/card*/device/mem_info_gtt_total   # expect ~40802189312 (~38 GiB)',
  'sudo usermod -aG render,video ollama && sudo apt install -y mesa-vulkan-drivers vulkan-tools',
  'vulkaninfo --summary | grep -i radv',
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
      { role: 'coder', model: 'gpt-oss:20b', sizeGiB: 13.8, why: 'Default non-Qwen local coder; fast MoE with 128K context (64K–128K on repo tasks) that fits cleanly beside resident models or runs via llama-server.', alt: 'qwen3.6:35b-a3b (via llama-server + DFlash2), or devstral' },
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
      'Recommended OS: Ubuntu Server 26.04 LTS with GRUB GTT raised to ~38 GiB (see host steps above).',
      'RAM cap 40 GB with OLLAMA_MAX_LOADED_MODELS=2: main (18 GB) + fast (3.3 GB) + embed (0.6 GB) stay loaded (~22 GB + q8_0 KV cache); the coder (gpt-oss:20b, ~13.8 GB) swaps in for code turns.',
      'Default context is 16K–32K per role, expanding to 64K–128K for the coder on repository tasks.',
      'For maximum APU speed or GGUF models with DFlash2 speculative decoding, run llama-server under systemd on 127.0.0.1 and configure it in Settings → System.',
    ],
  },
  {
    id: 'generic-32g', title: '32 GB machine, CPU or small iGPU', ramCapGiB: 24,
    match: (m) => m.ramGiB >= 24 && m.ramGiB < 40,
    roles: [
      { role: 'main', model: 'gemma4:26b-a4b-it-qat', sizeGiB: 16, resident: true, why: 'QAT 4-bit MoE: the largest Hebrew-capable model that leaves room.' },
      { role: 'hebrew', model: 'gemma4:26b-a4b-it-qat', sizeGiB: 0, resident: true, why: 'Same as main.' },
      { role: 'fast', model: 'gemma3:4b', sizeGiB: 3.3, resident: true, measured: true, why: 'Measured Hebrew quality on a CPU box.' },
      { role: 'coder', model: 'gpt-oss:20b', sizeGiB: 13.8, why: 'Default non-Qwen coder; on demand, swaps with main.' },
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

export interface InstallRow { role: ProfileRole; model: string; sizeGiB: number; resident: boolean; installed: boolean; viaOllama: boolean; changed: boolean }
export interface InstallPlan { profileId: string; ramCapGiB: number; rows: InstallRow[]; pulls: string[]; downloadGiB: number; residentGiB: number; peakGiB: number; fits: boolean; warnings: string[] }

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || b === `${a}:latest`;

/**
 * What the installer will pull for a profile with the user's per-role changes, and whether it fits the RAM cap.
 * Resident models (loaded together) plus the largest on-demand model must stay under the cap with ~15% for KV cache.
 * `sizes` gives GiB for models the user typed in (from the catalog); otherwise the size is estimated from the name ("32b" -> ~20 GB at Q4).
 */
export function planInstall(profile: Pick<MachineProfile, 'id' | 'ramCapGiB' | 'roles'>, choices: Partial<Record<ProfileRole, string>> = {}, installed: string[] = [], sizes: Record<string, number> = {}): InstallPlan {
  const rows: InstallRow[] = profile.roles.map((row) => {
    const picked = choices[row.role]?.trim();
    const model = picked || row.model;
    const changed = Boolean(picked && picked !== row.model);
    const params = Number(model.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/)?.[1] ?? NaN);
    const sizeGiB = changed ? (sizes[model] ?? (Number.isFinite(params) ? Math.round((params * 0.6 + 1) * 10) / 10 : (row.sizeGiB || 4))) : row.sizeGiB;
    return { role: row.role, model, sizeGiB, resident: Boolean(row.resident), installed: installed.some((name) => sameModel(name, model)), viaOllama: row.role !== 'image', changed };
  });
  const sizeOf = (model: string) => Math.max(...rows.filter((row) => row.model === model).map((row) => row.sizeGiB), 0);
  const residentModels = [...new Set(rows.filter((row) => row.resident && row.viaOllama).map((row) => row.model))];
  const residentGiB = residentModels.reduce((sum, model) => sum + sizeOf(model), 0);
  const onDemand = [...new Set(rows.filter((row) => !row.resident && row.viaOllama && !residentModels.includes(row.model)).map((row) => row.model))];
  const largest = Math.max(0, ...onDemand.map(sizeOf));
  // The RAM queue unloads the main model for a big on-demand one, so the peak is the larger of the two sets.
  const mainGiB = sizeOf(rows.find((row) => row.role === 'main')?.model ?? '');
  const peakGiB = Math.max(residentGiB, residentGiB - mainGiB + largest) * 1.15;
  const pulls = [...new Set(rows.filter((row) => row.viaOllama && !row.installed).map((row) => row.model))];
  const downloadGiB = Math.round(pulls.reduce((sum, model) => sum + sizeOf(model), 0) * 10) / 10;
  const warnings: string[] = [];
  if (residentGiB * 1.15 > profile.ramCapGiB) warnings.push(`Models kept loaded need ~${Math.round(residentGiB * 1.15)} GB with KV cache, over the ${profile.ramCapGiB} GB cap. Pick a smaller main or fast model.`);
  else if (peakGiB > profile.ramCapGiB) warnings.push(`Swapping in the largest on-demand model peaks at ~${Math.round(peakGiB)} GB, over the ${profile.ramCapGiB} GB cap. Pick a smaller coder.`);
  for (const row of rows) if (row.changed && sizes[row.model] === undefined) warnings.push(`Size of ${row.model} is estimated from its name: ~${row.sizeGiB} GB at 4-bit.`);
  if (rows.some((row) => !row.viaOllama)) warnings.push('The image model is not an Ollama model; it downloads the first time you generate an image.');
  return { profileId: profile.id, ramCapGiB: profile.ramCapGiB, rows, pulls, downloadGiB, residentGiB: Math.round(residentGiB * 10) / 10, peakGiB: Math.round(peakGiB * 10) / 10, fits: peakGiB <= profile.ramCapGiB, warnings };
}

/** The auto-model map for a plan (same shape as autoMapFor). */
export function autoMapForPlan(plan: InstallPlan) {
  const get = (role: ProfileRole) => plan.rows.find((row) => row.role === role)?.model ?? '';
  return { fast: get('fast'), main: get('main'), coder: get('coder'), thinking: get('coder'), embed: get('embed') };
}
