import CDP from "chrome-remote-interface";
async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd")
  );
  if (!tab) { console.error("No tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Page, Target } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await Page.reload();
  console.log("Reloaded, waiting for load...");
  await new Promise(r => setTimeout(r, 8000));
  console.log("Done");
  await client.close();
}
main().catch(console.error);
