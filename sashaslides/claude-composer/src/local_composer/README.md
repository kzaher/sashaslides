# local_composer

In-browser vision-language-model (VLM) agent that composes slide presentations.
Runs the model client-side via WebGPU — no API calls, no server — so an agentic
slide builder can operate entirely on the user's machine.

## What this is

A TypeScript library + evaluation harness for picking the best open-weight VLM
that can run in a Chrome tab on a 32 GB machine (up to 24 GB usable by Chrome
for model weights + KV cache) and is credibly strong at the three things a
manus.im-style presentation agent needs:

1. **Analyze images** — read slide screenshots, charts, layouts
2. **Write JavaScript** — emit `pptxgenjs` / HTML / tool-call code
3. **Plan and accomplish tasks** — multi-step agent loops over tools

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  browser tab (chrome + webgpu)                                    │
│                                                                   │
│  ┌────────────┐   ┌───────────┐   ┌────────────┐   ┌──────────┐  │
│  │ Batcher    │──▶│ PrefixKV  │──▶│ VLM Adapter│──▶│ WebLLM / │  │
│  │ (20ms deb) │   │ RadixCache│   │ (abstract) │   │ trans.js │  │
│  └────────────┘   │ + ImgHash │   └────────────┘   └──────────┘  │
│         ▲          └───────────┘          ▲                       │
│         │                                 │                       │
│  ┌──────┴──────────────────────────────────┴───────────────────┐ │
│  │  SlideAgent — tool-using loop                                │ │
│  │  tools: generate_html, render, screenshot, score, pptxgenjs  │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ CDP
┌─────────────────────────────┴─────────────────────────────────┐
│  node runner (playwright/CDP)                                   │
│  eval harness → feeds 100 items → collects results → writes    │
│  results/<modelId>.json                                         │
└────────────────────────────────────────────────────────────────┘
```

### Key modules

| File | Responsibility |
|------|----------------|
| `types.ts` | Shared types: `Message`, `ChatRequest`, `ToolCall`, `ImageInput` |
| `vlm-adapter.ts` | `IVLMAdapter` interface — generate, stream, loadModel |
| `mock-adapter.ts` | Deterministic fake adapter for unit tests |
| `webllm-adapter.ts` | `@mlc-ai/web-llm` backend (browser) |
| `transformers-js-adapter.ts` | `@huggingface/transformers` backend (browser) |
| `radix-cache.ts` | Token-level radix tree with TTL + LRU eviction |
| `image-cache.ts` | SHA-256-keyed cache for ViT outputs |
| `batcher.ts` | Debounced micro-queue that groups prefix-compatible requests |
| `agent.ts` | `SlideAgent` — multi-turn tool-using agent |
| `prompts.ts` | System prompt + tool schemas for slide building |
| `eval/eval-types.ts` | `EvalItem`, `EvalResult`, `ModelReport` |
| `eval/eval-set.json` | 100-item test set (50 visual + 50 action) |
| `eval/eval-set.ts` | Loader + validator |
| `eval/scorer.ts` | Per-item scoring (exact match, JSON schema, code-runs, rubric) |
| `eval/harness.ts` | Runs all items through an adapter |
| `browser-harness.html` | Page loaded in Chrome — instantiates adapter, runs items |
| `run-eval.ts` | Node driver that launches Chrome + Playwright |

## Model candidates

Based on the research report (see `research/05-in-browser-vlm-shortlist.md`)
the four candidates we evaluate are:

| Rank | Model | Params | q4 VRAM | Runtime | Why |
|------|-------|--------|---------|---------|-----|
| 1 | **Qwen2.5-VL-7B-Instruct** | 8.3 B | ~5.5 GB | transformers.js (ONNX) | Default. DocVQA 95.7, ScreenSpot 84.7, Apache-2.0, computer-use trained |
| 2 | **Phi-3.5-vision-instruct** | 4.2 B | ~3.9 GB | WebLLM (prebuilt) | Only VLM in WebLLM's prebuilt list — zero integration work. Fallback |
| 3 | **Qwen3-VL-8B-Instruct** | 8 B | ~6 GB | transformers.js (needs port) | Step-change over Qwen2.5-VL: ScreenSpot-Pro 52.3, OSWorld 24.1, HumanEval 78 |
| 4 | **SmolVLM2-2.2B** | 2.2 B | ~1.5 GB | transformers.js (demo) | Fast router / classifier. Not the brain |

## Why these (vs alternatives)

- **Qwen2.5-VL-32B / Qwen3-VL-32B**: best raw scores (MMMU 70–76, ScreenSpot-Pro 39–62) but no working in-browser path — ONNX export of the ViT tower is incomplete and KV buffers exceed WebGPU's ~2 GB per-buffer limit
- **InternVL3-8B / 14B**: MMMU 62.7, strong numbers, but no transformers.js or WebLLM path
- **Gemma-3-27B-VL**: MMMU 64.9 but SigLIP vision tower not ported to ONNX/MLC
- **Llama-3.2-Vision-11B**: cross-attention architecture, no browser runtime
- **Molmo-7B-D**: great for pointing/GUI but no in-browser path yet
- **Pixtral / DeepSeek-VL2**: no browser runtime

The shortlist is not "best benchmark numbers" — it's "best benchmark numbers
among models that actually run in Chrome today".

## KV-prefix caching + batching

Neither WebLLM nor transformers.js ships prefix-KV reuse or request batching.
We build both on top:

- **`RadixCache`** — SGLang-style radix tree keyed on token-ID sequences.
  Longest-prefix lookup returns a cached `{ kvBlobRef, lastUsedMs, tokens }`.
  Eviction: TTL (default 5 min) + LRU when free VRAM < 1 GB. At ~0.5 MB/token
  for a 7 B q4 model, a 16 GB KV budget caches ~30 k tokens.
- **`ImageCache`** — SHA-256 of the PNG bytes → cached ViT output tensor.
  Slide screenshots repeat constantly during an edit loop; this alone is
  typically a 5–10× speedup on visual turns.
- **`Batcher`** — 20 ms debounce micro-queue. Groups incoming requests by
  shared prefix (same system prompt + same slide context). Runs them as
  sequential "prefill-from-cache + per-request decode" — WGSL does not yet
  expose the ragged-batch kernels vLLM uses, and a single browser tab has
  one GPU queue, so the win is amortized prefill, not tensor-parallel decode.

The cache is adapter-aware: the WebLLM adapter uses WebLLM's own PagedAttention
block pool under the hood (we only track the radix metadata; actual reuse
happens because the chat history *is* the prefix). The transformers.js adapter
operates on past_key_values tensors directly.

## Running

```bash
# build
npm run build

# unit tests (no GPU needed — uses MockAdapter)
npm test -- local_composer

# full e2e eval against a real model (requires host machine with WebGPU)
npm run eval:local -- --model qwen2.5-vl-7b --out results/
```

See `run-eval.ts` for the full CLI.

## Devcontainer blocker

**This devcontainer cannot run WebGPU.** Chrome launches with `--disable-gpu`,
there is no `/dev/dri`, and there are no GPU drivers. WebGPU falls back to
SwiftShader (software) which is unusable for VLM inference.

The library is fully portable and the unit tests all run here. To run the
evaluation against real models, use a host machine with:

- Chrome ≥ 127 with WebGPU enabled (`chrome://flags/#enable-unsafe-webgpu`
  on Linux if needed)
- ≥ 24 GB of VRAM available to the tab (Apple M3 Max 36 GB / M4 Pro, RTX 3090,
  RTX 4090, or equivalent)
- Node ≥ 22 + Playwright
