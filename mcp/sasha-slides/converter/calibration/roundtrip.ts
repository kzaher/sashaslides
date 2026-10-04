#!/usr/bin/env npx tsx
/**
 * roundtrip.ts — the converter's real output through a real `batchUpdate`.
 *
 *   npx tsx .../calibration/roundtrip.ts create
 *   npx tsx .../calibration/roundtrip.ts run --presentation <id> --fixtures a.html,b.html --out results.json
 *   npx tsx .../calibration/roundtrip.ts bullets --presentation <id> --out bullets.json
 *   npx tsx .../calibration/roundtrip.ts report --out results.json
 *   npx tsx .../calibration/roundtrip.ts drop --presentation <id>
 *
 * `run` is split from `create`/`drop` so one fixture-at-a-time invocations can
 * share a single throwaway presentation and still finish inside the 30 s command
 * budget. `drop` deletes it; nothing here leaves a file in Drive on a path that
 * completes.
 *
 * What it proves that the offline tests cannot:
 *   - whether `batchUpdate` ACCEPTS each request type, field mask and enum value
 *     the converter emits (a rejected batch is atomic, so the API names the
 *     offending index; the loop drops it, records the API's own words and
 *     retries, which enumerates every rejection in one pass rather than one);
 *   - whether the geometry read back by `presentations.get` is the geometry the
 *     converter asked for.
 *
 * The converter needs a DOM, so it runs bundled inside Chrome on CDP :9222 —
 * the same harness `test/browser.e2e.test.ts` uses, imported rather than copied.
 */
import CDPraw from "chrome-remote-interface";
import { build, transformSync } from "esbuild";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { slides_v1 } from "googleapis";
import type { CdpModule } from "../../../../types/cdp-types.ts";
import type { SlidesApiRequest } from "../slides-api.js";
import { applyBatch, googleDrive, kindOf, slidesClient } from "./slides-client.js";
import type { SlidesClient } from "./slides-client.js";

// chrome-remote-interface ships no .d.ts; its default export is `unknown` in
// types/ambient.d.ts. Narrowed once here, as the browser e2e test does.
const CDP = CDPraw as CdpModule;

const CDP_PORT = 9222;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const BASIC_FIXTURES = join(REPO_ROOT, "renderer/html2slides/e2e/fixtures-basic");
const OWN_FIXTURES = join(HERE, "../test/fixtures");
const HOST_PAGE = join(OWN_FIXTURES, "host.html");

/** 2 CSS px at 7143.75 EMU/px — the tolerance CLAUDE.md's measurements justify. */
const GEOMETRY_TOLERANCE_EMU = 2 * 7143.75;

type Rejection = Readonly<{
  fixture: string;
  kind: string;
  fields: string | null;
  message: string;
  status: number | null;
}>;

type GeometryDelta = Readonly<{
  objectId: string;
  kind: string;
  dxEmu: number;
  dyEmu: number;
  dWidthEmu: number;
  dHeightEmu: number;
}>;

type FixtureResult = Readonly<{
  fixture: string;
  pageObjectId: string;
  requestCount: number;
  kinds: Readonly<Record<string, number>>;
  acceptedKinds: readonly string[];
  rejections: readonly Rejection[];
  droppedCount: number;
  applied: boolean;
  worstDeltas: readonly GeometryDelta[];
  missingFromReadback: readonly string[];
  unsupportedKinds: readonly string[];
}>;

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "create":
      return create();
    case "run":
      return run();
    case "bullets":
      return bullets();
    case "audit":
      return audit();
    case "dump":
      return dump();
    case "probe":
      return probe();
    case "tablegeom":
      return tableGeometry();
    case "report":
      return report();
    case "drop":
      return drop();
    default:
      throw new Error(`unknown command ${String(command)}; want create|run|audit|dump|probe|tablegeom|bullets|report|drop`);
  }
}

function argAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? null;
}

function required(flag: string): string {
  const value = argAfter(flag);
  if (value === null) throw new Error(`${flag} is required`);
  return value;
}

async function create(): Promise<void> {
  const client = slidesClient();
  const created = await client.slides.presentations.create({
    requestBody: { title: `sasha-converter-roundtrip-${Date.now()}` },
  });
  const presentationId = created.data.presentationId;
  if (typeof presentationId !== "string") throw new Error("presentations.create returned no id");
  console.log(presentationId);
}

async function drop(): Promise<void> {
  const presentationId = required("--presentation");
  await slidesClient().deletePresentation(presentationId);
  console.log(`deleted ${presentationId}`);
}

/**
 * Prove nothing was left in Drive. Every presentation these scripts create is
 * named `sasha-<something>-<timestamp>`, so this lists any that survive, live or
 * trashed — `drive.files.delete` is a permanent delete, not a trash, so a name
 * showing up in the trash listing would mean something else removed it.
 */
async function audit(): Promise<void> {
  const drive = googleDrive();
  for (const trashed of [false, true]) {
    const response = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.presentation' and trashed=${String(trashed)}`,
      fields: "files(id,name,createdTime)",
      orderBy: "createdTime desc",
      pageSize: 100,
    });
    const files = response.data.files ?? [];
    const ours = files.filter((file) => /^sasha-(inset-calibration|converter-roundtrip|auth-probe)-\d+$/.test(file.name ?? ""));
    console.log(`${trashed ? "trashed" : "live"} presentations: ${files.length} total, ${ours.length} from these scripts`);
    for (const file of ours) console.log(`  LEFTOVER ${file.id ?? "?"} ${file.name ?? "?"}`);
  }
}

function fixtureList(): readonly Readonly<{ dir: string; name: string }>[] {
  const spec = required("--fixtures");
  if (spec === "all-basic") {
    return readdirSync(BASIC_FIXTURES)
      .filter((name) => name.endsWith(".html"))
      .sort()
      .map((name) => ({ dir: BASIC_FIXTURES, name }));
  }
  if (spec === "all-own") {
    return readdirSync(OWN_FIXTURES)
      .filter((name) => name.endsWith(".html") && name !== "host.html")
      .sort()
      .map((name) => ({ dir: OWN_FIXTURES, name }));
  }
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((name) => ({ dir: existsSync(join(BASIC_FIXTURES, name)) ? BASIC_FIXTURES : OWN_FIXTURES, name }));
}

/**
 * Convert fixtures and write the raw requests out without touching the API —
 * what the geometry comparison needs in order to say what the converter ASKED
 * for, next to what `tablegeom` reads back.
 */
async function dump(): Promise<void> {
  const outPath = required("--out");
  const fixtures = fixtureList();
  const browser = await openConverter();
  try {
    const dumped: Record<string, readonly SlidesApiRequest[]> = {};
    for (const fixture of fixtures) {
      const conversion = await convertInPage({
        page: browser.page,
        html: readFileSync(join(fixture.dir, fixture.name), "utf-8"),
        name: fixture.name,
        pageObjectId: "p1",
        presentationId: "dump",
      });
      dumped[fixture.name] = conversion.requests;
      console.log(`${fixture.name}: ${conversion.requests.length} requests`);
    }
    writeFileSync(outPath, JSON.stringify(dumped, null, 2));
  } finally {
    await browser.close();
  }
}

type Browser = Readonly<{ page: Awaited<ReturnType<CdpModule>>; close: () => Promise<void> }>;

/** Bundle the converter as the extension will, inject it, hand back the tab. */
async function openConverter(): Promise<Browser> {
  const extractorScript = transformSync(
    readFileSync(join(REPO_ROOT, "renderer/html2slides/extract-dom.ts"), "utf-8"),
    { loader: "ts", target: "es2020" },
  ).code;
  const bundled = await build({
    entryPoints: [join(HERE, "../index.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "SashaConverter",
    platform: "browser",
    target: "es2020",
    logLevel: "silent",
  });
  const converterBundle = bundled.outputFiles[0]?.text ?? "";
  if (converterBundle.length === 0) throw new Error("converter bundle is empty");
  const tab = await CDP.New({ port: CDP_PORT, url: `file://${HOST_PAGE}` });
  const page = await CDP({ target: tab, port: CDP_PORT });
  await page.Page.enable();
  await page.Runtime.enable();
  await waitForReady(page);
  await evaluate(page, converterBundle, false);
  await evaluate(page, `window.__EXTRACTOR__ = ${JSON.stringify(extractorScript)}; true`, false);
  return {
    page,
    close: async (): Promise<void> => {
      await page.close();
      await CDP.Close({ port: CDP_PORT, id: tab.id });
    },
  };
}

async function run(): Promise<void> {
  const presentationId = required("--presentation");
  const outPath = required("--out");
  const fixtures = fixtureList();
  const client = slidesClient();

  const browser = await openConverter();
  const results: FixtureResult[] = [];
  try {
    for (const fixture of fixtures) {
      results.push(
        await oneFixture({
          client,
          presentationId,
          page: browser.page,
          html: readFileSync(join(fixture.dir, fixture.name), "utf-8"),
          name: fixture.name,
        }),
      );
    }
  } finally {
    await browser.close();
  }

  const previous: FixtureResult[] = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf-8")) as FixtureResult[])
    : [];
  const names = new Set(results.map((entry) => entry.fixture));
  writeFileSync(outPath, JSON.stringify([...previous.filter((entry) => !names.has(entry.fixture)), ...results], null, 2));
  for (const entry of results) printFixture(entry);
}

async function oneFixture(
  options: Readonly<{
    client: SlidesClient;
    presentationId: string;
    page: Awaited<ReturnType<CdpModule>>;
    html: string;
    name: string;
  }>,
): Promise<FixtureResult> {
  const { client, presentationId, page, html, name } = options;
  const slug = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);
  const pageObjectId = `s${slug}`;
  const scaffolding: slides_v1.Schema$Request[] = [
    { createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } },
  ];
  await client.slides.presentations.batchUpdate({ presentationId, requestBody: { requests: scaffolding } });

  const conversion = await convertInPage({ page, html, name, pageObjectId, presentationId });
  const kinds: Record<string, number> = {};
  for (const request of conversion.requests) kinds[kindOf(request)] = (kinds[kindOf(request)] ?? 0) + 1;

  const submission = await applyWithDrops({ client, presentationId, requests: conversion.requests, fixture: name });
  const readback = submission.applied
    ? await readGeometry({ client, presentationId, pageObjectId })
    : new Map<string, ReadElement>();
  const comparison = compareGeometry({ requests: submission.survivors, readback });

  return {
    fixture: name,
    pageObjectId,
    requestCount: conversion.requests.length,
    kinds,
    acceptedKinds: [...new Set(submission.survivors.map(kindOf))].sort(),
    rejections: submission.rejections,
    droppedCount: conversion.requests.length - submission.survivors.length,
    applied: submission.applied,
    worstDeltas: comparison.worst,
    missingFromReadback: comparison.missing,
    unsupportedKinds: [...new Set(conversion.unsupported.map((entry) => entry.kind))].sort(),
  };
}

/**
 * `batchUpdate` is atomic, so a single bad request hides every other verdict in
 * the batch. The API names the offending index, so dropping it and resubmitting
 * walks the whole batch and ends with the maximal accepted subset plus one
 * recorded rejection per failure.
 */
async function applyWithDrops(
  options: Readonly<{
    client: SlidesClient;
    presentationId: string;
    requests: readonly SlidesApiRequest[];
    fixture: string;
  }>,
): Promise<Readonly<{ applied: boolean; survivors: readonly SlidesApiRequest[]; rejections: readonly Rejection[] }>> {
  const { client, presentationId, fixture } = options;
  let survivors = [...options.requests];
  const rejections: Rejection[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    if (survivors.length === 0) return { applied: true, survivors, rejections };
    const outcome = await applyBatch({ client, presentationId, requests: survivors });
    if (outcome.ok) return { applied: true, survivors, rejections };
    const { failure } = outcome;
    const index = failure.requestIndex;
    if (index === null || index < 0 || index >= survivors.length) {
      rejections.push({ fixture, kind: "<whole batch>", fields: null, message: failure.message, status: failure.status });
      return { applied: false, survivors, rejections };
    }
    // SAFETY: index was just bounds-checked against survivors.length.
    const offender = survivors[index]!;
    const body = Object.values(offender)[0];
    const fields =
      typeof body === "object" && body !== null && typeof (body as Record<string, unknown>)["fields"] === "string"
        ? String((body as Record<string, unknown>)["fields"])
        : null;
    rejections.push({ fixture, kind: kindOf(offender), fields, message: failure.message, status: failure.status });
    survivors = [...survivors.slice(0, index), ...survivors.slice(index + 1)];
  }
  return { applied: false, survivors, rejections };
}

type ReadElement = Readonly<{
  translateX: number;
  translateY: number;
  width: number;
  height: number;
}>;

async function readGeometry(
  options: Readonly<{ client: SlidesClient; presentationId: string; pageObjectId: string }>,
): Promise<Map<string, ReadElement>> {
  const response = await options.client.slides.presentations.pages.get({
    presentationId: options.presentationId,
    pageObjectId: options.pageObjectId,
    fields: "pageElements(objectId,size,transform,table(tableRows(rowHeight),tableColumns(columnWidth)))",
  });
  const out = new Map<string, ReadElement>();
  for (const element of response.data.pageElements ?? []) {
    const objectId = element.objectId;
    const transform = element.transform;
    if (typeof objectId !== "string" || transform === undefined || transform === null) continue;
    const table = element.table;
    if (table !== undefined && table !== null) {
      // A table's `size` is NOT its extent. Slides stores a canonical
      // 3000000 x 3000000 EMU box for every table (measured: see the project
      // report) and derives the real extent from the rows and columns, so the
      // only honest readback is the sum of those.
      out.set(objectId, {
        translateX: transform.translateX ?? 0,
        translateY: transform.translateY ?? 0,
        width: (table.tableColumns ?? []).reduce((total, column) => total + (column.columnWidth?.magnitude ?? 0), 0),
        height: (table.tableRows ?? []).reduce((total, row) => total + (row.rowHeight?.magnitude ?? 0), 0),
      });
      continue;
    }
    out.set(objectId, {
      translateX: transform.translateX ?? 0,
      translateY: transform.translateY ?? 0,
      // `size` is the element's own coordinate-space extent; the rendered extent
      // is size x scale, which is what the converter's `placeBox` intends.
      //
      // An ABSENT scale means 0, not 1: the API speaks proto3 JSON, which omits
      // a double at its default. This is not pedantry — Slides rewrites every
      // `createLine` to a canonical 3000000 x 3000000 EMU box and puts the real
      // extent in the scales, so a vertical edge line comes back with scaleY
      // 0.4286 and NO scaleX. Reading that as 1 makes it look like Google
      // replaced a hairline with a 420 px diagonal; it did not (verified on the
      // rendered thumbnail of slide_04_border_partial: three axis-aligned
      // hairlines, no diagonal anywhere).
      width: (element.size?.width?.magnitude ?? 0) * (transform.scaleX ?? 0),
      height: (element.size?.height?.magnitude ?? 0) * (transform.scaleY ?? 0),
    });
  }
  return out;
}

const CREATE_KINDS: ReadonlySet<string> = new Set(["createShape", "createLine", "createImage", "createTable"]);

function compareGeometry(
  options: Readonly<{ requests: readonly SlidesApiRequest[]; readback: ReadonlyMap<string, ReadElement> }>,
): Readonly<{ worst: readonly GeometryDelta[]; missing: readonly string[] }> {
  const { requests, readback } = options;
  const deltas: GeometryDelta[] = [];
  const missing: string[] = [];
  for (const request of requests) {
    const kind = kindOf(request);
    if (!CREATE_KINDS.has(kind)) continue;
    const body = Object.values(request)[0] as Readonly<{
      objectId?: unknown;
      elementProperties?: Readonly<{
        size?: Readonly<{ width?: { magnitude?: number }; height?: { magnitude?: number } }>;
        transform?: Readonly<{ translateX?: number; translateY?: number; scaleX?: number; scaleY?: number }>;
      }>;
    }>;
    const objectId = body.objectId;
    if (typeof objectId !== "string") continue;
    const actual = readback.get(objectId);
    if (actual === undefined) {
      missing.push(objectId);
      continue;
    }
    // Same proto3 reading as the readback above; the converter always writes
    // both scales explicitly, so this default never actually fires.
    const intendedWidth =
      kind === "createTable"
        ? tableSpecTotal({ requests, objectId, kind: "column" })
        : (body.elementProperties?.size?.width?.magnitude ?? 0) * (body.elementProperties?.transform?.scaleX ?? 0);
    const intendedHeight =
      kind === "createTable"
        ? tableSpecTotal({ requests, objectId, kind: "row" })
        : (body.elementProperties?.size?.height?.magnitude ?? 0) * (body.elementProperties?.transform?.scaleY ?? 0);
    deltas.push({
      objectId,
      kind,
      dxEmu: Math.round(actual.translateX - (body.elementProperties?.transform?.translateX ?? 0)),
      dyEmu: Math.round(actual.translateY - (body.elementProperties?.transform?.translateY ?? 0)),
      dWidthEmu: Math.round(actual.width - intendedWidth),
      dHeightEmu: Math.round(actual.height - intendedHeight),
    });
  }
  const magnitude = (delta: GeometryDelta): number =>
    Math.max(Math.abs(delta.dxEmu), Math.abs(delta.dyEmu), Math.abs(delta.dWidthEmu), Math.abs(delta.dHeightEmu));
  return {
    worst: [...deltas].sort((left, right) => magnitude(right) - magnitude(left)).slice(0, 4),
    missing,
  };
}


/**
 * The extent a table was actually ASKED for: the sum of the per-column widths
 * and per-row minimum heights the same batch sets, not `createTable`'s advisory
 * `elementProperties.size`, which Slides discards. A row height is a FLOOR, so a
 * positive height delta here is Slides growing a row for its content — which is
 * a finding, not an error.
 */
function tableSpecTotal(
  options: Readonly<{ requests: readonly SlidesApiRequest[]; objectId: string; kind: "column" | "row" }>,
): number {
  const { requests, objectId, kind } = options;
  let total = 0;
  for (const request of requests) {
    if (kind === "column" && "updateTableColumnProperties" in request) {
      const body = request.updateTableColumnProperties;
      if (body.objectId !== objectId) continue;
      total += body.tableColumnProperties.columnWidth.magnitude * body.columnIndices.length;
    }
    if (kind === "row" && "updateTableRowProperties" in request) {
      const body = request.updateTableRowProperties;
      if (body.objectId !== objectId) continue;
      total += body.tableRowProperties.minRowHeight.magnitude * body.rowIndices.length;
    }
  }
  return total;
}

function printFixture(result: FixtureResult): void {
  const worst = result.worstDeltas[0];
  const worstMagnitude =
    worst === undefined
      ? 0
      : Math.max(Math.abs(worst.dxEmu), Math.abs(worst.dyEmu), Math.abs(worst.dWidthEmu), Math.abs(worst.dHeightEmu));
  const verdict = !result.applied
    ? "BATCH FAILED"
    : result.rejections.length > 0
      ? `${result.rejections.length} rejected`
      : "all accepted";
  console.log(
    `${result.fixture.padEnd(34)} ${String(result.requestCount).padStart(4)} req  ${verdict.padEnd(14)} ` +
      `worst geometry delta ${(worstMagnitude / 7143.75).toFixed(2)} px` +
      (worstMagnitude > GEOMETRY_TOLERANCE_EMU ? "  <-- over tolerance" : ""),
  );
  for (const rejection of result.rejections) {
    console.log(`    REJECTED ${rejection.kind}${rejection.fields === null ? "" : ` [${rejection.fields}]`}`);
    console.log(`      ${rejection.message}`);
  }
  if (result.missingFromReadback.length > 0) {
    console.log(`    not present in readback: ${result.missingFromReadback.join(", ")}`);
  }
  for (const delta of result.worstDeltas) {
    console.log(
      `    ${delta.kind} ${delta.objectId}: dx ${delta.dxEmu} dy ${delta.dyEmu} ` +
        `dw ${delta.dWidthEmu} dh ${delta.dHeightEmu} EMU`,
    );
  }
}

function report(): void {
  const outPath = required("--out");
  const results = JSON.parse(readFileSync(outPath, "utf-8")) as FixtureResult[];
  const emitted = new Map<string, number>();
  const accepted = new Set<string>();
  const rejected = new Map<string, Rejection>();
  for (const result of results) {
    for (const [kind, count] of Object.entries(result.kinds)) emitted.set(kind, (emitted.get(kind) ?? 0) + count);
    for (const kind of result.acceptedKinds) accepted.add(kind);
    for (const rejection of result.rejections) if (!rejected.has(rejection.kind)) rejected.set(rejection.kind, rejection);
  }
  console.log(`fixtures: ${results.length}; total requests emitted: ${[...emitted.values()].reduce((a, b) => a + b, 0)}`);
  console.log("\nrequest type                        emitted  verdict");
  for (const [kind, count] of [...emitted.entries()].sort()) {
    const rejection = rejected.get(kind);
    const verdict = rejection === undefined ? (accepted.has(kind) ? "ACCEPTED" : "never submitted") : "REJECTED";
    console.log(`  ${kind.padEnd(34)} ${String(count).padStart(5)}  ${verdict}`);
    if (rejection !== undefined) console.log(`      ${rejection.message}`);
  }
  let worstMagnitude = 0;
  let worstLabel = "";
  for (const result of results) {
    for (const delta of result.worstDeltas) {
      const magnitude = Math.max(
        Math.abs(delta.dxEmu), Math.abs(delta.dyEmu), Math.abs(delta.dWidthEmu), Math.abs(delta.dHeightEmu),
      );
      if (magnitude <= worstMagnitude) continue;
      worstMagnitude = magnitude;
      worstLabel = `${result.fixture} ${delta.kind} ${delta.objectId} (dx ${delta.dxEmu} dy ${delta.dyEmu} dw ${delta.dWidthEmu} dh ${delta.dHeightEmu})`;
    }
  }
  console.log(`\nworst geometry delta across all fixtures: ${(worstMagnitude / 7143.75).toFixed(2)} px — ${worstLabel}`);
  const failed = results.filter((result) => !result.applied).map((result) => result.fixture);
  console.log(`fixtures whose batch could not be applied at all: ${failed.length === 0 ? "none" : failed.join(", ")}`);
}


/**
 * The two request types no fixture reaches: `createImage` with a URL that
 * actually exists (the `img_http` fixture points at example.com on purpose, so
 * its rejection says nothing about the request shape) and `mergeTableCells`.
 *
 * Each goes in its OWN batchUpdate, because an atomic batch would let one
 * rejection mask the other's verdict.
 */
async function probe(): Promise<void> {
  const presentationId = required("--presentation");
  const client = slidesClient();
  const pageObjectId = "apiProbe";
  await client.slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [{ createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } }],
    },
  });

  const place = (translateX: number, translateY: number, width: number, height: number) => ({
    pageObjectId,
    size: { width: { magnitude: width, unit: "EMU" as const }, height: { magnitude: height, unit: "EMU" as const } },
    transform: { scaleX: 1, scaleY: 1, translateX, translateY, unit: "EMU" as const },
  });

  const steps: readonly Readonly<{ label: string; requests: readonly SlidesApiRequest[] }>[] = [
    {
      label: "createImage (publicly fetchable https URL)",
      requests: [
        {
          createImage: {
            objectId: "probeImage",
            url: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png",
            elementProperties: place(400000, 400000, 2440000, 825000),
          },
        },
      ],
    },
    {
      label: "createTable for the merge probe",
      requests: [{ createTable: { objectId: "probeTable", elementProperties: place(400000, 1600000, 4000000, 1200000), rows: 3, columns: 3 } }],
    },
    {
      label: "mergeTableCells (2x2 at 0,0)",
      requests: [
        { mergeTableCells: { objectId: "probeTable", tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 2, columnSpan: 2 } } },
      ],
    },
  ];

  for (const step of steps) {
    const outcome = await applyBatch({ client, presentationId, requests: step.requests });
    console.log(
      `${step.label.padEnd(44)} ${outcome.ok ? "ACCEPTED" : `REJECTED (${outcome.failure.status ?? "?"}) — ${outcome.failure.message}`}`,
    );
  }
}

/**
 * The per-fixture comparison flags `createTable` as hundreds of px off, but
 * `createTable.elementProperties.size` is ADVISORY: Slides derives the table's
 * extent from its rows and columns, which the converter then sets with
 * `updateTableColumn/RowProperties`. So the question that matters is whether
 * those land, not whether the advisory size did. This prints both.
 */
async function tableGeometry(): Promise<void> {
  const presentationId = required("--presentation");
  const pageObjectId = required("--page");
  const client = slidesClient();
  const response = await client.slides.presentations.pages.get({
    presentationId,
    pageObjectId,
    fields: "pageElements(objectId,size,transform,table(rows,columns,tableRows(rowHeight),tableColumns(columnWidth)))",
  });
  for (const element of response.data.pageElements ?? []) {
    const table = element.table;
    if (table === undefined || table === null) continue;
    const columns = (table.tableColumns ?? []).map((column) => column.columnWidth?.magnitude ?? 0);
    const rows = (table.tableRows ?? []).map((row) => row.rowHeight?.magnitude ?? 0);
    const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
    console.log(`${element.objectId ?? "?"}  ${table.rows ?? 0}x${table.columns ?? 0}`);
    console.log(`  advisory size      ${element.size?.width?.magnitude ?? 0} x ${element.size?.height?.magnitude ?? 0} EMU`);
    console.log(`  sum(columnWidth)   ${sum(columns)} EMU   cols ${columns.join(", ")}`);
    console.log(`  sum(rowHeight)     ${sum(rows)} EMU   rows ${rows.join(", ")}`);
  }
}

/**
 * Does `createParagraphBullets` strip the leading tabs, and does that shift the
 * indices of text styled earlier in the same batch?
 *
 * Two shapes with identical text and identical FIXED_RANGE styling, differing
 * only in whether the bullets request comes before or after the styling.
 *
 * The styled range has to be chosen so the two orderings CANNOT agree by
 * accident. Text is `AAAA\n\t\tBBBB\nCCCC`: two tabs, so stripping shifts the
 * nested paragraph's body two characters earlier. Styling [7,9) selects the
 * FIRST two Bs before the strip and the LAST two Bs after it, so the readback
 * says unambiguously which coordinate space the API applied the range in.
 */
async function bullets(): Promise<void> {
  const presentationId = required("--presentation");
  const outPath = argAfter("--out");
  const client = slidesClient();
  const pageObjectId = "bulletProbe2";
  await client.slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [{ createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } }],
    },
  });

  // Three paragraphs, the middle one nested two levels, exactly as emitList
  // emits them — the index arithmetic in emitList counts the tabs.
  const text = "AAAA\n\t\tBBBB\nCCCC";
  // Pre-strip  "AAAA\n\t\tBBBB\nCCCC": [7,9) is the first two Bs.
  // Post-strip "AAAA\nBBBB\nCCCC":     [7,9) is the last two Bs.
  const redRange = { type: "FIXED_RANGE", startIndex: 7, endIndex: 9 } as const;
  const probes = [
    { objectId: "bulletsLast2", bulletsFirst: false, top: 600000 },
    { objectId: "bulletsFirst2", bulletsFirst: true, top: 2600000 },
  ] as const;

  for (const probe of probes) {
    const styling: readonly SlidesApiRequest[] = [
      {
        updateTextStyle: {
          objectId: probe.objectId,
          textRange: redRange,
          style: { foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 0, blue: 0 } } } },
          fields: "foregroundColor",
        },
      },
    ];
    const bulletRequest: readonly SlidesApiRequest[] = [
      {
        createParagraphBullets: {
          objectId: probe.objectId,
          textRange: { type: "ALL" },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      },
    ];
    const requests: readonly SlidesApiRequest[] = [
      {
        createShape: {
          objectId: probe.objectId,
          shapeType: "TEXT_BOX",
          elementProperties: {
            pageObjectId,
            size: { width: { magnitude: 4000000, unit: "EMU" }, height: { magnitude: 1800000, unit: "EMU" } },
            transform: { scaleX: 1, scaleY: 1, translateX: 500000, translateY: probe.top, unit: "EMU" },
          },
        },
      },
      { insertText: { objectId: probe.objectId, text, insertionIndex: 0 } },
      ...(probe.bulletsFirst ? [...bulletRequest, ...styling] : [...styling, ...bulletRequest]),
    ];
    const outcome = await applyBatch({ client, presentationId, requests });
    console.log(`${probe.objectId}: ${outcome.ok ? "accepted" : `REJECTED — ${outcome.failure.message}`}`);
  }

  const readback = await client.slides.presentations.pages.get({
    presentationId,
    pageObjectId,
    fields: "pageElements(objectId,shape(text(textElements(startIndex,endIndex,textRun(content,style(foregroundColor)),paragraphMarker(bullet(listId,nestingLevel,glyph))))))",
  });
  const summary = (readback.data.pageElements ?? []).map((element) => ({
    objectId: element.objectId ?? "<none>",
    textElements: (element.shape?.text?.textElements ?? []).map((entry) => ({
      startIndex: entry.startIndex ?? 0,
      endIndex: entry.endIndex ?? 0,
      content: entry.textRun?.content ?? null,
      red: entry.textRun?.style?.foregroundColor?.opaqueColor?.rgbColor?.red ?? null,
      bulletGlyph: entry.paragraphMarker?.bullet?.glyph ?? null,
      nestingLevel: entry.paragraphMarker?.bullet?.nestingLevel ?? null,
    })),
  }));
  console.log(JSON.stringify(summary, null, 2));
  if (outPath !== null) writeFileSync(outPath, JSON.stringify(summary, null, 2));
}

type Conversion = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly Readonly<{ kind: string }>[];
}>;

async function convertInPage(
  options: Readonly<{
    page: Awaited<ReturnType<CdpModule>>;
    html: string;
    name: string;
    pageObjectId: string;
    presentationId: string;
  }>,
): Promise<Conversion> {
  const expression = `(async () => {
    const result = await SashaConverter.convertHtmlToSlideRequests({
      html: ${JSON.stringify(options.html)},
      presentationId: ${JSON.stringify(options.presentationId)},
      pageObjectId: ${JSON.stringify(options.pageObjectId)},
      extractorScript: window.__EXTRACTOR__,
      container: document.body,
      objectIdPrefix: ${JSON.stringify(options.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16))},
    });
    return JSON.stringify({ requests: result.requests, unsupported: result.unsupported });
  })()`;
  const raw = await evaluate(options.page, expression, true);
  if (typeof raw !== "string") throw new Error(`conversion of ${options.name} returned ${typeof raw}`);
  return JSON.parse(raw) as Conversion;
}

async function evaluate(
  page: Awaited<ReturnType<CdpModule>>,
  expression: string,
  awaitPromise: boolean,
): Promise<unknown> {
  const response = await page.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  const thrown = response.exceptionDetails as
    | Readonly<{ text?: string; exception?: Readonly<{ description?: string }> }>
    | undefined
    | null;
  if (thrown !== undefined && thrown !== null) {
    throw new Error(`page threw: ${thrown.exception?.description ?? thrown.text ?? "<no detail>"}`);
  }
  return response.result.value;
}

/** Poll for the static host page rather than sleeping on it. */
async function waitForReady(page: Awaited<ReturnType<CdpModule>>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await evaluate(page, "document.readyState + '|' + !!document.body", false);
    if (state === "complete|true") return;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error("host page did not become ready within 5s");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
