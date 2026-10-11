// GOOGLE'S PICTURE OF A SLIDE, REMEMBERED.
//
// A rendered preview costs a throwaway presentation, a batchUpdate, a thumbnail fetch and a
// delete -- per candidate, every time the window is opened. Nothing about it changes while the
// slide does not, so re-paying that on every open is pure latency: the user reported the
// Converted view taking "so long" and the window being slow to come up.
//
// KEYED BY WHAT WAS DRAWN, not by the slide's identity. Two candidates with the same requests
// render the same picture, and the same candidate revised is a different one -- so the key is a
// hash of the requests themselves. A revision therefore misses the cache without anything
// having to remember to invalidate it, which is the only invalidation strategy that cannot rot.
//
// `localStorage` IS THE RIGHT STORE and its failures are all expected: it is per-origin and the
// add-on's sandbox has its own, it survives the window closing, and it is capped. Every access
// is wrapped, because a private window, blocked site data or a full quota all throw, and none of
// them is a reason to fail a render -- a miss just means doing the work.

/** One cached picture. `at` is only for eviction; nothing reads it for display. */
type CachedRender = Readonly<{ dataUri: string; at: number }>;

const PREFIX = "sashaSlides.render.";
/**
 * How many pictures to keep. A proposal is up to eight candidates and a user may compare a few
 * proposals in a session; beyond that the oldest are worth less than the space.
 */
export const RENDER_CACHE_LIMIT = 24;

/**
 * A stable key for one rendered slide: the requests that produced it.
 *
 * FNV-1a over the serialised requests. It is not a cryptographic hash and does not need to be --
 * a collision would show one slide's picture for another, and at 32 bits over a handful of
 * slides per session that is far rarer than the network failing, which this already tolerates.
 */
export function renderKeyOf(requests: readonly unknown[]): string {
  const text = JSON.stringify(requests);
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    // The FNV prime, as shifts, so the whole thing stays in 32 bits under Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${PREFIX}${hash.toString(36)}_${String(text.length)}`;
}

/** The picture for these requests, or null. Never throws: a miss is always a legal answer. */
export function cachedRender(key: string, store?: Storage): string | null {
  const shelf = storeOf(store);
  if (shelf === null) return null;
  try {
    const raw = shelf.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const dataUri = (parsed as Readonly<{ dataUri?: unknown }>).dataUri;
    return typeof dataUri === "string" && dataUri.startsWith("data:image/") ? dataUri : null;
  } catch {
    return null;
  }
}

/**
 * Remember one picture, evicting the oldest when the shelf is full.
 *
 * A FAILED WRITE IS NOT A FAILED RENDER. The picture is already on screen; all that is lost is
 * the next open being fast, so every path here swallows.
 */
export function rememberRender(key: string, dataUri: string, store?: Storage): void {
  const shelf = storeOf(store);
  if (shelf === null) return;
  try {
    evictTo(shelf, RENDER_CACHE_LIMIT - 1);
    const entry: CachedRender = { dataUri, at: Date.now() };
    shelf.setItem(key, JSON.stringify(entry));
  } catch {
    // A full quota is the common one. Drop everything we own and leave the next open to re-fill.
    try {
      evictTo(shelf, 0);
    } catch {
      // Nothing further to try; the render still happened.
    }
  }
}

/** Keep at most `keep` of our own entries, oldest out first. */
function evictTo(shelf: Storage, keep: number): void {
  const ours: { key: string; at: number }[] = [];
  for (let at = 0; at < shelf.length; at += 1) {
    const key = shelf.key(at);
    if (key === null || !key.startsWith(PREFIX)) continue;
    ours.push({ key, at: stampOf(shelf, key) });
  }
  if (ours.length <= keep) return;
  ours.sort((left, right) => left.at - right.at);
  for (const victim of ours.slice(0, ours.length - keep)) shelf.removeItem(victim.key);
}

function stampOf(shelf: Storage, key: string): number {
  try {
    const raw = shelf.getItem(key);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    const at = (parsed as Readonly<{ at?: unknown }>)?.at;
    return typeof at === "number" ? at : 0;
  } catch {
    return 0;
  }
}

/** `localStorage` can throw on ACCESS, not only on use, so even reaching it is guarded. */
function storeOf(store?: Storage): Storage | null {
  if (store !== undefined) return store;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
