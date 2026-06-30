import * as fs from "fs";
import * as path from "path";
import * as http from "http";

// ── Boundary types ─────────────────────────────────────────────────────────
// The Chrome DevTools /json endpoint entry (only the fields we read).
interface DevtoolsTarget {
  url: string;
  webSocketDebuggerUrl: string;
}

// `ws` ships its types behind `unknown` in types/ambient.d.ts; narrow the
// minimal surface this script drives.
type WSListener = (...args: unknown[]) => void;
interface WSInstance {
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (data: string) => void): void;
  on(event: string, cb: WSListener): void;
}
interface WSConstructor {
  new (url: string): WSInstance;
}

// CDP wire response. Runtime.evaluate nests its JS value at
// `.result.result.value`; Page.captureScreenshot puts the PNG at `.result.data`.
interface CDPInnerResult {
  value?: unknown;
  description?: string;
}
interface CDPCommandPayload {
  result?: CDPInnerResult;
  value?: unknown;
  data?: string;
  exceptionDetails?: unknown;
}
interface CDPWireResponse {
  id?: number;
  method?: string;
  result?: CDPCommandPayload;
}

// Shape returned by the "click a button" evaluate snippets.
interface ClickProbe {
  clicked: boolean;
  x?: number;
  y?: number;
  text?: string;
}

function httpGet<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer | string) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data) as T));
    }).on("error", reject);
  });
}

async function main() {
  const startTime = Date.now();

  try {
    // Get list of targets
    const debugUrl = "http://localhost:9222/json";
    const targets = await httpGet<DevtoolsTarget[]>(debugUrl);

    const targetInfo = targets.find((t) => t.url.includes("1xegFC0RQiZd"));
    if (!targetInfo) {
      console.error("Tab with 1xegFC0RQiZd not found");
      process.exit(1);
    }

    console.log(`Found tab: ${targetInfo.url}`);
    const wsUrl = targetInfo.webSocketDebuggerUrl;

    // Use WebSocket to connect via native Node API.
    // SAFETY: `ws` ships no usable .d.ts (default export typed `unknown`);
    // assert the documented constructor signature at this single boundary.
    const WSImpl = (await import("ws")).default as WSConstructor;
    const ws = new WSImpl(wsUrl);

    let messageId = 1;
    const pendingMessages = new Map<number, (value: CDPWireResponse) => void>();

    const sendCommand = (
      method: string,
      params?: Record<string, unknown>
    ): Promise<CDPWireResponse> => {
      return new Promise<CDPWireResponse>((resolve) => {
        const id = messageId++;
        pendingMessages.set(id, resolve);
        ws.send(
          JSON.stringify({
            id,
            method,
            params: params || {},
          })
        );
      });
    };

    ws.on("message", (data: string) => {
      try {
        const msg = JSON.parse(data) as CDPWireResponse;
        if (msg.id && pendingMessages.has(msg.id)) {
          const resolve = pendingMessages.get(msg.id);
          pendingMessages.delete(msg.id);
          resolve?.(msg);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    // Wait for connection
    await new Promise<void>((r) => ws.on("open", () => r()));

    // Enable Runtime
    await sendCommand("Runtime.enable");

    // Click "Select all slides" button
    console.log("Clicking 'Select all slides' button...");
    const selectAllResult = await sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const b of btns) {
          if (b.textContent?.trim() === 'Select all slides') {
            const r = b.getBoundingClientRect();
            if (r.width > 0) {
              b.click();
              return { clicked: true, x: r.x, y: r.y, text: b.textContent.trim() };
            }
          }
        }
        return { clicked: false };
      })()`,
      returnByValue: true,
    });
    console.log("Select all result:", JSON.stringify(selectAllResult, null, 2));
    const selectAllProbe = selectAllResult.result?.result?.value as ClickProbe | undefined;
    const selectAllClicked = selectAllProbe?.clicked || false;

    // Wait 300ms
    await new Promise((r) => setTimeout(r, 300));

    // Click "Import slides" button (y > 400)
    console.log("Clicking 'Import slides' button...");
    const importResult = await sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const b of btns) {
          if (b.textContent?.trim() === 'Import slides') {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && r.y > 400) {
              b.click();
              return { clicked: true, x: r.x, y: r.y, text: b.textContent.trim() };
            }
          }
        }
        return { clicked: false };
      })()`,
      returnByValue: true,
    });
    console.log("Import result:", JSON.stringify(importResult, null, 2));
    const importProbe = importResult.result?.result?.value as ClickProbe | undefined;
    const importClicked = importProbe?.clicked || false;

    // Poll for dialog closure (max 3 seconds)
    let dialogClosed = false;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 3000) {
      const dialogCheckResult = await sendCommand("Runtime.evaluate", {
        expression: `!document.querySelector('.google-picker.modal-dialog, [role="dialog"]')`,
        returnByValue: true,
      });
      if (dialogCheckResult.result?.value === true) {
        dialogClosed = true;
        console.log("Dialog closed!");
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Enable Page for screenshot
    await sendCommand("Page.enable");

    // Screenshot
    const screenshotDir = "/workspaces/sashaslides/presentations/1/screenshots";
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const screenshotData = await sendCommand("Page.captureScreenshot");
    const screenshotPath = path.join(screenshotDir, "js_click_result.png");
    if (screenshotData.result?.data) {
      fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.result.data, "base64"));
      console.log(`Screenshot saved to ${screenshotPath}`);
    }

    // Scroll filmstrip to bottom and count slides
    const slideCountResult = await sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const scroll = document.querySelector('.punch-filmstrip-scroll');
        if (scroll) scroll.scrollTop = 99999;
        return document.querySelectorAll('.punch-filmstrip-thumbnail').length;
      })()`,
      returnByValue: true,
    });

    const rawSlideCount = slideCountResult.result?.value;
    const finalSlideCount = typeof rawSlideCount === "number" ? rawSlideCount : 0;
    const totalRuntime = Date.now() - startTime;

    console.log(`\n=== RESULTS ===`);
    console.log(`Select all clicked: ${selectAllClicked}`);
    console.log(`Import clicked: ${importClicked}`);
    console.log(`Dialog closed: ${dialogClosed}`);
    console.log(`Final slide count: ${finalSlideCount}`);
    console.log(`Total runtime: ${totalRuntime}ms`);

    ws.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
