#!/usr/bin/env npx tsx
/**
 * debug-runs.ts — the TEXT RUNS `extract-dom.ts` produced, and nothing else.
 *
 *   npx tsx renderer/html2slides/debug-runs.ts e2e/fixtures-basic/slide_13_list_styled.html
 *
 * `debug-extract.ts` prints one line per element and `debug-extract-full.ts` adds geometry, but
 * neither shows a list item's or a text element's RUNS -- so when a goldens diff says "the words
 * moved" there is no way to see whether the words themselves changed. That is exactly the question
 * a `text-transform` change raises, and answering it by eye on a 2169-pixel diff is guesswork.
 *
 * Output is stable, line-per-run and diffable: run it, change the extractor, run it again, `diff`.
 */
import CDPraw from "chrome-remote-interface";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import type { CdpModule } from "../../types/cdp-types.ts";

const CDP = CDPraw as CdpModule;
const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACT_JS = transformSync(readFileSync(join(HERE, "extract-dom.ts"), "utf-8"), {
  loader: "ts",
  target: "es2020",
}).code;

type Run = Readonly<{ text?: unknown; style?: Readonly<{ fontSize?: unknown; fontWeight?: unknown }> | null }>;
type Item = Readonly<{ text?: unknown; runs?: readonly Run[] }>;
type Element = Readonly<{ type?: unknown; text?: unknown; runs?: readonly Run[]; items?: readonly Item[] }>;

async function main(): Promise<void> {
  const htmlPath = resolve(process.argv[2] ?? "");
  const tab = await CDP.New({ port: 9222, url: "about:blank" });
  const client = await CDP({ target: tab, port: 9222 });
  try {
    await client.Page.enable();
    await client.Runtime.enable();
    await client.Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    // SUBSCRIBE BEFORE NAVIGATING: `loadEventFired()` awaited afterwards never resolves, because
    // the event has already fired and does not fire twice (CLAUDE.md).
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: `file://${htmlPath}` });
    await Promise.race([loaded, new Promise<void>((done) => setTimeout(done, 3000))]);

    const response = await client.Runtime.evaluate({
      // `extract-dom.ts` IS an IIFE whose completion value is the JSON string -- there is no
      // `extractSlide()` to call (see its tail, and debug-extract.ts, which evaluates it the
      // same way).
      expression: EXTRACT_JS,
      returnByValue: true,
      awaitPromise: false,
    });
    const raw = response.result.value;
    if (typeof raw !== "string") throw new Error(`extract-dom did not return a JSON string, got ${typeof raw}`);
    const extraction = JSON.parse(raw) as Readonly<{ elements?: readonly Element[] }>;
    for (const [at, element] of (extraction.elements ?? []).entries()) {
      const kind = String(element.type);
      if (typeof element.text === "string") console.log(`[${at}] ${kind} text=${JSON.stringify(element.text)}`);
      for (const [runAt, run] of (element.runs ?? []).entries()) {
        const size = run.style == null ? "style=null (inherits the element's)" : `size=${String(run.style.fontSize)} weight=${String(run.style.fontWeight)}`;
        console.log(`[${at}]   run ${runAt} ${JSON.stringify(run.text)}  ${size}`);
      }
      for (const [itemAt, item] of (element.items ?? []).entries()) {
        console.log(`[${at}]   item ${itemAt} text=${JSON.stringify(item.text)}`);
        for (const [runAt, run] of (item.runs ?? []).entries()) {
          console.log(`[${at}]     item ${itemAt} run ${runAt} ${JSON.stringify(run.text)}`);
        }
      }
    }
  } finally {
    await client.close();
    await CDP.Close({ port: 9222, id: tab.id });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
