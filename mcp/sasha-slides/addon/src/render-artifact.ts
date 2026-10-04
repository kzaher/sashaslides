// `<proposalId>/render/NN.png` -- the one file other than PICK the picker is allowed to write
// (PROTOCOL.md, "Render artifacts"), so the server's `slide_images` tool has something to serve.
//
// WHY ONLY THE INSERTED SLIDE GETS ONE. A true rasterisation of a converted slide can only come
// from `presentations.pages.getThumbnail`, which needs the page to exist in a real deck. There is
// no way to render N candidates without first putting N slides into the user's presentation, so the
// render artifact is produced for the slide the user actually picked, immediately after it is
// inserted and before PICK is written. A dismissal produces no render, and `slide_images` is
// already specified to answer "unavailable" in that case.
//
// IT IS BEST-EFFORT, DELIBERATELY. By the time it runs the slide is already in the user's deck; a
// failed upload must never be reported as a failed insert, or the user would be invited to insert
// it a second time. (Same lesson as the post-verdict productization rule in the repo's CLAUDE.md:
// anything after the decisive step is non-fatal.)
//
// ADAPTED FROM THE EXTENSION'S COPY. There this file made the three calls itself -- getThumbnail,
// ensureChildFolder, createBinaryFile -- because the offscreen document held a bearer token and a
// `Blob`. A sidebar has neither: the thumbnail's `contentUrl` is a cross-origin googleusercontent
// link it cannot fetch, so the bytes never exist client-side. The three calls therefore run inside
// `sashaInsert`, in the same round trip as the batchUpdate, and what stays here is every NAME and
// TAG the protocol specifies -- computed in TypeScript, unit-tested, and handed to Code.gs as a
// value it executes without deciding anything.

import type { RenderRequest } from "./bridge.ts";

export const RENDER_FOLDER_NAME = "render";
export const ROLE_RENDER = "render";
export const RENDER_MIME_TYPE = "image/png";

export type RenderArtifactOutcome =
  | Readonly<{ kind: "written"; name: string }>
  | Readonly<{ kind: "skipped"; reason: string }>;

/**
 * The render artifact Code.gs should write after the insert succeeds, or null when there is nowhere
 * to put it. `folderId === ""` is the real case: a proposal whose folder is no longer known cannot
 * receive a render, and the insert must still go ahead.
 */
export function renderRequestFor({
  proposalId,
  folderId,
  index,
  pageObjectId,
}: {
  proposalId: string;
  folderId: string;
  index: number;
  pageObjectId: string;
}): RenderRequest | null {
  if (folderId === "" || proposalId === "" || !Number.isInteger(index) || index < 1) return null;
  return {
    folderId,
    folderName: RENDER_FOLDER_NAME,
    folderAppProperties: { sashaSlides: ROLE_RENDER, proposalId },
    fileName: renderArtifactName(index),
    fileAppProperties: { sashaSlides: ROLE_RENDER, proposalId, index: String(index) },
    mimeType: RENDER_MIME_TYPE,
    pageObjectId,
  };
}

/**
 * What `sashaInsert` reported. A null `renderArtifact` is the NORMAL best-effort outcome, not an
 * error -- which is why this returns `skipped` and never `failed`.
 */
export function renderArtifactOf({
  renderArtifact,
  requested,
}: {
  renderArtifact: string | null;
  requested: RenderRequest | null;
}): RenderArtifactOutcome {
  if (requested === null) return { kind: "skipped", reason: "no proposal folder to write a render into" };
  if (renderArtifact === null) return { kind: "skipped", reason: "the server could not write the render PNG" };
  return { kind: "written", name: renderArtifact };
}

/** `NN.png`, zero-padded to two digits to match the `01.html` naming the server already uses. */
export function renderArtifactName(index: number): string {
  return `${String(index).padStart(2, "0")}.png`;
}
