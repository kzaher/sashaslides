/**
 * diff-pptx-pairs.ts — thin CLI wrapper around diffPptxPairs() in
 * ./diff-pptx-pairs-lib.
 *
 * Usage:
 *   npx tsx diff-pptx-pairs.ts --before <dir> --after <dir> --out <dir>
 */
import { diffPptxPairs } from "./diff-pptx-pairs-lib";

type Args = { before: string; after: string; out: string };

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--before") a.before = argv[++i];
    else if (argv[i] === "--after") a.after = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
  }
  if (!a.before || !a.after || !a.out) {
    throw new Error("usage: --before <dir> --after <dir> --out <dir>");
  }
  return a as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await diffPptxPairs(args);
}

main().catch(e => { console.error(e); process.exit(1); });
