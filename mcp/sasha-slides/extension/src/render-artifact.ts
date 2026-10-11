// `<proposalId>/render/NN.png` -- the one file other than PICK the extension is allowed to write
// (PROTOCOL.md, "Render artifacts"), so the server's `slide_images` tool has something to serve.
//
// WHY ONLY THE INSERTED SLIDE GETS ONE. A true rasterisation of a converted slide can only come
// from `presentations.pages.getThumbnail`, which needs the page to exist in a real deck. There is
// no way to render N candidates without first putting N slides into the user's presentation, so the
// render artifact is produced for the slide the user actually picked, immediately after it is
// inserted and before PICK is written. A dismissal produces no render, and `slide_images` is
// already specified to answer "unavailable" in that case.
//
// IT IS BEST-EFFORT, DELIBERATELY. By the time this runs the slide is already in the user's deck;
// a failed upload must never be reported as a failed insert, or the user would be invited to insert
// it a second time. (Same lesson as the post-verdict productization rule in the repo's CLAUDE.md:
// anything after the decisive step is non-fatal.)

import type { DriveApi, SlidesApi } from "./drive-api.ts";
import { assertNever } from "./protocol.ts";

export const RENDER_FOLDER_NAME = "render";
export const ROLE_RENDER = "render";
const PNG_MIME_TYPE = "image/png";

export type RenderArtifactOutcome =
  | Readonly<{ kind: "written"; fileId: string; name: string }>
  | Readonly<{ kind: "skipped"; reason: string }>;

export async function writeRenderArtifact({
  drive,
  slides,
  proposalId,
  folderId,
  index,
  presentationId,
  pageObjectId,
}: {
  drive: DriveApi;
  slides: SlidesApi;
  proposalId: string;
  folderId: string;
  index: number;
  presentationId: string;
  pageObjectId: string;
}): Promise<RenderArtifactOutcome> {
  const png = await slides.pageThumbnailPng({ presentationId, pageObjectId });
  if (png.kind !== "ok") return { kind: "skipped", reason: `thumbnail ${png.kind}: ${png.message}` };

  const renderFolder = await drive.ensureChildFolder({
    parentFolderId: folderId,
    name: RENDER_FOLDER_NAME,
    appProperties: { sashaSlides: ROLE_RENDER, proposalId },
  });
  if (renderFolder.kind !== "ok") {
    return { kind: "skipped", reason: `render folder ${renderFolder.kind}: ${renderFolder.message}` };
  }

  const name = renderArtifactName(index);
  const uploaded = await drive.createBinaryFile({
    name,
    parentFolderId: renderFolder.value.id,
    mimeType: PNG_MIME_TYPE,
    bytes: png.value,
    appProperties: { sashaSlides: ROLE_RENDER, proposalId, index: String(index) },
  });
  switch (uploaded.kind) {
    case "ok":
      return { kind: "written", fileId: uploaded.value.id, name };
    case "unauthorized":
    case "failed":
      return { kind: "skipped", reason: `render upload ${uploaded.kind}: ${uploaded.message}` };
    default:
      return assertNever(uploaded);
  }
}

/** `NN.png`, zero-padded to two digits to match the `01.html` naming the server already uses. */
export function renderArtifactName(index: number): string {
  return `${String(index).padStart(2, "0")}.png`;
}
