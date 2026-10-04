// A TOKEN BUCKET per client key, in memory.
//
// WHAT IT STOPS: one host hammering the endpoint. Two buckets are composed by the HTTP layer -- a
// small fast-refilling one for bursts and a large slow-refilling one for sustained volume -- so a
// client can submit a handful of reports back to back but cannot keep that rate up for an hour.
//
// WHAT IT DOES NOT STOP, stated plainly because a rate limiter is the control people most often
// over-trust:
//
//   * Anything distributed. The key is derived from an address; a botnet, or anyone with an IPv6
//     allocation larger than the /64 the key is cut to, gets a fresh bucket per source. The disk
//     caps in `report-store.ts` are the control that actually bounds the damage there, not this.
//   * Anything behind a shared egress address, in the other direction: a whole office or a mobile
//     carrier NAT shares one bucket and can throttle each other. The defaults are set high enough
//     that a human submitting defect reports will never notice.
//   * Anything at all, if `REPORT_TRUSTED_PROXY_HOPS` is wrong. With it at 0 behind a reverse
//     proxy every request carries the proxy's address and this degrades to one global bucket. With
//     it set too high, a client can prepend its own `X-Forwarded-For` entries and choose its own
//     key, which means choosing its own bucket -- unlimited. See `client-identity.ts`.
//   * It is in memory, so a restart forgives everyone. That is a deliberate trade against keeping
//     a per-address file on disk, which would itself be a disk-growth vector.

/** Immutable because the HTTP layer logs it and the response's `Retry-After` is read from it. */
export type RateLimitDecision =
  | Readonly<{ kind: "allowed"; remaining: number }>
  | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

export type RateLimiter = Readonly<{
  take: (options: Readonly<{ clientKey: string; now: number }>) => RateLimitDecision;
  trackedClients: () => number;
}>;

/**
 * `capacity` is the burst size and `refillPerSecond` the long-run rate. `maxTrackedClients` bounds
 * the memory this can be made to allocate: without it, an attacker rotating source addresses would
 * grow the map without bound, which is a memory-exhaustion attack delivered through the thing meant
 * to prevent attacks.
 */
export function tokenBucketRateLimiter(options: {
  capacity: number;
  refillPerSecond: number;
  maxTrackedClients: number;
}): RateLimiter {
  const buckets = new Map<string, MutableBucket>();

  const take = ({ clientKey, now }: Readonly<{ clientKey: string; now: number }>): RateLimitDecision => {
    const bucket = bucketFor({ buckets, clientKey, now, options });
    refill({ bucket, now, options });
    if (bucket.tokens < 1) {
      const secondsToOneToken = (1 - bucket.tokens) / options.refillPerSecond;
      return { kind: "throttled", retryAfterSeconds: Math.max(1, Math.ceil(secondsToOneToken)) };
    }
    bucket.tokens -= 1;
    return { kind: "allowed", remaining: Math.floor(bucket.tokens) };
  };

  return Object.freeze({ take, trackedClients: () => buckets.size });
}

/**
 * The one mutable value in this service. A bucket is a counter that is read and written on every
 * request; copying a frozen record per request would allocate for no benefit, and the mutation is
 * confined to this file.
 */
type MutableBucket = { tokens: number; lastRefillAt: number };

function bucketFor(options: {
  buckets: Map<string, MutableBucket>;
  clientKey: string;
  now: number;
  options: Readonly<{ capacity: number; refillPerSecond: number; maxTrackedClients: number }>;
}): MutableBucket {
  const existing = options.buckets.get(options.clientKey);
  if (existing !== undefined) return existing;
  evictIfFull({ buckets: options.buckets, now: options.now, limits: options.options });
  const fresh: MutableBucket = { tokens: options.options.capacity, lastRefillAt: options.now };
  options.buckets.set(options.clientKey, fresh);
  return fresh;
}

/**
 * Drops buckets that have refilled to capacity first -- they are indistinguishable from absent, so
 * forgetting them costs nothing. Only if none are idle does it evict the oldest entry, and the
 * victim is then the least recently inserted rather than whoever is currently being throttled.
 */
function evictIfFull(options: {
  buckets: Map<string, MutableBucket>;
  now: number;
  limits: Readonly<{ capacity: number; refillPerSecond: number; maxTrackedClients: number }>;
}): void {
  if (options.buckets.size < options.limits.maxTrackedClients) return;
  for (const [key, bucket] of options.buckets) {
    const replenished = bucket.tokens + (options.now - bucket.lastRefillAt) * options.limits.refillPerSecond * 0.001;
    if (replenished >= options.limits.capacity) options.buckets.delete(key);
  }
  if (options.buckets.size < options.limits.maxTrackedClients) return;
  const oldest = options.buckets.keys().next();
  if (!oldest.done) options.buckets.delete(oldest.value);
}

function refill(options: {
  bucket: MutableBucket;
  now: number;
  options: Readonly<{ capacity: number; refillPerSecond: number }>;
}): void {
  const elapsedSeconds = Math.max(0, (options.now - options.bucket.lastRefillAt) / 1000);
  options.bucket.lastRefillAt = options.now;
  options.bucket.tokens = Math.min(
    options.options.capacity,
    options.bucket.tokens + elapsedSeconds * options.options.refillPerSecond,
  );
}
