/**
 * SlideAgent — tool-using loop that builds one slide at a time.
 *
 * Flow (matches Manus's CodeAct + self-critique pattern):
 *   1. Generate HTML for the slide (generate_slide_html).
 *   2. Render it to a PNG (render_slide — provided by the host).
 *   3. Score it (score_slide — VLM looks at the screenshot).
 *   4. If score < threshold, revise HTML using the VLM's critique. Max 2 revisions.
 *   5. Emit pptxgenjs code and finish.
 *
 * Tools are executed by a host-provided `ToolExecutor`. This keeps the agent
 * runtime-agnostic: in the browser harness the executor uses a real renderer,
 * in unit tests a mock executor returns canned values.
 */

import { SLIDE_AGENT_SYSTEM_PROMPT, SLIDE_AGENT_TOOLS } from "./prompts.js";
import type { ChatRequest, ChatResponse, Message, ToolCall } from "./types.js";
import type { IVLMAdapter } from "./vlm-adapter.js";

export type ToolExecutor = (call: ToolCall) => Promise<unknown>;

export type SlideAgentOptions = Readonly<{
  adapter: IVLMAdapter;
  executor: ToolExecutor;
  /** Max tool iterations. Default 8. */
  maxSteps?: number;
  /** Aesthetic score threshold (0..10). Default 7. */
  scoreThreshold?: number;
  /** Max revisions after scoring. Default 2. */
  maxRevisions?: number;
}>;

export type SlideAgentResult = Readonly<{
  /** Final transcript. */
  messages: readonly Message[];
  /** Whether the agent called `finish`. */
  finished: boolean;
  /** Number of tool calls made. */
  stepCount: number;
  /** Final slide HTML (if produced). */
  slideHtml?: string;
  /** Final pptxgenjs code (if produced). */
  pptxCode?: string;
  /** Total latency including tool execution, in ms. */
  totalLatencyMs: number;
  /** Aggregated prefix cache hit tokens across all turns. */
  totalPrefixHitTokens: number;
}>;

export async function runSlideAgent(
  goal: string,
  opts: SlideAgentOptions,
): Promise<SlideAgentResult> {
  const { adapter, executor } = opts;
  const maxSteps = opts.maxSteps ?? 8;

  const messages: Message[] = [
    { role: "system", content: SLIDE_AGENT_SYSTEM_PROMPT },
    { role: "user", content: goal },
  ];

  const start = Date.now();
  let stepCount = 0;
  let slideHtml: string | undefined;
  let pptxCode: string | undefined;
  let finished = false;
  let totalPrefixHit = 0;

  while (stepCount < maxSteps) {
    const req: ChatRequest = {
      messages: [...messages],
      tools: SLIDE_AGENT_TOOLS,
      temperature: 0,
      maxTokens: 2048,
    };
    const resp: ChatResponse = await adapter.generate(req);
    totalPrefixHit += resp.prefixHitTokens;
    messages.push(resp.message);
    stepCount++;

    const toolCalls = resp.message.toolCalls ?? [];
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      const result = await executor(call);

      // Capture canonical artifacts from known tools.
      if (call.name === "generate_slide_html") {
        const html = typeof result === "string" ? result : (result as { html?: string }).html;
        if (html) slideHtml = html;
      } else if (call.name === "write_pptxgenjs") {
        const code = (call.arguments as { code?: string }).code;
        if (code) pptxCode = code;
      } else if (call.name === "finish") {
        finished = true;
      }

      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(result ?? null),
      });
    }

    if (finished) break;
  }

  return {
    messages,
    finished,
    stepCount,
    slideHtml,
    pptxCode,
    totalLatencyMs: Date.now() - start,
    totalPrefixHitTokens: totalPrefixHit,
  };
}
