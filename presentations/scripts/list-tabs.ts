import CDPraw from "chrome-remote-interface";
import type { CdpModule } from "../../types/cdp-types.ts";

const CDP = CDPraw as CdpModule;

async function main() {
  const targets = await CDP.List({ port: 9222 });
  for (const t of targets) {
    console.log(`${t.type}: ${t.url?.slice(0, 120)}`);
  }
}
main();
