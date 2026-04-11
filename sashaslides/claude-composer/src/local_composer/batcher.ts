/**
 * Batcher — debounced micro-queue that groups prefix-compatible requests.
 *
 * Browser WebGPU cannot actually run multiple decodes in parallel on a single
 * tab (one GPU queue, no ragged-batch kernels in WGSL). The win we can
 * realistically capture is **amortizing the prefill**: when two requests in a
 * 20 ms window share a long prompt prefix, we prefill once and decode twice.
 *
 * This Batcher schedules requests; the PrefixKV cache (held inside the
 * adapter) is what actually serves them from a shared prefill.
 *
 * Usage:
 *   const b = new Batcher({ adapter, windowMs: 20 });
 *   const resp = await b.enqueue(request);
 */

import type { ChatRequest, ChatResponse } from "./types.js";
import type { IVLMAdapter } from "./vlm-adapter.js";

type Pending<T> = {
  request: ChatRequest;
  resolve: (v: ChatResponse) => void;
  reject: (e: unknown) => void;
};

export type BatcherOptions = Readonly<{
  adapter: IVLMAdapter;
  /** Debounce window in ms. Default 20. */
  windowMs?: number;
  /** Max requests per batch. Default 8. */
  maxBatchSize?: number;
}>;

export class Batcher {
  private queue: Pending<unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly adapter: IVLMAdapter;
  private readonly windowMs: number;
  private readonly maxBatchSize: number;

  constructor(opts: BatcherOptions) {
    this.adapter = opts.adapter;
    this.windowMs = opts.windowMs ?? 20;
    this.maxBatchSize = opts.maxBatchSize ?? 8;
  }

  enqueue(request: ChatRequest): Promise<ChatResponse> {
    return new Promise<ChatResponse>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      if (this.queue.length >= this.maxBatchSize) {
        this.flush();
      } else if (this.timer == null) {
        this.timer = setTimeout(() => this.flush(), this.windowMs);
      }
    });
  }

  /** Force-run whatever is in the queue right now. */
  async flush(): Promise<void> {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];

    // Sort by prefix-similarity so cache hits are maximal: stable group by
    // system prompt, then by the size of the prompt (longer first — so its
    // prefill seeds the cache that shorter prompts reuse).
    batch.sort((a, b) => {
      const sysA = a.request.messages.find((m) => m.role === "system")?.content ?? "";
      const sysB = b.request.messages.find((m) => m.role === "system")?.content ?? "";
      if (sysA !== sysB) return sysA < sysB ? -1 : 1;
      return totalChars(b.request) - totalChars(a.request);
    });

    // Run sequentially — the real cache reuse happens inside the adapter.
    for (const p of batch) {
      try {
        const resp = await this.adapter.generate(p.request);
        p.resolve(resp);
      } catch (e) {
        p.reject(e);
      }
    }
  }

  /** How many requests are currently waiting. */
  pendingCount(): number {
    return this.queue.length;
  }
}

function totalChars(r: ChatRequest): number {
  let n = 0;
  for (const m of r.messages) n += m.content.length;
  return n;
}
