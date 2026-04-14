import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

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
  
  for (let i = 0; i < slides.length; i++) {
    const slideId = slides[i].objectId!;
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
}
main().catch(e => { console.error(e); process.exit(1); });
