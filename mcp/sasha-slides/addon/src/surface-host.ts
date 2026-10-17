// WHAT EVERY HTMLSERVICE SURFACE DOES TO ITS OWN PAGE: mount React, read the seed Code.gs appended,
// and give the converter its staging element and its extractor. One copy, so a fix made for one
// surface reaches the others -- the converter stage once diverged, and every report conversion
// waited out the whole frame budget on the 0x0 copy the dialog had already fixed.

import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";

/** The element React owns. Nothing else is ever put inside it. */
const ROOT_ELEMENT_ID = "sasha-slides-root";
/** Where the converter parks its offscreen 1280x720 staging iframe. */
const STAGE_ELEMENT_ID = "sasha-slides-stage";

/** A renderer onto `#sasha-slides-root`: the root is created on the first render and reused. */
export function surfaceRenderer(): (element: ReactElement) => void {
  let root: Root | null = null;
  return (element) => {
    if (root === null) {
      const existing = document.getElementById(ROOT_ELEMENT_ID);
      const host = existing ?? document.createElement("div");
      host.id = ROOT_ELEMENT_ID;
      if (existing === null) document.body.append(host);
      root = createRoot(host);
    }
    root.render(element);
  };
}

/**
 * The text of the seed Code.gs appended under `id` (`sashaAppendSeed_`), or null when there is none.
 * The seed is appended AFTER the bundle's loader, so it is only in the document once parsing is done
 * -- this waits for that. Read once: the element is removed.
 */
export async function seedText(id: string): Promise<string | null> {
  if (document.readyState === "loading") {
    await new Promise<void>((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
  }
  const element = document.getElementById(id);
  if (element === null) return null;
  element.remove();
  return element.textContent ?? "";
}

/**
 * The staging container for the converter's iframe. Kept out of the React tree on purpose: React
 * owns `#sasha-slides-root` and must never re-parent an iframe the converter is measuring.
 */
export function stageElement(): HTMLElement {
  const existing = document.getElementById(STAGE_ELEMENT_ID);
  if (existing !== null) return existing;
  const stage = document.createElement("div");
  stage.id = STAGE_ELEMENT_ID;
  /*
   * IT HAS TO BE A REAL SIZE, not 0x0 with overflow hidden.
   *
   * The staged iframe is 1280x720, but a 0x0 `overflow:hidden` parent CLIPS IT AWAY ENTIRELY, and
   * a browser does not paint -- or service `requestAnimationFrame` for -- a frame with no
   * rendered area. The converter waits one frame after layout settles, so a frame that never
   * paints used to hang the conversion outright (fixed in convert-html-to-slide-requests.ts) and
   * now costs the whole frame budget on every candidate instead. Giving the stage the slide's own
   * size lets the normal path run at normal speed. It stays off-screen and inert.
   */
  stage.style.cssText =
    "position:fixed;left:-99999px;top:0;width:1280px;height:720px;overflow:hidden;pointer-events:none";
  document.body.append(stage);
  return stage;
}

/**
 * The extractor blob, decoded. It travels base64 so HtmlService's sanitiser cannot mangle it (see
 * build-addon.ts); `atob` yields LATIN-1 bytes, so it is decoded through TextDecoder rather than
 * used directly -- extract-dom.ts is not guaranteed to be pure ASCII.
 */
export function extractorSource(): string {
  const binary = atob(__SASHA_EXTRACTOR_JS_B64__);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
