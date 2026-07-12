/**
 * drawio-store.e2e.test.ts — LIVE test against real Google Drive.
 *
 * Run:  cd renderer/html2slides && npx tsx drawio-store.e2e.test.ts
 *
 * Exercises the pure SVG<->XML plumbing, then a full Drive round-trip
 * (ensure folders → upload → read-back → update → read-back) and finally
 * DELETES the unique test folder so nothing is left in Drive. Exits non-zero
 * on any failed assertion or unexpected error.
 */

import { google } from "googleapis";
import { getAuth } from "./convert-pptx-io.js";
import {
  buildEditableSvg,
  extractXmlFromEditableSvg,
  drawioFolderSegments,
  drawioFileName,
  ensureFolderPath,
  uploadDrawioSvg,
  getDrawioSvgByPath,
} from "./drawio-store.js";

let failures = 0;
function pass(step: string, detail = "") {
  console.log(`PASS  ${step}${detail ? `  — ${detail}` : ""}`);
}
function fail(step: string, detail = "") {
  failures++;
  console.log(`FAIL  ${step}${detail ? `  — ${detail}` : ""}`);
}
function check(cond: boolean, step: string, detail = "") {
  if (cond) pass(step, detail);
  else fail(step, detail);
}

// A sample mxfile whose XML deliberately includes characters that MUST survive
// attribute escaping: & < > " and a raw "&lt;" literal.
const SAMPLE_XML_A =
  `<mxfile host="app.diagrams.net"><diagram id="a" name="Page &amp; 1">` +
  `<mxGraphModel dx="800" dy="600"><root>` +
  `<mxCell id="0"/><mxCell id="1" parent="0"/>` +
  `<mxCell id="2" value="if a &lt; b &amp; c > 0 say &quot;hi&quot;" vertex="1" parent="1">` +
  `<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>` +
  `</root></mxGraphModel></diagram></mxfile>`;

const SAMPLE_XML_B =
  `<mxfile host="app.diagrams.net"><diagram id="a" name="Updated">` +
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
  `<mxCell id="9" value="v2 &lt;changed&gt;" vertex="1" parent="1">` +
  `<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>` +
  `</root></mxGraphModel></diagram></mxfile>`;

async function main() {
  // --- Step 1: pure round-trip (no baseSvg) ------------------------------
  {
    const svg = buildEditableSvg(SAMPLE_XML_A);
    const back = extractXmlFromEditableSvg(svg);
    check(back === SAMPLE_XML_A, "Step 1a  build→extract byte-equal (minimal wrapper)",
      back === SAMPLE_XML_A ? "" : `got: ${JSON.stringify(back)?.slice(0, 120)}`);
    // must still contain the xmlns so it's a valid standalone SVG
    check(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg), "Step 1b  wrapper has svg xmlns");
  }

  // --- Step 1c: baseSvg branch -------------------------------------------
  {
    const base = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" content="STALE">` +
      `<rect width="200" height="100" fill="#eef"/></svg>`;
    const svg = buildEditableSvg(SAMPLE_XML_A, base);
    const back = extractXmlFromEditableSvg(svg);
    check(back === SAMPLE_XML_A, "Step 1c  build→extract byte-equal (baseSvg, replaced content)",
      back === SAMPLE_XML_A ? "" : `got: ${JSON.stringify(back)?.slice(0, 120)}`);
    check(/width="200"/.test(svg) && /<rect/.test(svg), "Step 1d  baseSvg geometry/children preserved");
    check(!/STALE/.test(svg), "Step 1e  stale content attribute removed");
  }

  // --- Step 1f: extract on non-editable / empty svg → null ---------------
  {
    check(extractXmlFromEditableSvg("<svg></svg>") === null, "Step 1f  extract null when no content attr");
    check(extractXmlFromEditableSvg("not svg at all") === null, "Step 1g  extract null when no <svg>");
  }

  // --- Step 2: Drive client ----------------------------------------------
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const testDocId = `TEST_${Date.now()}`;
  const segments = drawioFolderSegments("slide", testDocId);
  const fileName = drawioFileName("diagA");
  console.log(`\nDrive namespace: My Drive / ${segments.join(" / ")} / ${fileName}\n`);

  let docFolderId = "";
  try {
    // --- Step 3: ensure folders → upload → read-back ---------------------
    docFolderId = await ensureFolderPath(drive, segments);
    check(!!docFolderId, "Step 3a  ensureFolderPath created path", docFolderId);

    // idempotency: calling again must return the SAME id (no duplicate folder)
    const again = await ensureFolderPath(drive, segments);
    check(again === docFolderId, "Step 3b  ensureFolderPath idempotent", again);

    const svgA = buildEditableSvg(SAMPLE_XML_A);
    const up1 = await uploadDrawioSvg(drive, docFolderId, fileName, svgA);
    check(!!up1.fileId, "Step 3c  uploadDrawioSvg (create) returned fileId", up1.fileId);
    check(!!up1.webViewLink, "Step 3d  create returned webViewLink", up1.webViewLink);

    const got1 = await getDrawioSvgByPath(drive, segments, fileName);
    check(got1 !== null && got1.xml === SAMPLE_XML_A, "Step 3e  getDrawioSvgByPath xml round-trips",
      got1 ? `fileId=${got1.fileId}` : "null");

    // --- Step 4: update path --------------------------------------------
    const svgB = buildEditableSvg(SAMPLE_XML_B);
    const up2 = await uploadDrawioSvg(drive, docFolderId, fileName, svgB);
    check(up2.fileId === up1.fileId, "Step 4a  update reused SAME fileId (no dup)",
      `${up1.fileId} == ${up2.fileId}`);

    const got2 = await getDrawioSvgByPath(drive, segments, fileName);
    check(got2 !== null && got2.xml === SAMPLE_XML_B, "Step 4b  updated xml round-trips",
      got2 ? `xml len=${got2.xml?.length}` : "null");
  } finally {
    // --- Step 5: cleanup — delete the unique test docId folder ----------
    if (docFolderId) {
      try {
        await drive.files.delete({ fileId: docFolderId });
        // Verify: resolving the (now-deleted) path must yield null.
        const gone = await getDrawioSvgByPath(drive, segments, fileName);
        check(gone === null, "Step 5  cleanup deleted test folder (path no longer resolves)");
      } catch (e) {
        fail("Step 5  cleanup", e instanceof Error ? e.message : String(e));
      }
    }
  }

  console.log("");
  if (failures === 0) {
    console.log("ALL PASS");
    process.exit(0);
  } else {
    console.log(`${failures} FAILURE(S)`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
