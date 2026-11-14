# Images

local-agent can make pictures. Agents call the `generate_image` tool, and typing `/image <description>` in any chat makes one directly. Results show as image previews with a download button and are saved in that user's own files (`data/users/<id>/files` for members).

## Backends

| Mode | What runs | Notes |
|---|---|---|
| Auto (default) | Local first, then Gemini | Gemini only for accounts allowed to use it |
| Local | stable-diffusion.cpp (`sd-cli`) on the mini PC, or any AUTOMATIC1111-compatible API (`/sdapi/v1/txt2img`: sd-webui, Forge, sd.cpp `sd-server`) | Private and free; CPU-bound |
| Gemini | `gemini-2.5-flash-image` | Counted in the shared Gemini quota (Settings > quotaLimits for that model, else 20/day on the free tier) |

Members obey their Gemini limit: with Gemini off they only ever get the local runner.

## Local models

Install from the setup site (Images card) or Models > Image role. Files come from Hugging Face into `data/image/models`, with progress, resume and disk checks.

| Model | Download | RAM | Speed on a CPU |
|---|---|---|---|
| SD-Turbo (default) | 2.0 GB | ~3 GB | 1 step, ~20 s at 512 px (measured on an 8-core box) |
| SDXL-Turbo | 4.1 GB | ~6 GB | about twice SD-Turbo |
| FLUX.1-schnell Q4 ("quality, slow") | 12.2 GB | ~14 GB | minutes per image |

FLUX's VAE lives in a gated repo: accept the licence on huggingface.co, then save your token as `HF_TOKEN` in the vault (Settings > Vault). The token is only sent to Hugging Face.

More models: add entries to `IMAGE_MODELS` in `packages/shared/src/image-models.ts`, or at runtime through `PATCH /api/settings` with `imageGen.extraModels` (same shape: id, files with Hugging Face repo/file/bytes, steps, cfg, size, sampler).

## The runner

"Install stable-diffusion.cpp" downloads the latest prebuilt release for the platform (Vulkan build when a GPU device such as an iGPU is present). If the prebuilt binary needs a newer glibc than the system has (common on Debian 12/13 and Ubuntu 24.04), the installer builds a static `sd-cli` inside Docker using the same distro as the host and copies it out. No compiler is needed on the host.

Health: Settings > Health shows an `image` check (runner and model present, or Gemini covering).

## Video

Video generation is intentionally not supported. Current open video models (Wan 2.x, HunyuanVideo, LTX-Video) need a large GPU (12-24 GB VRAM) and take many minutes per second of video even then; on a mini PC CPU/iGPU they are impractical. Cloud video APIs are paid-only. If a future model runs acceptably on this hardware, it would slot in as another role next to images.
