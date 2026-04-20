const puppeteer = require('puppeteer');
const { pathToFileURL } = require('url');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(pathToFileURL('/workspaces/sashaslides/renderer/html2slides/e2e/fixtures/slide_04.html').href);
  await new Promise(r => setTimeout(r, 500));

  const info = await page.evaluate(() => {
    const dot = document.querySelector('.dot.current');
    if (!dot) return null;
    const r = dot.getBoundingClientRect();
    const cs = getComputedStyle(dot);
    const beforeCs = getComputedStyle(dot, '::before');
    const afterCs = getComputedStyle(dot, '::after');
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      boxShadow: cs.boxShadow,
      before: {
        content: beforeCs.content, position: beforeCs.position,
        top: beforeCs.top, left: beforeCs.left, right: beforeCs.right, bottom: beforeCs.bottom,
        width: beforeCs.width, height: beforeCs.height,
        bg: beforeCs.backgroundColor, br: beforeCs.borderTopLeftRadius,
      },
      after: {
        content: afterCs.content, position: afterCs.position,
        top: afterCs.top, left: afterCs.left, right: afterCs.right, bottom: afterCs.bottom,
        width: afterCs.width, height: afterCs.height,
        bg: afterCs.backgroundColor, br: afterCs.borderTopLeftRadius,
      },
    };
  });
  console.log('slide_04 .dot.current:', JSON.stringify(info, null, 2));

  await page.goto(pathToFileURL('/workspaces/sashaslides/renderer/html2slides/e2e/fixtures/slide_20.html').href);
  await new Promise(r => setTimeout(r, 500));
  const info2 = await page.evaluate(() => {
    const b = document.querySelector('.bubble-us');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      boxShadow: cs.boxShadow,
      bg: cs.backgroundColor,
      borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor,
    };
  });
  console.log('slide_20 .bubble-us:', JSON.stringify(info2, null, 2));

  await browser.close();
})();
