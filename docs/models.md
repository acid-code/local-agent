# Models and runtime for the Glorlin TG105 mini PC

Target box: Ryzen 7 8745HS (8C/16T, Zen 4), Radeon 780M iGPU (RDNA3, gfx1103, 12 CUs), 48 GB DDR5-5600, 1 TB SSD,
Linux. local-agent caps everything it runs at **40 GB** (`ramBudgetGiB`), which leaves ~8 GB for the OS, Docker and the
browser.

Labels: **measured** = run on a real machine by us (CPU box, not the TG105 yet). **reported** = public benchmarks on the
same chip family. **untested** = not run anywhere by us. Everything GPU-related is untested until `scripts/bench-runtime.sh`
runs on the real box.

## Main model: Gemma 4 26B-A4B vs Qwen3.6-35B-A3B

| | Gemma 4 26B-A4B (`gemma4:26b-a4b`) | Qwen3.6-35B-A3B (`qwen3.6:35b-a3b`) |
|---|---|---|
| Download (Q4_K_M) | ~18 GB | ~23 GB |
| Active parameters | 3.8B (MoE) | 3B (MoE) |
| Input | text + images (documents, handwriting) | text (vision variants are separate) |
| Context | 256K (we run 16K) | 256K (we run 16K) |
| Tools / agentic | good | stronger, especially coding and long tool chains |
| Hebrew | Gemma family: 0 code-switching on 8/8 prompts (gemma3:4b, **measured**); 26B expected better, **untested** | Qwen3 leaked English reasoning on 8/8 Hebrew prompts (qwen3:4b, **measured**); 3.6 **untested** |
| Speed on 780M | ~20–30 t/s decode expected for a ~4B-active MoE, **untested** | ~20 t/s Q8 Vulkan, ~29 t/s Q4 (Qwen3-30B-A3B on an 8845HS, **reported**) |

**Pick: Gemma 4 26B-A4B as main** (kept loaded). It covers chat, Hebrew and vision with one model, so OCR fallback and
Hebrew cost no extra RAM. **Qwen3.6-35B-A3B is the coder**, loaded on demand. Both together (~41 GB plus KV cache) pass
the cap, so the RAM queue unloads main while the coder runs. If you mostly code, swap them in Setup → Recommended models.

## Defaults per role (profile `ryzen-780m-48g`)

| Role | Model | GB | Loaded | Why |
|---|---|---|---|---|
| Main | gemma4:26b-a4b | 18 | always | See above |
| Hebrew | gemma4:26b-a4b | 0 | always | Same model; Gemini 2.5 Flash wins when a key is set |
| Fast chat | gemma3:4b | 3.3 | always | Titles, summaries, short replies, the Hebrew polish pass (**measured**: fluent Hebrew, some factual mistakes) |
| Coder | qwen3.6:35b-a3b | 23 | on demand | Strongest agentic coder that fits; alt `qwen3-coder:30b` (19 GB) |
| Vision / OCR | Tesseract eng+heb, then gemma4:26b-a4b | 0 | always | Printed text via Tesseract first; handwriting via main (gemma3:4b **measured**: English handwriting perfect, Hebrew partial) |
| Embeddings | embeddinggemma | 0.6 | always | Multilingual incl. Hebrew; nomic-embed-text is English-first |
| Image | sdxl-turbo (stable-diffusion.cpp, Vulkan) | 4.1 | on demand | Seconds per image expected on the iGPU, **untested** |

RAM: kept loaded ≈ 22 GB (+15% KV/server ≈ 25 GB). Peak with the coder swapped in for main ≈ 31 GB. Both under 40.

Small models we measured for Hebrew (CPU box): gemma3:4b best; gemma3:1b OK but adds English preambles (2/8);
qwen3:1.7b weak vocabulary; qwen3:0.6b unusable. Other profiles: `generic-32g` (24 GB cap, QAT Gemma 4) and
`generic-16g` (10 GB cap, gemma3:4b).

## Runtime: Ollama Vulkan vs llama.cpp Vulkan vs ROCm

| | Ollama + Vulkan | llama.cpp server (Vulkan) | ROCm (Ollama or llama.cpp) |
|---|---|---|---|
| Works on 780M (gfx1103) | yes (RADV) | yes (RADV) | not officially; needs `HSA_OVERRIDE_GFX_VERSION=11.0.0`, crashes reported |
| local-agent integration | native: pulls, RAM queue, unload, vision, tools | via the OpenAI-compatible provider; no pulls or RAM queue | as Ollama |
| Speed | same llama.cpp kernels, small overhead | fastest by a few %, newest Vulkan fixes first | no gain over Vulkan on RDNA3 iGPUs in reports |
| Risk | Ollama 0.32.10+ Vulkan regression for models >~18 GB on 780M (ErrorDeviceLost); raising GTT fixed it for others | manual model files | driver fragility |

**Pick: Ollama with Vulkan**, with llama.cpp as the fallback if the bench shows it >15% faster or Ollama hits the
regression. Decode on an iGPU is memory-bandwidth bound (DDR5-5600 dual channel ≈ 80–90 GB/s), so the GPU mainly speeds
up prompt reading (~3x **reported**) and frees the CPU for the rest of the system.

Ollama Vulkan env (systemd override, written by `bench-runtime.sh --apply`):

```
OLLAMA_VULKAN=1 OLLAMA_IGPU_ENABLE=1 GGML_VK_VISIBLE_DEVICES=0 OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_MAX_LOADED_MODELS=2 OLLAMA_KEEP_ALIVE=15m
```

## UMA frame buffer and GTT

- **BIOS: UMA Frame Buffer Size = 2 GB** (or Auto). Do not set 16 GB: a carve-out is lost to the CPU even when the GPU is idle.
  The iGPU borrows the rest dynamically through GTT.
- Raise GTT to 40 GiB so large models fit on the GPU:

```bash
echo "options ttm pages_limit=10485760 page_pool_size=10485760" | sudo tee /etc/modprobe.d/amdgpu-gtt.conf   # 40 GiB in 4 KiB pages
echo "options amdgpu gttsize=40960" | sudo tee -a /etc/modprobe.d/amdgpu-gtt.conf                            # older kernels
sudo update-initramfs -u && sudo reboot
sudo usermod -aG render,video ollama
sudo apt install mesa-vulkan-drivers vulkan-tools && vulkaninfo --summary | grep -i radv
cat /sys/class/drm/card*/device/mem_info_gtt_total   # expect ~42949672960
```

Kernel 6.10+ recommended for the 780M. GTT memory is still system RAM: the 40 GB app cap already counts it.

## Installing the models

Setup → **Recommended models for this machine** (also shown in the empty chat on first run):

1. Detects CPU, RAM and GPU and picks the profile (you can choose another).
2. Shows each role's model, size, whether it is installed, peak RAM against the cap and the download size.
3. Edit any role; the plan recomputes (sizes from the catalog or estimated from the name) and refuses plans over the cap.
4. **Install** pulls the missing models one at a time with progress, then saves the role map, RAM cap and image model.

API: `GET /api/setup/profile`, `POST /api/setup/profile/plan {id?, choices}`, `POST /api/setup/profile/install {confirm:true, id?, choices}`.

## Picking the runtime on the real machine

```bash
scripts/bench-runtime.sh gemma4:26b-a4b          # measure: Ollama CPU vs Ollama Vulkan (+ llama.cpp if LA_BENCH_GGUF is set)
scripts/bench-runtime.sh gemma4:26b-a4b --apply  # also write the winner into the Ollama service and restart it
```

If the running Ollama is not using Vulkan, the script starts a temporary Vulkan Ollama on :11499 against the same model
store for the GPU run, then stops it. The GPU wins only when it is ≥15% faster at decode or ≥2x at prompt reading. The
result is saved to `data/runtime-bench.json` and shown in Setup. Setup → **Benchmark runtimes** runs the same
measurement against the running Ollama.

## Not tested yet

All 780M numbers, the Ollama Vulkan regression workaround, Gemma 4 / Qwen3.6 Hebrew quality, sdxl-turbo on Vulkan,
and ROCm. Run the bench on arrival and update this page with the numbers.
