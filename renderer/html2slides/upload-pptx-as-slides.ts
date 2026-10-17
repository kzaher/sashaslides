/**
 * The ONE pptx -> Google Slides upload: Drive `files.create` with the Google Slides mime type makes
 * Drive convert the .pptx into a native presentation and answer with its id. Every devcontainer
 * harness that uploads a deck goes through here (the converter's `runConvertPptx`, bug_solving's
 * `record-rendering --mode full`, the whiteboard skill's `upload-pptx-to-slides.ts`).
 *
 * A leaf module (googleapis and node built-ins only), like dev-google-auth.ts.
 */
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { google } from "googleapis";
import type { DevOAuthClient } from "./dev-google-auth.ts";

export const GOOGLE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
export const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** The editor address of a presentation. */
export function presentationUrl(presentationId: string): string {
  return `https://docs.google.com/presentation/d/${presentationId}/edit`;
}

/** Upload `pptxPath` as a new Google Slides presentation named `title`; resolves to its id. */
export async function uploadPptxAsSlides(
  options: Readonly<{ auth: DevOAuthClient; pptxPath: string; title: string }>,
): Promise<string> {
  const drive = google.drive({ version: "v3", auth: options.auth });
  const response = await drive.files.create({
    requestBody: { name: options.title, mimeType: GOOGLE_SLIDES_MIME_TYPE },
    media: { mimeType: PPTX_MIME_TYPE, body: Readable.from(readFileSync(options.pptxPath)) },
    fields: "id",
  });
  const presentationId = response.data.id;
  if (typeof presentationId !== "string" || presentationId === "") {
    throw new Error(`Drive returned no presentation id for ${options.pptxPath}`);
  }
  return presentationId;
}
