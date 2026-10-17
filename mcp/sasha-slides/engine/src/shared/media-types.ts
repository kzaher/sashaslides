// THE IMAGE FORMATS AN ASSET MAY HAVE (document.ts `AssetMediaType`), as a list and a parser. Every
// boundary that receives a media type -- a stored asset record (model/stored-values.ts), a deck API
// body or response header (web/), a transferred asset on the transition runner's port
// (presenter/sandbox/) and a chosen file (view/application/) -- asks the same question here. Its own
// file, apart from closed-sets.ts, because the runner bundle needs only this.

import type { AssetMediaType } from "../contracts/document.ts";

// `Object.keys` widens to string[]; the `satisfies` record has exactly the AssetMediaType members,
// so a format added to the union is a compile error here.
export const ASSET_MEDIA_TYPES = Object.keys({
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
  "image/svg+xml": true,
} satisfies Readonly<Record<AssetMediaType, true>>) as readonly AssetMediaType[];

/** `candidate` when it names a supported format exactly (no parameters, no other case), else null. */
export function parseAssetMediaType(candidate: unknown): AssetMediaType | null {
  return ASSET_MEDIA_TYPES.find((mediaType) => mediaType === candidate) ?? null;
}
