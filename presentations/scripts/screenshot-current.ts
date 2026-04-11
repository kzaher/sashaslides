import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";

async function main() {
  const outputDir = process.argv[2] ?? "/workspaces/sashaslides/presentations/1/screenshots";
  mkdirSync(outputDir, { recursive: true });

  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("docs.google.com/presentation")
  );
  if (!tab) {
    console.error("No Slides tab found");
    process.exit(1);
  }

  const client = await CDP({ target: tab });
  const { Page } = client;
  await Page.enable();

  const screenshot = await Page.captureScreenshot({ format: "png" });
  const path = `${outputDir}/current_view.png`;
  writeFileSync(path, Buffer.from(screenshot.data, "base64"));
  console.log(`Screenshot saved: ${path}`);

  await client.close();
}

main().catch(console.error);
