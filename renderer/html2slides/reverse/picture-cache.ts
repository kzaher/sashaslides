/**
 * The pictures an import fetched, kept on disk so the reverse round trip can be re-run OFFLINE.
 *
 * WHY: the developer token's refresh token lives seven days (the OAuth client is in Testing mode),
 * and re-consenting needs a person. Everything else the reverse step consumes is already cached per
 * set (the `presentations.get` answer, the .pptx export, Google's thumbnails, the fixture shots), so
 * the pictures were the only input that still needed Google: their `contentUrl`s are short-lived
 * signed addresses. With them cached, an importer fix can be measured on the same inputs any time.
 *
 * Keyed by the SHA-256 of the address, because the cached `presentations.get` answer is what names
 * the addresses: an online run that re-reads the presentation gets new addresses and fills new
 * entries. Only successful answers are stored; offline, a missing entry answers 404, which the
 * import reports as a picture loss exactly as a failed online fetch would.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PictureCacheMode = "online" | "offline";

export function cachingPictureFetch(options: Readonly<{ directory: string; mode: PictureCacheMode; fetch: typeof fetch }>): typeof fetch {
  return async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const entry = pictureCacheEntry({ directory: options.directory, address });
    if (existsSync(entry.bytesPath)) {
      return new Response(readFileSync(entry.bytesPath), { status: 200, headers: { "content-type": readFileSync(entry.typePath, "utf-8").trim() } });
    }
    if (options.mode === "offline") return new Response(`offline: no cached picture for ${address}`, { status: 404 });
    const answer = await options.fetch(input, init);
    if (!answer.ok) return answer;
    const bytes = new Uint8Array(await answer.arrayBuffer());
    const mediaType = answer.headers.get("content-type") ?? "application/octet-stream";
    storePicture({ directory: options.directory, address, bytes, mediaType });
    return new Response(bytes, { status: answer.status, headers: { "content-type": mediaType } });
  };
}

/** Writes one picture into the cache (also used to seed it from bytes recovered elsewhere). */
export function storePicture(options: Readonly<{ directory: string; address: string; bytes: Uint8Array; mediaType: string }>): void {
  mkdirSync(options.directory, { recursive: true });
  const entry = pictureCacheEntry(options);
  writeFileSync(entry.bytesPath, options.bytes);
  writeFileSync(entry.typePath, `${options.mediaType}\n`);
}

function pictureCacheEntry(options: Readonly<{ directory: string; address: string }>): Readonly<{ bytesPath: string; typePath: string }> {
  const key = createHash("sha256").update(options.address).digest("hex");
  return { bytesPath: join(options.directory, `${key}.bin`), typePath: join(options.directory, `${key}.type`) };
}
