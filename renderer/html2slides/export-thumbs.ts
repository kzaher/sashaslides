import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";

const presId = process.argv[2] || "1JzxZYfftmDqJ-cyOfw4hHNFISwvdX7EXme-HYyEETRQ";
const outDir = process.argv[3] || "/tmp/slides-v2-thumbs";

const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost");
oauth2.setCredentials(tokens);

const slidesApi = google.slides({ version: "v1", auth: oauth2 });

async function main() {
  mkdirSync(outDir, { recursive: true });
  const pres = await slidesApi.presentations.get({ presentationId: presId });
  const slides = pres.data.slides || [];
  console.log(slides.length + " slides");

  const slideIds: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const slideId = slides[i].objectId!;
    slideIds.push(slideId);
    const thumb = await slidesApi.presentations.pages.getThumbnail({
      presentationId: presId,
      pageObjectId: slideId,
      "thumbnailProperties.mimeType": "PNG",
      "thumbnailProperties.thumbnailSize": "LARGE",
    });
    const url = thumb.data.contentUrl!;
    const resp = await fetch(url);
    const buf = Buffer.from(await resp.arrayBuffer());
    const outPath = outDir + "/slide_" + String(i + 1).padStart(2, "0") + ".png";
    writeFileSync(outPath, buf);
    console.log("  Slide " + (i + 1) + ": " + buf.length + " bytes");
  }
  console.log("Saved to " + outDir);

  // Merge slideIds into the run's meta.json so rating-server can deep-link
  // each comparison to the right slide in the editor (?slide=id.X#slide=id.X).
  const metaPath = join(dirname(outDir), "meta.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.slideIds = slideIds;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log("Updated " + metaPath + " with " + slideIds.length + " slideIds");
  }
}
main().catch(e => { console.error(e); process.exit(1); });
