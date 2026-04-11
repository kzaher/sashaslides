import { describe, expect, it } from "vitest";
import { runSlideAgent } from "./agent.js";
import { MockAdapter } from "./mock-adapter.js";
import type { ToolCall } from "./types.js";

describe("runSlideAgent", () => {
  it("completes when the adapter emits a finish tool call", async () => {
    // Script an adapter that emits generate_slide_html then finish.
    const adapter = new MockAdapter([
      {
        match: "", // matches any user message
        response: "ok",
        toolCalls: [
          {
            id: "c1",
            name: "generate_slide_html",
            arguments: { title: "Hi", layout: "title_only", content: "Welcome" },
          },
        ],
      },
    ]);
    await adapter.loadModel();

    let sawFinishPrompt = false;
    let step = 0;
    const executor = async (call: ToolCall): Promise<unknown> => {
      step++;
      if (call.name === "generate_slide_html") {
        return "<section>Hi</section>";
      }
      if (call.name === "finish") {
        sawFinishPrompt = true;
        return { done: true };
      }
      return { ok: true };
    };

    // First turn returns generate_slide_html, second turn (after tool result)
    // needs to return finish. Re-script on the fly:
    const origGenerate = adapter.generate.bind(adapter);
    let turn = 0;
    adapter.generate = async (req) => {
      turn++;
      const base = await origGenerate(req);
      if (turn === 1) return base; // generate_slide_html
      return {
        ...base,
        message: {
          role: "assistant",
          content: "done",
          toolCalls: [{ id: "c2", name: "finish", arguments: {} }],
        },
      };
    };

    const result = await runSlideAgent("Make a welcome slide", {
      adapter,
      executor,
      maxSteps: 5,
    });

    expect(result.finished).toBe(true);
    expect(result.slideHtml).toContain("<section>");
    expect(result.stepCount).toBeGreaterThanOrEqual(2);
    expect(step).toBeGreaterThanOrEqual(2);
    expect(sawFinishPrompt).toBe(true);
  });

  it("stops at maxSteps when the model never calls finish", async () => {
    const adapter = new MockAdapter();
    await adapter.loadModel();
    // Force a tool call on every turn so the loop never naturally exits.
    adapter.generate = async () =>
      ({
        message: {
          role: "assistant",
          content: "loop",
          toolCalls: [{ id: "c", name: "generate_slide_html", arguments: {} }],
        },
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 0,
        prefixHitTokens: 0,
        imageCacheHit: false,
      }) as Awaited<ReturnType<typeof adapter.generate>>;

    const result = await runSlideAgent("x", {
      adapter,
      executor: async () => ({ html: "<section/>" }),
      maxSteps: 3,
    });
    expect(result.finished).toBe(false);
    expect(result.stepCount).toBe(3);
  });
});
