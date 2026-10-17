// THE OFFLINE ".pptx DOWNLOAD", as the page sees it: a separate bundle (public/dev-pptx.js, entry
// pptx-download.ts) that the page loads only when the person asks for a file, because it carries
// the whole command-line converter and the pptxgenjs fork (about 1 MB) that the Google path never
// needs. The bundle hands itself over on `window.SashaDevPptx`.

import type { QueuedDocument } from "./queue-state.ts";

export type PptxFile = Readonly<{ bytes: Uint8Array; fileName: string; slideCount: number; failures: readonly string[] }>;

export type PptxBuilder = Readonly<{
  buildPptx: (options: Readonly<{ documents: readonly QueuedDocument[]; oversampling: number; log: (line: string) => void }>) => Promise<PptxFile>;
}>;

declare global {
  interface Window {
    SashaDevPptx?: PptxBuilder;
  }
}

export const PPTX_BUNDLE_ADDRESS = "/static/dev-pptx.js";
export const PPTX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Loads the bundle once (a script element) and resolves with what it registered. */
export function loadPptxBuilder(document: Document): Promise<PptxBuilder> {
  const view = document.defaultView;
  if (view === null) return Promise.reject(new Error("no window to load the .pptx converter into"));
  const loaded = view.SashaDevPptx;
  if (loaded !== undefined) return Promise.resolve(loaded);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PPTX_BUNDLE_ADDRESS;
    script.onload = () => {
      const registered = view.SashaDevPptx;
      if (registered === undefined) reject(new Error(`${PPTX_BUNDLE_ADDRESS} loaded but registered nothing`));
      else resolve(registered);
    };
    script.onerror = () => reject(new Error(`${PPTX_BUNDLE_ADDRESS} did not load: run the page build (npm run build in addon-server)`));
    document.head.appendChild(script);
  });
}

/** The deck title: the first document's name, with "-deck" when there are several. */
export function pptxTitleOf(documents: readonly QueuedDocument[]): string {
  const first = documents[0];
  const base = first === undefined ? "slides" : first.name.replace(/\.html?$/i, "") || "slides";
  return documents.length > 1 ? `${base}-deck` : base;
}
