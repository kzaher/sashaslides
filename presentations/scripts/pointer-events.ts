import CDP from 'chrome-remote-interface';
import * as fs from 'fs';
import * as path from 'path';

(async () => {
  const protocol = await CDP({ port: 9222 });
  const { Runtime, Page } = protocol;

  // Find target with 1xegFC0RQiZd
  const targetInfos = await CDP.List({ port: 9222 });
  const target = targetInfos.find((t: any) => t.url.includes('1xegFC0RQiZd')) || targetInfos[0];

  // Reconnect to specific tab
  const tabProtocol = await CDP({ target: (target as any).webSocketDebuggerUrl });
  const { Runtime: R, Page: P } = tabProtocol;

  await P.enable();

  // 1. Inspect dialog
  const inspect = await R.evaluate({
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"], .google-picker.modal-dialog');
      if (!dialog) return { error: 'no dialog' };
      const cells = [];
      dialog.querySelectorAll('div, li, a').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.width < 220 && r.height > 70 && r.height < 130) {
          cells.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
      return { dialogW: dialog.getBoundingClientRect().width, cellCount: cells.length, cells: cells.slice(0, 5) };
    })()`,
    returnByValue: true,
  });
  console.log('INSPECT:', JSON.stringify(inspect.result.value));

  // 2. Click thumbnails
  const clicked = await R.evaluate({
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"], .google-picker.modal-dialog');
      if (!dialog) return 0;
      const cells = [];
      dialog.querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.width < 220 && r.height > 70 && r.height < 130) {
          cells.push(el);
        }
      });
      let count = 0;
      const seen = new Set();
      for (const el of cells) {
        const r = el.getBoundingClientRect();
        const key = Math.round(r.x) + ',' + Math.round(r.y);
        if (seen.has(key)) continue;
        seen.add(key);
        const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, pointerType: 'mouse', button: 0 };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        count++;
      }
      return count;
    })()`,
    returnByValue: true,
  });
  console.log('CLICKED:', clicked.result.value);

  await new Promise(r => setTimeout(r, 300));

  // 3. Check selected
  const selected = await R.evaluate({
    expression: `document.querySelectorAll('[class*="selected"], [aria-selected="true"]').length`,
    returnByValue: true,
  });
  console.log('SELECTED:', selected.result.value);

  // 4. Click Import button
  const imported = await R.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Import slides') {
          const r = b.getBoundingClientRect();
          if (r.y > 400 && r.width > 0) {
            const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, pointerType: 'mouse', button: 0 };
            b.dispatchEvent(new PointerEvent('pointerdown', opts));
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new PointerEvent('pointerup', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
            b.click();
            return { clicked: true, x: r.x, y: r.y };
          }
        }
      }
      return { clicked: false };
    })()`,
    returnByValue: true,
  });
  console.log('IMPORT:', JSON.stringify(imported.result.value));

  // 5. Poll for dialog close
  let dialogClosed = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    const isOpen = await R.evaluate({
      expression: `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.getBoundingClientRect().height > 0 : false; })()`,
      returnByValue: true,
    });
    if (!isOpen.result.value) { dialogClosed = true; break; }
  }
  console.log('DIALOG_CLOSED:', dialogClosed);

  // 6. Screenshot
  const screenshotDir = '/workspaces/sashaslides/presentations/1/screenshots';
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { data } = await P.captureScreenshot();
  fs.writeFileSync(path.join(screenshotDir, 'pointer_result.png'), Buffer.from(data, 'base64'));
  console.log('SCREENSHOT: saved');

  // 7. Count thumbnails
  const thumbnailCount = await R.evaluate({
    expression: `(() => {
      const scroll = document.querySelector('.punch-filmstrip-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
      return document.querySelectorAll('.punch-filmstrip-thumbnail').length;
    })()`,
    returnByValue: true,
  });
  console.log('THUMBNAILS:', thumbnailCount.result.value);

  await tabProtocol.close();
  await protocol.close();
})();
