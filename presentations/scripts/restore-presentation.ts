import CDP from "chrome-remote-interface";
import fs from "fs";

const TAB_ID = "1xegFC0RQiZd";
const MAX_ITERATIONS = 50;
const STABILIZE_THRESHOLD = 3;
const TARGET_SLIDES = 38;

async function main() {
  let client;
  try {
    client = await CDP({ port: 9222 });

    const { Target, Page, Input, Runtime } = client;

    await Target.setDiscoverTargets({ discover: true });

    const { targetInfos } = await Target.getTargets();
    let targetInfo = targetInfos.find((t) =>
      t.url.includes(TAB_ID)
    );

    if (!targetInfo) {
      console.error(`Tab ${TAB_ID} not found. Available tabs:`);
      targetInfos.forEach((t) => console.log(`  ${t.url}`));
      process.exit(1);
    }

    await Target.activateTarget({ targetId: targetInfo.targetId });
    await new Promise((r) => setTimeout(r, 500));

    const TargetInput = Input;
    const TargetRuntime = Runtime;
    const TargetPage = Page;

    await TargetPage.enable();
    await TargetRuntime.enable();

    await new Promise((r) => setTimeout(r, 2000));

    const pageUrl = await TargetRuntime.evaluate({
      expression: "window.location.href",
    }).then((r) => r.result.value);
    console.log(`Connected to: ${pageUrl}`);

    // Check what elements exist
    const bodyInfo = await TargetRuntime.evaluate({
      expression: `JSON.stringify({
        classes: Array.from(document.querySelectorAll('[class*="filmstrip"]')).slice(0, 5).map(e => e.className),
        allThumbnails: document.querySelectorAll('[data-slide-id]').length,
        svgCount: document.querySelectorAll('svg').length
      })`,
    }).then((r) => r.result.value);
    console.log(`Page elements:`, bodyInfo);

    let startCount = await TargetRuntime.evaluate({
      expression:
        "document.querySelectorAll('[data-slide-id]').length",
    }).then((r) => r.result.value);

    console.log(`Starting slide count: ${startCount}`);

    // Log detailed page state
    const pageState = await TargetRuntime.evaluate({
      expression: `
        JSON.stringify({
          documentTitle: document.title,
          isEditable: document.designMode === 'on',
          bodyChildren: document.body.children.length,
          slides: document.querySelectorAll('[data-slide-id]').length,
          thumbnails: document.querySelectorAll('.punch-filmstrip-thumbnail').length,
          readyState: document.readyState,
          isFullyLoaded: document.readyState === 'complete'
        })
      `,
    }).then((r) => r.result.value);
    console.log(`Page state:`, pageState);

    await TargetRuntime.evaluate({
      expression: `
        const svg = document.querySelector('.workspace svg');
        if (svg) {
          const rect = svg.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          svg.click();
        }
      `,
    });

    await new Promise((r) => setTimeout(r, 100));

    let previousCounts: number[] = [];
    let undoCount = 0;
    let finalCount = startCount;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Try to invoke undo via Google Slides keyboard shortcut
      const undoResult = await TargetRuntime.evaluate({
        expression: `
          (async () => {
            const event = new KeyboardEvent('keydown', {
              key: 'z',
              code: 'KeyZ',
              keyCode: 90,
              ctrlKey: true,
              bubbles: true,
              cancelable: true
            });
            document.body.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 150));
            return document.querySelectorAll('.punch-filmstrip-thumbnail').length;
          })()
        `,
      });

      await new Promise((r) => setTimeout(r, 200));

      const currentCountResult = await TargetRuntime.evaluate({
        expression:
          "document.querySelectorAll('.punch-filmstrip-thumbnail').length",
      });
      const currentCount = currentCountResult.result.value;

      previousCounts.push(currentCount);
      if (previousCounts.length > STABILIZE_THRESHOLD) {
        previousCounts.shift();
      }

      console.log(`Undo ${i + 1}: ${currentCount} slides`);
      finalCount = currentCount;
      undoCount++;

      if (currentCount >= TARGET_SLIDES) {
        console.log(`Reached target count of ${TARGET_SLIDES}`);
        break;
      }

      if (
        previousCounts.length === STABILIZE_THRESHOLD &&
        previousCounts.every((c) => c === previousCounts[0])
      ) {
        console.log(`Count stabilized at ${currentCount}`);
        break;
      }
    }

    const screenshotDir = "/workspaces/sashaslides/presentations/1/screenshots";
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const screenshotPath = `${screenshotDir}/restored.png`;
    const { data } = await TargetPage.captureScreenshot();
    fs.writeFileSync(screenshotPath, Buffer.from(data, "base64"));

    console.log("\n=== Report ===");
    console.log(`Starting count: ${startCount}`);
    console.log(`Final count: ${finalCount}`);
    console.log(`Undos performed: ${undoCount}`);
    console.log(`Screenshot: ${screenshotPath}`);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

main().catch(console.error);
