/**
 * upload-and-scrape.ts — build a combined pptx for the task's slides,
 * upload it to Google Slides under a fork-unique presentation name, and
 * scrape per-slide PNG thumbnails to the given output dir.
 *
 * This is the structured-prompt-pipeline's single side-effectful Google
 * touchpoint; the earlier record-pptx.sh builds use --no-upload. Multiple
 * forks can run this concurrently because the presentation name is
 * task-scoped + timestamped.
 *
 * Usage:
 *   npx tsx upload-and-scrape.ts --slides slide_04,slide_11 \
 *       --title bug_solving-clipping-1713512345 \
 *       --out /workspace/scratch/thumbnails
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { resolve } from "path";
import { Readable } from "stream";
import { execSync } from "child_process";
import { google } from "googleapis";

type Args = { slides: string[]; title: string; out: string; fixtures: string };

function parseArgs(argv: string[]): Args {
  const a: any = { fixtures: "renderer/html2slides/e2e/fixtures" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slides") a.slides = argv[++i].split(",").map((s: string) => s.trim());
    else if (argv[i] === "--title") a.title = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--fixtures") a.fixtures = argv[++i];
  }
  if (!a.slides || !a.title || !a.out) {
    throw new Error("usage: --slides <csv> --title <name> --out <dir> [--fixtures <dir>]");
  }
  return a;
}

function getAuth() {
  const credsPath = resolve("/workspaces/sashaslides/.auth/google_oauth.json");
  const tokensPath = resolve("/workspaces/sashaslides/.auth/tokens.json");
  if (!existsSync(credsPath) || !existsSync(tokensPath)) {
    throw new Error(
      `Missing Google credentials. Run \`npx tsx /workspaces/sashaslides/.auth/generate-token.ts\` first. ` +
      `Looked for: ${credsPath}, ${tokensPath}`,
    );
  }
  const creds = JSON.parse(readFileSync(credsPath, "utf-8")).installed;
  const tokens = JSON.parse(readFileSync(tokensPath, "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uris?.[0]);
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (newTokens) => {
    writeFileSync(tokensPath, JSON.stringify({ ...tokens, ...newTokens }, null, 2));
  });
  return oauth2;
}

async function main() {
  const { slides, title, out, fixtures } = parseArgs(process.argv.slice(2));
  mkdirSync(out, { recursive: true });
  const pptxPath = resolve(out, `${title}.pptx`);
  const htmlList = slides.map(s => `${s}.html`).join(",");

  console.log(`[1/3] Building combined pptx (${slides.length} slide(s)) → ${pptxPath}`);
  execSync(
    `npx tsx renderer/html2slides/convert-pptx.ts "${fixtures}" ` +
    `--only "${htmlList}" --title "${title}" --out "${pptxPath}" --no-upload`,
    { stdio: "inherit" },
  );
  if (!existsSync(pptxPath)) throw new Error("pptx not produced: " + pptxPath);

  console.log(`[2/3] Uploading to Google Drive as Slides presentation...`);
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.presentation" },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      body: Readable.from(readFileSync(pptxPath)),
    },
    fields: "id",
  });
  const presId = res.data.id!;
  console.log(`  → https://docs.google.com/presentation/d/${presId}/edit`);

  console.log(`[3/3] Scraping per-slide PNG thumbnails...`);
  // Reuse export-thumbs.ts which handles the thumbnailLink API + CDP fallback.
  execSync(
    `npx tsx renderer/html2slides/export-thumbs.ts "${presId}" "${out}"`,
    { stdio: "inherit" },
  );

  // Rename exported slide_NN.png → <slide_id>.png using input order.
  // export-thumbs writes slide_01.png, slide_02.png, etc. in upload order.
  const renames: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < slides.length; i++) {
    const from = resolve(out, `slide_${String(i + 1).padStart(2, "0")}.png`);
    const to = resolve(out, `${slides[i]}.png`);
    if (from !== to && existsSync(from)) {
      renameSync(from, to);
      renames.push({ from, to });
    }
  }
  if (renames.length) {
    console.log(`  renamed ${renames.length} thumbnails to task-slide-ids`);
  }

  // Emit a manifest for downstream consumers.
  writeFileSync(
    resolve(out, "manifest.json"),
    JSON.stringify({
      task_title: title,
      presentation_id: presId,
      slides,
      thumbnails: slides.map(s => `${s}.png`),
      created_at: new Date().toISOString(),
    }, null, 2),
  );

  console.log(`Done. Manifest: ${resolve(out, "manifest.json")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
