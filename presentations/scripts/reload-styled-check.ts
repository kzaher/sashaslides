import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1yYcZXgK2MGr7kdvt613iX7f7GJwmnG1D")
  );
  if (!tab) { console.error("No styled tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Page, Target, Runtime, Input } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await Page.reload();
  await new Promise(r => setTimeout(r, 5000));

  // Dismiss any dialog
  await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Got it') { b.click(); return true; }
      }
      return false;
    })()`,
  });
  await new Promise(r => setTimeout(r, 500));

  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/styled_reloaded.png", Buffer.from(ss.data, "base64"));
  console.log("Saved: styled_reloaded.png");
  await client.close();
}
main().catch(console.error);
