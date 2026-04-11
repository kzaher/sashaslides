import CDP from "chrome-remote-interface";
async function main() {
  const targets = await CDP.List({ port: 9222 });
  for (const t of targets) {
    console.log(`${t.type}: ${t.url?.slice(0, 120)}`);
  }
}
main();
