/**
 * IVLMAdapter — the single interface every backend implements.
 *
 * Backends:
 *   - MockAdapter (tests, no GPU)
 *   - WebLLMAdapter (browser, WebGPU via @mlc-ai/web-llm)
 *   - TransformersJsAdapter (browser, WebGPU via @huggingface/transformers)
 *
 * The adapter owns: model download, tokenizer, inference, nothing else.
 * Caching, batching, and agent loops live in other modules.
 */

import type { ChatRequest, ChatResponse, ModelId } from "./types.js";

export type ModelLoadProgress = Readonly<{
  /** 0..1 */
  progress: number;
  /** Human-readable stage, e.g., "downloading weights (3/8)". */
  stage: string;
  /** Bytes downloaded so far, if known. */
  bytesLoaded?: number;
  /** Total bytes, if known. */
  bytesTotal?: number;
}>;

export type ModelInfo = Readonly<{
  id: ModelId;
  /** User-facing name. */
  displayName: string;
  /** Approximate VRAM requirement in bytes (weights + working set, not KV cache). */
  vramBytes: number;
  /** Does this model accept image inputs? */
  supportsVision: boolean;
  /** Does this model support function calling natively? */
  supportsTools: boolean;
  /** Max context window, in tokens. */
  contextWindow: number;
}>;

export interface IVLMAdapter {
  /** Stable identifier used in eval result filenames. */
  readonly modelInfo: ModelInfo;

  /**
   * Download + initialize the model. Idempotent — calling twice with the same
   * modelId is a no-op. Calling with a different modelId frees the old model.
   */
  loadModel(onProgress?: (p: ModelLoadProgress) => void): Promise<void>;

  /** Is the model loaded and ready to serve `generate` calls? */
  isReady(): boolean;

  /**
   * Run a single chat completion. This is the low-level entry point —
   * higher-level code (agent loop, batcher) calls this after cache lookup.
   */
  generate(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Free VRAM. After this, `loadModel` must be called before `generate`.
   */
  dispose(): Promise<void>;
}
