// THE DRAW.IO ROUND-TRIP HARNESS (public/e2e-drawio.html + public/e2e-drawio.js), driven by
// renderer/html2slides/e2e/drawio-editor.e2e.ts. It exposes `window.__run(xml)`, which draws the
// diagram in the self-hosted editor through the PRODUCT's embed protocol (converter/drawio-embed.ts
// `renderDrawioPicture`, the one the developer page and the add-on use) and resolves with the PNG
// data address, the editable SVG and the source the editor ended with.

import { renderDrawioPicture } from "../../../../mcp/sasha-slides/converter/index.ts";
import { assertNever } from "../../../../mcp/sasha-slides/engine/src/contracts/assert-never.ts";

export type HarnessResult = Readonly<{ png: string; svg: string; xml: string }>;

declare global {
  interface Window {
    __run?: (xml: string) => Promise<HarnessResult>;
  }
}

window.__run = async (xml: string): Promise<HarnessResult> => {
  const rendered = await renderDrawioPicture({ document, editorOrigin: location.origin, xml, timeoutMilliseconds: 30_000 });
  switch (rendered.kind) {
    case "rendered":
      return { png: rendered.picture.pngDataUrl, svg: rendered.picture.svg, xml: rendered.picture.xml };
    case "failed":
      throw new Error(rendered.reason);
    default:
      return assertNever(rendered);
  }
};
