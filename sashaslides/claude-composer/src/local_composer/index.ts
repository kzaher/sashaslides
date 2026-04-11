/**
 * local_composer — in-browser VLM slide agent.
 *
 * Runtime-agnostic public API. Browser-only adapters (WebLLM,
 * transformers.js) are exported from their own modules and only imported
 * dynamically so Node-side test runs do not pull them in.
 */

// Types
export type {
  ImageInput,
  Message,
  ToolCall,
  ToolDef,
  ChatRequest,
  ChatResponse,
  ModelId,
} from "./types.js";
export type { IVLMAdapter, ModelInfo, ModelLoadProgress } from "./vlm-adapter.js";
export type {
  EvalCategory,
  EvalSubcategory,
  Difficulty,
  EvalInput,
  EvalExpected,
  EvalItem,
  ItemResult,
  ModelReport,
} from "./eval-types.js";

// Core runtime
export { MockAdapter } from "./mock-adapter.js";
export { RadixCache } from "./radix-cache.js";
export type { KVHandle, CacheLookupResult, RadixCacheOptions } from "./radix-cache.js";
export { ImageCache, sha256Hex } from "./image-cache.js";
export type { ImageEmbedding, ImageCacheOptions } from "./image-cache.js";
export { Batcher } from "./batcher.js";
export type { BatcherOptions } from "./batcher.js";

// Agent
export { runSlideAgent } from "./agent.js";
export type { SlideAgentOptions, SlideAgentResult, ToolExecutor } from "./agent.js";
export { SLIDE_AGENT_SYSTEM_PROMPT, SLIDE_AGENT_TOOLS } from "./prompts.js";

// Eval
export { EVAL_SET } from "./eval-set.js";
export { runEval } from "./harness.js";
export type { HarnessOptions, RenderSlideFn } from "./harness.js";
export { scoreResponse, makeItemResult, stripFences, extractNumber, isSyntacticallyValidJs } from "./scorer.js";
