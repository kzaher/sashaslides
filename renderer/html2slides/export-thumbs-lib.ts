/**
 * The forward gate's thumbnail export: Google's LARGE PNG of every slide of one presentation, read
 * through the reverse round trip's GoogleSlidesSource, so it is paced under the "expensive read
 * requests per minute" quota (about 67 a minute) and backs off on 429 instead of failing a regen
 * half way. That costs about 1 s a slide.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { createGoogleSlidesSource, developerSourceDependencies, type GoogleSlidesSource } from "./reverse/google-slides-source.ts";

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
  /** Defaults to the developer grant; injected by tests. */
  source?: GoogleSlidesSource;
}): Promise<{ slideIds: string[] }> {
  const { presId, outDir } = opts;
  const log = (line: string): void => console.log(line);
  const source = opts.source ?? createGoogleSlidesSource(developerSourceDependencies(log));

  mkdirSync(outDir, { recursive: true });
  const slideIds = slideObjectIdsOf(await source.readPresentation(presId));
  console.log(slideIds.length + " slides");
  if (opts.fileNames && opts.fileNames.length !== slideIds.length) {
    throw new Error(
      `exportThumbs: fileNames.length=${opts.fileNames.length} != presentation slides.length=${slideIds.length}`,
    );
  }

  for (const [i, slideId] of slideIds.entries()) {
    const png = await source.downloadThumbnail({ presentationId: presId, pageObjectId: slideId });
    const outName = opts.fileNames?.[i] ?? "slide_" + String(i + 1).padStart(2, "0") + ".png";
    const outPath = outDir + "/" + outName;
    writeFileSync(outPath, png);
    console.log("  Slide " + (i + 1) + " (" + outName + "): " + png.length + " bytes");
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

/** The slides' object ids, in order, from an untrusted `presentations.get` answer. */
export function slideObjectIdsOf(presentation: unknown): string[] {
  const slides = typeof presentation === "object" && presentation !== null && "slides" in presentation ? presentation.slides : undefined;
  if (slides === undefined || slides === null) return [];
  if (!Array.isArray(slides)) throw new Error("presentations.get answered a non-array `slides`");
  return slides.map((slide: unknown, index) => {
    const objectId = typeof slide === "object" && slide !== null && "objectId" in slide ? slide.objectId : undefined;
    if (typeof objectId !== "string") throw new Error(`presentations.get slide ${index + 1} has no objectId`);
    return objectId;
  });
}
