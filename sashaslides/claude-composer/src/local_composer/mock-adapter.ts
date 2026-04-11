/**
 * MockAdapter — deterministic, no-GPU fake for unit tests.
 *
 * Given a request, produces a response based on a scripted response map OR
 * a fallback heuristic (echo / canned JSON). Simulates prefix cache hits by
 * tracking the longest common prefix across sequential calls.
 */

import type { ChatRequest, ChatResponse, Message } from "./types.js";
import type { IVLMAdapter, ModelInfo, ModelLoadProgress } from "./vlm-adapter.js";

/** A scripted response — matched by the last user message text (substring). */
export type MockScript = Readonly<{
  match: string;
  response: string;
  toolCalls?: Message["toolCalls"];
}>;

export class MockAdapter implements IVLMAdapter {
  readonly modelInfo: ModelInfo = {
    id: "mock-vlm",
    displayName: "Mock VLM (unit tests)",
    vramBytes: 0,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 8192,
  };

  private ready = false;
  private scripts: readonly MockScript[];
  private lastPromptTokens: readonly number[] = [];
  // Deterministic pseudo-tokenizer: hash words → 32-bit ints, stable across runs.
  private tokenize(msgs: readonly Message[]): number[] {
    const text = msgs
      .map((m) => `${m.role}:${m.content}${m.images?.map((i) => `[img:${i.sha256}]`).join("") ?? ""}`)
      .join("\n");
    // djb2 hash per whitespace word
    const words = text.split(/\s+/).filter(Boolean);
    return words.map((w) => {
      let h = 5381;
      for (let i = 0; i < w.length; i++) h = ((h << 5) + h + w.charCodeAt(i)) | 0;
      return h >>> 0;
    });
  }

  constructor(scripts: readonly MockScript[] = []) {
    this.scripts = scripts;
  }

  async loadModel(onProgress?: (p: ModelLoadProgress) => void): Promise<void> {
    onProgress?.({ progress: 0.5, stage: "mock-loading" });
    onProgress?.({ progress: 1, stage: "ready" });
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  async generate(request: ChatRequest): Promise<ChatResponse> {
    if (!this.ready) throw new Error("MockAdapter: loadModel() not called");
    const start = Date.now();
    const tokens = this.tokenize(request.messages);

    // Compute prefix hit vs last call
    let hit = 0;
    while (hit < tokens.length && hit < this.lastPromptTokens.length && tokens[hit] === this.lastPromptTokens[hit]) {
      hit++;
    }

    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";
    const script = this.scripts.find((s) => userText.includes(s.match));

    let responseText: string;
    let toolCalls: Message["toolCalls"] | undefined;
    if (script) {
      responseText = script.response;
      toolCalls = script.toolCalls;
    } else if (request.jsonMode) {
      responseText = JSON.stringify({ ok: true, echo: userText.slice(0, 64) });
    } else {
      responseText = `mock response to: ${userText.slice(0, 64)}`;
    }

    const response: ChatResponse = {
      message: {
        role: "assistant",
        content: responseText,
        toolCalls,
      },
      usage: {
        promptTokens: tokens.length,
        completionTokens: responseText.split(/\s+/).filter(Boolean).length,
      },
      latencyMs: Date.now() - start,
      prefixHitTokens: hit,
      imageCacheHit: false,
    };

    this.lastPromptTokens = tokens;
    return response;
  }

  async dispose(): Promise<void> {
    this.ready = false;
    this.lastPromptTokens = [];
  }
}
