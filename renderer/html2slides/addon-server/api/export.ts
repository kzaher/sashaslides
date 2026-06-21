/**
 * Workstream B — export non-skipped slides as a PNG zip (slide range).
 *
 * POST /api/export  {presentationId, range?, excludeHidden?} → application/zip
 *   1. parse `range` ("1-5, 8, 11-13") → set of 1-based indices (blank = all)
 *   2. presentations.get → slide list (+ slideProperties.isSkipped per slide)
 *   3. for each included slide: getThumbnail PNG → fetch bytes → JSZip entry
 *      slide_<NN>.png
 *   4. zip.generateAsync({type:'nodebuffer'}) → application/zip attachment
 *
 * Auth: in the dev/server path we reuse the project's stored OAuth tokens
 * (getAuth, same loader as export-thumbs-lib / convert-pptx-io). In the
 * add-on path Code.gs does the equivalent with UrlFetchApp + the user's
 * OAuth — see ./export-appsscript.gs.txt for the parallel implementation.
 *
 * Also hosts the dev-only /api/fetch-html proxy used by the URL loader when
 * the UI runs standalone (in the add-on, Code.gs's UrlFetchApp does this).
 */
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { readFileSync, writeFileSync } from "fs";
import { google } from "googleapis";
import JSZip from "jszip";
import { registerApi } from "../registry.js";

// dev-only outbound HTML fetch (CORS bypass for the "load from URL" control)
registerApi("GET", "/api/fetch-html", (req, res, url) => {
  const target = url.searchParams.get("url");
  if (!target) { res.writeHead(400); res.end("missing url"); return true; }
  const getter = target.startsWith("https:") ? httpsGet : httpGet;
  getter(target, (up) => {
    res.writeHead(up.statusCode || 200, { "Content-Type": "text/html; charset=utf-8" });
    up.pipe(res);
  }).on("error", (e) => { res.writeHead(502); res.end("fetch failed: " + e.message); });
  return true;
});

/**
 * Parse a slide-range spec like "1-5, 8, 11-13" into a Set of 1-based slide
 * indices. Blank / undefined input returns `null` meaning "all slides".
 *
 * Tolerant of: extra whitespace, trailing/empty segments ("1,,3"), and
 * reversed bounds ("5-1" → 1..5). Throws on anything non-numeric so a typo
 * surfaces as a 400 rather than silently exporting the wrong slides.
 */
export function parseRange(range: string | undefined | null): Set<number> | null {
  if (range == null) return null;
  const trimmed = range.trim();
  if (trimmed === "") return null;
  const out = new Set<number>();
  for (const rawSeg of trimmed.split(",")) {
    const seg = rawSeg.trim();
    if (seg === "") continue; // tolerate "1,,3" and a trailing comma
    const dash = seg.indexOf("-");
    if (dash === -1) {
      const n = Number(seg);
      if (!Number.isInteger(n) || n < 1) throw new Error(`bad slide index "${seg}"`);
      out.add(n);
    } else {
      const aStr = seg.slice(0, dash).trim();
      const bStr = seg.slice(dash + 1).trim();
      const a = Number(aStr);
      const b = Number(bStr);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
        throw new Error(`bad slide range "${seg}"`);
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) out.add(i);
    }
  }
  return out;
}

// Load the project's stored OAuth (same files as convert-pptx-io.getAuth /
// export-thumbs-lib). Kept local so api/export.ts has no import cycle back
// into the converter pipeline. In add-on mode this is replaced by the
// signed-in user's OAuth token (Apps Script path).
function getAuth() {
  const creds = JSON.parse(
    readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8"),
  ).installed;
  const tokens = JSON.parse(
    readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"),
  );
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost");
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (newTokens: Record<string, unknown>) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify(merged, null, 2));
  });
  return oauth2;
}

interface ExportBody {
  presentationId?: string;
  range?: string;
  excludeHidden?: boolean;
}

registerApi("POST", "/api/export", async (req, res, _url, body) => {
  try {
    const raw = await body();
    let parsed: ExportBody;
    try {
      parsed = JSON.parse(raw.toString("utf-8") || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return true;
    }
    const presentationId = parsed.presentationId;
    if (!presentationId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing presentationId" }));
      return true;
    }

    let included: Set<number> | null;
    try {
      included = parseRange(parsed.range);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
      return true;
    }

    const auth = getAuth();
    const slidesApi = google.slides({ version: "v1", auth });

    const pres = await slidesApi.presentations.get({ presentationId });
    const slides = pres.data.slides || [];

    // excludeHidden: filter out slides skipped in presentation mode.
    //
    // NOTE: The Slides REST API DOES surface the skip flag as
    // `slide.slideProperties.isSkipped` (Schema$SlideProperties.isSkipped) —
    // this maps to the editor's "Skip slide" toggle, which is also how an
    // imported pptx `show="0"` slide lands (see CLAUDE.md). When that field
    // is present we honour it. If a future API revision omits it (the field
    // is optional/nullable in the schema), `isSkipped` reads `undefined`,
    // which we treat as "not skipped" — so excludeHidden silently degrades to
    // a no-op for those slides rather than dropping content. We log a warning
    // once when excludeHidden is requested but no slide reports the property,
    // so the caller knows the filter couldn't actually do anything.
    const wantExcludeHidden = parsed.excludeHidden === true;
    let sawSkipProp = false;

    const zip = new JSZip();
    let addedCount = 0;

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const oneBased = i + 1;
      if (included && !included.has(oneBased)) continue;

      const isSkipped = slide.slideProperties?.isSkipped;
      if (isSkipped != null) sawSkipProp = true;
      if (wantExcludeHidden && isSkipped === true) continue;

      const slideId = slide.objectId;
      if (!slideId) continue;

      const thumb = await slidesApi.presentations.pages.getThumbnail({
        presentationId,
        pageObjectId: slideId,
        "thumbnailProperties.mimeType": "PNG",
        "thumbnailProperties.thumbnailSize": "LARGE",
      });
      const contentUrl = thumb.data.contentUrl;
      if (!contentUrl) continue;
      const resp = await fetch(contentUrl);
      const buf = Buffer.from(await resp.arrayBuffer());

      const name = "slide_" + String(oneBased).padStart(2, "0") + ".png";
      zip.file(name, buf);
      addedCount++;
    }

    if (wantExcludeHidden && !sawSkipProp) {
      console.warn(
        "[export] excludeHidden requested but no slide reported " +
          "slideProperties.isSkipped — filter was a no-op for this presentation.",
      );
    }

    if (addedCount === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no slides matched the requested range/filter" }));
      return true;
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="slides.zip"',
      "Content-Length": String(zipBuf.length),
    });
    res.end(zipBuf);
    return true;
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "export failed: " + (err as Error).message }));
    return true;
  }
});

export {};
