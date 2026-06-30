import CDPDefault from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";

// chrome-remote-interface ships no .d.ts (its default export types as
// `unknown` via types/ambient.d.ts). Narrow the boundary into the methods we
// actually invoke — the only place untyped CDP becomes typed.
interface CDPTarget { id: string; url: string; type: string }
interface CDPEvalResult { result: { value?: unknown; description?: string }; exceptionDetails?: unknown }
interface CDPRuntime {
  evaluate(opts: { expression: string; awaitPromise?: boolean; returnByValue?: boolean }): Promise<CDPEvalResult>;
}
interface CDPInput {
  dispatchMouseEvent(opts: Record<string, unknown>): Promise<unknown>;
}
interface CDPPage {
  enable(): Promise<unknown>;
  captureScreenshot(opts?: { format?: string }): Promise<{ data: string }>;
}
interface CDPClient {
  Runtime: CDPRuntime;
  Input: CDPInput;
  Page: CDPPage;
  close(): Promise<void>;
}
interface CDPModule {
  (opts?: { target?: { id: string; url: string }; port?: number }): Promise<CDPClient>;
  List(opts: { port: number }): Promise<CDPTarget[]>;
}
const CDP = CDPDefault as CDPModule;

async function main() {
  const slideNum = parseInt(process.argv[2] ?? "1", 10);
  const outputDir = "/workspaces/sashaslides/presentations/1/screenshots";
  mkdirSync(outputDir, { recursive: true });

  const targets = await CDP.List({ port: 9222 });
  // Find the NEW slides tab (the .pptx upload, not the original)
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" &&
      t.url.includes("docs.google.com/presentation") &&
      !t.url.includes("1xegFC0RQiZd")
  );

  if (!tab) {
    console.error("No new presentation tab found");
    process.exit(1);
  }

  const client = await CDP({ target: tab });
  const { Runtime, Input, Page } = client;
  await Page.enable();

  // Wait a bit for the editor to settle
  await new Promise(r => setTimeout(r, 1500));

  // Navigate to slide
  await Runtime.evaluate({
    expression: `
      (() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        const idx = ${slideNum - 1};
        if (thumbs[idx]) {
          thumbs[idx].scrollIntoView({ block: 'center' });
          const r = thumbs[idx].getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
        return null;
      })()
    `,
    returnByValue: true,
  }).then(async (r) => {
    const pos = r.result.value as { x: number; y: number } | null;
    if (pos) {
      await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
      await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    }
  });

  await new Promise(r => setTimeout(r, 1500));

  const screenshot = await Page.captureScreenshot({ format: "png" });
  const path = `${outputDir}/new_slide_${String(slideNum).padStart(2, "0")}.png`;
  writeFileSync(path, Buffer.from(screenshot.data, "base64"));
  console.log(`Saved: ${path}`);

  await client.close();
}

main().catch(console.error);
