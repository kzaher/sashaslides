/**
 * fidelity.e2e.ts — does the anonymised slide still lay out like the original?
 *
 *   cd mcp/sasha-slides/addon && node --import tsx src/anonymise/fidelity.e2e.ts
 *   (about 10 s; Chrome must be listening on 9222)
 *
 * The unit tests prove the anonymiser preserves the things it MEANT to preserve — the skeleton, the
 * stylesheet, the text lengths. They cannot prove the slide still looks the same, because that is a
 * question about a layout engine: substitute letters have slightly different advance widths, so a
 * line could wrap one word earlier and a block could grow by a line. Only a browser knows.
 *
 * So this renders the original and the anonymised copy at 1280x720 in real Chrome, walks the whole
 * element tree of both, and compares every box. It also counts LINE BOXES per text run, which is
 * the direct test of "wrapping behaves the same": a reflowed paragraph changes its line count even
 * when its own box is the same height.
 *
 * IT RUNS EVERY TEXT STRATEGY, one block of rows each, because the question "does it still lay
 * out the same" has a different answer for each of them and averaging them would hide which. The
 * line-box count is asserted exactly under all of them.
 *
 * Last measured (Chrome 154, seed `fidelity-run-seed`): block drift 0.00px everywhere, 0 reflowed
 * runs everywhere, document height unchanged everywhere; worst content-sized drift 4.30 / 2.98 /
 * 0.02 / 10.48px for lorem against 11.66 / 6.20 / 4.58 / 13.94px for substitution. If a row comes
 * out materially worse than that, something regressed even though the run still says PASS.
 *
 * PORT 9222 ONLY. There is a signed-in session on 9223 and nothing here may go near it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpModule } from "../../../../../types/cdp-types.ts";
import { anonymiseSlideHtml, type TextStrategy } from "./anonymise-slide-html.ts";

// SAFETY: types/ambient.d.ts declares this module's default export as `unknown` because the package
// ships no .d.ts; types/cdp-types.ts is the repo's hand-written shape for it, and this is the one
// narrowing point the style guide asks for.
const CDP = CDPraw as unknown as CdpModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../e2e/fixtures");
const NAMES: readonly string[] = ["01-text.html", "02-table.html", "03-image.html", "04-gradient-shadow.html"];

/** One block of rows per strategy. `path` is also the screenshot's name, so it stays filesystem-safe. */
const VARIANTS: readonly Readonly<{ label: string; strategy: TextStrategy }>[] = [
  { label: "substitute", strategy: { kind: "substitute" } },
  { label: "lorem", strategy: { kind: "lorem" } },
];
const SEED = "fidelity-run-seed";
const CDP_PORT = 9222;
const PORT = 7342;
const SHOT_DIR = join(process.env["TMPDIR"] ?? "/tmp", "anonymise-fidelity");

/**
 * The tolerance this run asserts, in CSS pixels, on every box of every element.
 *
 * It is not zero and cannot be: a substituted letter has a different advance width from the one it
 * replaced even within its width class, so a run of text measures a fraction differently and an
 * inline box that depends on its content moves with it. What must NOT move is anything the
 * stylesheet positions, which is why the line-box count is asserted exactly.
 */
/**
 * The two budgets, and why there are two.
 *
 * A box the stylesheet sizes and positions — a block, a flex item, an absolutely positioned footer
 * — must not move: its geometry is a function of the CSS, which is byte-identical. 2px is slack for
 * sub-pixel rounding, and the measured worst case across the four fixtures is 0.70px.
 *
 * A CONTENT-SIZED box is a different question. An inline element starts wherever the text before it
 * ended; a cell in a `table-layout: auto` table is as wide as its own text needs. Both are
 * functions of advance widths, and a substituted letter's advance differs from the one it replaced
 * even inside its width bucket. So these get a budget rather than an assertion of equality, and the
 * run prints the real numbers next to it.
 *
 * The line-box count is asserted EXACTLY, with no budget at all, in both categories. That is the
 * property that actually matters — it is the direct test of "the text wraps the same way".
 */
/**
 * A box that shrinks to fit (`ElementBox.shrinkToFit`) is scored against the CONTENT-SIZED budget
 * whatever its `display` says, because its width is a function of its own text.
 */
const BLOCK_TOLERANCE_PX = 2;
const CONTENT_SIZED_TOLERANCE_PX = 16;

type ElementBox = Readonly<{
  path: string;
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Line boxes across this element's own text children. 0 when it has none. */
  lines: number;
  /**
   * The computed `display`, which says which of the two budgets applies — see
   * `CONTENT_SIZED_TOLERANCE_PX`.
   */
  display: string;
  /**
   * True when this box SHRINKS TO FIT its own text even though its `display` is a block one: an
   * absolutely positioned element with no declared `width` and only one of `left`/`right` set. The
   * stylesheet fixes where its left edge is, not how wide it is, so its width is a function of
   * advance widths exactly like an inline box's — fixture 01's `footer` is one.
   */
  shrinkToFit: boolean;
}>;

/** Boxes whose own geometry is a function of the text inside them, not of the stylesheet. */
const CONTENT_SIZED_DISPLAYS: ReadonlySet<string> = new Set([
  "inline",
  "inline-block",
  "inline-flex",
  "table",
  "inline-table",
  "table-cell",
  "table-row",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
  "table-column",
  "table-column-group",
  "table-caption",
]);

type PageGeometry = Readonly<{ elements: readonly ElementBox[]; documentHeight: number }>;

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const pages = new Map<string, string>();
  for (const name of NAMES) {
    const original = readFileSync(join(FIXTURES, name), "utf-8");
    pages.set(`/${name}`, original);
    for (const variant of VARIANTS) {
      const anonymised = anonymiseSlideHtml({
        html: original,
        seed: SEED,
        identifiers: "preserve",
        textStrategy: variant.strategy,
      });
      pages.set(`/${variant.label}-${name}`, anonymised.html);
    }
  }

  const server = await listen(pages);
  const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
  let client: CdpClient | null = null;
  const failures: string[] = [];
  try {
    client = await CDP({ target: tab, port: CDP_PORT });
    await client.Page.enable();
    await client.Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    for (const variant of VARIANTS) {
      console.log(`\n== textStrategy: ${variant.label}`);
      for (const name of NAMES) {
        const before = await render({ client, path: `/${name}`, shot: join(SHOT_DIR, `${name}.original.png`) });
        const after = await render({
          client,
          path: `/${variant.label}-${name}`,
          shot: join(SHOT_DIR, `${name}.${variant.label}.png`),
        });
        failures.push(...report({ name: `${name} [${variant.label}]`, before, after }));
      }
    }
  } finally {
    if (client !== null) await client.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id });
    // Chrome keeps the HTTP connection alive, so `close` on its own never calls back.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\nscreenshots: ${SHOT_DIR}`);
  if (failures.length > 0) {
    console.error(`\nFAIL (${failures.length})`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS — every stylesheet-positioned box within ${BLOCK_TOLERANCE_PX}px, every content-sized box ` +
      `within ${CONTENT_SIZED_TOLERANCE_PX}px, every line-box count identical`,
  );
}

function report({ name, before, after }: { name: string; before: PageGeometry; after: PageGeometry }): readonly string[] {
  const failures: string[] = [];
  if (before.elements.length !== after.elements.length) {
    failures.push(`${name}: element count ${before.elements.length} -> ${after.elements.length}`);
    return failures;
  }
  let maxBlock = 0;
  let maxContentSized = 0;
  let totalDrift = 0;
  let reflowed = 0;
  for (let index = 0; index < before.elements.length; index += 1) {
    const original = before.elements[index];
    const anonymised = after.elements[index];
    if (original === undefined || anonymised === undefined) continue;
    if (original.path !== anonymised.path) {
      failures.push(`${name}: tree diverged at ${index}: ${original.path} -> ${anonymised.path}`);
      continue;
    }
    const drift = Math.max(
      Math.abs(original.x - anonymised.x),
      Math.abs(original.y - anonymised.y),
      Math.abs(original.w - anonymised.w),
      Math.abs(original.h - anonymised.h),
    );
    const contentSized = CONTENT_SIZED_DISPLAYS.has(original.display) || original.shrinkToFit;
    totalDrift += drift;
    if (contentSized) maxContentSized = Math.max(maxContentSized, drift);
    else maxBlock = Math.max(maxBlock, drift);
    if (original.lines !== anonymised.lines) {
      reflowed += 1;
      failures.push(`${name}: ${original.path} wrapped to ${anonymised.lines} lines instead of ${original.lines}`);
    }
    const budget = contentSized ? CONTENT_SIZED_TOLERANCE_PX : BLOCK_TOLERANCE_PX;
    if (drift > budget) {
      failures.push(`${name}: ${original.display} ${original.path} drifted ${drift.toFixed(2)}px (budget ${budget}px)`);
    }
  }
  const heightDelta = Math.abs(before.documentHeight - after.documentHeight);
  if (heightDelta > BLOCK_TOLERANCE_PX) failures.push(`${name}: document height moved ${heightDelta}px`);
  console.log(
    `${name.padEnd(26)} ${String(before.elements.length).padStart(4)} elements  ` +
      `block <= ${maxBlock.toFixed(2)}px  content-sized <= ${maxContentSized.toFixed(2)}px  ` +
      `mean ${(totalDrift / Math.max(1, before.elements.length)).toFixed(2)}px  ` +
      `reflowed runs ${reflowed}  doc height ${before.documentHeight}->${after.documentHeight}`,
  );
  return failures;
}

async function render({
  client,
  path,
  shot,
}: {
  client: CdpClient;
  path: string;
  shot: string;
}): Promise<PageGeometry> {
  await client.Page.navigate({ url: `http://127.0.0.1:${PORT}${path}` });
  await settle({ client, path });
  const geometry = await evaluateJson({ client, expression: GEOMETRY_SCRIPT });
  const { data } = await client.Page.captureScreenshot({ format: "png" });
  writeFileSync(shot, Buffer.from(data, "base64"));
  return geometry;
}

/**
 * Poll for the conditions that prove the page is measurable, rather than waiting on `loadEventFired`
 * — the event can fire between the navigate and the await, and then the wait never returns.
 */
async function settle({ client, path }: { client: CdpClient; path: string }): Promise<void> {
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  for (;;) {
    const ready = await client.Runtime.evaluate({
      expression: `location.pathname === ${JSON.stringify(path)} && document.readyState === "complete" && document.fonts.status === "loaded"`,
      returnByValue: true,
    });
    if (ready.result.value === true) return;
    if (Date.now() > deadline) throw new Error(`${path} did not become measurable within ${SETTLE_BUDGET_MS}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

const SETTLE_BUDGET_MS = 4000;

const GEOMETRY_SCRIPT = `(() => {
  const elements = [];
  const lineBoxesOf = (element) => {
    let lines = 0;
    for (const child of element.childNodes) {
      if (child.nodeType !== 3 || child.textContent.trim() === "") continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      lines += range.getClientRects().length;
    }
    return lines;
  };
  // getComputedStyle RESOLVES width, left and right to USED pixel values on a positioned box, so
  // it cannot say which of them the author actually wrote -- and that is the whole question. The
  // CSSOM can. @media / @supports bodies are not CSSStyleRule and are skipped, which no fixture
  // uses.
  const declares = (element, property) => {
    if (element.style.getPropertyValue(property) !== "") return true;
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule.type !== CSSRule.STYLE_RULE || rule.style.getPropertyValue(property) === "") continue;
        if (element.matches(rule.selectorText)) return true;
      }
    }
    return false;
  };
  const shrinksToFit = (element, style) => {
    if (style.position !== "absolute" && style.position !== "fixed") return false;
    if (declares(element, "width")) return false;
    // Both edges pinned makes the width a function of the containing block, not of the text.
    return !(declares(element, "left") && declares(element, "right"));
  };
  const walk = (element, path) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    elements.push({
      path,
      tag: element.tagName.toLowerCase(),
      x: box.x, y: box.y, w: box.width, h: box.height,
      lines: lineBoxesOf(element),
      display: style.display,
      shrinkToFit: shrinksToFit(element, style),
    });
    let index = 0;
    for (const child of element.children) {
      walk(child, path + "/" + child.tagName.toLowerCase() + "[" + index + "]");
      index += 1;
    }
  };
  walk(document.body, "body");
  return JSON.stringify({ elements, documentHeight: document.documentElement.scrollHeight });
})()`;

async function evaluateJson({ client, expression }: { client: CdpClient; expression: string }): Promise<PageGeometry> {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (exceptionDetails !== undefined && exceptionDetails !== null) {
    throw new Error(`the geometry script threw: ${JSON.stringify(exceptionDetails)}`);
  }
  if (typeof result.value !== "string") throw new Error("the geometry script returned no JSON");
  // SAFETY: GEOMETRY_SCRIPT is the only producer of this string and it is a few lines above; the
  // shape is fixed there, not received from anywhere untrusted.
  return JSON.parse(result.value) as PageGeometry;
}

function listen(pages: ReadonlyMap<string, string>): Promise<Server> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const body = pages.get(request.url ?? "");
    if (body === undefined) {
      response.writeHead(404).end("no such page");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

await main();
