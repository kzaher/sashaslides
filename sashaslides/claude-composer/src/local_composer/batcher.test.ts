import { describe, expect, it } from "vitest";
import { Batcher } from "./batcher.js";
import { MockAdapter } from "./mock-adapter.js";

describe("Batcher", () => {
  it("flushes a single enqueued request after the window", async () => {
    const adapter = new MockAdapter();
    await adapter.loadModel();
    const b = new Batcher({ adapter, windowMs: 10 });

    const resp = await b.enqueue({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(resp.message.content).toContain("mock response");
  });

  it("runs multiple queued requests sequentially", async () => {
    const adapter = new MockAdapter([
      { match: "alpha", response: "A" },
      { match: "beta", response: "B" },
      { match: "gamma", response: "G" },
    ]);
    await adapter.loadModel();
    const b = new Batcher({ adapter, windowMs: 5 });

    const [r1, r2, r3] = await Promise.all([
      b.enqueue({ messages: [{ role: "user", content: "alpha" }] }),
      b.enqueue({ messages: [{ role: "user", content: "beta" }] }),
      b.enqueue({ messages: [{ role: "user", content: "gamma" }] }),
    ]);

    expect(r1.message.content).toBe("A");
    expect(r2.message.content).toBe("B");
    expect(r3.message.content).toBe("G");
  });

  it("flushes early when maxBatchSize is reached", async () => {
    const adapter = new MockAdapter();
    await adapter.loadModel();
    const b = new Batcher({ adapter, windowMs: 1000, maxBatchSize: 2 });

    const started = Date.now();
    await Promise.all([
      b.enqueue({ messages: [{ role: "user", content: "x" }] }),
      b.enqueue({ messages: [{ role: "user", content: "y" }] }),
    ]);
    // Should not have waited ~1s.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("pendingCount reports queue size while waiting", async () => {
    const adapter = new MockAdapter();
    await adapter.loadModel();
    const b = new Batcher({ adapter, windowMs: 50 });

    const p = b.enqueue({ messages: [{ role: "user", content: "hi" }] });
    expect(b.pendingCount()).toBe(1);
    await p;
    expect(b.pendingCount()).toBe(0);
  });
});
