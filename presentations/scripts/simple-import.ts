import puppeteer from "puppeteer";
import fs from "fs";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function importSlides() {
  // Get the correct WebSocket endpoint
  const versionInfo = await fetch("http://127.0.0.1:9222/json/version").then(
    (r) => r.json()
  );

  const browser = await puppeteer.connect({
    browserWSEndpoint: versionInfo.webSocketDebuggerUrl,
  });

  const page = await browser.newPage();
  const startTime = Date.now();

  try {
    // Step 1: Connect to tab and enable Page domain
    await page.goto(
      `https://docs.google.com/presentation/d/1xegFC0RQiZd/edit`,
      { waitUntil: "networkidle2" }
    );
    await page.evaluate(() => {});

    // Count initial slides
    const initialCount = await page.evaluate(() => {
      const thumbnails = document.querySelectorAll(".punch-filmstrip-thumbnail");
      return thumbnails.length;
    });
    console.log(`Initial slide count: ${initialCount}`);

    // Step 2: Click File menu
    await page.evaluate(() => {
      const menuItems = document.querySelectorAll("[role='menubar'] [role='menuitem']");
      for (const item of menuItems) {
        if (item.textContent?.trim() === "File") {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    await delay(400);

    // Step 3: Click "Import slides" menu item
    await page.evaluate(() => {
      const menuItems = document.querySelectorAll("[role='menuitem']");
      for (const item of menuItems) {
        const text = item.textContent?.trim() || "";
        if (text.startsWith("Import slides")) {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    await delay(2500);

    // Step 4: Click RobPresentation thumbnail at hardcoded coords
    await page.mouse.click(549, 313);
    await delay(600);

    // Step 5: Press Enter to confirm selection
    await page.keyboard.press("Enter");
    await delay(3000);

    // Step 6: Select all slides
    const selectAllResult = await page.evaluate(() => {
      const btns = document.querySelectorAll("button, [role='button']");
      for (const b of btns) {
        if (b.textContent?.trim() === "Select all slides") {
          const r = b.getBoundingClientRect();
          const opts = {
            bubbles: true,
            cancelable: true,
            clientX: r.x + r.width / 2,
            clientY: r.y + r.height / 2,
            pointerType: "mouse",
            button: 0,
          };
          b.dispatchEvent(new PointerEvent("pointerdown", opts));
          b.dispatchEvent(new MouseEvent("mousedown", opts));
          b.dispatchEvent(new PointerEvent("pointerup", opts));
          b.dispatchEvent(new MouseEvent("mouseup", opts));
          b.dispatchEvent(new MouseEvent("click", opts));
          return true;
        }
      }
      return false;
    });
    console.log(`Select all clicked: ${selectAllResult}`);

    await delay(400);

    // Step 7: Click Import slides button
    const importResult = await page.evaluate(() => {
      const btns = document.querySelectorAll("button, [role='button']");
      for (const b of btns) {
        if (b.textContent?.trim() === "Import slides") {
          const r = b.getBoundingClientRect();
          if (r.y > 400 && r.width > 0) {
            const opts = {
              bubbles: true,
              cancelable: true,
              clientX: r.x + r.width / 2,
              clientY: r.y + r.height / 2,
              pointerType: "mouse",
              button: 0,
            };
            b.dispatchEvent(new PointerEvent("pointerdown", opts));
            b.dispatchEvent(new MouseEvent("mousedown", opts));
            b.dispatchEvent(new PointerEvent("pointerup", opts));
            b.dispatchEvent(new MouseEvent("mouseup", opts));
            b.dispatchEvent(new MouseEvent("click", opts));
            b.click();
            return true;
          }
        }
      }
      return false;
    });
    console.log(`Import clicked: ${importResult}`);

    // Step 8: Poll for thumbnails
    let finalCount = initialCount;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 4000) {
      finalCount = await page.evaluate(() => {
        const thumbnails = document.querySelectorAll(".punch-filmstrip-thumbnail");
        return thumbnails.length;
      });

      if (finalCount >= 19) {
        console.log(`Reached ${finalCount} slides`);
        break;
      }

      await delay(150);
    }

    // Step 9: Screenshot
    const screenshotDir = "/workspaces/sashaslides/presentations/1/screenshots";
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    await page.screenshot({
      path: `${screenshotDir}/simple_imported.png`,
      fullPage: false,
    });
    console.log("Screenshot saved: simple_imported.png");

    const runtime = Date.now() - startTime;
    console.log(`\n=== REPORT ===`);
    console.log(`Initial slides: ${initialCount}`);
    console.log(`Final slides: ${finalCount}`);
    console.log(`Runtime: ${runtime}ms`);
    console.log(`Screenshot saved: Yes`);
  } finally {
    await browser.disconnect();
  }
}

importSlides().catch(console.error);
