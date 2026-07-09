/**
 * stability.ts — the 3× stability classifier for bug_solving.
 *
 * When a solve run starts, EVERY slide in the deck is recorded N times (default
 * 3) BEFORE any fix is applied. Rendering is not perfectly deterministic (Chrome
 * web-font load races make the emitted pptx — and thus the Google-rendered
 * pixels — jitter for some slides), so we bucket each slide by how reproducible
 * its render is:
 *
 *   - pixelPerfect : the PIXEL output was byte-identical across all N attempts.
 *                    A merged solution for such a slide must ALSO be pixel-identical
 *                    to the user-approved (LGTM'd) render.
 *   - xmlStable    : the pixels differed but the slide XML was identical across
 *                    all N. A merged solution only needs XML + rendered-parts
 *                    stability (the wobble is Google-side raster noise, not ours).
 *   - unstable     : neither pixels nor XML were stable. Gated like xmlStable
 *                    (the weaker requirement) and named in a WARNING.
 *
 * This module is STANDALONE: `classifyStability()` is a pure function over an
 * injected `record` seam (only the recording is mocked in tests; the
 * classification is real), and the CLI runs it independently of the solve and
 * writes `stability.json` that the regression gate later reads.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Render record + comparison keys (shared with regression-gate.ts)
// ---------------------------------------------------------------------------

/**
 * A single render observation. The seam may return either a precomputed hash or
 * a path/string the key helpers hash themselves — whichever is cheaper for the
 * producer. `renderedParts*` captures ONLY the "rendered parts" (the rough.js
 * overlay images baked into the pptx), used by the xml-stable comparison.
 */
export interface RenderRecord {
  /** hex hash of the rendered PIXELS (Google thumbnail / screenshot). */
  pixelHash?: string;
  /** path to a rendered PNG; hashed on demand if `pixelHash` is absent. */
  pngPath?: string;
  /** hex hash of the slide XML. */
  xmlHash?: string;
  /** raw slide XML; hashed on demand if `xmlHash` is absent. */
  xml?: string;
  /** hex hash of the rendered-parts (embedded overlay images). */
  renderedPartsHash?: string;
  /** path to a rendered-parts PNG; hashed on demand if the hash is absent. */
  renderedPartsPng?: string;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Stable comparison key for the PIXEL representation, or null if none present. */
export function pixelKey(r: RenderRecord): string | null {
  if (r.pixelHash != null) return `h:${r.pixelHash}`;
  if (r.pngPath != null) {
    try { return `f:${sha256(readFileSync(r.pngPath))}`; } catch { return null; }
  }
  return null;
}

/** Stable comparison key for the XML representation, or null if none present. */
export function xmlKey(r: RenderRecord): string | null {
  if (r.xmlHash != null) return `h:${r.xmlHash}`;
  if (r.xml != null) return `x:${sha256(r.xml)}`;
  return null;
}

/** Stable comparison key for the rendered-parts representation, or null. */
export function renderedPartsKey(r: RenderRecord): string | null {
  if (r.renderedPartsHash != null) return `h:${r.renderedPartsHash}`;
  if (r.renderedPartsPng != null) {
    try { return `f:${sha256(readFileSync(r.renderedPartsPng))}`; } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// classifyStability — the pure classifier
// ---------------------------------------------------------------------------

/** The injected recording seam. Real default renders via record-rendering; tests
 *  mock it. Called once per (slide, attempt). */
export type StabilityRecorder = (slideId: string, attemptIdx: number) => RenderRecord;

export interface ClassifyStabilityOpts {
  record: StabilityRecorder;
  /** how many times to record each slide. Default 3. */
  attempts?: number;
}

export interface StabilityClassification {
  /** pixel output identical across ALL attempts. */
  pixelPerfect: string[];
  /** pixels varied but XML identical across all attempts. */
  xmlStable: string[];
  /** neither pixels nor XML stable. */
  unstable: string[];
  /** human-readable warning naming the unstable slides (empty-set safe). */
  warning: string;
  /** the attempts count actually used. */
  attempts: number;
}

/**
 * Classify every slide by recording it `attempts` times and comparing the
 * PIXEL and XML representations across attempts:
 *   all pixels identical           → pixelPerfect
 *   else all XML identical          → xmlStable
 *   else                            → unstable
 * A representation that is MISSING in any attempt disqualifies that tier (a null
 * key can never be "identical across all"), so an XML-only recorder buckets a
 * reproducible slide as xmlStable, never pixelPerfect.
 */
export function classifyStability(slideIds: string[], opts: ClassifyStabilityOpts): StabilityClassification {
  const attempts = opts.attempts ?? 3;
  const pixelPerfect: string[] = [];
  const xmlStable: string[] = [];
  const unstable: string[] = [];

  for (const sid of slideIds) {
    const pixelKeys: Array<string | null> = [];
    const xmlKeys: Array<string | null> = [];
    for (let i = 0; i < attempts; i++) {
      const rec = opts.record(sid, i);
      pixelKeys.push(pixelKey(rec));
      xmlKeys.push(xmlKey(rec));
    }
    const allSame = (keys: Array<string | null>): boolean =>
      keys.length > 0 && keys[0] != null && keys.every((k) => k != null && k === keys[0]);

    if (allSame(pixelKeys)) pixelPerfect.push(sid);
    else if (allSame(xmlKeys)) xmlStable.push(sid);
    else unstable.push(sid);
  }

  const warning = unstable.length
    ? `[stability] ${unstable.length}/${slideIds.length} slide(s) NOT stable across ${attempts} attempts ` +
      `(neither pixel-perfect nor xml-stable): ${unstable.join(", ")}. ` +
      `These will be gated on xml+rendered-parts only.`
    : `[stability] all ${slideIds.length} slide(s) stable across ${attempts} attempts ` +
      `(${pixelPerfect.length} pixel-perfect, ${xmlStable.length} xml-stable).`;

  return { pixelPerfect, xmlStable, unstable, warning, attempts };
}

/** The full deck as classified (every bucket unioned). */
export function classifiedSlides(c: StabilityClassification): string[] {
  return [...new Set([...c.pixelPerfect, ...c.xmlStable, ...c.unstable])].sort();
}

// ---------------------------------------------------------------------------
// stability.json — the on-disk artifact the regression gate reads
// ---------------------------------------------------------------------------

/** The SHARED (outside-any-overlay) root for cross-boundary artifacts. Mirrors
 *  startup-detection.ts's DEFAULT_SHARED_ROOT + workspace-setup.ts's SHARED_ROOT;
 *  kept as a local literal so this module stays dependency-light. */
export const SHARED_ROOT = "/overlays/shared";

/** Canonical stability.json path both the scaffolding writer and the regression
 *  gate reader agree on (outside overlays, survives container restarts). */
export const STABILITY_JSON = join(SHARED_ROOT, "stability.json");

export function writeStabilityJson(path: string, c: StabilityClassification): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2));
}

/** Read a stability.json, or null if missing/unparseable (caller degrades). */
export function loadStability(path: string): StabilityClassification | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StabilityClassification>;
    if (!Array.isArray(raw.pixelPerfect) || !Array.isArray(raw.xmlStable) || !Array.isArray(raw.unstable)) return null;
    return {
      pixelPerfect: raw.pixelPerfect,
      xmlStable: raw.xmlStable,
      unstable: raw.unstable,
      warning: typeof raw.warning === "string" ? raw.warning : "",
      attempts: typeof raw.attempts === "number" ? raw.attempts : 3,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// pptx extraction helpers (used by the real recorder + the real gate)
// ---------------------------------------------------------------------------

/** slide1.xml from a single-slide pptx via `unzip -p` (sync). Null on failure. */
export function extractSlideXml(pptxPath: string): string | null {
  if (!existsSync(pptxPath)) return null;
  try {
    return execSync(`unzip -p "${pptxPath}" ppt/slides/slide1.xml`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Hash of the embedded media (rough.js overlay PNGs) — the "rendered parts".
 *  Null if the pptx has no ppt/media/ entries or unzip fails. */
export function extractRenderedPartsHash(pptxPath: string): string | null {
  if (!existsSync(pptxPath)) return null;
  try {
    const names = execSync(`unzip -Z1 "${pptxPath}"`, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .split("\n").map((s) => s.trim()).filter((n) => /^ppt\/media\//.test(n)).sort();
    if (names.length === 0) return null;
    const h = createHash("sha256");
    for (const n of names) {
      h.update(n);
      h.update(execSync(`unzip -p "${pptxPath}" "${n}"`, { maxBuffer: 64 * 1024 * 1024 }));
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// defaultStabilityRecorder — the REAL recording seam (renders via record-rendering)
// ---------------------------------------------------------------------------

export interface DefaultRecorderDeps {
  repo: string;
  fixturesDir: string;
  /** every slide the classifier will ask about (the whole deck). */
  slides: string[];
  /** scratch dir under which per-attempt renders land. */
  scratchDir: string;
  /** per-attempt render timeout (ms). Default 20 min (whole-deck full render). */
  timeoutMs?: number;
}

/**
 * The production recorder: renders the WHOLE deck once per attempt with
 * record-rendering `--mode full` (Google thumbnail = pixel truth) + reads the
 * per-slide pptx (xml + rendered-parts). Sequential (RECORD_CONCURRENCY=1) so a
 * concurrency race can't be misread as instability. The render for an attempt is
 * memoized — the first slide of attempt K renders all of attempt K.
 */
export function defaultStabilityRecorder(deps: DefaultRecorderDeps): StabilityRecorder {
  const REC = "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts";
  const rendered = new Map<number, string>();
  const csv = deps.slides.join(",");

  return (slideId: string, attemptIdx: number): RenderRecord => {
    let outDir = rendered.get(attemptIdx);
    if (!outDir) {
      outDir = join(deps.scratchDir, `attempt_${attemptIdx}`);
      mkdirSync(outDir, { recursive: true });
      // The recorder runs from `renderer/`, so `--fixtures` MUST be absolute —
      // a repo-root-relative path (e.g. "renderer/html2slides/e2e/fixtures") would
      // resolve against renderer/ and DOUBLE to renderer/renderer/… ("fixture not
      // found"). resolve() leaves an already-absolute fixturesDir untouched.
      const fixturesAbs = resolve(deps.repo, deps.fixturesDir);
      execSync(
        `cd "${join(deps.repo, "renderer")}" && RECORD_CONCURRENCY=1 npx tsx "${join(deps.repo, REC)}" ` +
          `--mode full --fixtures "${fixturesAbs}" --slides "${csv}" ` +
          `--title "stability-a${attemptIdx}-${Date.now()}" --out "${outDir}"`,
        { stdio: "ignore", timeout: deps.timeoutMs ?? 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      );
      rendered.set(attemptIdx, outDir);
    }
    const png = join(outDir, "thumbs", `${slideId}.png`);
    const pptx = join(outDir, "pptx", `${slideId}.pptx`);
    const rec: RenderRecord = {};
    if (existsSync(png)) rec.pngPath = png;
    const xml = extractSlideXml(pptx);
    if (xml != null) rec.xml = xml;
    const parts = extractRenderedPartsHash(pptx);
    if (parts != null) rec.renderedPartsHash = parts;
    return rec;
  };
}

// ---------------------------------------------------------------------------
// STANDALONE CLI — `npx tsx stability.ts --slides <csv> [--out <json>]`
// ---------------------------------------------------------------------------

interface CliArgs {
  slides: string[];
  out: string;
  fixtures: string;
  repo: string;
  attempts: number;
  scratch: string;
}

function parseCli(argv: string[]): CliArgs {
  const a: Partial<CliArgs> = {
    fixtures: "renderer/html2slides/e2e/fixtures",
    repo: process.cwd(),
    attempts: 3,
    out: STABILITY_JSON,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--slides": a.slides = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--out": a.out = resolve(argv[++i]); break;
      case "--fixtures": a.fixtures = argv[++i]; break;
      case "--repo": a.repo = resolve(argv[++i]); break;
      case "--attempts": a.attempts = Number(argv[++i]) || 3; break;
      case "--scratch": a.scratch = resolve(argv[++i]); break;
    }
  }
  if (!a.slides || a.slides.length === 0) {
    throw new Error("usage: stability.ts --slides <csv> [--out <json>] [--fixtures <dir>] [--repo <dir>] [--attempts N] [--scratch <dir>]");
  }
  a.scratch ??= join(a.repo!, ".bug-solving-scratch", "stability");
  return a as CliArgs;
}

async function cliMain(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  console.error(`[stability] classifying ${args.slides.length} slide(s) over ${args.attempts} attempt(s)...`);
  const record = defaultStabilityRecorder({
    repo: args.repo,
    fixturesDir: args.fixtures,
    slides: args.slides,
    scratchDir: args.scratch,
  });
  const classification = classifyStability(args.slides, { record, attempts: args.attempts });
  console.log(JSON.stringify(classification, null, 2));
  console.error(classification.warning);
  writeStabilityJson(args.out, classification);
  console.error(`[stability] wrote ${args.out}`);
}

// BUNDLE-SAFE main guard: in the esbuild single-file bundle EVERY module's
// import.meta.url equals the bundle's own URL, so comparing it to argv[1] fires
// for every imported CLI-hybrid (this killed the solver at startup: the CLI saw
// no --slides, printed usage, and process.exit'ed). Match the ENTRY FILENAME
// instead — true only for `npx tsx .../stability.ts`, never inside a bundle.
const isCliMain = !!process.argv[1] && /(^|\/)stability\.(ts|mts|js|mjs)$/.test(process.argv[1]);

if (isCliMain) {
  cliMain().catch((e) => {
    console.error(`[stability] failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
