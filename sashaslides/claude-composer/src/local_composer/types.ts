/**
 * Shared types for the in-browser VLM pipeline.
 *
 * Kept deliberately runtime-agnostic: WebLLM, transformers.js, and the mock
 * adapter all consume the same shapes.
 */

/** A PNG image fed to the model. Either a data URL or raw bytes. */
export type ImageInput = Readonly<{
  /** sha256 of the PNG bytes — used as the image-cache key. */
  sha256: string;
  /** `data:image/png;base64,...` or an ObjectURL. */
  url: string;
  /** Decoded dimensions (cached to avoid re-decoding for tokenizer planning). */
  width: number;
  height: number;
}>;

/** A single message in a chat. */
export type Message = Readonly<{
  role: "system" | "user" | "assistant" | "tool";
  /** Text content. For multimodal messages, text is concatenated with images. */
  content: string;
  /** Optional images attached to a user message. */
  images?: readonly ImageInput[];
  /** For tool messages: the id of the tool_call being answered. */
  toolCallId?: string;
  /** For assistant messages: tool calls the model wants to make. */
  toolCalls?: readonly ToolCall[];
}>;

/** A tool call emitted by the model. */
export type ToolCall = Readonly<{
  id: string;
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}>;

/** JSON-schema-ish tool definition exposed to the model. */
export type ToolDef = Readonly<{
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Readonly<Record<string, unknown>>;
}>;

/** A single chat-completion request. */
export type ChatRequest = Readonly<{
  messages: readonly Message[];
  tools?: readonly ToolDef[];
  /** 0..2, default 0 for eval reproducibility. */
  temperature?: number;
  /** Default 1024. */
  maxTokens?: number;
  /** When true, adapter MUST emit JSON parseable output. */
  jsonMode?: boolean;
  /** Deterministic seed, if the adapter supports it. */
  seed?: number;
  /** Abort the request if not complete by this deadline. */
  timeoutMs?: number;
}>;

/** A single chat-completion response. */
export type ChatResponse = Readonly<{
  /** Final assistant message. */
  message: Message;
  /** Total tokens the adapter reports (prompt + completion). */
  usage: Readonly<{ promptTokens: number; completionTokens: number }>;
  /** Wall-clock time for this turn, in ms. */
  latencyMs: number;
  /**
   * Whether the prefix cache was hit for the prompt.
   * `prefixHitTokens` is the number of cached prefix tokens reused.
   */
  prefixHitTokens: number;
  /** Whether the image cache was hit (at least one image was reused). */
  imageCacheHit: boolean;
}>;

/** Model identifier — stable key for eval result files. */
export type ModelId = string;
