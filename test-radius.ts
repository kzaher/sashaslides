import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";

const creds = JSON.parse(readFileSync(".auth/google_oauth.json", "utf-8")).installed;
const tokens = JSON.parse(readFileSync(".auth/tokens.json", "utf-8"));
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
oauth2.setCredentials(tokens);

const slides = google.slides({ version: "v1", auth: oauth2 });

async function main() {
  // Create a test presentation
  const pres = await slides.presentations.create({ requestBody: { title: "Radius Test" } });
  const presId = pres.data.presentationId!;
  const slideId = pres.data.slides![0].objectId!;

  const EMU = 914400; // 1 inch

  // Create shapes at different sizes to see how radius scales
  const shapes = [
    { name: "R1_16x16",  type: "ROUND_1_RECTANGLE", w: 16, h: 16, x: 0.5, y: 0.5 },
    { name: "R1_32x32",  type: "ROUND_1_RECTANGLE", w: 32, h: 32, x: 1.5, y: 0.5 },
    { name: "R1_64x64",  type: "ROUND_1_RECTANGLE", w: 64, h: 64, x: 2.5, y: 0.5 },
    { name: "R1_128x128",type: "ROUND_1_RECTANGLE", w: 128,h: 128,x: 4,   y: 0.5 },
    { name: "RR_240x240", type: "ROUND_RECTANGLE",  w: 240,h: 240,x: 6,   y: 0.5 },
    { name: "R1_240x240", type: "ROUND_1_RECTANGLE",w: 240,h: 240,x: 6,   y: 3 },
  ];

  const PX2EMU = 9144000 / 1280;
  const requests: any[] = [];
  for (const s of shapes) {
    const id = `shape_${s.name}`;
    requests.push({
      createShape: {
        objectId: id,
        shapeType: s.type,
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: s.w * PX2EMU, unit: "EMU" }, height: { magnitude: s.h * PX2EMU, unit: "EMU" } },
          transform: { scaleX: 1, scaleY: 1, translateX: s.x * EMU, translateY: s.y * EMU, unit: "EMU" },
        },
      },
    });
    requests.push({
      updateShapeProperties: {
        objectId: id,
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 0.2, green: 0.6, blue: 1 } } } },
          outline: { propertyState: "NOT_RENDERED" },
        },
        fields: "shapeBackgroundFill.solidFill.color,outline.propertyState",
      },
    });
  }

  await slides.presentations.batchUpdate({ presentationId: presId, requestBody: { requests } });

  // Now read back the shapes to see if there's any radius property
  const full = await slides.presentations.get({ presentationId: presId });
  const page = full.data.slides![0];
  for (const el of page.pageElements || []) {
    const sp = el.shape?.shapeProperties;
    const id = el.objectId;
    console.log(`${id}:`, JSON.stringify({
      shapeType: el.shape?.shapeType,
      size: el.size,
      // dump all shape properties to find radius-related fields
      props: sp ? Object.keys(sp) : [],
      full: sp,
    }, null, 2).slice(0, 500));
    console.log("---");
  }

  console.log(`\nhttps://docs.google.com/presentation/d/${presId}/edit`);
}

main().catch(console.error);
