/**
 * insert-feature.ts — the HTML→pptx conversion + insert, wired to the
 * server-hosted UI's bridge. Bundled (esbuild, same config as addon-main) to
 * addon-server/public/convert-bundle.js and loaded by app.html, so the new
 * sidebar UI can actually Insert (the conversion lived only in the old
 * Sidebar.html before).
 *
 * It registers `bridge.insert(position)` where position is "before" | "after":
 * convert every queued HTML to a single .pptx in-browser, then call the matching
 * Code.gs function (insertPptxBeforeCurrent / insertPptxAfterCurrent) via
 * google.script.run with the base64 bytes.
 */
import { processFile, buildPptxInMemory, type Slide, type SlideInput } from "./convert-core";

type LogFn = (msg: string, kind?: "info" | "error") => void;
interface QueueItem { name: string; html: string }
interface Bridge {
  queue: QueueItem[];
  log: LogFn;
  oversampling?: () => number;
  inAddon?: boolean;
  insert?: (position: "before" | "after" | "download") => Promise<void>;
}
interface GsRunner { [fn: string]: (...a: unknown[]) => void }
declare const google: {
  script: { run: { withSuccessHandler: (f: (v: unknown) => void) => { withFailureHandler: (f: (e: Error) => void) => GsRunner } } };
} | undefined;
declare global { interface Window { h2s?: { register: (f: (b: Bridge) => void) => void; bridge: Bridge } } }

/** Chunked base64 — avoids a call-stack overflow on multi-hundred-KB decks. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

/** Promise wrapper around google.script.run.<fn>(...args) (add-on mode only). */
function gsRun(fn: string, ...args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof google === "undefined" || !google.script || !google.script.run) {
      reject(new Error("google.script.run unavailable (not running inside the add-on)"));
      return;
    }
    google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn](...args);
  });
}

window.h2s?.register((bridge: Bridge) => {
  bridge.insert = async (position: "before" | "after" | "download") => {
    const items = bridge.queue.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (items.length === 0) { bridge.log("nothing queued"); return; }
    // download works standalone; insert needs the add-on (there's a live deck).
    if (position !== "download" && !bridge.inAddon) { bridge.log("Insert needs the Slides add-on — use Download .pptx here."); return; }

    const oversampling = bridge.oversampling ? bridge.oversampling() : 2;
    if (oversampling !== 2) bridge.log(`oversampling: ${oversampling}×`);

    const slides: Slide[] = [];
    for (let i = 0; i < items.length; i++) {
      bridge.log(`[${i + 1}/${items.length}] converting ${items[i].name}…`);
      try {
        const file = new File([items[i].html], items[i].name, { type: "text/html" });
        slides.push(await processFile(file, bridge.log, oversampling));
      } catch (e) {
        bridge.log(`  ${items[i].name}: extraction failed: ${(e as Error).message}`, "error");
      }
    }
    if (slides.length === 0) { bridge.log("nothing to assemble — aborting", "error"); return; }

    const title = items[0].name.replace(/\.html?$/i, "") + (items.length > 1 ? "-deck" : "");
    bridge.log(`assembling .pptx (${slides.length} slide(s))…`);
    const bytes = await buildPptxInMemory(slides as readonly SlideInput[], title);

    // Standalone (or explicit Download): hand the file to the browser.
    if (position === "download" || !bridge.inAddon) {
      const blob = new Blob([bytes as Uint8Array], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = title + ".pptx";
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      bridge.log(`✓ downloaded ${title}.pptx (${slides.length} slide(s), ${bytes.byteLength.toLocaleString()} bytes)`);
      // Keep the queue so you can re-download/insert (e.g. at a different
      // oversampling). Remove items manually with the ✕ in the list.
      return;
    }

    bridge.log(`pptx built: ${bytes.byteLength.toLocaleString()} bytes — inserting ${position} the current slide…`);
    const fn = position === "before" ? "insertPptxBeforeCurrent" : "insertPptxAfterCurrent";
    try {
      const r = await gsRun(fn, bytesToBase64(bytes), title) as { inserted?: number; at?: number };
      bridge.log(`✓ inserted ${r.inserted ?? slides.length} slide(s) ${position} the current slide${r.at ? ` (now at position ${r.at})` : ""}.`);
      // Keep the queue so you can re-insert (e.g. after changing oversampling).
      // Remove items manually with the ✕ in the list.
      return r;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      bridge.log(`insert failed: ${msg}`, "error");
      // Propagate so callers (the agent bridge, the insert buttons) see the
      // failure instead of a false success — e.g. a Drive PERMISSION_DENIED.
      throw new Error(msg);
    }
  };
  bridge.log("insert handler ready");
});
