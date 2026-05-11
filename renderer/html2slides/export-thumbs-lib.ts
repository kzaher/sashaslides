import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";

export async function exportThumbs(opts: {
  presId: string;
  outDir: string;
  /**
   * Optional per-slide output filenames, parallel to the presentation's
   * slide order. When provided, each thumbnail is written directly to
   * `<outDir>/<fileNames[i]>`. When omitted, falls back to position-based
   * `slide_NN.png` names (the previous default behavior).
   *
   * Why this exists: callers used to write position-based names here and
   * then `renameSync` them to fixture-id names. That loop was order-
   * dependent and silently overwrote thumbs whose position-based names
   * collided with target fixture-id names (e.g. position-1's slide_01.png
   * → fixture-id slide_04.png clobbered position-4's slide_04.png, which
   * itself was supposed to become slide_11.png — wave-10A's 5-of-7 thumb
   * gap was caused by exactly this). Writing the right filename up-front
   * eliminates the entire class of bug.
   */
  fileNames?: string[];
  // Optional: when called from another script we still want to update the
  // sibling meta.json with slideIds. Caller can opt out by setting false.
  updateMetaJson?: boolean; // default true
}): Promise<{ slideIds: string[] }> {
  const { presId, outDir } = opts;

  const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
  const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost");
  oauth2.setCredentials(tokens);

  const slidesApi = google.slides({ version: "v1", auth: oauth2 });

  mkdirSync(outDir, { recursive: true });
  const pres = await slidesApi.presentations.get({ presentationId: presId });
  const slides = pres.data.slides || [];
  console.log(slides.length + " slides");
  if (opts.fileNames && opts.fileNames.length !== slides.length) {
    throw new Error(
      `exportThumbs: fileNames.length=${opts.fileNames.length} != presentation slides.length=${slides.length}`,
    );
  }

  const slideIds: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const slideId = slides[i].objectId!;
    slideIds.push(slideId);
    const thumb = await slidesApi.presentations.pages.getThumbnail({
      presentationId: presId,
      pageObjectId: slideId,
      "thumbnailProperties.mimeType": "PNG",
      "thumbnailProperties.thumbnailSize": "LARGE",
    });
    const url = thumb.data.contentUrl!;
    const resp = await fetch(url);
    const buf = Buffer.from(await resp.arrayBuffer());
    const outName = opts.fileNames
      ? opts.fileNames[i]
      : "slide_" + String(i + 1).padStart(2, "0") + ".png";
    const outPath = outDir + "/" + outName;
    writeFileSync(outPath, buf);
    console.log("  Slide " + (i + 1) + " (" + outName + "): " + buf.length + " bytes");
  }
  console.log("Saved to " + outDir);

  // Merge slideIds into the run's meta.json so rating-server can deep-link
  // each comparison to the right slide in the editor (?slide=id.X#slide=id.X).
  if (opts.updateMetaJson !== false) {
    const metaPath = join(dirname(outDir), "meta.json");
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      meta.slideIds = slideIds;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      console.log("Updated " + metaPath + " with " + slideIds.length + " slideIds");
    }
  }

  return { slideIds };
}
