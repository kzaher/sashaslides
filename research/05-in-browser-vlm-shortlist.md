# In-Browser VLM Shortlist (for a slide-building agent)

Research cutoff: 2026-04-11. Target hardware: 32 GB system RAM, up to 24 GB
available to Chrome for model weights + KV cache, WebGPU enabled.

## TL;DR

**Default pick: Qwen2.5-VL-7B-Instruct (Apache-2.0) via transformers.js (ONNX + WebGPU)**.
It is the only open-weight VLM in April 2026 that ticks every box:

- open weights (Apache-2.0)
- runnable in Chrome today via the `onnx-community/Qwen2.5-VL-7B-Instruct` export
- ≤ 6 GB VRAM at q4 — leaves ~18 GB headroom for KV cache and batch
- top-tier document-reading scores (DocVQA 95.7, ChartQA 87.3, OCRBench 86.4)
- trained for tool calling and computer-use
- strong enough on MMMU (58.6) and ScreenSpot (84.7) to be the brain, not just a tool

Fallbacks and alternates are listed below with reasons.

## Runtime landscape (2026-04)

### MLC-AI WebLLM
Ships **exactly two VLMs** in `prebuiltAppConfig`: `Phi-3.5-vision-instruct`
at q4f16 (~3.95 GB) and q4f32 (~5.88 GB). Adding a new VLM requires MLC-LLM
compilation + WGSL kernels for the vision tower — non-trivial. PagedAttention
exists internally but there is no public prefix-cache API.

### Hugging Face transformers.js v4
Runs on ONNX Runtime Web + WebGPU. Working in-browser VLM paths today:
SmolVLM-{256M,500M,2.2B}, Moondream2, Florence-2, Phi-3.5-Vision,
Qwen2-VL-2B, Qwen2.5-VL-{3B,7B} (ViT path still flaky on some ops). Nothing
larger than ~8 B runs reliably — the ViT forward pass or the KV cache buffer
blows past Chrome's ~2 GB per-GPU-buffer limit.

### wllama / candle-wasm / ratchet / ORT Web (raw)
wllama is CPU-only. candle-wasm and ratchet ship text-only demos. ORT Web
is what transformers.js v4 wraps, so it's a viable direct path if you want
to hand-write a Qwen2.5-VL pipeline.

### Prefix caching + batching — out of the box?
**No.** Neither WebLLM nor transformers.js exposes KV-prefix reuse or
request batching. vLLM / SGLang RadixAttention has no browser implementation.
You build both on top — see `src/local_composer/radix-cache.ts` and
`src/local_composer/batcher.ts`.

## Benchmarks (published)

Leaders in **bold** across the columns reported. Dashes = not published.

| Model | Params | q4 VRAM | MMMU | MathVista | OCRBench | DocVQA | ChartQA | ScreenSpot | ScreenSpot-Pro | OSWorld | HumanEval |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SmolVLM2-2.2B | 2.2 B | 1.5 GB | 34.8 | — | 61 | — | 62.8 | — | — | — | — |
| Moondream2 | 1.9 B | 1.3 GB | — | — | 61.2 | — | 72.2 | — | — | — | — |
| Phi-3.5-Vision | 4.2 B | 3.9 GB | 43.0 | 43.9 | 59.9 | 75.9 | 72.0 | — | — | — | 62.2 |
| Phi-4-multimodal | 5.6 B | 4.6 GB | 55.1 | 62.4 | 84.4 | **93.2** | 81.4 | — | — | — | 74.4 |
| **Qwen2.5-VL-7B** | 8.3 B | **5.5 GB** | 58.6 | 68.2 | 86.4 | **95.7** | 87.3 | 84.7 | 29.0 | 8.83 | — |
| Qwen2.5-VL-32B | 33 B | 20 GB | 70.0 | 74.7 | — | 94.8 | — | — | 39.4 | — | — |
| Qwen3-VL-8B | 8 B | 6 GB | 69.5 | 78.1 | 89.1 | 94.9 | 87.2 | 89.3 | 52.3 | 24.1 | 78.0 |
| Qwen3-VL-32B | 33 B | 20 GB | 76.2 | 82.3 | 90.2 | 95.4 | 89.8 | 91.0 | **61.8** | **35.4** | 82.3 |
| InternVL3-8B | 8 B | 6 GB | 62.7 | 71.6 | 88.0 | 92.7 | 86.6 | 79.5 | — | — | — |
| Gemma-3-12B | 12 B | 8 GB | 59.6 | — | — | — | — | — | — | — | — |
| Gemma-3-27B | 27 B | 17 GB | 64.9 | 67.6 | — | — | — | — | — | — | — |
| MiniCPM-V 4.5 | 8 B | 5.5 GB | 65.1 | 73.8 | 88.9 | 92.6 | 85.3 | — | — | — | — |
| Pixtral-12B | 12 B | 8.5 GB | 52.5 | 58.0 | — | 90.7 | 81.8 | — | — | — | 72.0 |
| Llama-3.2-Vision-11B | 11 B | 8 GB | 50.7 | 51.5 | — | 88.4 | 83.4 | — | — | — | — |
| Molmo-7B-D | 7 B | 5 GB | 54.1 | 51.6 | 69.4 | 92.2 | 84.1 | — | — | — | — |

Sources: Qwen2.5-VL report (arXiv:2502.13923), Qwen3-VL report (arXiv:2511.21631),
InternVL3 (arXiv:2504.10479), Gemma 3 (arXiv:2503.19786), Pixtral (arXiv:2410.07073),
Molmo (allenai.org/blog/molmo), MiniCPM-V-4_5 card, Phi-4-multimodal card,
DeepSeek-VL2 (arXiv:2412.10302), SmolVLM (arXiv:2504.05299).

## Shortlist for evaluation

The hard constraint is "must actually run in Chrome on a 24 GB machine
today." That alone eliminates Qwen2.5-VL-32B, Qwen3-VL-32B, InternVL3-78B,
Gemma-3-27B, Llama-3.2-90B, DeepSeek-VL2-MoE. The remaining shortlist and why
we chose each:

1. **Qwen2.5-VL-7B-Instruct** — default. See above.
2. **Phi-3.5-Vision-Instruct** — the only VLM in WebLLM's prebuilt list.
   Zero integration work, but weaker (MMMU 43, DocVQA 75.9). **Fallback** when
   Qwen2.5-VL's WebGPU path fails.
3. **Qwen3-VL-8B-Instruct** — not runnable today (no ONNX export), but a
   step-change on agentic axes: ScreenSpot-Pro 52.3 (1.8× Qwen2.5-VL-7B),
   OSWorld 24.1 (2.7×), HumanEval 78. If / when an export lands, swap in.
   This is the **roadmap model**.
4. **SmolVLM2-2.2B** — not strong enough to drive the agent loop (MMMU 34.8)
   but the transformers.js reference demo runs end-to-end today, fits in
   <1.5 GB, and is the ideal fast **classifier / router**: "is this slide a
   title / chart / bullets?" in 500 ms before dispatching to the main model.

## Why not the larger models

- **Qwen2.5-VL-32B / Qwen3-VL-32B (MMMU 70-76)** — raw scores are great.
  They do not run: at q4 the weights alone are ~18-20 GB, and the ViT ONNX
  export is incomplete. KV cache + activations blow past Chrome's ~2 GB
  per-GPU-buffer cap.
- **InternVL3-8B (MMMU 62.7)** — comparable footprint to Qwen2.5-VL-7B and a
  higher MMMU, but no transformers.js or WebLLM path. The InternViT is not
  ONNX-exportable without manual op rewrites.
- **Gemma-3-12B / 27B** — SigLIP vision tower has no browser port.
- **Llama-3.2-Vision-11B** — cross-attention vision architecture, no ONNX
  path in transformers.js.
- **Molmo-7B-D** — great for pointing / GUI tasks but no browser runtime.
- **Pixtral / DeepSeek-VL2** — no in-browser path.

## KV-prefix cache + batching — design notes

See `src/local_composer/radix-cache.ts`, `image-cache.ts`, `batcher.ts` for
the concrete implementation. High-level:

- **Radix tree over token IDs** keyed on full prefix (system + image tokens).
  Image tokens are deterministic after the ViT, so the radix approach works
  even for multimodal inputs — we separately cache ViT outputs by
  `sha256(pngBytes)` and feed them in as a prefix block.
- **TTL + LRU eviction**. At ~0.5 MB / token for a 7 B q4 model, a 16 GB KV
  budget holds ~30 k tokens.
- **Batcher micro-queue** with 20 ms debounce, groups by shared prefix. Win
  is amortized prefill, not tensor-parallel decode — WGSL has no ragged-batch
  kernels and a single tab has one GPU queue.

## Evaluation blocker on the devcontainer

This devcontainer launches Chrome with `--disable-gpu`, has no `/dev/dri`,
and no GPU drivers. WebGPU in this environment falls back to SwiftShader
(software), which is unusable for VLM inference. To run the 100-item eval
set, `src/local_composer/run-eval.ts` must execute on a host machine with:

- Chrome ≥ 127, WebGPU enabled (`chrome://flags/#enable-unsafe-webgpu` on
  Linux if needed)
- ≥ 24 GB VRAM available to the tab
- Node ≥ 22

The devcontainer can still run the unit tests and TypeScript compilation —
all 49 pass against `MockAdapter`.
