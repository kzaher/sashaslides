import { google } from "googleapis";
import { readFileSync } from "fs";
import { Readable } from "stream";

const creds = JSON.parse(readFileSync(".auth/google_oauth.json", "utf-8")).installed;
const tokens = JSON.parse(readFileSync(".auth/tokens.json", "utf-8"));
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
oauth2.setCredentials(tokens);
const slidesApi = google.slides({ version: "v1", auth: oauth2 });
const driveApi = google.drive({ version: "v3", auth: oauth2 });

const PX2EMU = 9144000 / 1280;

async function main() {
  // Create an SVG file with a rounded rect
  const svg8 = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
    <rect x="0" y="0" width="240" height="240" rx="8" ry="8" fill="#f0f0f0"/>
  </svg>`;

  // Upload SVG to Drive
  const res = await driveApi.files.create({
    requestBody: { name: "rounded_rect_8px.svg", mimeType: "image/svg+xml" },
    media: { mimeType: "image/svg+xml", body: Readable.from(Buffer.from(svg8)) },
    fields: "id,webContentLink",
  });
  console.log("SVG file ID:", res.data.id);

  // Make it public
  await driveApi.permissions.create({
    fileId: res.data.id!,
    requestBody: { role: "reader", type: "anyone" },
  });

  const svgUrl = `https://drive.google.com/uc?id=${res.data.id}&export=download`;
  console.log("SVG URL:", svgUrl);

  // Create presentation and try to insert SVG as image
  const pres = await slidesApi.presentations.create({ requestBody: { title: "SVG Inline Test" } });
  const presId = pres.data.presentationId!;
  const slideId = pres.data.slides![0].objectId!;

  try {
    await slidesApi.presentations.batchUpdate({
      presentationId: presId,
      requestBody: {
        requests: [{
          createImage: {
            objectId: "svg_test_1",
            url: svgUrl,
            elementProperties: {
              pageObjectId: slideId,
              size: {
                width: { magnitude: 240 * PX2EMU, unit: "EMU" },
                height: { magnitude: 240 * PX2EMU, unit: "EMU" },
              },
              transform: { scaleX: 1, scaleY: 1, translateX: 200 * PX2EMU, translateY: 240 * PX2EMU, unit: "EMU" },
            },
          },
        }],
      },
    });
    console.log("SVG createImage succeeded!");
  } catch (e: any) {
    console.log("SVG createImage failed:", e.message?.slice(0, 200));
  }

  // Also try with direct data URI
  const b64 = Buffer.from(svg8).toString("base64");
  const dataUri = `data:image/svg+xml;base64,${b64}`;
  try {
    await slidesApi.presentations.batchUpdate({
      presentationId: presId,
      requestBody: {
        requests: [{
          createImage: {
            objectId: "svg_test_2",
            url: dataUri,
            elementProperties: {
              pageObjectId: slideId,
              size: {
                width: { magnitude: 240 * PX2EMU, unit: "EMU" },
                height: { magnitude: 240 * PX2EMU, unit: "EMU" },
              },
              transform: { scaleX: 1, scaleY: 1, translateX: 520 * PX2EMU, translateY: 240 * PX2EMU, unit: "EMU" },
            },
          },
        }],
      },
    });
    console.log("SVG data URI succeeded!");
  } catch (e: any) {
    console.log("SVG data URI failed:", e.message?.slice(0, 200));
  }

  console.log(`\nhttps://docs.google.com/presentation/d/${presId}/edit`);
}

main().catch(console.error);
