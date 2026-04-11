import * as fs from "fs";
import * as path from "path";

interface ChromeTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface PageScreenshot {
  data: string;
}

async function connectToChrome(
  wsUrl: string
): Promise<{
  send: (method: string, params?: any) => Promise<any>;
  close: () => void;
}> {
  const WebSocket = await import("ws");
  const ws = new WebSocket.default(wsUrl);

  // Wait for WebSocket to open
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
  });

  let messageId = 0;
  const pendingMessages = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
    }
  >();

  ws.on("message", (data: string) => {
    const message = JSON.parse(data);
    if (message.id) {
      const pending = pendingMessages.get(message.id);
      if (pending) {
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        pendingMessages.delete(message.id);
      }
    }
  });

  const send = async (method: string, params?: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      const id = ++messageId;
      pendingMessages.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(
        () => {
          if (pendingMessages.has(id)) {
            pendingMessages.delete(id);
            reject(new Error(`Timeout for ${method}`));
          }
        },
        5000
      );
    });
  };

  return {
    send,
    close: () => ws.close(),
  };
}

async function main() {
  try {
    // Get Chrome targets
    const targetsResponse = await fetch("http://localhost:9222/json");
    const targets: ChromeTarget[] = await targetsResponse.json();

    const tab = targets.find((t) => t.url.includes("1xegFC0RQiZd"));
    if (!tab) {
      console.error("Tab with ID 1xegFC0RQiZd not found");
      process.exit(1);
    }

    const client = await connectToChrome(tab.webSocketDebuggerUrl);

    // Enable Page domain
    await client.send("Page.enable");

    // Activate tab and bring to front
    const targetId = tab.id;
    await fetch("http://localhost:9222/json/activate/" + targetId);

    // Scroll filmstrip to bottom
    await client.send("Runtime.evaluate", {
      expression: `
        (() => {
          const filmstrip = document.querySelector('.punch-filmstrip-scroll');
          if (filmstrip) {
            filmstrip.scrollTop = filmstrip.scrollHeight;
          }
        })()
      `,
    });

    // Wait 300ms
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Count thumbnails
    const countResult = await client.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    const slideCount = countResult?.result?.value || countResult.value;

    // Scroll filmstrip to top
    await client.send("Runtime.evaluate", {
      expression: `
        (() => {
          const filmstrip = document.querySelector('.punch-filmstrip-scroll');
          if (filmstrip) {
            filmstrip.scrollTop = 0;
          }
        })()
      `,
    });

    // Wait 200ms
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Take screenshot
    const screenshotDir = "/workspaces/sashaslides/presentations/1/screenshots";
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const screenshotResult: PageScreenshot = await client.send(
      "Page.captureScreenshot"
    );
    const screenshotPath = path.join(screenshotDir, "current_state.png");
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotResult.data, "base64"));
    const screenshotSaved = true;

    // Check for open dialog
    const dialogResult = await client.send("Runtime.evaluate", {
      expression: `
        (() => {
          const dialog = document.querySelector('[role="dialog"], .google-picker.modal-dialog');
          if (dialog) {
            return {
              width: dialog.offsetWidth,
              height: dialog.offsetHeight
            };
          }
          return null;
        })()
      `,
    });
    const dialogOpen = dialogResult.value;

    // Click first thumbnail and get title
    let firstSlideTitle = "N/A";
    try {
      await client.send("Runtime.evaluate", {
        expression: `document.querySelector('.punch-filmstrip-thumbnail')?.click()`,
      });

      // Wait for canvas to update
      await new Promise((resolve) => setTimeout(resolve, 500));

      const titleResult = await client.send("Runtime.evaluate", {
        expression: `
          (() => {
            const title = document.querySelector('.g-font-titlenew');
            return title ? title.textContent : null;
          })()
        `,
      });
      if (titleResult.value) {
        firstSlideTitle = titleResult.value;
      }
    } catch (e) {
      // Continue even if title fetch fails
    }

    client.close();

    // Report results
    console.log("=== Google Slides State ===");
    console.log(`Slide count: ${slideCount}`);
    console.log(`Dialog open: ${dialogOpen ? `Yes (${dialogOpen.width}x${dialogOpen.height})` : "No"}`);
    console.log(`Screenshot saved: ${screenshotSaved}`);
    console.log(`First slide title: ${firstSlideTitle}`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
