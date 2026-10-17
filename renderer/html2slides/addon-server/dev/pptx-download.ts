// THE ".pptx DOWNLOAD" BUNDLE (public/dev-pptx.js): HTML -> .pptx entirely in the browser, with no
// Google involved, through the command-line converter's own browser core
// (renderer/html2slides/browser/convert-core.ts: the extractor, the post-extraction fixes, the
// rasterised visuals, and convert-pptx-lib.ts's `buildPptxInMemory` with its post-processing).
//
// pptxgenjs is OUR FORK (deps/pptxgenjs, with the gradient, rounding and group fixes), bundled by
// dev/build.ts straight from its TypeScript source, so the bundle builds the same locally and in
// the image and never ships a stale prebuilt copy.

import { buildPptxInMemory, processFile, type Slide } from "../../browser/convert-core.ts";
import { pptxTitleOf, type PptxBuilder } from "./pptx-builder.ts";

const builder: PptxBuilder = {
  buildPptx: async ({ documents, oversampling, log }) => {
    const slides: Slide[] = [];
    const failures: string[] = [];
    for (const [index, document] of documents.entries()) {
      log(`[${index + 1}/${documents.length}] converting ${document.name}`);
      try {
        const file = new File([document.html], document.name, { type: "text/html" });
        slides.push(await processFile(file, (line) => log(line), oversampling));
      } catch (error) {
        failures.push(`${document.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (slides.length === 0) throw new Error(`nothing converted: ${failures.join("; ")}`);
    const title = pptxTitleOf(documents);
    log(`assembling ${title}.pptx (${slides.length} slide(s))`);
    const bytes = await buildPptxInMemory(slides, title);
    return { bytes, fileName: `${title}.pptx`, slideCount: slides.length, failures };
  },
};

window.SashaDevPptx = builder;
