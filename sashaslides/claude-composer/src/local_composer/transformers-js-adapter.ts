/**
 * TransformersJsAdapter — @huggingface/transformers backend (browser + WebGPU).
 *
 * Uses the ONNX Runtime Web WebGPU execution provider under the hood.
 * Supports Qwen2.5-VL / Qwen2-VL / SmolVLM / Moondream / Phi-3.5-Vision
 * via HF ONNX-community exports.
 *
 * Like webllm-adapter.ts, this is a dynamic-import shell so Node-side
 * unit tests do not drag the huge @huggingface/transformers package into
 * their module graph.
 */

import { RadixCache, type KVHandle } from "./radix-cache.js";
import { ImageCache, type ImageEmbedding } from "./image-cache.js";
import type { ChatRequest, ChatResponse, Message } from "./types.js";
import type { IVLMAdapter, ModelInfo, ModelLoadProgress } from "./vlm-adapter.js";

// Narrow subset of the @huggingface/transformers pipeline API.
type PipelineFn = (
  input: Array<{ role: string; content: Array<{ type: string; text?: string; image?: string }> }>,
  opts: { max_new_tokens?: number; temperature?: number; do_sample?: boolean },
) => Promise<Array<{ generated_text: string }>>;

type TransformersModule = {
  pipeline: (
    task: string,
    modelId: string,
    opts: { device?: string; dtype?: string; progress_callback?: (r: { status: string; progress?: number; file?: string }) => void },
  ) => Promise<PipelineFn>;
  env: { backends: { onnx: { wasm: { numThreads?: number }; webgpu: { powerPreference?: string } } } };
};

export type TransformersJsAdapterOptions = Readonly<{
  modelId: string;
  /** Default 'webgpu'. */
  device?: "webgpu" | "wasm" | "cpu";
  /** Default 'q4'. */
  dtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
}>;

export class TransformersJsAdapter implements IVLMAdapter {
  readonly modelInfo: ModelInfo;
  private pipe: PipelineFn | null = null;
  private readonly kv = new RadixCache();
  private readonly imgCache = new ImageCache();

  constructor(private readonly opts: TransformersJsAdapterOptions) {
    this.modelInfo = MODEL_INFO[opts.modelId] ?? {
      id: opts.modelId,
      displayName: opts.modelId,
      vramBytes: 0,
      supportsVision: true,
      supportsTools: false, // most HF exports do not natively emit tool calls
      contextWindow: 8192,
    };
  }

  async loadModel(onProgress?: (p: ModelLoadProgress) => void): Promise<void> {
    if (this.pipe) return;
    // @ts-ignore — dynamic import, no hard dep
    const mod: TransformersModule = await import("@huggingface/transformers");
    this.pipe = await mod.pipeline("image-text-to-text", this.opts.modelId, {
      device: this.opts.device ?? "webgpu",
      dtype: this.opts.dtype ?? "q4",
      progress_callback: (r) => {
        onProgress?.({
          progress: r.progress ?? 0,
          stage: `${r.status}${r.file ? " " + r.file : ""}`,
        });
      },
    });
  }

  isReady(): boolean {
    return this.pipe !== null;
  }

  async generate(request: ChatRequest): Promise<ChatResponse> {
    if (!this.pipe) throw new Error("TransformersJsAdapter: loadModel() not called");
    const start = performance.now();

    // Compose HF-style multimodal messages.
    const hfMessages = request.messages.map((m) => {
      const content: Array<{ type: string; text?: string; image?: string }> = [];
      for (const img of m.images ?? []) content.push({ type: "image", image: img.url });
      content.push({ type: "text", text: m.content });
      return { role: m.role, content };
    });

    // Track surrogate tokens for the radix cache.
    const tokens = surrogateTokenize(request.messages);
    const hit = this.kv.lookup(tokens);

    // Image cache: record hit for reporting even though we do not yet patch
    // the vision tower forward pass (that requires a PR into transformers.js).
    let imageCacheHit = false;
    for (const m of request.messages) {
      for (const img of m.images ?? []) {
        if (this.imgCache.has(img.sha256)) {
          imageCacheHit = true;
        } else {
          const emb: ImageEmbedding = { handle: null, sizeBytes: 1024 * 1024 };
          this.imgCache.put(img.sha256, emb);
        }
      }
    }

    const out = await this.pipe(hfMessages, {
      max_new_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0,
      do_sample: (request.temperature ?? 0) > 0,
    });
    const text = out[0]?.generated_text ?? "";

    // Refresh radix cache with the new prompt.
    const handle: KVHandle = {
      handle: { kind: "transformers-js" },
      sizeBytes: tokens.length * 512,
    };
    this.kv.insert(tokens, handle);

    return {
      message: { role: "assistant", content: text },
      usage: { promptTokens: tokens.length, completionTokens: text.split(/\s+/).filter(Boolean).length },
      latencyMs: performance.now() - start,
      prefixHitTokens: hit.matchedTokens,
      imageCacheHit,
    };
  }

  async dispose(): Promise<void> {
    this.pipe = null;
    this.kv.clear();
    this.imgCache.clear();
  }
}

function surrogateTokenize(messages: readonly Message[]): number[] {
  const parts: string[] = [];
  for (const m of messages) {
    parts.push(`<${m.role}>`);
    parts.push(m.content);
    if (m.images) for (const img of m.images) parts.push(`<img:${img.sha256}>`);
  }
  const words = parts.join(" ").split(/\s+/).filter(Boolean);
  return words.map((w) => {
    let h = 5381;
    for (let i = 0; i < w.length; i++) h = ((h << 5) + h + w.charCodeAt(i)) | 0;
    return h >>> 0;
  });
}

// Known HF model metadata.
const MODEL_INFO: Record<string, ModelInfo> = {
  "onnx-community/Qwen2.5-VL-7B-Instruct": {
    id: "onnx-community/Qwen2.5-VL-7B-Instruct",
    displayName: "Qwen2.5-VL 7B Instruct (ONNX)",
    vramBytes: 5.5 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 32768,
  },
  "onnx-community/Qwen2.5-VL-3B-Instruct": {
    id: "onnx-community/Qwen2.5-VL-3B-Instruct",
    displayName: "Qwen2.5-VL 3B Instruct (ONNX)",
    vramBytes: 2.8 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 32768,
  },
  "HuggingFaceTB/SmolVLM2-2.2B-Instruct": {
    id: "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
    displayName: "SmolVLM2 2.2B Instruct",
    vramBytes: 1.5 * 1024 ** 3,
    supportsVision: true,
    supportsTools: false,
    contextWindow: 8192,
  },
  "vikhyatk/moondream2": {
    id: "vikhyatk/moondream2",
    displayName: "Moondream 2",
    vramBytes: 1.3 * 1024 ** 3,
    supportsVision: true,
    supportsTools: false,
    contextWindow: 2048,
  },
};
