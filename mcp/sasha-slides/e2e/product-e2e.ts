#!/usr/bin/env npx tsx
/**
 * product-e2e.ts — the FULL PRODUCT end-to-end run against real Google.
 *
 * run-e2e.ts proves the server half of the protocol (propose -> Drive layout -> PICK -> await_pick)
 * with the picker SIMULATED. This harness proves the other half for real: the actual React picker
 * bundle, in a real browser, polling real Drive, converting real HTML, and inserting into a real
 * deck with `presentations.batchUpdate`.
 *
 * WHY THE PICKER IS SERVED LOCALLY. The Apps Script API is disabled at the Cloud-project level
 * (project 982862611156), so the add-on cannot be deployed programmatically — that is one manual
 * click, not something to work around. Everything else about the vehicle is incidental: the sidebar
 * bundle only ever talks to Apps Script through five `google.script.run` functions. product-host.ts
 * serves the EMITTED `Sidebar.html` byte for byte and product-shim/shim.ts installs those five
 * functions over real Drive/Slides REST with a real OAuth token. Apps Script is the only thing
 * substituted; nothing is stubbed.
 *
 *   npx tsx mcp/sasha-slides/e2e/product-e2e.ts --list
 *   npx tsx mcp/sasha-slides/e2e/product-e2e.ts --step host
 *   npx tsx mcp/sasha-slides/e2e/product-e2e.ts --step propose
 *   npx tsx mcp/sasha-slides/e2e/product-e2e.ts --step open,picker
 *   npx tsx mcp/sasha-slides/e2e/product-e2e.ts --step pick
 *   npx tsx mcp/sasha-slides/e2e/product-e2e.ts --step verify
 *   npx tsx mcp/sasha-slides/e2e/product-e2e.ts --step cleanup
 *
 * ONE STEP PER COMMAND IS THE POINT, not a workaround: every shell command here has to finish
 * inside 30 s, and a step is a conclusion with its own evidence. What a step learned (proposal id,
 * folder id, the page the insert created) goes to `<work>/product-state.json`, which is what makes
 * `--step` genuine. The host is the one exception — it is a SERVICE, started detached, and it
 * outlives the turn the way Chrome does here.
 *
 * Wrapped in `main()` rather than using top-level await: the root package.json has no
 * "type": "module", so tsx transforms this to CJS, where esbuild rejects top-level await.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OAuth2Client } from "google-auth-library";
import { describeAuthFailure, loadOAuthClient } from "../google-auth.ts";
import { closePages, withExistingPage, withNewPage, type PageSession } from "./product-browser.ts";
import { capturePageThumbnail, describeElement, pageById, readDeck, type DeckElement } from "./product-deck.ts";
import { INBOX_FOLDER_NAME, PICK_NAME, READY_NAME, assertNever, slideFileName } from "./protocol-records.ts";
import { googleStagingDrive } from "./google-staging-drive.ts";
import { referenceProposalSide } from "./reference-proposal-side.ts";
import { openMcpProposalSide } from "./mcp-proposal-side.ts";
import { childByName, describeChildren } from "./staged-file.ts";
import type { StagingDrive } from "./staging-drive.ts";
import type { ProposalSide } from "./proposal-side.ts";

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVER_PATH = join(REPO_ROOT, "mcp", "sasha-slides", "server.ts");
const HOST_PATH = join(HERE, "product-host.ts");

/** The throwaway deck this harness inserts into. Overridable with --presentation. */
const DEFAULT_PRESENTATION_ID = "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";

/** The same four varied candidates run-e2e.ts stages, so both harnesses offer the same proposal. */
const FIXTURES: readonly Readonly<{ file: string; label: string }>[] = [
  { file: "01-text.html", label: "Text only, serif, numbered list" },
  { file: "02-table.html", label: "Table, uneven cell borders" },
  { file: "03-image.html", label: "Embedded png, cropped frame" },
  { file: "04-gradient-shadow.html", label: "Conic gradient, clipped text, glass" },
];

/** 1-based, and deliberately not the default selection: picking 2 proves the chip drives the insert. */
const PICKED_INDEX = 2;

type StepName = "host" | "propose" | "open" | "picker" | "pick" | "verify" | "cleanup";

const STEP_ORDER: readonly StepName[] = ["host", "propose", "open", "picker", "pick", "verify", "cleanup"];

const STEP_PURPOSE: Readonly<Record<StepName, string>> = {
  host: "the local Sidebar.html host is up, with a live OAuth token and the target deck",
  propose: "4 varied fixtures are staged to REAL Drive by the real propose path",
  open: "the real picker bundle mounts in Chrome :9223 and finds the proposal by the name walk",
  picker: "4 candidates numbered 1..4, the authoritative HTML pane, and the rendered toggle",
  pick: "picking option 2 runs a real presentations.batchUpdate and writes PICK to Drive",
  verify: "presentations.get reports the inserted elements as native objects with geometry",
  cleanup: "the proposal folder and the picker tab are gone; the deck is left in place",
};

type Options = Readonly<{
  steps: readonly StepName[];
  workDir: string;
  port: number;
  cdpPort: number;
  presentationId: string;
  keepProposal: boolean;
}>;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "invalid") {
    console.error(`sasha-slides product E2E: ${parsed.reason}\n`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (parsed.kind === "list") {
    console.log(usage());
    return;
  }
  process.exitCode = await runHarness(parsed.options);
}

async function runHarness(options: Options): Promise<number> {
  mkdirSync(options.workDir, { recursive: true });
  const context = openContext(options);
  console.log(
    `\nsasha-slides PRODUCT E2E — deck=${options.presentationId} host=127.0.0.1:${options.port} ` +
      `chrome=:${options.cdpPort} work=${options.workDir}`,
  );
  console.log(`steps: ${options.steps.join(" -> ")}\n`);

  const tally = { passed: 0, failed: 0 };
  try {
    for (const step of options.steps) {
      const startedAt = Date.now();
      const outcome = await runStepSafely({ step, context, options });
      report({ step, outcome, seconds: (Date.now() - startedAt) / 1000 });
      if (outcome.kind === "fail") {
        tally.failed += 1;
        break;
      }
      tally.passed += 1;
    }
  } finally {
    await context.close();
  }
  console.log(`\n=== ${tally.passed} step(s) passed, ${tally.failed} failed ===\n`);
  return tally.failed > 0 ? 1 : 0;
}

type Check = Readonly<{ ok: boolean; what: string; detail: string }>;

type StepOutcome =
  | Readonly<{ kind: "pass"; checks: readonly Check[]; notes: readonly string[] }>
  | Readonly<{ kind: "fail"; reason: string; checks: readonly Check[]; notes: readonly string[] }>;

async function runStepSafely(
  input: Readonly<{ step: StepName; context: Context; options: Options }>,
): Promise<StepOutcome> {
  try {
    return await runStep(input);
  } catch (cause) {
    if (cause instanceof Error && cause.stack !== undefined) console.error(cause.stack);
    return { kind: "fail", reason: describe(cause), checks: [], notes: [] };
  }
}

function runStep(input: Readonly<{ step: StepName; context: Context; options: Options }>): Promise<StepOutcome> {
  const { step, context, options } = input;
  switch (step) {
    case "host":
      return stepHost({ options });
    case "propose":
      return stepPropose({ context, options });
    case "open":
      return stepOpen({ context, options });
    case "picker":
      return stepPicker({ context, options });
    case "pick":
      return stepPick({ context, options });
    case "verify":
      return stepVerify({ context, options });
    case "cleanup":
      return stepCleanup({ context, options });
    default:
      return assertNever(step);
  }
}

/**
 * The host, started detached if it is not already answering. A static server is a SERVICE: it has
 * to outlive the turn, so it is spawned in its own session (`detached: true` is setsid) with its
 * output on a log file, and this step only waits for readiness.
 */
async function stepHost({ options }: { options: Options }): Promise<StepOutcome> {
  const checks: Check[] = [];
  const notes: string[] = [];
  const logPath = join(options.workDir, "product-host.log");

  const already = await health({ port: options.port });
  if (already === null) {
    notes.push(`starting a detached host, log: ${logPath}`);
    const log = openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), HOST_PATH, "--port", String(options.port), "--presentation", options.presentationId],
      { cwd: REPO_ROOT, detached: true, stdio: ["ignore", log, log] },
    );
    child.unref();
    notes.push(`host pid ${String(child.pid)}`);
  }

  // Readiness, polled for the observable condition rather than slept on. The first start pays for
  // a tsc gate plus an esbuild bundle, which is why the budget is seconds and not milliseconds.
  const ready = await pollHealth({ port: options.port, budgetMs: 22_000 });
  checks.push({
    ok: ready !== null,
    what: `the host answers http://127.0.0.1:${options.port}/healthz`,
    detail: ready === null ? `no answer in 22s — see ${logPath}` : JSON.stringify(ready),
  });
  if (ready === null) return failed({ reason: "the sidebar host never became ready", checks, notes });

  checks.push({
    ok: ready.presentationId === options.presentationId,
    what: "the host is bound to the deck under test",
    detail: `host says ${ready.presentationId}`,
  });
  checks.push({
    ok: ready.tokenPrefix.length === 8,
    what: "the host minted a live OAuth access token",
    detail: `token ${ready.tokenPrefix}… expires ${String(ready.tokenExpiresAt)}`,
  });
  checks.push({
    ok: ready.shimBytes > 2_000,
    what: "the google.script.run shim compiled into the page",
    detail: `${ready.shimBytes}B shim, ${ready.sidebarBytes}B Sidebar.html`,
  });
  return verdict({ checks, notes });
}

/** The real proposal: 4 fixtures on real Drive through the real propose path. */
async function stepPropose({ context, options }: { context: Context; options: Options }): Promise<StepOutcome> {
  const checks: Check[] = [];
  const notes: string[] = [];
  const side = await context.side();
  notes.push(`side: ${side.describe}`);

  const outcome = await side.propose({
    htmlPaths: FIXTURES.map((fixture) => join(HERE, "fixtures", fixture.file)),
    labels: FIXTURES.map((fixture) => fixture.label),
    presentationId: options.presentationId,
  });
  notes.push(`proposalId=${outcome.proposalId} count=${outcome.count}`);
  notes.push(`ids: ${outcome.slides.map((slide) => `${slide.index}:${slide.name}=${slide.fileId}`).join(" ")}`);

  checks.push({
    ok: outcome.count === FIXTURES.length && outcome.slides.length === FIXTURES.length,
    what: `propose staged ${FIXTURES.length} candidates`,
    detail: `count=${outcome.count}, ${outcome.slides.length} entries`,
  });
  checks.push({
    ok: outcome.slides.every((slide, position) => slide.index === position + 1 && slide.name === slideFileName(position + 1)),
    what: "they are 1-based and named 01..04.html",
    detail: outcome.slides.map((slide) => `${slide.index}->${slide.name}`).join(" "),
  });

  const drive = await context.drive();
  const located = await proposalFolder({ drive, proposalId: outcome.proposalId });
  checks.push({
    ok: located !== null,
    what: `the folder is discoverable by NAME under "${INBOX_FOLDER_NAME}"`,
    detail: located === null ? "not found" : `${located.folderId} in inbox ${located.inboxId}`,
  });
  if (located === null) return failed({ reason: "the staged proposal is not discoverable by name", checks, notes });

  const children = await drive.listChildren({ parentId: located.folderId });
  notes.push(`folder: ${describeChildren(children)}`);
  checks.push({
    ok: childByName(children, READY_NAME) !== null,
    what: `${READY_NAME} is present, so the picker may offer the proposal`,
    detail: describeChildren(children),
  });

  context.saveState({
    proposalId: outcome.proposalId,
    folderId: located.folderId,
    inboxId: located.inboxId,
    presentationId: options.presentationId,
    pickedIndex: PICKED_INDEX,
    insertedPageObjectId: null,
    insertedObjectIds: [],
  });
  return verdict({ checks, notes });
}

/** Open the picker. A NEW tab, navigated (not CDP.New({url})), activated so the poll is fast. */
async function stepOpen({ context, options }: { context: Context; options: Options }): Promise<StepOutcome> {
  const state = context.requireState();
  const url = sidebarUrl(options);
  return withNewPage({ port: options.cdpPort, url }, async (page) => {
    const checks: Check[] = [];
    const notes: string[] = [`tab ${page.targetId} -> ${url}`];
    // Visible, or the observer drops to the 30 s background cadence (observer.ts HIDDEN_POLL_MS).
    await page.activate();

    const broken = await page.text("String(window.__SASHA_E2E_BROKEN__ || '')");
    checks.push({ ok: broken === "", what: "the shim installed", detail: broken === "" ? "window.google.script.run is present" : broken });

    const mounted = await page.waitFor({ expression: "!!document.querySelector('.sasha-dialog')", budgetMs: 22_000 });
    checks.push({
      ok: mounted !== null,
      what: "the picker dialog mounted after the Drive name walk found the proposal",
      detail: mounted === null ? "no .sasha-dialog in 22s" : `${mounted} ms from navigate to dialog`,
    });
    if (mounted === null) {
      notes.push(`page errors: ${page.pageErrors().join(" | ") || "<none>"}`);
      notes.push(`shim calls: ${await page.text("JSON.stringify((window.__SASHA_E2E__?.().records ?? []).map(r => r.call + ': ' + r.detail))")}`);
      return failed({ reason: "the picker never offered the staged proposal", checks, notes });
    }

    const header = await page.text("(document.querySelector('.sasha-header')||{}).textContent||''");
    notes.push(`header: ${JSON.stringify(header)}`);
    checks.push({
      ok: header.includes(state.proposalId),
      what: "the offered proposal is the one this run staged",
      detail: `header names ${state.proposalId ? state.proposalId : "<none>"}`,
    });
    notes.push(`shim calls: ${await page.text("JSON.stringify((window.__SASHA_E2E__?.().records ?? []).map(r => r.call))")}`);
    return verdict({ checks, notes });
  });
}

/** The three UI assertions: 4 numbered candidates, the authoritative HTML pane, the toggle. */
async function stepPicker({ context, options }: { context: Context; options: Options }): Promise<StepOutcome> {
  context.requireState();
  return withExistingPage({ port: options.cdpPort, urlNeedle: sidebarUrl(options) }, async (page) => {
    const checks: Check[] = [];
    const notes: string[] = [];
    await page.activate();

    const chips = await page.count("document.querySelectorAll('.sasha-chip').length");
    const numbers = await page.text(
      "JSON.stringify([...document.querySelectorAll('.sasha-chip-number')].map(e => e.textContent))",
    );
    checks.push({ ok: chips === FIXTURES.length, what: `the picker renders ${FIXTURES.length} candidates`, detail: `saw ${chips}` });
    checks.push({
      ok: numbers === JSON.stringify(FIXTURES.map((_fixture, position) => String(position + 1))),
      what: "they are numbered 1..4",
      detail: numbers,
    });
    const labels = await page.text("JSON.stringify([...document.querySelectorAll('.sasha-chip-label')].map(e => e.textContent))");
    notes.push(`chip labels: ${labels}`);

    // The HTML pane is the authoritative document: compare its srcdoc with the fixture bytes.
    const authoritative = await htmlPaneCheck({ page, index: 1 });
    checks.push(authoritative);

    // Selecting option 2 must move the authoritative pane to option 2's bytes.
    const selected = await page.click({ selector: ".sasha-chip:nth-of-type(2)" });
    notes.push(`clicked chip 2 at ${selected.kind === "clicked" ? `${selected.x.toFixed(0)},${selected.y.toFixed(0)}` : "<absent>"}`);
    const movedOn = await page.waitFor({
      expression: "(document.querySelector('.sasha-primary')||{}).textContent === 'Insert option 2'",
      budgetMs: 5_000,
    });
    checks.push({
      ok: movedOn !== null,
      what: "clicking chip 2 selects option 2",
      detail: movedOn === null ? await page.text("(document.querySelector('.sasha-primary')||{}).textContent||''") : `${movedOn} ms`,
    });
    const loadedTwo = await page.waitFor({ expression: "!!document.querySelector('iframe.sasha-frame')", budgetMs: 10_000 });
    notes.push(`option 2 HTML pane in ${String(loadedTwo)} ms`);
    checks.push(await htmlPaneCheck({ page, index: 2 }));
    await page.screenshot({ path: join(options.workDir, "picker-html.png") });
    notes.push(`screenshot: ${join(options.workDir, "picker-html.png")}`);

    // The toggle. The rendered pane is the REAL converter running in the page, so this is also the
    // proof that the inlined extract-dom blob survived and ran under the page's CSP.
    const toggled = await page.click({ selector: ".sasha-toggle .sasha-tab:nth-of-type(2)" });
    checks.push({ ok: toggled.kind === "clicked", what: "the HTML/rendered toggle is clickable", detail: toggled.kind });
    const converted = await page.waitFor({
      expression: "document.querySelectorAll('.sasha-rendered .sasha-el').length > 0",
      budgetMs: 20_000,
    });
    const boxes = await page.count("document.querySelectorAll('.sasha-rendered .sasha-el').length");
    checks.push({
      ok: converted !== null && boxes > 0,
      what: "the rendered pane shows converted Slides elements",
      detail: converted === null
        ? `no .sasha-el in 20s; pane says ${JSON.stringify(await page.text("(document.querySelector('.sasha-placeholder')||{}).textContent||''"))}`
        : `${boxes} element boxes in ${converted} ms`,
    });
    const kinds = await page.text(
      "JSON.stringify([...document.querySelectorAll('.sasha-rendered .sasha-el')].map(e => e.className.replace('sasha-el ','')))",
    );
    notes.push(`rendered element kinds: ${kinds}`);
    const onTab = await page.text("(document.querySelector('.sasha-tab-on')||{}).textContent||''");
    checks.push({ ok: onTab === "Converted slide", what: "the toggle really switched view", detail: `active tab: ${JSON.stringify(onTab)}` });
    await page.screenshot({ path: join(options.workDir, "picker-rendered.png") });
    notes.push(`screenshot: ${join(options.workDir, "picker-rendered.png")}`);

    // Back to the authoritative pane, which is what the user decides from.
    await page.click({ selector: ".sasha-toggle .sasha-tab:nth-of-type(1)" });
    checks.push({
      ok: (await page.waitFor({ expression: "!!document.querySelector('iframe.sasha-frame')", budgetMs: 5_000 })) !== null,
      what: "the toggle switches back to HTML",
      detail: "iframe.sasha-frame is back",
    });
    const errors = page.pageErrors();
    checks.push({ ok: errors.length === 0, what: "no uncaught page exceptions", detail: errors.join(" | ") || "<none>" });
    return verdict({ checks, notes });
  });
}

/** Picking option 2: a real batchUpdate and a real PICK on Drive. */
async function stepPick({ context, options }: { context: Context; options: Options }): Promise<StepOutcome> {
  const state = context.requireState();
  const auth = await context.auth();
  const drive = await context.drive();
  const before = await readDeck({ auth, presentationId: state.presentationId });

  const picked = await withExistingPage({ port: options.cdpPort, urlNeedle: sidebarUrl(options) }, async (page) => {
    const checks: Check[] = [];
    const notes: string[] = [`deck had ${before.pages.length} slide(s) before the insert`];
    await page.activate();

    const label = await page.text("(document.querySelector('.sasha-primary')||{}).textContent||''");
    checks.push({
      ok: label === `Insert option ${PICKED_INDEX}`,
      what: `the primary action offers option ${PICKED_INDEX}`,
      detail: JSON.stringify(label),
    });
    if (label !== `Insert option ${PICKED_INDEX}`) {
      return failed({ reason: "the picker is not on option 2; run the picker step first", checks, notes });
    }

    const clicked = await page.click({ selector: ".sasha-primary" });
    notes.push(`clicked "${label}" at ${clicked.kind === "clicked" ? `${clicked.x.toFixed(0)},${clicked.y.toFixed(0)}` : "<absent>"}`);
    const settled = await page.waitFor({ expression: "!!document.querySelector('.sasha-settled')", budgetMs: 24_000 });
    const message = await page.text("(document.querySelector('.sasha-settled')||document.querySelector('.sasha-trouble')||{}).textContent||''");
    checks.push({
      ok: settled !== null,
      what: "the picker reports the decision as settled",
      detail: settled === null ? `still busy after 24s; page says ${JSON.stringify(message)}` : `${settled} ms — ${JSON.stringify(message)}`,
    });

    const evidence = await page.text("JSON.stringify(window.__SASHA_E2E__ ? window.__SASHA_E2E__() : null)");
    return { kind: "collected" as const, checks, notes, evidence, settled: settled !== null };
  });
  if ("kind" in picked && picked.kind === "fail") return picked;
  if (!("evidence" in picked)) return failed({ reason: "the pick step collected no evidence", checks: [], notes: [] });

  const checks = [...picked.checks];
  const notes = [...picked.notes];
  const shim = parseShimEvidence(picked.evidence);
  if (shim === null) {
    checks.push({ ok: false, what: "the shim recorded what it called", detail: picked.evidence.slice(0, 200) });
    return failed({ reason: "the shim evidence could not be read out of the page", checks, notes });
  }
  notes.push(`shim calls: ${shim.records.map((record) => record.call).join(" -> ")}`);

  const insert = shim.insert;
  checks.push({
    ok: insert !== null,
    what: "a real presentations.batchUpdate was issued",
    detail: insert === null ? "sashaInsert never ran" : `${insert.requestCount} requests against ${insert.presentationId}`,
  });
  if (insert === null) return failed({ reason: "picking option 2 did not reach batchUpdate", checks, notes });
  notes.push(`request kinds: ${insert.requestKinds.join(" ")}`);
  notes.push(`batchUpdate reply: ${insert.batchResponseJson.slice(0, 220)}…`);
  checks.push({
    ok: insert.presentationId === state.presentationId,
    what: "it targeted the deck under test",
    detail: insert.presentationId,
  });
  checks.push({
    ok: insert.createdObjectIds.length > 1 && insert.createdObjectIds.includes(insert.pageObjectId),
    what: "Slides reported the created object ids, including the new page",
    detail: `${insert.createdObjectIds.length} ids, page ${insert.pageObjectId}`,
  });
  notes.push(`created ids: ${insert.createdObjectIds.join(" ")}`);
  notes.push(`render artifact: ${insert.renderArtifact ?? "<none — best effort>"}`);

  // PICK on real Drive, read back with a different OAuth path than the one that wrote it.
  const children = await drive.listChildren({ parentId: state.folderId });
  const pickFile = childByName(children, PICK_NAME);
  checks.push({
    ok: pickFile !== null,
    what: `${PICK_NAME} is on Drive in the proposal folder`,
    detail: pickFile === null ? describeChildren(children) : `${PICK_NAME} -> ${pickFile.id}`,
  });
  if (pickFile === null) return failed({ reason: "the picker did not write PICK", checks, notes });
  const body = await drive.readFile({ id: pickFile.id });
  notes.push(`PICK body: ${body.replace(/\s+/g, " ").slice(0, 300)}`);
  const record = parsePickBody(body);
  checks.push({
    ok: record !== null && record.picked === PICKED_INDEX,
    what: `PICK names the chosen index (${PICKED_INDEX})`,
    detail: record === null ? "unreadable" : `picked=${String(record.picked)} proposalId=${record.proposalId}`,
  });
  checks.push({
    ok: record !== null && record.insertedObjectIds.length === insert.createdObjectIds.length,
    what: "PICK carries the object ids Slides created",
    detail: record === null ? "unreadable" : `${record.insertedObjectIds.length} ids in PICK`,
  });

  context.saveState({
    ...state,
    insertedPageObjectId: insert.pageObjectId,
    insertedObjectIds: insert.createdObjectIds,
  });
  const outcome = verdict({ checks, notes });
  return outcome;
}

/** `presentations.get`: the inserted slide is made of native objects, with geometry. */
async function stepVerify({ context, options }: { context: Context; options: Options }): Promise<StepOutcome> {
  const state = context.requireState();
  const checks: Check[] = [];
  const notes: string[] = [];
  if (state.insertedPageObjectId === null) {
    return failed({ reason: "no inserted page recorded — run the pick step first", checks, notes });
  }
  const auth = await context.auth();
  const deck = await readDeck({ auth, presentationId: state.presentationId });
  notes.push(`deck "${deck.title}" is ${deck.widthPt}x${deck.heightPt}pt with ${deck.pages.length} slide(s)`);

  const page = pageById({ deck, objectId: state.insertedPageObjectId });
  checks.push({
    ok: page !== null,
    what: "the page the insert created exists in the deck",
    detail: page === null ? `${state.insertedPageObjectId} is not among ${deck.pages.map((entry) => entry.objectId).join(" ")}` : `${page.objectId} at position ${page.position}`,
  });
  if (page === null) return failed({ reason: "the inserted page is not in the deck", checks, notes });

  for (const element of page.elements) notes.push(`  ${describeElement(element)}`);
  checks.push({
    ok: page.elements.length > 0,
    what: "the page carries page elements",
    detail: `${page.elements.length} element(s)`,
  });
  const native = page.elements.filter((element) => element.kind === "shape" || element.kind === "table" || element.kind === "line");
  checks.push({
    ok: native.length === page.elements.length && native.length > 0,
    what: "every element is a NATIVE object (shape / table / line), not a flattened image",
    detail: `${native.length}/${page.elements.length} native; kinds=${[...new Set(page.elements.map((element) => element.kind))].join(",")}`,
  });
  const textBoxes = page.elements.filter((element) => element.shapeType === "TEXT_BOX");
  checks.push({
    ok: textBoxes.length > 0,
    what: "at least one native TEXT_BOX landed",
    detail: `${textBoxes.length} text box(es): ${textBoxes.map((element) => element.objectId).join(" ")}`,
  });
  const withText = page.elements.filter((element) => element.text.trim() !== "");
  checks.push({
    ok: withText.length > 0,
    what: "the text of the chosen candidate is in the deck as editable text",
    detail: withText.map((element) => `${element.objectId}:"${element.text.replace(/\s+/g, " ").trim().slice(0, 32)}"`).join(" "),
  });
  checks.push({
    ok: page.elements.every(onSlide({ widthPt: deck.widthPt, heightPt: deck.heightPt })),
    what: "every element has real geometry inside the slide",
    detail: `all ${page.elements.length} within 0..${deck.widthPt}x${deck.heightPt}pt with positive size`,
  });
  const reportedIds = new Set(page.elements.map((element) => element.objectId));
  const promised = state.insertedObjectIds.filter((objectId) => objectId !== state.insertedPageObjectId);
  const missing = promised.filter((objectId) => !reportedIds.has(objectId));
  checks.push({
    ok: missing.length === 0,
    what: "every object id batchUpdate reported is a real element Google now serves",
    detail: missing.length === 0 ? `${promised.length}/${promised.length} present` : `missing ${missing.join(" ")}`,
  });

  const shotPath = join(options.workDir, "inserted-slide.png");
  const shot = await capturePageThumbnail({
    auth,
    presentationId: state.presentationId,
    pageObjectId: state.insertedPageObjectId,
    path: shotPath,
  });
  checks.push({ ok: shot.bytes > 1_000, what: "Slides rendered the inserted page", detail: `${shot.bytes}B -> ${shotPath}` });
  notes.push(`screenshot: ${shotPath}`);
  notes.push(`deck: https://docs.google.com/presentation/d/${state.presentationId}/edit#slide=id.${state.insertedPageObjectId}`);
  return verdict({ checks, notes });
}

/** Delete what this run created, count before and after, and say what is left. */
async function stepCleanup({ context, options }: { context: Context; options: Options }): Promise<StepOutcome> {
  const state = context.requireState();
  const checks: Check[] = [];
  const notes: string[] = [];
  const drive = await context.drive();

  const closed = await closePages({ port: options.cdpPort, urlNeedle: sidebarUrl(options) });
  notes.push(`closed ${closed.length} picker tab(s) on :${options.cdpPort}`);

  if (options.keepProposal) {
    notes.push(`--keep: ${state.proposalId} (${state.folderId}) left on real Drive`);
    return verdict({ checks, notes });
  }

  // Counted before and after, so an over-delete is visible rather than inferred.
  const before = await drive.listChildren({ parentId: state.inboxId });
  await drive.deleteFile({ id: state.folderId });
  const after = await drive.listChildren({ parentId: state.inboxId });
  notes.push(`inbox: ${before.length} folder(s) before, ${after.length} after`);
  checks.push({
    ok: !after.some((file) => file.id === state.folderId),
    what: `the proposal folder ${state.proposalId} is gone`,
    detail: `deleted ${state.folderId}`,
  });
  checks.push({
    ok: after.length === before.length - 1,
    what: "exactly one inbox child was removed",
    detail: `${before.length - after.length} removed; remaining: ${after.map((file) => file.name).join(" ") || "<none>"}`,
  });

  const deck = await readDeck({ auth: await context.auth(), presentationId: state.presentationId });
  notes.push(
    `LEFT IN PLACE: deck ${state.presentationId} with ${deck.pages.length} slide(s), ` +
      `including the inserted ${String(state.insertedPageObjectId)} — the user opens this`,
  );
  context.clearState();
  return verdict({ checks, notes });
}

type HarnessState = Readonly<{
  proposalId: string;
  folderId: string;
  inboxId: string;
  presentationId: string;
  pickedIndex: number;
  insertedPageObjectId: string | null;
  insertedObjectIds: readonly string[];
}>;

/**
 * The composition root: auth, the Drive backend and the proposal side, each opened lazily so a step
 * that needs none of them touches nothing, plus the state file that makes `--step` genuine.
 */
type Context = Readonly<{
  auth(): Promise<OAuth2Client>;
  drive(): Promise<StagingDrive>;
  side(): Promise<ProposalSide>;
  requireState(): HarnessState;
  saveState(state: HarnessState): void;
  clearState(): void;
  close(): Promise<void>;
}>;

function openContext(options: Options): Context {
  const statePath = join(options.workDir, "product-state.json");
  let openedAuth: OAuth2Client | null = null;
  let openedDrive: StagingDrive | null = null;
  let openedSide: ProposalSide | null = null;

  async function auth(): Promise<OAuth2Client> {
    if (openedAuth !== null) return openedAuth;
    const loaded = await loadOAuthClient();
    if (loaded.kind !== "ok") throw new Error(`cannot reach Google: ${describeAuthFailure(loaded)}`);
    openedAuth = loaded.auth;
    return openedAuth;
  }

  async function drive(): Promise<StagingDrive> {
    if (openedDrive !== null) return openedDrive;
    openedDrive = googleStagingDrive({ auth: await auth(), accountLabel: "oauth user" });
    return openedDrive;
  }

  async function side(): Promise<ProposalSide> {
    if (openedSide !== null) return openedSide;
    // The real MCP server first; the in-process reference writer only if it cannot be started, and
    // then loudly, because "the full product" means the product's own propose path.
    const opened = await openMcpProposalSide({ serverPath: SERVER_PATH, repoRoot: REPO_ROOT, startupTimeoutMs: 20_000 });
    if (opened.kind === "ready") {
      console.log(`      mcp server tools: ${opened.tools.join(", ")}`);
      openedSide = opened.side;
      return openedSide;
    }
    console.log(`      WARNING: falling back to the reference writer: ${opened.reason}`);
    openedSide = referenceProposalSide({
      drive: await drive(),
      nowMs: () => Date.now(),
      randomFraction: () => Math.random(),
      faults: [],
    });
    return openedSide;
  }

  return {
    auth,
    drive,
    side,
    requireState() {
      if (!existsSync(statePath)) throw new Error(`no ${statePath} — run --step propose first`);
      // Written by saveState in an earlier step, so its shape is this harness's own invariant; a
      // mismatch is a harness bug and should throw rather than be tolerated.
      const parsed: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error(`${statePath} is not an object`);
      return parsed as HarnessState;
    },
    saveState(state) {
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    },
    clearState() {
      rmSync(statePath, { force: true });
    },
    async close() {
      if (openedSide !== null) await openedSide.close();
    },
  };
}

/** The authoritative-HTML assertion: the pane's srcdoc IS the staged fixture, byte for byte. */
async function htmlPaneCheck({ page, index }: { page: PageSession; index: number }): Promise<Check> {
  const fixture = FIXTURES[index - 1];
  if (fixture === undefined) return { ok: false, what: `fixture ${index} exists`, detail: "no such fixture" };
  const expected = readFileSync(join(HERE, "fixtures", fixture.file), "utf-8");
  // The pane is titled for the candidate it is showing, so waiting on the TITLE waits for the
  // right candidate's document rather than for "some iframe" — the download is asynchronous and a
  // stale pane would otherwise make this assertion a coin toss. The bytes are still compared in
  // full below, so a pane that shows the wrong document is still a hard failure.
  const expectedTitle = `candidate ${index} as HTML`;
  await page.waitFor({
    expression:
      "(() => { const pane = document.querySelector('iframe.sasha-frame');" +
      ` return pane !== null && pane.title === ${JSON.stringify(expectedTitle)} && (pane.srcdoc || '').length > 0; })()`,
    budgetMs: 12_000,
  });
  const title = await page.text("(document.querySelector('iframe.sasha-frame')||{}).title||''");
  const shown = await page.text("(document.querySelector('iframe.sasha-frame')||{}).srcdoc||''");
  const digest = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 12);
  const matches = shown === expected && title === expectedTitle;
  return {
    ok: matches,
    what: `the HTML pane shows the authoritative ${fixture.file} for candidate ${index}`,
    detail: matches
      ? `${JSON.stringify(title)}, ${shown.length}B, sha1:${digest(shown)} — identical to the file propose staged`
      : `pane ${JSON.stringify(title)} sha1:${digest(shown)} (${shown.length}B) != fixture sha1:${digest(expected)} (${expected.length}B)`,
  };
}

function onSlide({ widthPt, heightPt }: { widthPt: number; heightPt: number }): (element: DeckElement) => boolean {
  return (element) =>
    element.widthPt > 0 &&
    element.heightPt > 0 &&
    element.leftPt >= -1 &&
    element.topPt >= -1 &&
    element.leftPt <= widthPt + 1 &&
    element.topPt <= heightPt + 1;
}

async function proposalFolder({
  drive,
  proposalId,
}: {
  drive: StagingDrive;
  proposalId: string;
}): Promise<Readonly<{ inboxId: string; folderId: string }> | null> {
  const inbox = await drive.findFolder({ name: INBOX_FOLDER_NAME, parentId: null });
  if (inbox === null) return null;
  const folder = await drive.findFolder({ name: proposalId, parentId: inbox.id });
  return folder === null ? null : { inboxId: inbox.id, folderId: folder.id };
}

type Health = Readonly<{
  presentationId: string;
  sidebarBytes: number;
  shimBytes: number;
  tokenPrefix: string;
  tokenExpiresAt: string | null;
}>;

async function pollHealth({ port, budgetMs }: { port: number; budgetMs: number }): Promise<Health | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const answered = await health({ port });
    if (answered !== null) return answered;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((done) => setTimeout(done, 250));
  }
}

async function health({ port }: { port: number }): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const record = asRecord(await response.json());
    if (record === null) return null;
    const presentationId = stringAt({ record, key: "presentationId" });
    const tokenPrefix = stringAt({ record, key: "tokenPrefix" });
    if (presentationId === null || tokenPrefix === null) return null;
    return {
      presentationId,
      sidebarBytes: numberAt({ record, key: "sidebarBytes" }),
      shimBytes: numberAt({ record, key: "shimBytes" }),
      tokenPrefix,
      tokenExpiresAt: stringAt({ record, key: "tokenExpiresAt" }),
    };
  } catch {
    // Not up yet, or not up any more. Either way the caller polls.
    return null;
  }
}

type ShimEvidenceRead = Readonly<{
  records: readonly Readonly<{ call: string; detail: string }>[];
  insert:
    | Readonly<{
        presentationId: string;
        pageObjectId: string;
        requestCount: number;
        requestKinds: readonly string[];
        createdObjectIds: readonly string[];
        renderArtifact: string | null;
        batchResponseJson: string;
      }>
    | null;
}>;

/** The probe's own payload, parsed at this boundary like any other untrusted JSON. */
function parseShimEvidence(raw: string): ShimEvidenceRead | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const rawRecords = record["records"];
  const records: Readonly<{ call: string; detail: string }>[] = [];
  if (Array.isArray(rawRecords)) {
    for (const candidate of rawRecords) {
      const entry = asRecord(candidate);
      if (entry === null) continue;
      records.push({ call: stringAt({ record: entry, key: "call" }) ?? "<?>", detail: stringAt({ record: entry, key: "detail" }) ?? "" });
    }
  }
  const rawInsert = asRecord(record["insert"]);
  if (rawInsert === null) return { records, insert: null };
  const presentationId = stringAt({ record: rawInsert, key: "presentationId" });
  const pageObjectId = stringAt({ record: rawInsert, key: "pageObjectId" });
  if (presentationId === null || pageObjectId === null) return { records, insert: null };
  return {
    records,
    insert: {
      presentationId,
      pageObjectId,
      requestCount: numberAt({ record: rawInsert, key: "requestCount" }),
      requestKinds: stringsAt({ record: rawInsert, key: "requestKinds" }),
      createdObjectIds: stringsAt({ record: rawInsert, key: "createdObjectIds" }),
      renderArtifact: stringAt({ record: rawInsert, key: "renderArtifact" }),
      batchResponseJson: stringAt({ record: rawInsert, key: "batchResponseJson" }) ?? "",
    },
  };
}

type PickBody = Readonly<{ proposalId: string; picked: number | null; insertedObjectIds: readonly string[] }>;

function parsePickBody(body: string): PickBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const proposalId = stringAt({ record, key: "proposalId" });
  if (proposalId === null) return null;
  const picked = record["picked"];
  return {
    proposalId,
    picked: typeof picked === "number" ? picked : null,
    insertedObjectIds: stringsAt({ record, key: "insertedObjectIds" }),
  };
}

function verdict({ checks, notes }: { checks: readonly Check[]; notes: readonly string[] }): StepOutcome {
  const broken = checks.filter((check) => !check.ok);
  if (broken.length === 0) return { kind: "pass", checks, notes };
  return {
    kind: "fail",
    reason: broken.map((check) => `${check.what} — ${check.detail}`).join("; "),
    checks,
    notes,
  };
}

function failed({ reason, checks, notes }: { reason: string; checks: readonly Check[]; notes: readonly string[] }): StepOutcome {
  return { kind: "fail", reason, checks, notes };
}

function report(input: Readonly<{ step: StepName; outcome: StepOutcome; seconds: number }>): void {
  const column = `${input.step.padEnd(8)} ${input.seconds.toFixed(2).padStart(6)}s`;
  console.log(`${input.outcome.kind === "pass" ? "PASS" : "FAIL"}  ${column}`);
  if (input.outcome.kind === "fail") {
    console.log(`      WHAT BROKE: ${input.outcome.reason}`);
    console.log(`      invariant:  ${STEP_PURPOSE[input.step]}`);
  }
  for (const check of input.outcome.checks) {
    console.log(`      ${check.ok ? "ok  " : "FAIL"} ${check.what} (${check.detail})`);
  }
  for (const note of input.outcome.notes) console.log(`      . ${note}`);
}

function sidebarUrl(options: Options): string {
  return `http://127.0.0.1:${options.port}/sidebar.html`;
}

type ParsedArguments =
  | Readonly<{ kind: "run"; options: Options }>
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "invalid"; reason: string }>;

function parseArguments(argv: readonly string[]): ParsedArguments {
  let steps: readonly StepName[] = STEP_ORDER;
  let workDir = join(HERE, ".work-product");
  let port = 7342;
  let cdpPort = 9223;
  let presentationId = DEFAULT_PRESENTATION_ID;
  let keepProposal = false;

  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    const value = argv[position + 1];
    switch (flag) {
      case "--list":
      case "--help":
      case "-h":
        return { kind: "list" };
      case "--keep":
        keepProposal = true;
        break;
      case "--only":
      case "--step": {
        if (value === undefined) return { kind: "invalid", reason: `${flag} needs a step name` };
        const requested: StepName[] = [];
        for (const token of value.split(",").filter((entry) => entry.length > 0)) {
          if (!isStepName(token)) return { kind: "invalid", reason: `unknown step "${token}"` };
          requested.push(token);
        }
        if (requested.length === 0) return { kind: "invalid", reason: `${flag} needs a step name` };
        // Kept in canonical order so --step pick,open still runs open first.
        steps = STEP_ORDER.filter((step) => requested.includes(step));
        position += 1;
        break;
      }
      case "--work": {
        if (value === undefined) return { kind: "invalid", reason: "--work needs a directory" };
        workDir = resolve(value);
        position += 1;
        break;
      }
      case "--port":
      case "--cdp-port": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
          return { kind: "invalid", reason: `${flag} takes a port number` };
        }
        if (flag === "--port") port = parsed;
        else cdpPort = parsed;
        position += 1;
        break;
      }
      case "--presentation": {
        if (value === undefined || !/^[A-Za-z0-9_-]{10,}$/.test(value)) {
          return { kind: "invalid", reason: "--presentation takes a Google Slides file id" };
        }
        presentationId = value;
        position += 1;
        break;
      }
      default:
        return { kind: "invalid", reason: `unknown flag "${String(flag)}"` };
    }
  }
  return { kind: "run", options: { steps, workDir, port, cdpPort, presentationId, keepProposal } };
}

/** A parse-boundary guard over an argv token, so it cannot be exhaustive over StepName. */
function isStepName(token: string): token is StepName {
  return STEP_ORDER.includes(token as StepName);
}

function usage(): string {
  const stepLines = STEP_ORDER.map((step) => `    ${step.padEnd(8)} ${STEP_PURPOSE[step]}`).join("\n");
  return [
    "usage: npx tsx mcp/sasha-slides/e2e/product-e2e.ts --step <name[,name]> [flags]",
    "",
    "  --step a,b / --only a    run only these steps, in canonical order (default: all)",
    "  --work DIR               state + screenshots (default mcp/sasha-slides/e2e/.work-product)",
    `  --port N                 the local Sidebar.html host (default 7342)`,
    "  --cdp-port N             the headful, Google-logged-in Chrome (default 9223)",
    `  --presentation ID        the deck to insert into (default ${DEFAULT_PRESENTATION_ID})`,
    "  --keep                   do not delete the proposal folder in cleanup",
    "  --list                   print this and exit",
    "",
    "RUN ONE STEP PER COMMAND: every command here must finish inside 30 s. The host is a service,",
    "started detached by the host step, and it outlives the run.",
    "",
    "steps:",
    stepLines,
  ].join("\n");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numberAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): number {
  const value = record[key];
  return typeof value === "number" ? value : -1;
}

function stringsAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): readonly string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

void main();
