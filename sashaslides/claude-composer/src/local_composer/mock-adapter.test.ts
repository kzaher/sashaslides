import { describe, expect, it } from "vitest";
import { MockAdapter } from "./mock-adapter.js";

describe("MockAdapter", () => {
  it("throws before loadModel", async () => {
    const a = new MockAdapter();
    await expect(
      a.generate({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow();
  });

  it("runs scripted responses", async () => {
    const a = new MockAdapter([{ match: "weather", response: "rainy" }]);
    await a.loadModel();
    const r = await a.generate({
      messages: [{ role: "user", content: "What is the weather?" }],
    });
    expect(r.message.content).toBe("rainy");
  });

  it("falls back to echo when no script matches", async () => {
    const a = new MockAdapter();
    await a.loadModel();
    const r = await a.generate({
      messages: [{ role: "user", content: "anything" }],
    });
    expect(r.message.content).toContain("mock response");
    expect(r.message.content).toContain("anything");
  });

  it("emits JSON when jsonMode is set", async () => {
    const a = new MockAdapter();
    await a.loadModel();
    const r = await a.generate({
      messages: [{ role: "user", content: "ping" }],
      jsonMode: true,
    });
    expect(() => JSON.parse(r.message.content)).not.toThrow();
  });

  it("reports prefix hit across two sequential calls", async () => {
    const a = new MockAdapter();
    await a.loadModel();
    const req = {
      messages: [
        { role: "system" as const, content: "You are a slide-building agent." },
        { role: "user" as const, content: "Build slide 1" },
      ],
    };
    const r1 = await a.generate(req);
    expect(r1.prefixHitTokens).toBe(0);

    const req2 = {
      messages: [
        { role: "system" as const, content: "You are a slide-building agent." },
        { role: "user" as const, content: "Build slide 2" },
      ],
    };
    const r2 = await a.generate(req2);
    // The system-message tokens match → non-zero prefix hit.
    expect(r2.prefixHitTokens).toBeGreaterThan(0);
  });
});
