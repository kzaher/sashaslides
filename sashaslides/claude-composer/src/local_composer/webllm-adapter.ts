/**
 * WebLLMAdapter — @mlc-ai/web-llm backend (browser + WebGPU).
 *
 * This file is deliberately dependency-light: it uses dynamic `import()` so
 * Node-side unit tests that never instantiate this class do not pull
 * @mlc-ai/web-llm into their module graph. The browser harness calls it via
 * `new WebLLMAdapter(...)` and everything works.
 *
 * Prefix-KV reuse strategy:
 *   WebLLM does not expose KV tensors directly, but its chat engine maintains
 *   an internal `conversation` whose `messages` ARE the prefix. If we call
 *   `chatCompletion` with an `messages` array that starts with the exact
 *   same tokens as the previous call, WebLLM's paged-attention block pool
 *   reuses the blocks under the hood. Our RadixCache therefore tracks
 *   metadata only — it tells us HOW MANY tokens were reused so we can report
 *   prefixHitTokens to the harness.
 */

import { RadixCache, type KVHandle } from "./radix-cache.js";
import { ImageCache } from "./image-cache.js";
import type { ChatRequest, ChatResponse, Message } from "./types.js";
import type { IVLMAdapter, ModelInfo, ModelLoadProgress } from "./vlm-adapter.js";

// ---- WebLLM types we use (narrow subset, duck-typed to avoid hard dep) ----

type WebLLMModule = {
  CreateMLCEngine: (
    modelId: string,
    config: { initProgressCallback?: (r: { progress: number; text: string }) => void },
  ) => Promise<WebLLMEngine>;
};

type WebLLMEngine = {
  chat: {
    completions: {
      create: (req: {
        messages: Array<{ role: string; content: unknown }>;
        temperature?: number;
        max_tokens?: number;
        seed?: number;
      }) => Promise<{
        choices: Array<{ message: { role: string; content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>;
    };
  };
  unload: () => Promise<void>;
  getMessage: () => Promise<string>;
};

export type WebLLMAdapterOptions = Readonly<{
  modelId: string;
  /** Cache options. Sensible defaults are fine. */
  cacheMaxBytes?: number;
  cacheTtlMs?: number;
}>;

export class WebLLMAdapter implements IVLMAdapter {
  readonly modelInfo: ModelInfo;
  private engine: WebLLMEngine | null = null;
  private readonly kv = new RadixCache();
  private readonly imgCache = new ImageCache();
  private lastPromptTokens: number[] = [];

  constructor(private readonly opts: WebLLMAdapterOptions) {
    this.modelInfo = MODEL_INFO[opts.modelId] ?? {
      id: opts.modelId,
      displayName: opts.modelId,
      vramBytes: 0,
      supportsVision: opts.modelId.toLowerCase().includes("vision"),
      supportsTools: true,
      contextWindow: 8192,
    };
  }

  async loadModel(onProgress?: (p: ModelLoadProgress) => void): Promise<void> {
    if (this.engine) return;
    // @ts-ignore — dynamic import, no types pulled in Node test runs
    const mod: WebLLMModule = await import("@mlc-ai/web-llm");
    this.engine = await mod.CreateMLCEngine(this.opts.modelId, {
      initProgressCallback: (r) => onProgress?.({ progress: r.progress, stage: r.text }),
    });
  }

  isReady(): boolean {
    return this.engine !== null;
  }

  async generate(request: ChatRequest): Promise<ChatResponse> {
    if (!this.engine) throw new Error("WebLLMAdapter: loadModel() not called");
    const start = performance.now();

    // Approximate tokenization via char-hashing for radix lookup. WebLLM
    // does not expose its tokenizer publicly, so we use a deterministic
    // surrogate that's stable across calls — good enough for hit-rate stats.
    const tokens = surrogateTokenize(request.messages);
    const hit = this.kv.lookup(tokens);

    const webllmMessages = request.messages.map((m) => ({
      role: m.role,
      content: m.images && m.images.length > 0
        ? [
            ...m.images.map((img) => ({ type: "image_url", image_url: { url: img.url } })),
            { type: "text", text: m.content },
          ]
        : m.content,
    }));

    const resp = await this.engine.chat.completions.create({
      messages: webllmMessages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 1024,
      seed: request.seed,
    });

    const text = resp.choices[0]?.message.content ?? "";
    const usage = resp.usage ?? { prompt_tokens: tokens.length, completion_tokens: 0 };

    // Update radix cache with the full request tokens as "prefix for next call".
    const handle: KVHandle = {
      handle: { engineRef: this.engine },
      sizeBytes: tokens.length * 512, // rough 0.5 KB/token for a 7B q4 model
    };
    this.kv.insert(tokens, handle);
    this.lastPromptTokens = tokens;

    const assistantMessage: Message = { role: "assistant", content: text };
    return {
      message: assistantMessage,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      },
      latencyMs: performance.now() - start,
      prefixHitTokens: hit.matchedTokens,
      imageCacheHit: request.messages.some(
        (m) => m.images?.some((i) => this.imgCache.has(i.sha256)) ?? false,
      ),
    };
  }

  async dispose(): Promise<void> {
    await this.engine?.unload();
    this.engine = null;
    this.kv.clear();
    this.imgCache.clear();
    this.lastPromptTokens = [];
  }
}

/**
 * Stable surrogate tokenizer — used only for radix metadata.
 * Splits on whitespace and hashes each word to a 32-bit int. Determinism
 * across calls is the only property we need; absolute token counts do not
 * have to match the real tokenizer.
 */
function surrogateTokenize(messages: readonly Message[]): number[] {
  const parts: string[] = [];
  for (const m of messages) {
    parts.push(`<${m.role}>`);
    parts.push(m.content);
    if (m.images) for (const img of m.images) parts.push(`<img:${img.sha256}>`);
  }
  const words = parts.join(" ").split(/\s+/).filter(Boolean);
  return words.map(djb2);
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// --- Known model metadata (kept in sync with @mlc-ai/web-llm prebuilt list) ---
const MODEL_INFO: Record<string, ModelInfo> = {
  "Phi-3.5-vision-instruct-q4f16_1-MLC": {
    id: "Phi-3.5-vision-instruct-q4f16_1-MLC",
    displayName: "Phi-3.5 Vision Instruct (q4f16)",
    vramBytes: 3.95 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 4096,
  },
  "Phi-3.5-vision-instruct-q4f32_1-MLC": {
    id: "Phi-3.5-vision-instruct-q4f32_1-MLC",
    displayName: "Phi-3.5 Vision Instruct (q4f32)",
    vramBytes: 5.88 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 4096,
  },
};
