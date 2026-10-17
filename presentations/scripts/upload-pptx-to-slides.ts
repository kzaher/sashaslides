/**
 * upload-pptx-to-slides.ts — upload a .pptx to Google Drive as a Google Slides presentation through
 * the Drive API (renderer/html2slides/upload-pptx-as-slides.ts) and print its address. Replaces the
 * old Drive web user interface automation (file-input injection, fixed sleeps, "Replace existing
 * file" clicking and a separate find-and-open step): Drive converts the upload itself, so the id is
 * known at once.
 *
 * Usage: npx tsx upload-pptx-to-slides.ts <path-to-pptx> [title]
 * Prints `presentation-id: <id>` and the editor address. Needs `.auth/tokens.json`
 * (`npx tsx .auth/generate-token.ts`).
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadDevOAuthClient } from "../../renderer/html2slides/dev-google-auth.ts";
import { presentationUrl, uploadPptxAsSlides } from "../../renderer/html2slides/upload-pptx-as-slides.ts";

async function main(): Promise<void> {
  const pptxPath = resolve(process.argv[2] ?? "presentations/1/presentation.pptx");
  if (!existsSync(pptxPath)) throw new Error(`File not found: ${pptxPath}`);
  const title = process.argv[3] ?? basename(pptxPath, ".pptx");
  console.log(`Uploading ${pptxPath} as "${title}"`);
  const auth = loadDevOAuthClient({ persistRefreshedTokens: true });
  const presentationId = await uploadPptxAsSlides({ auth, pptxPath, title });
  console.log(`presentation-id: ${presentationId}`);
  console.log(presentationUrl(presentationId));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
