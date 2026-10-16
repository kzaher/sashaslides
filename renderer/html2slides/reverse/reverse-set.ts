/**
 * One set of the reverse round trip, end to end: presentation -> Google thumbnails -> Sasha import
 * -> exported pages -> screenshots -> metrics, written into the set's results directory
 * (reverse-results.ts).
 *
 * RESUMABLE AND QUOTA-AWARE. What costs quota or minutes is cached on disk and reused while the
 * presentation id is unchanged: the forward upload (its id in state.json), Google's thumbnails
 * (state.json lists the ones fetched, written after each one), and the fixture screenshots. What
 * is cheap and is the thing being debugged -- the import, the export and their screenshots -- runs
 * every time, so a fix to the importer or the exporter shows up on the next run without
 * re-uploading anything.
 *
 * SLIDE N IS FIXTURE N. convert-pptx.ts writes one slide per fixture in file-name order, so the
 * presentation's slides pair with the sorted fixture files by position; a count mismatch is
 * reported in every affected row's notes instead of being guessed around.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { renderSlideHtml } from "../../../mcp/sasha-slides/engine/src/export/slide-html.ts";
import type { AssetId } from "../../../mcp/sasha-slides/engine/src/contracts/ids.ts";
import { parsePresentation, type SlidesPresentation } from "../../../mcp/sasha-slides/google-slides/slides-presentation.ts";
import type { ChromeTab } from "./chrome-capture.ts";
import { uploadFixturesForward } from "./forward-upload.ts";
import { slideTextsOf } from "./google-slide-text.ts";
import type { GoogleSlidesSource } from "./google-slides-source.ts";
import { compareImages, matchText, type RgbaImage, type TextMatch } from "./reverse-metrics.ts";
import {
  reverseGoldensDirectory,
  roundTripGoldensDirectory,
  setLayoutOf,
  slideFileId,
  type ReverseSet,
  type SetLayout,
  type SetState,
  type SlideMetrics,
} from "./reverse-results.ts";
import { cachingPictureFetch } from "./picture-cache.ts";
import { importIntoSashaDocument, type SashaImport } from "./sasha-import.ts";

/** Where a set's presentation comes from. */
export type SetSource =
  | Readonly<{ kind: "fixtures"; fixtureDirectory: string; givenPresentationId: string | null; recordedPresentationId: string | null; freshUpload: boolean }>
  | Readonly<{ kind: "presentation"; presentationId: string }>;

export type SetRunOptions = Readonly<{
  set: ReverseSet;
  source: SetSource;
  outputRoot: string;
  /** renderer/html2slides: where convert-pptx.ts runs and the goldens directories are named from. */
  converterDirectory: string;
  /** Scratch for the forward .pptx and logs. */
  workDirectory: string;
  refreshThumbnails: boolean;
  refreshFixtureShots: boolean;
  /**
   * Re-measure from the set's recordings only (google is then createRecordedGoogleSlidesSource):
   * no upload, no thumbnail download, pictures from the picture cache, and the recorded .pptx
   * export is left as it is on disk.
   */
  offline: boolean;
  /**
   * The slide file ids (`slide_NN`) to export, screenshot and measure; null means every slide.
   * The bug_solving reverse direction re-renders only a cluster's slides per attempt, so the
   * import still reads the whole presentation (slide ids and assets depend on it) but the
   * per-slide work is skipped, and metrics.json keeps the other slides' earlier rows.
   */
  onlySlides: ReadonlySet<string> | null;
  google: GoogleSlidesSource;
  chrome: ChromeTab;
  now: () => number;
  log: (line: string) => void;
}>;

export async function runReverseSet(options: SetRunOptions): Promise<readonly SlideMetrics[]> {
  const layout = setLayoutOf({ outputRoot: options.outputRoot, set: options.set });
  for (const directory of [layout.originals, layout.slides, layout.diffs, layout.html, layout.importDirectory]) mkdirSync(directory, { recursive: true });
  const fixtureFiles = fixtureFilesOf(options.source);
  if (fixtureFiles.length > 0) for (const directory of [layout.roundTrip.originals, layout.roundTrip.slides, layout.roundTrip.diffs]) mkdirSync(directory, { recursive: true });

  let state = await presentationStateFor({ options, layout });
  writeJson(layout.statePath, state);
  options.log(`[${options.set}] presentation ${state.presentationId} (${state.source})`);

  const presentationAnswer = await options.google.readPresentation(state.presentationId);
  const parsed = parsePresentation(presentationAnswer);
  if (parsed.kind === "invalid") throw new Error(`[${options.set}] the presentation did not parse: ${parsed.message}`);
  const presentation = parsed.presentation;
  const slideCount = presentation.slides.length;
  const pairingNote = fixtureFiles.length > 0 && fixtureFiles.length !== slideCount ? `${fixtureFiles.length} fixtures but ${slideCount} slides: paired by position` : null;
  if (pairingNote !== null) options.log(`[${options.set}] WARNING ${pairingNote}`);

  state = await downloadThumbnails({ options, layout, presentation, state });

  const pptxExport = await pptxExportOf({ options, presentationId: state.presentationId });
  if (pptxExport !== null && !options.offline) writeFileSync(join(layout.importDirectory, "presentation.pptx"), pptxExport);
  options.log(`[${options.set}] importing ${slideCount} slides into a Sasha document`);
  const imported = await importIntoSashaDocument({
    presentationAnswer,
    accessToken: await options.google.accessToken(),
    pptxExport,
    fetch: cachingPictureFetch({ directory: join(layout.importDirectory, "pictures"), mode: options.offline ? "offline" : "online", fetch }),
    idSeedToken: `reverse${options.set}`,
    now: options.now,
  });
  // The raw answer too: diagnosing a lossy slide starts from what Google actually sent.
  writeJson(join(layout.importDirectory, "presentation.json"), presentationAnswer);
  writeJson(join(layout.importDirectory, "snapshot.json"), imported.snapshot);
  writeJson(join(layout.importDirectory, "losses.json"), imported.losses);
  if (imported.snapshot.slides.length !== slideCount) {
    throw new Error(`[${options.set}] the import made ${imported.snapshot.slides.length} slides from ${slideCount}`);
  }

  const googleTexts = slideTextsOf(presentation);
  const fixtureTexts = fixtureFiles.length > 0 ? await shootFixtures({ options, layout, fixtureFiles }) : new Map<string, string>();
  const assetAddress = dataAddresses(imported);
  const rows: SlideMetrics[] = [];
  for (let index = 0; index < slideCount; index++) {
    const slideNumber = index + 1;
    const fileId = slideFileId(slideNumber);
    if (options.onlySlides !== null && !options.onlySlides.has(fileId)) continue;
    const googleSlide = presentation.slides[index];
    const sashaSlide = imported.snapshot.slides[index];
    if (googleSlide === undefined || sashaSlide === undefined) throw new Error(`[${options.set}] slide ${slideNumber} is missing on one side`);
    const html = renderSlideHtml({ snapshot: imported.snapshot, slideId: sashaSlide.id, assetAddress });
    const htmlPath = join(layout.html, `${fileId}.html`);
    writeFileSync(htmlPath, html);
    const capture = await options.chrome.capture({ address: pathToFileURL(htmlPath).href });
    const sashaPath = join(layout.slides, `${fileId}.png`);
    writeFileSync(sashaPath, capture.png);
    const sashaImage = readPng(sashaPath);

    const notes: string[] = [];
    if (pairingNote !== null) notes.push(pairingNote);
    if (capture.readiness === "timedOut") notes.push("the Sasha page never reported ready; captured anyway");
    if (sashaSlide.skipped) notes.push("skipped slide");
    const lossFeatures = [...new Set(imported.losses.filter((loss) => loss.slideId === sashaSlide.id).map((loss) => loss.feature))];
    if (lossFeatures.length > 0) notes.push(`import losses: ${lossFeatures.join(", ")}`);

    const thumbnailPath = join(layout.originals, `${fileId}.png`);
    const thumbnail = existsSync(thumbnailPath) ? readPng(thumbnailPath) : null;
    const reverse = thumbnail === null ? null : compareImages({ expected: thumbnail, actual: sashaImage });
    if (reverse !== null) writePng(join(layout.diffs, `diff_${fileId}.png`), reverse.diffImage);
    else notes.push("no Google thumbnail");
    const reverseText = matchText({ expected: googleTexts.get(googleSlide.objectId) ?? "", actual: capture.text });
    notes.push(...wordNotes({ label: "vs Google", match: reverseText }));

    const fixtureFile = fixtureFiles[index];
    let roundTripMismatchPercent: number | null = null;
    let forwardMismatchPercent: number | null = null;
    let roundTripTextMatch: number | null = null;
    if (fixtureFile !== undefined) {
      const fixtureShot = readPng(join(layout.roundTrip.originals, `${fileId}.png`));
      copyFileSync(sashaPath, join(layout.roundTrip.slides, `${fileId}.png`));
      const roundTrip = compareImages({ expected: fixtureShot, actual: sashaImage });
      writePng(join(layout.roundTrip.diffs, `diff_${fileId}.png`), roundTrip.diffImage);
      roundTripMismatchPercent = roundTrip.mismatchPercent;
      if (thumbnail !== null) forwardMismatchPercent = compareImages({ expected: fixtureShot, actual: thumbnail }).mismatchPercent;
      const fixtureText = matchText({ expected: fixtureTexts.get(fixtureFile) ?? "", actual: capture.text });
      roundTripTextMatch = fixtureText.score;
      notes.push(...wordNotes({ label: "vs fixture", match: fixtureText }));
    }
    rows.push({
      caseId: fixtureFile === undefined ? `${options.set}-${fileId}` : basename(fixtureFile, ".html"),
      set: options.set,
      slideNumber,
      reverseMismatchPercent: reverse?.mismatchPercent ?? null,
      roundTripMismatchPercent,
      textMatch: reverseText.score,
      notes: notes.join("; "),
      forwardMismatchPercent,
      roundTripTextMatch,
      googleSlideObjectId: googleSlide.objectId,
      slideId: fileId,
      presentationId: state.presentationId,
      slideObjectId: googleSlide.objectId,
    });
    options.log(
      `[${options.set}] ${fileId} reverse ${formatPercent(reverse?.mismatchPercent ?? null)}  round trip ${formatPercent(roundTripMismatchPercent)}  forward ${formatPercent(forwardMismatchPercent)}  text ${reverseText.score.toFixed(2)}`,
    );
  }

  writeJson(layout.metricsPath, options.onlySlides === null ? rows : mergedMetrics({ previous: readMetrics(layout.metricsPath), measured: rows }));
  writeMeta({ options, layout, presentation, state, fixtureCount: fixtureFiles.length });
  if (!existsSync(layout.ratingsPath)) writeJson(layout.ratingsPath, {});
  if (fixtureFiles.length > 0 && !existsSync(layout.roundTrip.ratingsPath)) writeJson(layout.roundTrip.ratingsPath, {});
  return rows;
}

/** A filtered run's rows replace the same slides' earlier rows; every other slide keeps its row. */
function mergedMetrics(options: Readonly<{ previous: readonly SlideMetrics[]; measured: readonly SlideMetrics[] }>): readonly SlideMetrics[] {
  const measuredIds = new Set(options.measured.map((row) => row.slideId));
  return [...options.previous.filter((row) => !measuredIds.has(row.slideId)), ...options.measured].sort((left, right) => left.slideNumber - right.slideNumber);
}

function readMetrics(path: string): readonly SlideMetrics[] {
  if (!existsSync(path)) return [];
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  // metrics.json is written only by this module, as an array of SlideMetrics.
  return Array.isArray(raw) ? (raw as readonly SlideMetrics[]) : [];
}

/**
 * The presentation's .pptx export, or null when Drive refuses it. A refusal is logged and the run
 * goes on: the import then reports every gradient shape as a loss, which is what a person whose
 * grant cannot export would see.
 */
async function pptxExportOf(options: Readonly<{ options: SetRunOptions; presentationId: string }>): Promise<Uint8Array | null> {
  try {
    return await options.options.google.exportPresentationPptx(options.presentationId);
  } catch (cause) {
    options.options.log(`[${options.options.set}] WARNING the .pptx export failed, gradients will be reported as lost: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
}

function fixtureFilesOf(source: SetSource): readonly string[] {
  switch (source.kind) {
    case "fixtures":
      return listHtml(source.fixtureDirectory).map((file) => join(source.fixtureDirectory, file));
    case "presentation":
      return [];
    default:
      return assertNever(source);
  }
}

function listHtml(directory: string): readonly string[] {
  // Sorted like convert-pptx.ts and shot-originals.ts sort them, so slide N is fixture N.
  return existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".html")).sort() : [];
}

async function presentationStateFor(options: Readonly<{ options: SetRunOptions; layout: SetLayout }>): Promise<SetState> {
  const { source } = options.options;
  const previous = readState(options.layout.statePath);
  if (options.options.offline) {
    if (previous === null) throw new Error(`[${options.options.set}] offline: no earlier run recorded in ${options.layout.statePath}`);
    return previous;
  }
  switch (source.kind) {
    case "presentation":
      return keepThumbnailsIf({ previous, presentationId: source.presentationId, source: "testDeck" });
    case "fixtures": {
      if (source.givenPresentationId !== null) return keepThumbnailsIf({ previous, presentationId: source.givenPresentationId, source: "given" });
      if (!source.freshUpload && previous !== null) return previous;
      if (!source.freshUpload && source.recordedPresentationId !== null) return keepThumbnailsIf({ previous, presentationId: source.recordedPresentationId, source: "recordedForwardRun" });
      mkdirSync(options.options.workDirectory, { recursive: true });
      const title = `reverse_${options.options.set}_${options.options.now()}`;
      options.options.log(`[${options.options.set}] forward upload: convert-pptx.ts ${source.fixtureDirectory} as "${title}"`);
      const upload = await uploadFixturesForward({
        converterDirectory: options.options.converterDirectory,
        fixtureDirectory: source.fixtureDirectory,
        title,
        pptxPath: join(options.options.workDirectory, `${options.options.set}.pptx`),
        logPath: join(options.options.workDirectory, `${options.options.set}-convert.log`),
        log: options.options.log,
      });
      return { presentationId: upload.presentationId, source: "forwardUpload", thumbnails: [] };
    }
    default:
      return assertNever(source);
  }
}

function keepThumbnailsIf(options: Readonly<{ previous: SetState | null; presentationId: string; source: SetState["source"] }>): SetState {
  const thumbnails = options.previous?.presentationId === options.presentationId ? options.previous.thumbnails : [];
  return { presentationId: options.presentationId, source: options.source, thumbnails };
}

async function downloadThumbnails(
  options: Readonly<{ options: SetRunOptions; layout: SetLayout; presentation: SlidesPresentation; state: SetState }>,
): Promise<SetState> {
  let state: SetState = options.options.refreshThumbnails ? { ...options.state, thumbnails: [] } : options.state;
  const fetched = new Set(state.thumbnails);
  for (let index = 0; index < options.presentation.slides.length; index++) {
    const slide = options.presentation.slides[index];
    if (slide === undefined) continue;
    const fileName = `${slideFileId(index + 1)}.png`;
    const path = join(options.layout.originals, fileName);
    if (fetched.has(fileName) && existsSync(path)) continue;
    const png = await options.options.google.downloadThumbnail({ presentationId: options.presentation.presentationId, pageObjectId: slide.objectId });
    writeFileSync(path, png);
    fetched.add(fileName);
    state = { ...state, thumbnails: [...fetched].sort() };
    writeJson(options.layout.statePath, state);
    options.options.log(`[${options.options.set}] thumbnail ${fileName}`);
  }
  return state;
}

async function shootFixtures(options: Readonly<{ options: SetRunOptions; layout: SetLayout; fixtureFiles: readonly string[] }>): Promise<ReadonlyMap<string, string>> {
  const cached = readTextCache(options.layout.roundTrip.fixtureTextPath);
  const texts = new Map<string, string>();
  for (let index = 0; index < options.fixtureFiles.length; index++) {
    const fixtureFile = options.fixtureFiles[index];
    if (fixtureFile === undefined) continue;
    const shotPath = join(options.layout.roundTrip.originals, `${slideFileId(index + 1)}.png`);
    const cachedText = cached.get(fixtureFile);
    if (!options.options.refreshFixtureShots && cachedText !== undefined && existsSync(shotPath)) {
      texts.set(fixtureFile, cachedText);
      continue;
    }
    const capture = await options.options.chrome.capture({ address: pathToFileURL(fixtureFile).href });
    writeFileSync(shotPath, capture.png);
    texts.set(fixtureFile, capture.text);
    writeJson(options.layout.roundTrip.fixtureTextPath, { extraction: TEXT_EXTRACTION, texts: Object.fromEntries([...cached, ...texts]) });
    options.options.log(`[${options.options.set}] fixture ${basename(fixtureFile)}${capture.readiness === "timedOut" ? " (fonts never settled)" : ""}`);
  }
  return texts;
}

/** Every picture as a `data:` address, so each exported page is one self-contained file. */
function dataAddresses(imported: SashaImport): (assetId: AssetId) => string {
  return (assetId) => {
    const asset = imported.assets.get(assetId);
    if (asset === undefined) return "";
    return `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
  };
}

function wordNotes(options: Readonly<{ label: string; match: TextMatch }>): readonly string[] {
  const notes: string[] = [];
  const sample = (words: readonly string[]): string => `${words.slice(0, 8).join(" ")}${words.length > 8 ? ` (+${words.length - 8})` : ""}`;
  if (options.match.missingWords.length > 0) notes.push(`missing words ${options.label}: ${sample(options.match.missingWords)}`);
  if (options.match.extraWords.length > 0) notes.push(`extra words ${options.label}: ${sample(options.match.extraWords)}`);
  return notes;
}

function writeMeta(options: Readonly<{ options: SetRunOptions; layout: SetLayout; presentation: SlidesPresentation; state: SetState; fixtureCount: number }>): void {
  const { set, converterDirectory, source } = options.options;
  const slideIds = options.presentation.slides.map((slide) => slide.objectId);
  const fixtureDirectory = source.kind === "fixtures" ? source.fixtureDirectory : null;
  writeJson(options.layout.metaPath, {
    mode: "reverse",
    set,
    originalsAre: "googleThumbnail",
    slidesAre: "sashaExportScreenshot",
    presentationId: options.state.presentationId,
    presentationSource: options.state.source,
    slideIds,
    // The rating server links each comparison to `htmlDir/<slide id>.html`: the Sasha export here.
    htmlDir: options.layout.html,
    fixtureHtmlDir: fixtureDirectory,
    goldensDir: reverseGoldensDirectory({ converterDirectory, set }),
    roundTripDir: options.fixtureCount > 0 ? options.layout.roundTrip.root : null,
    metrics: options.layout.metricsPath,
    generatedAt: new Date(options.options.now()).toISOString(),
  });
  if (fixtureDirectory === null) return;
  writeJson(options.layout.roundTrip.metaPath, {
    mode: "roundTrip",
    set,
    originalsAre: "fixtureScreenshot",
    slidesAre: "sashaExportScreenshot",
    presentationId: options.state.presentationId,
    slideIds,
    htmlDir: fixtureDirectory,
    sashaHtmlDir: options.layout.html,
    goldensDir: roundTripGoldensDirectory({ converterDirectory, set }),
    metrics: options.layout.metricsPath,
    generatedAt: new Date(options.options.now()).toISOString(),
  });
}

function readState(path: string): SetState | null {
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null) return null;
  const presentationId = "presentationId" in raw ? raw.presentationId : undefined;
  const source = "source" in raw ? raw.source : undefined;
  const thumbnails = "thumbnails" in raw && Array.isArray(raw.thumbnails) ? raw.thumbnails.filter((name): name is string => typeof name === "string") : [];
  if (typeof presentationId !== "string" || !isStateSource(source)) return null;
  return { presentationId, source, thumbnails };
}

function isStateSource(candidate: unknown): candidate is SetState["source"] {
  // A parse-boundary guard over untrusted JSON: new sources are added here by hand.
  return candidate === "forwardUpload" || candidate === "recordedForwardRun" || candidate === "given" || candidate === "testDeck";
}

/** Names how chrome-capture.ts reads a page's text; a cache written another way is read as empty. */
const TEXT_EXTRACTION = "visibleTextByBox-3";

function readTextCache(path: string): ReadonlyMap<string, string> {
  if (!existsSync(path)) return new Map();
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null || !("extraction" in raw) || raw.extraction !== TEXT_EXTRACTION || !("texts" in raw)) return new Map();
  const texts = raw.texts;
  if (typeof texts !== "object" || texts === null) return new Map();
  return new Map(Object.entries(texts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function readPng(path: string): RgbaImage {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: png.data };
}

function writePng(path: string, image: RgbaImage): void {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function formatPercent(value: number | null): string {
  return value === null ? "   n/a" : `${value.toFixed(2).padStart(6)}%`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
