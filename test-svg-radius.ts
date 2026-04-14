import CDP from "chrome-remote-interface";
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import { Readable } from "stream";

const creds = JSON.parse(readFileSync(".auth/google_oauth.json", "utf-8")).installed;
const tokens = JSON.parse(readFileSync(".auth/tokens.json", "utf-8"));
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
oauth2.setCredentials(tokens);
const slidesApi = google.slides({ version: "v1", auth: oauth2 });
const driveApi = google.drive({ version: "v3", auth: oauth2 });

const EMU = 914400;
const PX2EMU = 9144000 / 1280;

async function renderSvgToPng(svgHtml: string, w: number, h: number): Promise<Buffer> {
  const tab = await (CDP as any).New({
    port: 9222,
    url: `data:text/html,${encodeURIComponent(svgHtml)}`,
  });
  await new Promise(r => setTimeout(r, 500));
  const client = await CDP({ target: tab, port: 9222 });
  const { Page, Emulation } = client;
  await Page.enable();
  await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await new Promise(r => setTimeout(r, 300));
  const ss = await Page.captureScreenshot({
    format: "png",
    clip: { x: 0, y: 0, width: w, height: h, scale: 2 },
  });
  await client.close();
  await (CDP as any).Close({ port: 9222, id: tab.id });
  return Buffer.from(ss.data, "base64");
}

async function uploadPng(buf: Buffer, name: string): Promise<string> {
  const res = await driveApi.files.create({
    requestBody: { name, mimeType: "image/png" },
    media: { mimeType: "image/png", body: Readable.from(buf) },
    fields: "id",
  });
  await driveApi.permissions.create({
    fileId: res.data.id!,
    requestBody: { role: "reader", type: "anyone" },
  });
  return `https://drive.google.com/uc?id=${res.data.id}&export=download`;
}

async function main() {
  // Test: 3 rounded rects with different radii, rendered as SVG PNGs
  const shapes = [
    { label: "8px", radius: 8, w: 240, h: 240, fill: "#f0f0f0" },
    { label: "16px", radius: 16, w: 240, h: 240, fill: "#f0f0f0" },
    { label: "50%", radius: 120, w: 240, h: 240, fill: "#f0f0f0" },
  ];

  // Render SVGs to PNGs
  const pngs: { url: string; w: number; h: number }[] = [];
  for (const s of shapes) {
    const svg = `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;}body{background:transparent;}</style></head><body>
      <svg width="${s.w}" height="${s.h}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${s.w}" height="${s.h}" rx="${s.radius}" ry="${s.radius}" fill="${s.fill}"/>
      </svg>
    </body></html>`;
    console.log(`Rendering ${s.label} radius...`);
    const png = await renderSvgToPng(svg, s.w, s.h);
    writeFileSync(`/tmp/svg_${s.label}.png`, png);
    const url = await uploadPng(png, `svg_radius_${s.label}.png`);
    pngs.push({ url, w: s.w, h: s.h });
    console.log(`  uploaded: ${url}`);
  }

  // Create presentation with the SVG-rendered shapes
  const pres = await slidesApi.presentations.create({ requestBody: { title: "SVG Radius Test" } });
  const presId = pres.data.presentationId!;
  const slideId = pres.data.slides![0].objectId!;

  const requests: any[] = [];
  const xPositions = [200, 520, 840]; // same as slide_02

  for (let i = 0; i < pngs.length; i++) {
    const p = pngs[i];
    const imgId = `img_${i}`;
    requests.push({
      createImage: {
        objectId: imgId,
        url: p.url,
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: p.w * PX2EMU, unit: "EMU" },
            height: { magnitude: p.h * PX2EMU, unit: "EMU" },
          },
          transform: {
            scaleX: 1, scaleY: 1,
            translateX: xPositions[i] * PX2EMU,
            translateY: 240 * PX2EMU,
            unit: "EMU",
          },
        },
      },
    });
  }

  await slidesApi.presentations.batchUpdate({ presentationId: presId, requestBody: { requests } });
  console.log(`\nhttps://docs.google.com/presentation/d/${presId}/edit`);
}

main().catch(console.error);
