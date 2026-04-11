/**
 * RadixCache — SGLang-style token radix tree with TTL + LRU eviction.
 *
 * Maps a token-ID sequence (the prompt prefix) to an opaque `kvHandle` that
 * the adapter can use to skip prefill. The tree stores common prefixes once,
 * which is the whole point — if two requests share a 5000-token system prompt
 * + slide context, the prefill happens once.
 *
 * This file is pure TypeScript / pure data structure. The adapter owns the
 * actual KV tensors; this module tracks metadata only.
 *
 * Semantics:
 *   - `lookup(tokens)` returns the longest matching prefix + its handle.
 *   - `insert(tokens, handle, sizeBytes)` adds (or refreshes) an entry.
 *   - TTL + LRU eviction fire on every insert when over budget.
 *
 * See: https://www.lmsys.org/blog/2024-01-17-sglang/
 */

export type KVHandle = Readonly<{
  /** Opaque reference the adapter can use to restore KV state. */
  handle: unknown;
  /** Bytes this entry occupies in VRAM — used for eviction accounting. */
  sizeBytes: number;
}>;

export type CacheLookupResult = Readonly<{
  /** Number of tokens matched from the start of the query. */
  matchedTokens: number;
  /** Adapter-level handle to reuse. `null` if the match is length 0. */
  handle: unknown | null;
}>;

type Node = {
  /** The edge label — tokens from parent to this node. */
  edge: number[];
  /** Handle attached when this node marks the end of an inserted sequence. */
  kv: KVHandle | null;
  /** Last time this node was hit (for LRU). */
  lastUsedMs: number;
  /** Creation time (for TTL). */
  insertedMs: number;
  /** Cumulative size of `kv` at this node (0 if none). */
  sizeBytes: number;
  children: Map<number, Node>;
};

function makeNode(edge: number[]): Node {
  return {
    edge,
    kv: null,
    lastUsedMs: 0,
    insertedMs: 0,
    sizeBytes: 0,
    children: new Map(),
  };
}

export type RadixCacheOptions = Readonly<{
  /** Time-to-live for each entry, in ms. Default 5 minutes. */
  ttlMs?: number;
  /** Max total VRAM, in bytes, the cache is allowed to use. Default 16 GB. */
  maxBytes?: number;
  /** Wall-clock function — injected for tests. */
  now?: () => number;
}>;

export class RadixCache {
  private root: Node = makeNode([]);
  private totalBytes = 0;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(opts: RadixCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxBytes = opts.maxBytes ?? 16 * 1024 ** 3;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Walk the tree greedy-matching the longest prefix of `tokens`.
   * Returns how many tokens matched and the handle of the deepest hit node.
   */
  lookup(tokens: readonly number[]): CacheLookupResult {
    this.evictExpired();
    let node = this.root;
    let cursor = 0;
    let lastHit: { node: Node; at: number } | null = null;

    while (cursor < tokens.length) {
      const child = node.children.get(tokens[cursor]);
      if (!child) break;

      // Match as far along the edge as possible.
      let edgeCursor = 0;
      while (
        edgeCursor < child.edge.length &&
        cursor + edgeCursor < tokens.length &&
        child.edge[edgeCursor] === tokens[cursor + edgeCursor]
      ) {
        edgeCursor++;
      }

      if (edgeCursor < child.edge.length) {
        // Partial edge match — stop here. Deepest hit is still the last one.
        break;
      }

      cursor += edgeCursor;
      node = child;
      if (node.kv) {
        lastHit = { node, at: cursor };
        node.lastUsedMs = this.now();
      }
    }

    if (!lastHit) return { matchedTokens: 0, handle: null };
    return { matchedTokens: lastHit.at, handle: lastHit.node.kv?.handle ?? null };
  }

  /**
   * Insert `tokens → handle`. Splits edges as needed. Fires eviction.
   */
  insert(tokens: readonly number[], kv: KVHandle): void {
    let node = this.root;
    let cursor = 0;

    while (cursor < tokens.length) {
      const child = node.children.get(tokens[cursor]);
      if (!child) {
        const leaf = makeNode(tokens.slice(cursor));
        leaf.kv = kv;
        leaf.sizeBytes = kv.sizeBytes;
        leaf.insertedMs = this.now();
        leaf.lastUsedMs = leaf.insertedMs;
        node.children.set(tokens[cursor], leaf);
        this.totalBytes += kv.sizeBytes;
        this.enforceBudget();
        return;
      }

      // How far does the edge match?
      let edgeCursor = 0;
      while (
        edgeCursor < child.edge.length &&
        cursor + edgeCursor < tokens.length &&
        child.edge[edgeCursor] === tokens[cursor + edgeCursor]
      ) {
        edgeCursor++;
      }

      if (edgeCursor === child.edge.length) {
        // Full edge match — descend.
        cursor += edgeCursor;
        node = child;
        continue;
      }

      // Partial edge match → split the edge at edgeCursor.
      const splitPrefix = child.edge.slice(0, edgeCursor);
      const splitSuffix = child.edge.slice(edgeCursor);

      const oldChildTail = makeNode(splitSuffix);
      oldChildTail.kv = child.kv;
      oldChildTail.sizeBytes = child.sizeBytes;
      oldChildTail.insertedMs = child.insertedMs;
      oldChildTail.lastUsedMs = child.lastUsedMs;
      oldChildTail.children = child.children;

      // Rewrite `child` in place as the split node.
      child.edge = splitPrefix;
      child.kv = null;
      child.sizeBytes = 0;
      child.children = new Map([[splitSuffix[0], oldChildTail]]);

      cursor += edgeCursor;
      node = child;
    }

    // Whole token sequence consumed — attach handle to current node.
    if (node.kv) this.totalBytes -= node.kv.sizeBytes;
    node.kv = kv;
    node.sizeBytes = kv.sizeBytes;
    node.insertedMs = this.now();
    node.lastUsedMs = node.insertedMs;
    this.totalBytes += kv.sizeBytes;
    this.enforceBudget();
  }

  /** Drop everything. Used on model swap. */
  clear(): void {
    this.root = makeNode([]);
    this.totalBytes = 0;
  }

  /** Total bytes currently tracked by the cache. */
  byteSize(): number {
    return this.totalBytes;
  }

  /** Evict entries older than ttl. */
  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    this.walkAndEvict((n) => n.insertedMs > 0 && n.insertedMs < cutoff);
  }

  /** Evict LRU entries until under budget. */
  private enforceBudget(): void {
    if (this.totalBytes <= this.maxBytes) return;
    // Collect all nodes with KV, sort by lastUsedMs, drop oldest first.
    const all: Node[] = [];
    const walk = (n: Node): void => {
      if (n.kv) all.push(n);
      for (const c of n.children.values()) walk(c);
    };
    walk(this.root);
    all.sort((a, b) => a.lastUsedMs - b.lastUsedMs);

    for (const n of all) {
      if (this.totalBytes <= this.maxBytes) break;
      this.totalBytes -= n.sizeBytes;
      n.kv = null;
      n.sizeBytes = 0;
    }
  }

  /** Walk and null out KV on nodes matching predicate. */
  private walkAndEvict(shouldEvict: (n: Node) => boolean): void {
    const walk = (n: Node): void => {
      if (n.kv && shouldEvict(n)) {
        this.totalBytes -= n.sizeBytes;
        n.kv = null;
        n.sizeBytes = 0;
      }
      for (const c of n.children.values()) walk(c);
    };
    walk(this.root);
  }
}
