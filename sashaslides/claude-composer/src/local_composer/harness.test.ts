import { describe, expect, it } from "vitest";
import { runEval } from "./harness.js";
import { MockAdapter } from "./mock-adapter.js";
import type { ImageInput } from "./types.js";

// Stub that never actually renders — returns a fake ImageInput with a stable
// sha so the image cache can still be exercised.
async function stubRenderer(_html: string): Promise<ImageInput> {
  return {
    sha256: "stub",
    url: "data:image/png;base64,iVBORw0KGgo=",
    width: 1920,
    height: 1080,
  };
}

describe("harness.runEval", () => {
  it("runs the full eval set against MockAdapter and produces a ModelReport", async () => {
    const adapter = new MockAdapter([
      // Hit a handful of items with scripted correct-ish answers so we know
      // the scorer is wired through end-to-end.
      { match: "third bullet", response: "Pricing strategy" },
      { match: "title of this slide", response: "Introduction" },
      { match: "Classify this slide's layout", response: "title_only" },
      { match: "Pick a layout", response: "title_and_body" },
    ]);
    await adapter.loadModel();

    let completedCount = 0;
    const report = await runEval({
      adapter,
      renderSlideToPng: stubRenderer,
      onItemComplete: () => completedCount++,
    });

    expect(report.results.length).toBe(100);
    expect(completedCount).toBe(100);
    expect(report.summary.total).toBe(100);
    expect(report.summary.byCategory.visual.total).toBe(50);
    expect(report.summary.byCategory.action.total).toBe(50);
    expect(report.modelId).toBe("mock-vlm");
    expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(report.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("filter restricts which items run", async () => {
    const adapter = new MockAdapter();
    await adapter.loadModel();
    const report = await runEval({
      adapter,
      renderSlideToPng: stubRenderer,
      filter: (i) => i.subcategory === "pick_layout",
    });
    expect(report.results.length).toBe(6);
    expect(report.summary.byCategory.action.total).toBe(6);
  });

  it("reports non-zero prefix hit rate as items share a system prompt", async () => {
    const adapter = new MockAdapter();
    await adapter.loadModel();
    const report = await runEval({
      adapter,
      renderSlideToPng: stubRenderer,
      filter: (i) => i.subcategory === "pick_layout",
    });
    // After the first item, the shared system prompt becomes prefix.
    expect(report.summary.avgPrefixHitRate).toBeGreaterThan(0);
  });
});
