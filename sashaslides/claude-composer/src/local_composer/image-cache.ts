/**
 * ImageCache — SHA-256-keyed cache for vision tower outputs.
 *
 * Slide-building agents feed the model the *same* slide screenshot many
 * times across turns (render → critique → revise → render → critique …).
 * The vision tower (ViT / SigLIP) is deterministic: same bytes in → same
 * embeddings out. Caching its output avoids the 100–500 ms re-encode.
 *
 * Pure TypeScript — the embedding itself is stored as an opaque handle the
 * adapter understands. TTL + LRU eviction keeps VRAM bounded.
 */

export type ImageEmbedding = Readonly<{
  /** Adapter-owned opaque tensor or GPU buffer id. */
  handle: unknown;
  /** Bytes this entry occupies in VRAM. */
  sizeBytes: number;
}>;

type Entry = {
  emb: ImageEmbedding;
  lastUsedMs: number;
  insertedMs: number;
};

export type ImageCacheOptions = Readonly<{
  ttlMs?: number;
  maxBytes?: number;
  now?: () => number;
}>;

export class ImageCache {
  private map = new Map<string, Entry>();
  private totalBytes = 0;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(opts: ImageCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxBytes = opts.maxBytes ?? 2 * 1024 ** 3;
    this.now = opts.now ?? Date.now;
  }

  get(sha256: string): ImageEmbedding | null {
    this.evictExpired();
    const e = this.map.get(sha256);
    if (!e) return null;
    e.lastUsedMs = this.now();
    return e.emb;
  }

  put(sha256: string, emb: ImageEmbedding): void {
    const existing = this.map.get(sha256);
    if (existing) {
      this.totalBytes -= existing.emb.sizeBytes;
    }
    const now = this.now();
    this.map.set(sha256, { emb, lastUsedMs: now, insertedMs: now });
    this.totalBytes += emb.sizeBytes;
    this.enforceBudget();
  }

  has(sha256: string): boolean {
    return this.map.has(sha256);
  }

  size(): number {
    return this.map.size;
  }

  byteSize(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, e] of this.map) {
      if (e.insertedMs < cutoff) {
        this.totalBytes -= e.emb.sizeBytes;
        this.map.delete(k);
      }
    }
  }

  private enforceBudget(): void {
    if (this.totalBytes <= this.maxBytes) return;
    const entries = [...this.map.entries()].sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs);
    for (const [k, e] of entries) {
      if (this.totalBytes <= this.maxBytes) break;
      this.totalBytes -= e.emb.sizeBytes;
      this.map.delete(k);
    }
  }
}

/** Compute sha256 of a Uint8Array, returning a hex string. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Works in browser (SubtleCrypto) and Node (globalThis.crypto).
  const subtle = (globalThis as unknown as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new Error("SubtleCrypto not available");
  // SubtleCrypto.digest requires a BufferSource; pass a fresh ArrayBuffer copy.
  const buf = bytes.slice().buffer;
  const digest = await subtle.digest("SHA-256", buf);
  const arr = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}
