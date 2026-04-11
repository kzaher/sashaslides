/**
 * upload-pptx-to-slides.ts
 *
 * Uploads a .pptx file to Google Drive and opens it as a Google Slides presentation,
 * fully programmatically via CDP file input injection.
 *
 * Usage: npx tsx upload-pptx-to-slides.ts <path-to-pptx>
 */

import CDP from "chrome-remote-interface";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function pressKey(input: any, key: string, keyCode: number, modifiers = 0) {
  await input.dispatchKeyEvent({ type: "rawKeyDown", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  await sleep(30);
  await input.dispatchKeyEvent({ type: "keyUp", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

async function clickAt(input: any, x: number, y: number) {
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(30);
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function main() {
  const pptxPath = resolve(process.argv[2] ?? "presentations/1/RobPresentation.pptx");
  if (!existsSync(pptxPath)) {
    console.error(`File not found: ${pptxPath}`);
    process.exit(1);
  }

  console.log(`Uploading ${pptxPath}`);

  // Open Google Drive in a new tab
  console.log("Opening Google Drive...");
  const newTarget = await CDP.New({ port: 9222, url: "https://drive.google.com/drive/my-drive" });

  const client = await CDP({ target: newTarget });
  const { Page, Runtime, Input, DOM } = client;
  await Page.enable();
  await DOM.enable();

  await Page.loadEventFired();
  await sleep(4000);

  // Find the file input element on Drive page
  // Drive has a hidden file input we can use
  console.log("Looking for file input...");

  // First, inject a file input we can target reliably
  await Runtime.evaluate({
    expression: `
      (() => {
        // Remove any existing injected input
        const old = document.getElementById('__claude_upload__');
        if (old) old.remove();

        // Create a new file input
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.id = '__claude_upload__';
        inp.style.position = 'fixed';
        inp.style.top = '10px';
        inp.style.left = '10px';
        inp.style.zIndex = '99999';
        inp.style.width = '200px';
        document.body.appendChild(inp);
        return 'injected';
      })()
    `,
    returnByValue: true,
  });

  // Get the node ID of our injected input
  const docResult = await DOM.getDocument({ depth: -1 });
  const nodeQuery = await DOM.querySelector({
    nodeId: docResult.root.nodeId,
    selector: "#__claude_upload__",
  });

  if (!nodeQuery.nodeId) {
    console.error("Could not find injected file input");
    await client.close();
    process.exit(1);
  }

  // Use setFileInputFiles to attach our file
  await DOM.setFileInputFiles({
    files: [pptxPath],
    nodeId: nodeQuery.nodeId,
  });
  console.log("File attached to injected input");

  // Now we need to trigger Drive's upload using this file
  // The cleanest approach: use the file's data and submit via Drive's upload API
  // But that needs auth tokens.
  //
  // Alternative: trigger drag-drop event on Drive's drop zone with our file
  // Let me try yet another approach: use the file from our injected input
  // to programmatically construct a DataTransfer and dispatch a drop event.

  await Runtime.evaluate({
    expression: `
      (async () => {
        const inp = document.getElementById('__claude_upload__');
        if (!inp || !inp.files || inp.files.length === 0) {
          return 'no file';
        }
        const file = inp.files[0];

        // Find Drive's drop zone — usually the body or a specific element
        const dropZone = document.querySelector('[role="main"]') ||
                         document.querySelector('.a-Sb-c') ||
                         document.body;

        if (!dropZone) return 'no drop zone';

        // Create DataTransfer
        const dt = new DataTransfer();
        dt.items.add(file);

        // Dispatch drag events
        const dragOver = new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        dropZone.dispatchEvent(dragOver);

        const drop = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        dropZone.dispatchEvent(drop);

        return 'drop dispatched, file=' + file.name + ' size=' + file.size;
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  }).then((r) => console.log("Drop result:", r.result.value));

  // Wait for upload to start
  await sleep(3000);

  // Alternative if drop didn't work: use the New > File upload menu
  console.log("Trying New > File upload menu...");

  const newBtnResult = await Runtime.evaluate({
    expression: `(() => {
      // Find the "+ New" button in Drive
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        const aria = btn.getAttribute('aria-label') || '';
        if (text === 'New' || aria === 'New' || aria.startsWith('New')) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.x < 250) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (newBtnResult.result.value) {
    const newPos = newBtnResult.result.value as { x: number; y: number };
    await clickAt(Input, newPos.x, newPos.y);
    await sleep(800);

    // Click "File upload"
    const uploadBtnResult = await Runtime.evaluate({
      expression: `(() => {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const item of items) {
          const text = item.textContent?.trim() || '';
          if (text.includes('File upload')) {
            const r = item.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (uploadBtnResult.result.value) {
      const uploadPos = uploadBtnResult.result.value as { x: number; y: number };

      // Before clicking, find the hidden file input that Drive uses
      // The click will trigger the system file picker, but we want to intercept
      // by finding the actual <input type=file> element that Drive uses internally.

      // Look for any file input on the page
      const allInputsResult = await Runtime.evaluate({
        expression: `(() => {
          const inputs = document.querySelectorAll('input[type="file"]');
          return Array.from(inputs).map((inp, i) => ({
            i,
            name: inp.name,
            id: inp.id,
            visible: inp.offsetParent !== null
          }));
        })()`,
        returnByValue: true,
      });
      console.log("File inputs on page:", allInputsResult.result.value);

      // Click File upload — this will create a new file input
      await clickAt(Input, uploadPos.x, uploadPos.y);
      await sleep(1000);

      // After clicking, find the newly created file input
      const newDoc = await DOM.getDocument({ depth: -1 });
      const fileInputs = await DOM.querySelectorAll({
        nodeId: newDoc.root.nodeId,
        selector: 'input[type="file"]:not(#__claude_upload__)',
      });

      console.log(`Found ${fileInputs.nodeIds.length} file inputs after click`);

      if (fileInputs.nodeIds.length > 0) {
        // Try each one
        for (const nodeId of fileInputs.nodeIds) {
          try {
            await DOM.setFileInputFiles({ files: [pptxPath], nodeId });
            console.log(`Set file on input ${nodeId}`);
          } catch (e) {
            console.log(`Failed to set on ${nodeId}: ${e}`);
          }
        }
      }
    }
  }

  // Wait for upload to complete
  console.log("Waiting for upload to complete...");
  await sleep(15000);

  // Check upload status
  const statusResult = await Runtime.evaluate({
    expression: `(() => {
      // Look for upload progress / completion
      const all = document.body.innerText || '';
      const lines = all.split('\\n').filter(l => l.includes('upload') || l.includes('Upload') || l.includes('.pptx'));
      return lines.slice(0, 10).join('\\n');
    })()`,
    returnByValue: true,
  });
  console.log("Upload status:", statusResult.result.value);

  await client.close();
  console.log("\nDone! Check Google Drive for the uploaded file.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
