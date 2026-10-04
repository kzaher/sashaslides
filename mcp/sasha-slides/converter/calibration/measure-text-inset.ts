#!/usr/bin/env npx tsx
/**
 * measure-text-inset.ts — measure the real Slides text inset, then verify the
 * converter's compensation against it.
 *
 *   npx tsx mcp/sasha-slides/converter/calibration/measure-text-inset.ts
 *
 * `ShapeProperties` has no inset field and `presentations.get` does not report
 * one, so the inset is only observable as a displacement of rendered ink. The
 * complication is that ink is not the text box's content edge: a glyph has side
 * bearings, and a line box has half-leading above the ascent. Both scale with
 * the font size; the inset does not. So each inset is read as the INTERCEPT of a
 * straight line through six font sizes:
 *
 *   ink_left   − box_left   = insetLeft   + bearingLeft·fontPt
 *   ink_top    − box_top    = insetTop    + leadingTop·fontPt
 *   box_right  − ink_right  = insetRight  + bearingRight·fontPt
 *   box_bottom − ink_bottom = insetBottom + leadingBottom·fontPt
 *
 * The right/bottom pair needs `alignment: END` and `contentAlignment: BOTTOM`
 * respectively, so they live on their own slide. `HHHH` is the probe text
 * because every one of its four ink edges is a straight line (see ink.ts).
 *
 * Step 3 is the part that is not arithmetic: a third slide places two text boxes
 * through the converter's own `outsetForTextInset` + `placeBox`, one with the
 * old constants and one with the measured ones, both aiming the TEXT at a known
 * point. The residual displacement of each is the before/after error.
 *
 * The presentation is deleted on every exit path.
 */
import type { slides_v1 } from "googleapis";
import { writeFileSync } from "node:fs";
import { outsetForTextInset, pageScaleFor, placeBox } from "../geometry.js";
import type { PageScale, TextInsetEmu } from "../geometry.js";
import { DEFAULT_TEXT_INSET_EMU } from "../geometry.js";
import type { SlidesApiRequest } from "../slides-api.js";
import { applyBatch, slidesClient } from "./slides-client.js";
import type { SlidesClient } from "./slides-client.js";
import { decodePng, inkEdges, linearFit } from "./ink.js";
import type { Image, LinearFit } from "./ink.js";

const EMU_PER_INCH = 914400;
const DEFAULT_FONT_SIZES_PT = [10, 14, 18, 24, 32, 40] as const;
const PROBE_TEXT = "HHHH";
const BOX_LEFT_IN = 1;
const BOX_WIDTH_IN = 5;
/** The converter's fixed slide document size, so `pageScaleFor` behaves as in production. */
const VIEWPORT_PX = { w: 1280, h: 720 } as const;

type Page = Readonly<{ widthIn: number; heightIn: number }>;

/**
 * Round numbers the real inset might BE, to be judged against the pooled
 * estimate rather than eyeballed. Slides lays its editor out in CSS px, so an
 * integral px value is the most likely true constant.
 */
/**
 * The constants `DEFAULT_TEXT_INSET_EMU` held before this calibration: the
 * documented PowerPoint defaults. Kept here so the before/after comparison stays
 * reproducible after the shipped constant changed.
 */
const LEGACY_TEXT_INSET_EMU: TextInsetEmu = { left: 91440, right: 91440, top: 45720, bottom: 45720 };

const ROUND_CANDIDATES = [
  { label: "0.05in (shipped vertical)", emu: 45720 },
  { label: "8px", emu: 76200 },
  { label: "0.09in", emu: 82296 },
  { label: "9px = 0.09375in", emu: 85725 },
  { label: "0.1in (shipped horizontal)", emu: 91440 },
  { label: "10px", emu: 95250 },
] as const;

function argAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? null;
}

/**
 * Font sizes to probe. More points and a wider spread tighten the intercept;
 * a taller band is needed for a bigger font, so the caller owns the trade-off.
 */
function fontSizesPt(): readonly number[] {
  const raw = argAfter("--fonts");
  if (raw === null) return DEFAULT_FONT_SIZES_PT;
  const parsed = raw.split(",").map((entry) => Number(entry.trim()));
  if (parsed.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`--fonts wants positive numbers, got ${raw}`);
  }
  return parsed;
}

/**
 * Inverse-variance weighted mean of the four edge intercepts. The four are
 * measurements of what the evidence below says is ONE number, so pooling them is
 * the right estimator and its standard error is the figure to quote.
 */
function poolIntercepts(fits: readonly LinearFit[]): Readonly<{ emu: number; stdErrEmu: number }> {
  const weights = fits.map((fit) => 1 / Math.max(fit.interceptStdErr, 1e-9) ** 2);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const mean = fits.reduce((sum, fit, index) => sum + fit.intercept * (weights[index] ?? 0), 0) / total;
  return { emu: mean * EMU_PER_INCH, stdErrEmu: Math.sqrt(1 / total) * EMU_PER_INCH };
}

type BandGeometry = Readonly<{ topIn: number; heightIn: number; fontPt: number }>;

async function main(): Promise<void> {
  const client = slidesClient();
  const created = await client.slides.presentations.create({
    requestBody: { title: `sasha-inset-calibration-${Date.now()}` },
  });
  const presentationId = created.data.presentationId;
  if (typeof presentationId !== "string") throw new Error("presentations.create returned no id");
  console.log(`presentation ${presentationId} created`);

  try {
    await run({ client, presentationId });
  } finally {
    await client.deletePresentation(presentationId);
    console.log(`presentation ${presentationId} deleted`);
  }
}

async function run(options: Readonly<{ client: SlidesClient; presentationId: string }>): Promise<void> {
  const { client, presentationId } = options;
  const opening = await client.slides.presentations.get({ presentationId });
  const pageSize = opening.data.pageSize;
  const widthEmu = pageSize?.width?.magnitude;
  const heightEmu = pageSize?.height?.magnitude;
  const defaultSlideId = opening.data.slides?.[0]?.objectId;
  if (typeof widthEmu !== "number" || typeof heightEmu !== "number") throw new Error("no page size");
  if (typeof defaultSlideId !== "string") throw new Error("no default slide");
  const page: Page = { widthIn: widthEmu / EMU_PER_INCH, heightIn: heightEmu / EMU_PER_INCH };
  console.log(`page ${page.widthIn.toFixed(3)}in x ${page.heightIn.toFixed(3)}in`);

  const fontSizes = fontSizesPt();
  const bands = fontSizes.map((fontPt, index): BandGeometry => ({
    topIn: (index * page.heightIn) / fontSizes.length,
    heightIn: page.heightIn / fontSizes.length,
    fontPt,
  }));

  const scaffolding: slides_v1.Schema$Request[] = [
    { createSlide: { objectId: "calTop", insertionIndex: 1, slideLayoutReference: { predefinedLayout: "BLANK" } } },
    { createSlide: { objectId: "calEnd", insertionIndex: 2, slideLayoutReference: { predefinedLayout: "BLANK" } } },
    { createSlide: { objectId: "calVerify", insertionIndex: 3, slideLayoutReference: { predefinedLayout: "BLANK" } } },
    { deleteObject: { objectId: defaultSlideId } },
  ];
  await client.slides.presentations.batchUpdate({ presentationId, requestBody: { requests: scaffolding } });

  const probeRequests = [
    ...bands.flatMap((band, index) =>
      probeBox({ pageObjectId: "calTop", objectId: `topProbe${index}`, band, page, corner: "start" }),
    ),
    ...bands.flatMap((band, index) =>
      probeBox({ pageObjectId: "calEnd", objectId: `endProbe${index}`, band, page, corner: "end" }),
    ),
  ];
  const applied = await applyBatch({ client, presentationId, requests: probeRequests });
  if (!applied.ok) throw new Error(`probe batch rejected: ${applied.failure.message}`);

  const topImage = await thumbnail({ client, presentationId, pageObjectId: "calTop" });
  const endImage = await thumbnail({ client, presentationId, pageObjectId: "calEnd" });
  const pixelsPerInch = topImage.width / page.widthIn;
  console.log(`thumbnail ${topImage.width}x${topImage.height} -> ${pixelsPerInch.toFixed(2)} px/in`);

  const leftSamples: { x: number; y: number }[] = [];
  const topSamples: { x: number; y: number }[] = [];
  const rightSamples: { x: number; y: number }[] = [];
  const bottomSamples: { x: number; y: number }[] = [];
  for (const band of bands) {
    const bandPx = {
      xFrom: 0,
      xTo: topImage.width - 1,
      yFrom: band.topIn * pixelsPerInch + 1,
      yTo: (band.topIn + band.heightIn) * pixelsPerInch - 1,
    };
    const top = inkEdges({ image: topImage, band: bandPx });
    const end = inkEdges({ image: endImage, band: bandPx });
    if (top === null || end === null) throw new Error(`no ink in band for ${band.fontPt}pt`);
    leftSamples.push({ x: band.fontPt, y: top.left / pixelsPerInch - BOX_LEFT_IN });
    topSamples.push({ x: band.fontPt, y: top.top / pixelsPerInch - band.topIn });
    rightSamples.push({ x: band.fontPt, y: BOX_LEFT_IN + BOX_WIDTH_IN - end.right / pixelsPerInch });
    bottomSamples.push({ x: band.fontPt, y: band.topIn + band.heightIn - end.bottom / pixelsPerInch });
  }

  const fits = {
    left: linearFit(leftSamples),
    top: linearFit(topSamples),
    right: linearFit(rightSamples),
    bottom: linearFit(bottomSamples),
  } as const;
  const measured: TextInsetEmu = {
    left: Math.round(fits.left.intercept * EMU_PER_INCH),
    right: Math.round(fits.right.intercept * EMU_PER_INCH),
    top: Math.round(fits.top.intercept * EMU_PER_INCH),
    bottom: Math.round(fits.bottom.intercept * EMU_PER_INCH),
  };

  console.log("\ninset fits (y = intercept + slope*fontPt, inches):");
  for (const [edge, fit] of Object.entries(fits)) {
    console.log(
      `  ${edge.padEnd(6)} intercept ${fit.intercept.toFixed(5)}in ` +
        `(${Math.round(fit.intercept * EMU_PER_INCH)} EMU, +-${Math.round(fit.interceptStdErr * EMU_PER_INCH)}) ` +
        `slope ${fit.slope.toFixed(6)} in/pt  R2 ${fit.rSquared.toFixed(5)}  ` +
        `max|resid| ${(Math.max(...fit.residuals.map(Math.abs)) * pixelsPerInch).toFixed(2)}px`,
    );
  }
  const pooled = poolIntercepts([fits.left, fits.right, fits.top, fits.bottom]);
  console.log(
    `\npooled inset across all four edges: ${pooled.emu.toFixed(0)} EMU ` +
      `+-${pooled.stdErrEmu.toFixed(0)}  (${(pooled.emu / EMU_PER_INCH).toFixed(5)}in, ` +
      `${((pooled.emu / EMU_PER_INCH) * 96).toFixed(3)} css px)`,
  );
  for (const candidate of ROUND_CANDIDATES) {
    const sigma = (candidate.emu - pooled.emu) / pooled.stdErrEmu;
    console.log(
      `  candidate ${candidate.label.padEnd(26)} ${String(candidate.emu).padStart(6)} EMU  ` +
        `${sigma >= 0 ? "+" : ""}${sigma.toFixed(1)} sigma`,
    );
  }
  console.log("\nassumed vs measured (EMU):");
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    console.log(
      `  ${edge.padEnd(6)} assumed ${DEFAULT_TEXT_INSET_EMU[edge]}  measured ${measured[edge]}  ` +
        `delta ${measured[edge] - DEFAULT_TEXT_INSET_EMU[edge]}`,
    );
  }

  const verification = await verifyCompensation({
    client,
    presentationId,
    page,
    measured,
    slopes: { left: fits.left.slope, top: fits.top.slope },
  });

  const outPath = argAfter("--out");
  if (outPath !== null) {
    writeFileSync(outPath, JSON.stringify({ page, pixelsPerInch, fits, measured, verification }, null, 2));
    console.log(`\nwrote ${outPath}`);
  }
}

/**
 * One probe: a text box filling its band, `HHHH` at one font size, with autofit
 * off so the specified size is the rendered size.
 */
function probeBox(
  options: Readonly<{
    pageObjectId: string;
    objectId: string;
    band: BandGeometry;
    page: Page;
    corner: "start" | "end";
  }>,
): readonly SlidesApiRequest[] {
  const { pageObjectId, objectId, band, corner } = options;
  return [
    {
      createShape: {
        objectId,
        shapeType: "TEXT_BOX",
        elementProperties: {
          pageObjectId,
          size: {
            width: { magnitude: Math.round(BOX_WIDTH_IN * EMU_PER_INCH), unit: "EMU" },
            height: { magnitude: Math.round(band.heightIn * EMU_PER_INCH), unit: "EMU" },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: Math.round(BOX_LEFT_IN * EMU_PER_INCH),
            translateY: Math.round(band.topIn * EMU_PER_INCH),
            unit: "EMU",
          },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId,
        shapeProperties: {
          contentAlignment: corner === "start" ? "TOP" : "BOTTOM",
          autofit: { autofitType: "NONE" },
        },
        fields: "contentAlignment,autofit.autofitType",
      },
    },
    { insertText: { objectId, text: PROBE_TEXT, insertionIndex: 0 } },
    {
      updateTextStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: {
          fontFamily: "Arial",
          fontSize: { magnitude: band.fontPt, unit: "PT" },
          foregroundColor: { opaqueColor: { rgbColor: { red: 0, green: 0, blue: 0 } } },
          bold: false,
          italic: false,
        },
        fields: "fontFamily,fontSize,foregroundColor,bold,italic",
      },
    },
    {
      updateParagraphStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: { alignment: corner === "start" ? "START" : "END", lineSpacing: 100 },
        fields: "alignment,lineSpacing",
      },
    },
  ];
}

type VerificationRow = Readonly<{
  label: string;
  insetEmu: TextInsetEmu;
  errorXEmu: number;
  errorYEmu: number;
}>;

/**
 * Place two text boxes through the converter's own compensation — one with the
 * shipped constants, one with the freshly measured ones — both aiming the text's
 * content corner at a known point, and report how far the ink actually landed
 * from it. The font-scaled bearing/leading term is removed using the slopes from
 * the fit above, which is what makes the two numbers comparable.
 */
async function verifyCompensation(
  options: Readonly<{
    client: SlidesClient;
    presentationId: string;
    page: Page;
    measured: TextInsetEmu;
    slopes: Readonly<{ left: number; top: number }>;
  }>,
): Promise<readonly VerificationRow[]> {
  const { client, presentationId, page, measured, slopes } = options;
  const scale = pageScaleFor({
    viewportPx: VIEWPORT_PX,
    pageSizeEmu: {
      widthEmu: Math.round(page.widthIn * EMU_PER_INCH),
      heightEmu: Math.round(page.heightIn * EMU_PER_INCH),
    },
  });
  const fontPt = 24;
  const cases = [
    { label: "legacy (0.1in / 0.05in)", insetEmu: LEGACY_TEXT_INSET_EMU, targetTopIn: 0.6 },
    { label: "shipped DEFAULT_TEXT_INSET_EMU", insetEmu: DEFAULT_TEXT_INSET_EMU, targetTopIn: 2.2 },
    { label: "measured this run", insetEmu: measured, targetTopIn: 3.8 },
  ] as const;

  const requests = cases.flatMap((probe, index) =>
    compensatedBox({
      objectId: `verify${index}`,
      scale,
      insetEmu: probe.insetEmu,
      targetLeftIn: 2,
      targetTopIn: probe.targetTopIn,
      fontPt,
    }),
  );
  const applied = await applyBatch({ client, presentationId, requests });
  if (!applied.ok) throw new Error(`verification batch rejected: ${applied.failure.message}`);

  const image = await thumbnail({ client, presentationId, pageObjectId: "calVerify" });
  const pixelsPerInch = image.width / page.widthIn;
  const rows: VerificationRow[] = [];
  console.log("\nverification — residual displacement of the TEXT from its target point:");
  for (const [index, probe] of cases.entries()) {
    const band = {
      xFrom: 0,
      xTo: image.width - 1,
      yFrom: (probe.targetTopIn - 0.25) * pixelsPerInch,
      yTo: (probe.targetTopIn + 1.25) * pixelsPerInch,
    };
    const edges = inkEdges({ image, band });
    if (edges === null) throw new Error(`no ink for verification case ${index}`);
    const errorXIn = edges.left / pixelsPerInch - 2 - slopes.left * fontPt;
    const errorYIn = edges.top / pixelsPerInch - probe.targetTopIn - slopes.top * fontPt;
    const row: VerificationRow = {
      label: probe.label,
      insetEmu: probe.insetEmu,
      errorXEmu: Math.round(errorXIn * EMU_PER_INCH),
      errorYEmu: Math.round(errorYIn * EMU_PER_INCH),
    };
    rows.push(row);
    console.log(
      `  ${row.label.padEnd(30)} dx ${String(row.errorXEmu).padStart(7)} EMU ` +
        `(${(errorXIn * 96).toFixed(2)} css px)   dy ${String(row.errorYEmu).padStart(7)} EMU ` +
        `(${(errorYIn * 96).toFixed(2)} css px)`,
    );
  }
  return rows;
}

function compensatedBox(
  options: Readonly<{
    objectId: string;
    scale: PageScale;
    insetEmu: TextInsetEmu;
    targetLeftIn: number;
    targetTopIn: number;
    fontPt: number;
  }>,
): readonly SlidesApiRequest[] {
  const { objectId, scale, insetEmu, targetLeftIn, targetTopIn, fontPt } = options;
  const pixelsPerInch = VIEWPORT_PX.w / (scale.pageSizeEmu.widthEmu / EMU_PER_INCH);
  const htmlBounds = {
    x: targetLeftIn * pixelsPerInch,
    y: targetTopIn * pixelsPerInch,
    w: 4 * pixelsPerInch,
    h: 1.2 * pixelsPerInch,
  };
  return [
    {
      createShape: {
        objectId,
        shapeType: "TEXT_BOX",
        elementProperties: placeBox({
          bounds: outsetForTextInset({ bounds: htmlBounds, insetEmu, scale }),
          pageObjectId: "calVerify",
          scale,
        }),
      },
    },
    {
      updateShapeProperties: {
        objectId,
        shapeProperties: { contentAlignment: "TOP", autofit: { autofitType: "NONE" } },
        fields: "contentAlignment,autofit.autofitType",
      },
    },
    { insertText: { objectId, text: PROBE_TEXT, insertionIndex: 0 } },
    {
      updateTextStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: {
          fontFamily: "Arial",
          fontSize: { magnitude: fontPt, unit: "PT" },
          foregroundColor: { opaqueColor: { rgbColor: { red: 0, green: 0, blue: 0 } } },
        },
        fields: "fontFamily,fontSize,foregroundColor",
      },
    },
    {
      updateParagraphStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: { alignment: "START", lineSpacing: 100 },
        fields: "alignment,lineSpacing",
      },
    },
  ];
}

async function thumbnail(
  options: Readonly<{ client: SlidesClient; presentationId: string; pageObjectId: string }>,
): Promise<Image> {
  const response = await options.client.slides.presentations.pages.getThumbnail({
    presentationId: options.presentationId,
    pageObjectId: options.pageObjectId,
    "thumbnailProperties.mimeType": "PNG",
    "thumbnailProperties.thumbnailSize": "LARGE",
  });
  const url = response.data.contentUrl;
  if (typeof url !== "string") throw new Error("getThumbnail returned no contentUrl");
  const fetched = await fetch(url);
  if (!fetched.ok) throw new Error(`thumbnail fetch failed: ${fetched.status}`);
  return decodePng(Buffer.from(await fetched.arrayBuffer()));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
