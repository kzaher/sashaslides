/**
 * run-apps-script.ts
 *
 * Opens the existing Apps Script project and runs applyWhiteboardStyle.
 * Handles the authorization popup flow by detecting the new CDP target.
 */

import CDP from "chrome-remote-interface";

const SCRIPT_URL =
  "https://script.google.com/u/0/home/projects/15g4CIxvCH4IHh5a3kGotU8vnPv8_h9nfJbt/edit";

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

// Handle OAuth consent flow in a tab
async function handleAuthTab(client: CDP.Client): Promise<void> {
  const { Runtime, Input } = client;

  // Click through the auth flow
  // Steps: Account chooser -> "Advanced" (unverified app) -> "Go to ... (unsafe)" -> "Allow"
  for (let step = 0; step < 10; step++) {
    await sleep(2000);

    // Get current page info
    const pageInfo = await Runtime.evaluate({
      expression: `(() => {
        const title = document.title;
        const url = location.href;
        const h1 = document.querySelector('h1')?.textContent || '';
        const h2 = document.querySelector('h2')?.textContent || '';
        const mainText = document.body?.innerText?.slice(0, 300) || '';
        return { title, url: url.slice(0, 100), h1, h2, mainText };
      })()`,
      returnByValue: true,
    });
    console.log(`    [auth step ${step + 1}] ${JSON.stringify(pageInfo.result.value).slice(0, 200)}`);

    // Look for an actionable button
    const btnResult = await Runtime.evaluate({
      expression: `(() => {
        // Priority list of buttons to click
        const priorities = [
          // Account chooser: click the account
          { selectors: '[data-identifier], [data-email]', text: null },
          // "Advanced" link (unverified app warning)
          { selectors: 'button, a, [role="button"]', text: 'Advanced' },
          // "Go to (unsafe)"
          { selectors: 'button, a, [role="button"]', text: 'Go to' },
          // "Allow"
          { selectors: 'button, a, [role="button"]', text: 'Allow' },
          // "Continue"
          { selectors: 'button, a, [role="button"]', text: 'Continue' },
          // "Review permissions"
          { selectors: 'button, a, [role="button"]', text: 'Review permissions' },
          // "Choose an account"
          { selectors: '[role="button"]', text: null },
        ];

        for (const { selectors, text } of priorities) {
          const els = document.querySelectorAll(selectors);
          for (const el of els) {
            if (text) {
              const elText = el.textContent?.trim() || '';
              if (!elText.includes(text)) continue;
            }
            const r = el.getBoundingClientRect();
            if (r.width > 20 && r.height > 10 && r.y < window.innerHeight) {
              return {
                x: r.x + r.width/2, y: r.y + r.height/2,
                text: (el.textContent || '').trim().slice(0, 60),
                cls: (el.className || '').toString().slice(0, 40)
              };
            }
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (btnResult.result.value) {
      const btn = btnResult.result.value as any;
      console.log(`    Clicking: "${btn.text}"`);
      await clickAt(Input, btn.x, btn.y);
      await sleep(2500);
    } else {
      console.log("    No actionable button found — auth may be complete");
      break;
    }
  }
}

async function main() {
  console.log("Connecting to Chrome...");

  // Open the script URL in a new tab
  const newTarget = await CDP.New({ port: 9222, url: SCRIPT_URL });
  console.log(`Opened Apps Script tab: ${newTarget.id}`);

  const client = await CDP({ target: newTarget });
  const { Runtime, Input, Page, Target } = client;
  await Page.enable();
  await Target.setDiscoverTargets({ discover: true });

  // Wait for the editor to load
  await sleep(7000);

  // Check the state
  const state = await Runtime.evaluate({
    expression: `(() => ({
      title: document.title,
      url: location.href.slice(0, 100),
      hasMonaco: !!document.querySelector('.monaco-editor'),
      hasEditor: !!document.querySelector('[role="code"]') || !!document.querySelector('.monaco-editor'),
      funcCount: document.querySelectorAll('[aria-label*="unction"]').length,
    }))()`,
    returnByValue: true,
  });
  console.log("State:", state.result.value);

  // Find and click the Run button
  console.log("Clicking Run button...");
  const runResult = await Runtime.evaluate({
    expression: `(() => {
      // Apps Script editor toolbar has a Run button
      const selectors = [
        'button[aria-label*="Run" i]',
        '[data-tooltip*="Run" i]',
        '[data-tooltip-text*="Run" i]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.y < 200) return { x: r.x + r.width/2, y: r.y + r.height/2, sel };
        }
      }
      // Fallback: search by text
      const all = document.querySelectorAll('button, [role="button"]');
      for (const b of all) {
        const label = b.getAttribute('aria-label') || '';
        if (label.toLowerCase().startsWith('run')) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.y < 200) return { x: r.x + r.width/2, y: r.y + r.height/2, sel: 'text-match' };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!runResult.result.value) {
    console.error("Could not find Run button");
    await client.close();
    process.exit(1);
  }

  const runPos = runResult.result.value as { x: number; y: number; sel: string };
  console.log(`  Found Run button via: ${runPos.sel}`);

  // Set up listener for new targets (popup tabs)
  const newTargets: string[] = [];
  client.on("Target.targetCreated", (params: any) => {
    if (params.targetInfo.type === "page" && params.targetInfo.url !== "about:blank") {
      newTargets.push(params.targetInfo.targetId);
      console.log(`  New tab created: ${params.targetInfo.url.slice(0, 80)}`);
    }
  });

  await clickAt(Input, runPos.x, runPos.y);
  await sleep(3000);

  // Check for in-page auth dialog (usually shown first)
  const authDialogResult = await Runtime.evaluate({
    expression: `(() => {
      // Look for "Review permissions" button
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const text = b.textContent?.trim() || '';
        if (text === 'Review permissions' || text === 'Review Permissions') {
          const r = b.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (authDialogResult.result.value) {
    const authPos = authDialogResult.result.value as { x: number; y: number };
    console.log("  Clicking 'Review permissions'...");
    await clickAt(Input, authPos.x, authPos.y);
    await sleep(4000);

    // A new tab/popup should have opened for OAuth
    const allTargets = await CDP.List({ port: 9222 });
    const authTarget = allTargets.find(
      (t: any) =>
        t.type === "page" &&
        (t.url.includes("accounts.google.com") || t.url.includes("oauth"))
    );

    if (authTarget) {
      console.log(`  Connecting to auth tab: ${authTarget.url.slice(0, 80)}`);
      const authClient = await CDP({ target: authTarget });
      try {
        await authClient.Page.enable();
        await handleAuthTab(authClient);
      } finally {
        await authClient.close();
      }

      // Wait for the auth to complete and script to run
      await sleep(5000);
    } else {
      console.log("  No auth tab found — maybe already authorized");
    }
  } else {
    console.log("  No 'Review permissions' dialog — script may already be running");
  }

  // Wait for execution to complete
  console.log("Waiting for script execution to complete...");
  await sleep(15000);

  // Check the execution log
  const logResult = await Runtime.evaluate({
    expression: `(() => {
      // Apps Script V2 editor has execution log at bottom
      const logArea = document.querySelector('[class*="execution-log"]') ||
                      document.querySelector('[class*="log"]') ||
                      document.querySelector('[aria-label*="Execution log" i]');
      if (logArea) return logArea.textContent?.slice(0, 500) || 'empty';

      // Look for any text that mentions execution
      const all = document.body.innerText || '';
      const idx = all.indexOf('Execution');
      if (idx >= 0) return all.slice(idx, idx + 500);
      return 'no log found';
    })()`,
    returnByValue: true,
  });
  console.log("Execution log:", logResult.result.value);

  await client.close();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
