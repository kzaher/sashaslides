/**
 * Eval harness — runs every item in EVAL_SET through an adapter.
 *
 * Designed for both browser and Node callers:
 *   - In the browser, `renderSlideToPng` uses an offscreen iframe
 *   - In Node unit tests, `renderSlideToPng` can be stubbed to return a
 *     blank placeholder PNG (for MockAdapter tests that don't actually use
 *     the image)
 *
 * The harness is intentionally stateless — each call produces a new
 * ModelReport. The batcher/cache sit inside the adapter.
 */

import { EVAL_SET } from "./eval-set.js";
import type {
  EvalCategory,
  EvalItem,
  ItemResult,
  ModelReport,
} from "./eval-types.js";
import { makeItemResult } from "./scorer.js";
import type { ChatRequest, ImageInput, Message } from "./types.js";
import type { IVLMAdapter } from "./vlm-adapter.js";

export type RenderSlideFn = (html: string) => Promise<ImageInput | null>;

export type HarnessOptions = Readonly<{
  adapter: IVLMAdapter;
  /** Renders a slide HTML fragment to a PNG + sha256. Return null to skip. */
  renderSlideToPng: RenderSlideFn;
  /** Filter which items to run. Defaults to all 100. */
  filter?: (item: EvalItem) => boolean;
  /** Called after each item completes — useful for live progress UI. */
  onItemComplete?: (result: ItemResult, item: EvalItem) => void;
  /** Max parallelism. Most browser backends want 1; the batcher handles the rest. */
  concurrency?: number;
}>;

export async function runEval(opts: HarnessOptions): Promise<ModelReport> {
  const { adapter, renderSlideToPng } = opts;
  const items = EVAL_SET.filter(opts.filter ?? (() => true));
  const startedAt = new Date().toISOString();

  if (!adapter.isReady()) {
    throw new Error("Adapter must be loaded before runEval()");
  }

  const results: ItemResult[] = [];
  for (const item of items) {
    const result = await runOneItem(adapter, item, renderSlideToPng);
    results.push(result);
    opts.onItemComplete?.(result, item);
  }

  const finishedAt = new Date().toISOString();
  return summarize(adapter, results, startedAt, finishedAt);
}

async function runOneItem(
  adapter: IVLMAdapter,
  item: EvalItem,
  renderSlide: RenderSlideFn,
): Promise<ItemResult> {
  // Build the chat request from the item's input.
  const userMessage: Message = {
    role: "user",
    content: buildUserPrompt(item),
    images: await buildImages(item, renderSlide),
  };

  const messages: Message[] = [
    {
      role: "system",
      content:
        "You are a helpful, precise assistant evaluated on slide-building tasks. Follow the user's instructions literally. When asked for a specific format (JSON, code, single number), output ONLY that format with no preamble and no markdown fences.",
    },
    userMessage,
  ];

  const request: ChatRequest = {
    messages,
    temperature: 0,
    maxTokens: item.maxTokens ?? 1024,
    seed: 42,
    timeoutMs: item.timeoutMs ?? 60_000,
  };

  const resp = await adapter.generate(request);
  return makeItemResult(item, resp.message.content, {
    latencyMs: resp.latencyMs,
    promptTokens: resp.usage.promptTokens,
    completionTokens: resp.usage.completionTokens,
    prefixHitTokens: resp.prefixHitTokens,
    imageCacheHit: resp.imageCacheHit,
  });
}

/** Build the user-visible prompt, appending context / code where needed. */
function buildUserPrompt(item: EvalItem): string {
  let prompt = item.input.prompt;
  if (item.input.code !== undefined) {
    prompt += `\n\n\`\`\`js\n${item.input.code}\n\`\`\``;
  }
  if (item.input.context) {
    prompt += `\n\n${JSON.stringify(item.input.context, null, 2)}`;
  }
  if (item.input.slideHtmlB !== undefined) {
    // Diff-detect items render both slides; the user message tells the model
    // which is which.
    prompt += "\n\n(Slide A is the first image, Slide B is the second image.)";
  }
  return prompt;
}

/** Render the slideHtml (and slideHtmlB) to ImageInput objects. */
async function buildImages(
  item: EvalItem,
  renderSlide: RenderSlideFn,
): Promise<readonly ImageInput[]> {
  const images: ImageInput[] = [];
  if (item.input.slideHtml) {
    const img = await renderSlide(item.input.slideHtml);
    if (img) images.push(img);
  }
  if (item.input.slideHtmlB) {
    const img = await renderSlide(item.input.slideHtmlB);
    if (img) images.push(img);
  }
  return images;
}

function summarize(
  adapter: IVLMAdapter,
  results: readonly ItemResult[],
  startedAt: string,
  finishedAt: string,
): ModelReport {
  const total = results.length;
  const passed = results.filter((r) => r.score >= 0.5).length;
  const scoreMean = total > 0 ? results.reduce((a, r) => a + r.score, 0) / total : 0;

  const byCategory: Record<EvalCategory, { total: number; scoreMean: number }> = {
    visual: { total: 0, scoreMean: 0 },
    action: { total: 0, scoreMean: 0 },
  };
  const bySub: Record<string, { total: number; scoreMean: number; sum: number }> = {};

  for (const r of results) {
    const item = findItem(r.itemId);
    byCategory[item.category].total += 1;
    byCategory[item.category].scoreMean += r.score;
    const key = item.subcategory;
    const prev = bySub[key] ?? { total: 0, scoreMean: 0, sum: 0 };
    prev.total += 1;
    prev.sum += r.score;
    bySub[key] = prev;
  }
  for (const k of Object.keys(byCategory) as EvalCategory[]) {
    if (byCategory[k].total > 0) byCategory[k].scoreMean /= byCategory[k].total;
  }
  const finalBySub: Record<string, { total: number; scoreMean: number }> = {};
  for (const [k, v] of Object.entries(bySub)) {
    finalBySub[k] = { total: v.total, scoreMean: v.sum / v.total };
  }

  const totalLatencyMs = results.reduce((a, r) => a + r.latencyMs, 0);
  const totalTokens = results.reduce((a, r) => a + r.usage.promptTokens + r.usage.completionTokens, 0);
  const totalPromptTokens = results.reduce((a, r) => a + r.usage.promptTokens, 0);
  const totalPrefixHit = results.reduce((a, r) => a + r.prefixHitTokens, 0);
  const avgPrefixHitRate = totalPromptTokens > 0 ? totalPrefixHit / totalPromptTokens : 0;

  return {
    modelId: adapter.modelInfo.id,
    modelDisplayName: adapter.modelInfo.displayName,
    startedAt,
    finishedAt,
    results,
    summary: {
      total,
      passed,
      failed: total - passed,
      scoreMean,
      byCategory,
      bySubcategory: finalBySub,
      totalLatencyMs,
      totalTokens,
      avgPrefixHitRate,
    },
  };
}

function findItem(id: string): EvalItem {
  const item = EVAL_SET.find((i) => i.id === id);
  if (!item) throw new Error(`Unknown item id: ${id}`);
  return item;
}
