#!/usr/bin/env npx tsx
/**
 * The sasha-slides end-to-end harness: propose four candidate slides, assert the Drive
 * staging layout of PROTOCOL.md, simulate the extension's PICK, and prove the pick plus
 * its anomaly comes back out of `await_pick`.
 *
 *   npx tsx mcp/sasha-slides/e2e/run-e2e.ts                      fake drive, every phase
 *   npx tsx mcp/sasha-slides/e2e/run-e2e.ts --drive real          real Drive + real server
 *   npx tsx mcp/sasha-slides/e2e/run-e2e.ts --drive real --only propose
 *   npx tsx mcp/sasha-slides/e2e/run-e2e.ts --list
 *
 * Every phase prints PASS / FAIL / SKIP with the ids, names and ordering it checked, so a
 * failure names the broken invariant instead of just the broken run. A FAIL stops the run:
 * the phases are a chain, and continuing past a broken link only produces noise.
 *
 * `--only` exists because each phase is its own conclusion and each is independently
 * runnable: the state a phase needs (proposal id, folder id, what PICK promised) is
 * written to `<work>/state.json` by the phase that learned it. That is what keeps a real
 * Drive run inside a 30s command budget — not splitting one job in half.
 *
 * Wrapped in `main()` rather than using top-level await: the root package.json has no
 * "type": "module", so tsx transforms this to CJS where esbuild rejects top-level await.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { loadOAuthClient, describeAuthFailure } from "../google-auth.ts";
import type { Anomaly } from "./protocol-records.ts";
import {
  HTML_MIME,
  INBOX_FOLDER_NAME,
  MANIFEST_NAME,
  PICK_NAME,
  PROTOCOL_VERSION,
  READY_NAME,
  RENDER_FOLDER_NAME,
  SASHA_PROPERTY,
  assertNever,
  parseManifest,
  parseReadyMarker,
  slideFileName,
} from "./protocol-records.ts";
import type { StagedFile } from "./staged-file.ts";
import { childByName, describeChildren, verifyWrittenLast } from "./staged-file.ts";
import type { StagingDrive } from "./staging-drive.ts";
import { fakeStagingDrive } from "./fake-staging-drive.ts";
import { googleStagingDrive } from "./google-staging-drive.ts";
import type { FaultName, ProposalSide } from "./proposal-side.ts";
import { FAULT_NAMES } from "./proposal-side.ts";
import { referenceProposalSide } from "./reference-proposal-side.ts";
import { openMcpProposalSide } from "./mcp-proposal-side.ts";
import { writePick } from "./extension-simulator.ts";

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVER_PATH = join(REPO_ROOT, "mcp", "sasha-slides", "server.ts");
const CHECK_AUTH_PATH = join(REPO_ROOT, ".auth", "check-auth.ts");

const FIXTURES: readonly Readonly<{ file: string; label: string }>[] = [
  { file: "01-text.html", label: "Text only, serif, numbered list" },
  { file: "02-table.html", label: "Table, uneven cell borders" },
  { file: "03-image.html", label: "Embedded png, cropped frame" },
  { file: "04-gradient-shadow.html", label: "Conic gradient, clipped text, glass" },
];

/** What the simulated extension files against the picked slide, and what must come back. */
const EXPECTED_ANOMALY: Anomaly = {
  index: 2,
  note: "double top border on the totals row collapsed to single",
  region: { x: 0.06, y: 0.72, w: 0.88, h: 0.1 },
};

type PhaseName = "auth" | "fixtures" | "propose" | "layout" | "images" | "pick" | "await" | "cleanup";

const PHASE_ORDER: readonly PhaseName[] = [
  "auth",
  "fixtures",
  "propose",
  "layout",
  "images",
  "pick",
  "await",
  "cleanup",
];

const PHASE_PURPOSE: Readonly<Record<PhaseName, string>> = {
  auth: "check-auth.ts passes (hard gate on real Drive)",
  fixtures: "the 4 candidate HTML files are self-contained 1280x720 documents",
  propose: "propose_slides takes paths and returns ids only",
  layout: "Drive matches PROTOCOL.md: folders, 01..NN.html, manifest, READY last",
  images: "slide_images answers for the staged proposal",
  pick: "the extension writes PICK (option 2 + one anomaly) and nothing else",
  await: "await_pick returns that pick and that anomaly",
  cleanup: "the proposal folder is removed",
};

type DriveMode = "fake" | "real";
type ServerMode = "auto" | "mcp" | "reference";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "invalid") {
    console.error(`sasha-slides E2E: ${parsed.reason}\n`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (parsed.kind === "list") {
    console.log(usage());
    process.exitCode = 0;
    return;
  }
  process.exitCode = await runHarness(parsed.options);
}

type Options = Readonly<{
  driveMode: DriveMode;
  serverMode: ServerMode;
  phases: readonly PhaseName[];
  workDir: string;
  keepProposal: boolean;
  pickedIndex: number;
  budgetSeconds: number;
  /** Harness-only protocol violations; see FaultName. Empty for a real run. */
  faults: readonly FaultName[];
}>;

async function runHarness(options: Options): Promise<number> {
  mkdirSync(options.workDir, { recursive: true });
  const context = openContext(options);

  console.log(
    `\nsasha-slides E2E — drive=${options.driveMode} server=${options.serverMode} ` +
      (options.faults.length > 0 ? `INJECTED FAULTS=[${options.faults.join(",")}] ` : "") +
      `work=${options.workDir} budget=${options.budgetSeconds}s`,
  );
  console.log(`phases: ${options.phases.join(" -> ")}\n`);

  const startedAt = Date.now();
  const tally = { passed: 0, failed: 0, skipped: 0 };
  const notRun: PhaseName[] = [];

  try {
    for (const [position, phase] of options.phases.entries()) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds > options.budgetSeconds) {
        notRun.push(...options.phases.slice(position));
        console.log(
          `STOP  budget of ${options.budgetSeconds}s spent after ${elapsedSeconds.toFixed(2)}s — ` +
            `re-run the rest with --only ${options.phases.slice(position).join(",")}`,
        );
        break;
      }

      const phaseStartedAt = Date.now();
      const outcome = await runPhaseSafely({ phase, context, options, startedAt });
      report({ phase, outcome, seconds: (Date.now() - phaseStartedAt) / 1000 });

      switch (outcome.kind) {
        case "pass":
          tally.passed += 1;
          break;
        case "skip":
          tally.skipped += 1;
          break;
        case "fail":
          tally.failed += 1;
          notRun.push(...options.phases.slice(position + 1));
          break;
        default:
          assertNever(outcome);
      }
      if (outcome.kind === "fail") break;
    }
  } finally {
    await context.close();
  }

  if (notRun.length > 0) console.log(`\nnot run: ${notRun.join(", ")}`);
  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(
    `\n=== ${tally.passed} passed, ${tally.failed} failed, ${tally.skipped} skipped in ${totalSeconds}s ===\n`,
  );
  return tally.failed > 0 ? 1 : 0;
}

type PhaseOutcome =
  | Readonly<{ kind: "pass"; evidence: readonly string[] }>
  | Readonly<{ kind: "fail"; reason: string; evidence: readonly string[] }>
  | Readonly<{ kind: "skip"; reason: string }>;

async function runPhaseSafely(
  input: Readonly<{ phase: PhaseName; context: Context; options: Options; startedAt: number }>,
): Promise<PhaseOutcome> {
  try {
    return await runPhase(input);
  } catch (cause) {
    // A thrown phase is still a FAIL with evidence; the stack goes to stderr so the
    // PASS/FAIL column stays readable.
    if (cause instanceof Error && cause.stack !== undefined) console.error(cause.stack);
    return { kind: "fail", reason: describe(cause), evidence: [] };
  }
}

async function runPhase(
  input: Readonly<{ phase: PhaseName; context: Context; options: Options; startedAt: number }>,
): Promise<PhaseOutcome> {
  const { phase, context, options } = input;
  switch (phase) {
    case "auth":
      return phaseAuth({ driveMode: options.driveMode });
    case "fixtures":
      return phaseFixtures();
    case "propose":
      return phasePropose({ context, options });
    case "layout":
      return phaseLayout({ context });
    case "images":
      return phaseImages({ context });
    case "pick":
      return phasePick({ context, options });
    case "await":
      return phaseAwait({ context, options, startedAt: input.startedAt });
    case "cleanup":
      return phaseCleanup({ context, options });
    default:
      return assertNever(phase);
  }
}

/**
 * The precondition. On real Drive this is a hard gate including `--write`, which proves
 * the two calls the server actually makes (Slides create, Drive delete). On the fake
 * backend there is nothing to authenticate, so the verdict is reported and the phase
 * skips — running the rest against absent credentials is exactly what must not happen.
 */
function phaseAuth(options: Readonly<{ driveMode: DriveMode }>): PhaseOutcome {
  const args = options.driveMode === "real" ? [CHECK_AUTH_PATH, "--write"] : [CHECK_AUTH_PATH];
  const probe = runCommand({ command: "npx", args: ["tsx", ...args], timeoutMs: 25_000 });
  const evidence = [`$ npx tsx ${args.join(" ")}`, ...probe.output.split("\n").filter((line) => line.length > 0)];

  if (options.driveMode === "fake") {
    return {
      kind: "skip",
      reason:
        `--drive fake needs no Google credentials. check-auth said: ${firstLine(probe.output) || "<no output>"}` +
        ` (exit ${probe.status})`,
    };
  }
  if (probe.status !== 0) {
    return { kind: "fail", reason: `check-auth.ts exited ${probe.status}; refusing to touch Drive`, evidence };
  }
  return { kind: "pass", evidence };
}

function phaseFixtures(): PhaseOutcome {
  const evidence: string[] = [];
  const digests = new Set<string>();
  for (const fixture of FIXTURES) {
    const path = join(HERE, "fixtures", fixture.file);
    if (!existsSync(path)) return { kind: "fail", reason: `missing fixture ${path}`, evidence };
    const html = readFileSync(path, "utf-8");
    const digest = createHash("sha1").update(html).digest("hex").slice(0, 10);
    digests.add(digest);
    evidence.push(`${fixture.file}  ${html.length}B  sha1:${digest}  "${fixture.label}"`);

    const missing = ["<!doctype html", "<html", "<head", "width: 1280px", "height: 720px"].filter(
      (needle) => !html.toLowerCase().includes(needle),
    );
    if (missing.length > 0) {
      return {
        kind: "fail",
        reason: `${fixture.file} is not a self-contained 1280x720 document — missing ${missing.join(", ")}`,
        evidence,
      };
    }
  }
  if (digests.size !== FIXTURES.length) {
    return { kind: "fail", reason: "two fixtures are byte-identical; the anomalies would not be distinguishable", evidence };
  }
  return { kind: "pass", evidence };
}

async function phasePropose(input: Readonly<{ context: Context; options: Options }>): Promise<PhaseOutcome> {
  const side = await input.context.side();
  const htmlPaths = FIXTURES.map((fixture) => join(HERE, "fixtures", fixture.file));
  const outcome = await side.propose({
    htmlPaths,
    labels: FIXTURES.map((fixture) => fixture.label),
    presentationId: null,
  });

  const evidence = [
    `side: ${side.describe}`,
    `paths in: ${htmlPaths.map((path) => path.replace(`${REPO_ROOT}/`, "")).join(" ")}`,
    `proposalId=${outcome.proposalId} count=${outcome.count}`,
    `ids out: ${outcome.slides.map((slide) => `${slide.index}:${slide.name}=${slide.fileId}`).join(" ")}`,
  ];

  if (outcome.count !== FIXTURES.length || outcome.slides.length !== FIXTURES.length) {
    return {
      kind: "fail",
      reason: `propose reported count=${outcome.count} with ${outcome.slides.length} entries for ${FIXTURES.length} paths`,
      evidence,
    };
  }
  for (const [position, slide] of outcome.slides.entries()) {
    const index = position + 1;
    if (slide.index !== index) {
      return { kind: "fail", reason: `propose is not 1-based ascending: got index ${slide.index} at position ${position}`, evidence };
    }
    if (slide.name !== slideFileName(index)) {
      return { kind: "fail", reason: `propose named slide ${index} "${slide.name}", expected ${slideFileName(index)}`, evidence };
    }
  }
  // "paths in, ids out": the reply must carry no markup back into the model's context.
  if (JSON.stringify(outcome).includes("<")) {
    return { kind: "fail", reason: "propose echoed slide markup back in its reply", evidence };
  }

  input.context.saveState({
    driveMode: input.options.driveMode,
    sideDescribe: side.describe,
    proposalId: outcome.proposalId,
    folderId: outcome.folderId,
    manifestFileId: outcome.manifestFileId,
    slideFileIds: outcome.slides.map((slide) => slide.fileId),
    expectedPick: input.options.pickedIndex,
    expectedAnomaly: EXPECTED_ANOMALY,
  });
  return { kind: "pass", evidence };
}

/**
 * The proposal folder, found the way the extension has to find it: by name under the
 * inbox. `propose_slides` does not return a folder id, so this is the only route — and
 * when a side does report one, it is cross-checked against what is discoverable.
 */
async function resolveProposalFolder(
  input: Readonly<{ drive: StagingDrive; state: HarnessState }>,
): Promise<
  | Readonly<{ kind: "ok"; inbox: StagedFile; folder: StagedFile }>
  | Readonly<{ kind: "missing"; reason: string }>
> {
  const inbox = await input.drive.findFolder({ name: INBOX_FOLDER_NAME, parentId: null });
  if (inbox === null) return { kind: "missing", reason: `no "${INBOX_FOLDER_NAME}" folder at the Drive root` };
  const folder = await input.drive.findFolder({ name: input.state.proposalId, parentId: inbox.id });
  if (folder === null) {
    return { kind: "missing", reason: `no folder named ${input.state.proposalId} under the inbox` };
  }
  if (input.state.folderId !== null && input.state.folderId !== folder.id) {
    return {
      kind: "missing",
      reason: `inbox child ${input.state.proposalId} is ${folder.id} but propose reported ${input.state.folderId}`,
    };
  }
  return { kind: "ok", inbox, folder };
}

/** Every structural invariant PROTOCOL.md states about a staged proposal folder. */
async function phaseLayout(input: Readonly<{ context: Context }>): Promise<PhaseOutcome> {
  const drive = await input.context.drive();
  const state = input.context.requireState();
  const evidence: string[] = [`drive: ${drive.describe}`];

  const located = await resolveProposalFolder({ drive, state });
  if (located.kind === "missing") return { kind: "fail", reason: located.reason, evidence };
  const { inbox, folder } = located;
  evidence.push(`inbox: ${inbox.id} appProperties=${JSON.stringify(inbox.appProperties)}`);
  if (inbox.appProperties[SASHA_PROPERTY] !== "inbox") {
    return { kind: "fail", reason: `inbox folder is not tagged ${SASHA_PROPERTY}=inbox`, evidence };
  }
  if (
    folder.appProperties[SASHA_PROPERTY] !== "proposal" ||
    folder.appProperties["proposalId"] !== state.proposalId
  ) {
    return {
      kind: "fail",
      reason: `proposal folder appProperties are ${JSON.stringify(folder.appProperties)}`,
      evidence,
    };
  }
  evidence.push(`proposal folder: ${folder.id} appProperties=${JSON.stringify(folder.appProperties)}`);

  const children = await drive.listChildren({ parentId: folder.id });
  evidence.push(`children: ${describeChildren(children)}`);

  const expectedNames = [
    ...FIXTURES.map((_fixture, position) => slideFileName(position + 1)),
    MANIFEST_NAME,
    READY_NAME,
  ];
  // `render/` holds the extension's PNGs and is the one thing it may write besides PICK,
  // so it is allowed here but never required — and it is excluded from the write-order
  // check below, since it legitimately lands after READY.
  const serverWritten = children.filter((child) => child.name !== RENDER_FOLDER_NAME);
  const actualNames = serverWritten.map((child) => child.name).sort();
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  const absent = expectedNames.filter((name) => !actualNames.includes(name));
  if (absent.length > 0 || unexpected.length > 0) {
    return {
      kind: "fail",
      reason: `folder contents wrong — missing [${absent.join(",")}] unexpected [${unexpected.join(",")}]`,
      evidence,
    };
  }

  // Write ORDER before write CONTENT: "READY last" is the invariant an observer stakes
  // everything on, so a violation of it should be the headline, not a side effect found
  // while cross-checking ids.
  const lastWrite = verifyWrittenLast({ files: serverWritten, name: READY_NAME });
  switch (lastWrite.kind) {
    case "last":
      evidence.push(
        `${READY_NAME} written last of the server's ${serverWritten.length} writes at ${lastWrite.atMs}`,
      );
      break;
    case "not-last":
      return {
        kind: "fail",
        reason: `${READY_NAME} was NOT written last — these landed after it: ${lastWrite.createdAfter.join(", ")}`,
        evidence,
      };
    case "tied":
      return {
        kind: "fail",
        reason:
          `${READY_NAME} shares its creation timestamp (${lastWrite.atMs}) with ${lastWrite.withNames.join(", ")}, ` +
          "so the backend cannot prove it was written last",
        evidence,
      };
    case "absent":
      return { kind: "fail", reason: `no ${READY_NAME} in the proposal folder`, evidence };
    default:
      return assertNever(lastWrite);
  }

  for (const [position, fixture] of FIXTURES.entries()) {
    const index = position + 1;
    const name = slideFileName(index);
    const slide = childByName(children, name);
    if (slide === null) return { kind: "fail", reason: `no ${name}`, evidence };
    const tags = slide.appProperties;
    if (
      tags[SASHA_PROPERTY] !== "slide" ||
      tags["proposalId"] !== state.proposalId ||
      tags["index"] !== String(index)
    ) {
      return {
        kind: "fail",
        reason: `${name} appProperties are ${JSON.stringify(tags)}, expected slide/${state.proposalId}/${index}`,
        evidence,
      };
    }
    if (slide.mimeType !== HTML_MIME) {
      return { kind: "fail", reason: `${name} has mimeType ${slide.mimeType}, expected ${HTML_MIME}`, evidence };
    }
    if (!state.slideFileIds.includes(slide.id)) {
      return { kind: "fail", reason: `${name} is ${slide.id}, which propose never reported`, evidence };
    }
    evidence.push(`${name} -> ${slide.id} index=${tags["index"]} (${fixture.label})`);
  }

  const manifestFile = childByName(children, MANIFEST_NAME);
  if (manifestFile === null) return { kind: "fail", reason: `no ${MANIFEST_NAME}`, evidence };
  const manifestParse = parseManifest(await drive.readFile({ id: manifestFile.id }));
  if (manifestParse.kind === "invalid") {
    return { kind: "fail", reason: `${MANIFEST_NAME} is malformed — ${manifestParse.reason}`, evidence };
  }
  const manifest = manifestParse.value;
  evidence.push(
    `manifest: version=${manifest.protocolVersion} count=${manifest.count} ` +
      `presentationId=${String(manifest.presentationId)} indices=${manifest.slides.map((slide) => slide.index).join(",")}`,
  );
  if (manifest.protocolVersion !== PROTOCOL_VERSION) {
    return { kind: "fail", reason: `manifest protocolVersion is ${manifest.protocolVersion}`, evidence };
  }
  if (manifest.proposalId !== state.proposalId) {
    return { kind: "fail", reason: `manifest proposalId is ${manifest.proposalId}`, evidence };
  }
  if (manifest.count !== FIXTURES.length || manifest.slides.length !== FIXTURES.length) {
    return {
      kind: "fail",
      reason: `manifest says count=${manifest.count} with ${manifest.slides.length} entries, expected ${FIXTURES.length}`,
      evidence,
    };
  }
  for (const [position, slide] of manifest.slides.entries()) {
    const index = position + 1;
    if (slide.index !== index) {
      return { kind: "fail", reason: `manifest slides are not 1-based ascending: got ${slide.index} at ${position}`, evidence };
    }
    if (slide.name !== slideFileName(index)) {
      return { kind: "fail", reason: `manifest slide ${index} is named ${slide.name}`, evidence };
    }
    const onDrive = childByName(children, slide.name);
    if (onDrive === null || onDrive.id !== slide.fileId) {
      return {
        kind: "fail",
        reason: `manifest slide ${index} points at ${slide.fileId} but ${slide.name} is ${onDrive?.id ?? "absent"}`,
        evidence,
      };
    }
    if (slide.label.includes("<")) {
      return { kind: "fail", reason: `manifest label for slide ${index} looks like transcribed markup`, evidence };
    }
  }

  const readyFile = childByName(children, READY_NAME);
  if (readyFile === null) return { kind: "fail", reason: `no ${READY_NAME}`, evidence };
  const readyParse = parseReadyMarker(await drive.readFile({ id: readyFile.id }));
  if (readyParse.kind === "invalid") {
    return { kind: "fail", reason: `${READY_NAME} is malformed — ${readyParse.reason}`, evidence };
  }
  const ready = readyParse.value;
  evidence.push(
    `READY: version=${ready.protocolVersion} count=${ready.count} manifestFileId=${ready.manifestFileId}`,
  );
  if (ready.protocolVersion !== PROTOCOL_VERSION || ready.proposalId !== state.proposalId) {
    return { kind: "fail", reason: `READY identifies ${ready.proposalId} at version ${ready.protocolVersion}`, evidence };
  }
  if (ready.count !== FIXTURES.length) {
    return { kind: "fail", reason: `READY says count=${ready.count}`, evidence };
  }
  if (ready.manifestFileId !== manifestFile.id) {
    return {
      kind: "fail",
      reason: `READY.manifestFileId=${ready.manifestFileId} but ${MANIFEST_NAME} is ${manifestFile.id}`,
      evidence,
    };
  }

  const side = await input.context.side();
  const stateReply = await side.state({ proposalId: state.proposalId });
  switch (stateReply.kind) {
    case "ok":
      evidence.push(`proposal_state: ${stateReply.summary}`);
      break;
    case "unsupported":
      evidence.push(`proposal_state: unsupported — ${stateReply.reason}`);
      break;
    default:
      return assertNever(stateReply);
  }
  evidence.push(`manifest file: ${manifestFile.id}`);

  return { kind: "pass", evidence };
}

async function phaseImages(input: Readonly<{ context: Context }>): Promise<PhaseOutcome> {
  const side = await input.context.side();
  const state = input.context.requireState();
  const outDir = join(input.context.workDir, "images");
  mkdirSync(outDir, { recursive: true });
  const reply = await side.images({ proposalId: state.proposalId, outDir });
  switch (reply.kind) {
    case "ok":
      // Paths, never image data. Reading one is the caller's choice, not the tool's.
      return {
        kind: "pass",
        evidence: [
          `slide_images -> ${reply.files.length} file(s) under ${outDir}`,
          ...reply.files.map((file) => `  ${file.index}: ${file.path}`),
        ],
      };
    case "unavailable":
      return {
        kind: "skip",
        reason: `slide_images says unavailable — ${reply.reason} (expected: conversion is client-side and no extension has run)`,
      };
    case "unsupported":
      return { kind: "skip", reason: reply.reason };
    default:
      return assertNever(reply);
  }
}

async function phasePick(input: Readonly<{ context: Context; options: Options }>): Promise<PhaseOutcome> {
  const drive = await input.context.drive();
  const state = input.context.requireState();
  const located = await resolveProposalFolder({ drive, state });
  if (located.kind === "missing") return { kind: "fail", reason: located.reason, evidence: [] };
  const folderId = located.folder.id;
  const before = await drive.listChildren({ parentId: folderId });
  const evidence = [`before: ${describeChildren(before)}`];

  // Injected violation: PICK names an option the harness never chose, so `await` must
  // notice the mismatch rather than echoing whatever came back.
  const pickedOnDrive = input.options.faults.includes("tamper-pick")
    ? (input.options.pickedIndex % FIXTURES.length) + 1
    : input.options.pickedIndex;
  const written = await writePick({
    drive,
    folderId,
    proposalId: state.proposalId,
    picked: pickedOnDrive,
    insertedObjectIds: [],
    anomalies: [EXPECTED_ANOMALY],
    nowMs: Date.now(),
  });
  evidence.push(
    `wrote ${PICK_NAME} ${written.fileId}: picked=${String(written.record.picked)} ` +
      `anomalies=${JSON.stringify(written.record.anomalies)}`,
  );

  const after = await drive.listChildren({ parentId: folderId });
  evidence.push(`after: ${describeChildren(after)}`);

  const added = after.filter((file) => !before.some((earlier) => earlier.id === file.id)).map((file) => file.name);
  if (added.length !== 1 || added[0] !== PICK_NAME) {
    return { kind: "fail", reason: `writing the pick added [${added.join(",")}], expected only ${PICK_NAME}`, evidence };
  }
  const removed = before.filter((file) => !after.some((later) => later.id === file.id)).map((file) => file.name);
  if (removed.length > 0) {
    return { kind: "fail", reason: `writing the pick removed [${removed.join(",")}]`, evidence };
  }

  // The extension only ever sees a finished proposal, so PICK must land after READY.
  const pickFile = childByName(after, PICK_NAME);
  const readyFile = childByName(after, READY_NAME);
  if (pickFile === null || readyFile === null) {
    return { kind: "fail", reason: `expected both ${PICK_NAME} and ${READY_NAME} after the write`, evidence };
  }
  if (pickFile.createdAtMs < readyFile.createdAtMs) {
    return {
      kind: "fail",
      reason: `${PICK_NAME} (${pickFile.createdAtMs}) predates ${READY_NAME} (${readyFile.createdAtMs})`,
      evidence,
    };
  }

  input.context.saveState({ ...state, expectedPick: input.options.pickedIndex, expectedAnomaly: EXPECTED_ANOMALY });
  return { kind: "pass", evidence };
}

async function phaseAwait(
  input: Readonly<{ context: Context; options: Options; startedAt: number }>,
): Promise<PhaseOutcome> {
  const side = await input.context.side();
  const state = input.context.requireState();
  const spentMs = Date.now() - input.startedAt;
  // At least a second, and never more than what is left of the command budget: a longer
  // wait would be killed by the watchdog with no evidence instead of failing cleanly.
  const timeoutSeconds = Math.max(1, Math.floor((input.options.budgetSeconds * 1000 - spentMs - 1_000) / 1000));

  const pick = await side.awaitPick({ proposalId: state.proposalId, timeoutSeconds });
  const evidence = [
    `await_pick(timeoutSeconds=${timeoutSeconds}) -> status=${pick.status} picked=${String(pick.picked)} ` +
      `decidedAt=${String(pick.decidedAt)}`,
    `anomalies: ${JSON.stringify(pick.anomalies)}`,
    ...(pick.note === null ? [] : [`note: ${pick.note}`]),
  ];

  if (pick.status !== "picked") {
    return {
      kind: "fail",
      reason: `await_pick returned status "${pick.status}"; a PICK naming option ${state.expectedPick} is on Drive`,
      evidence,
    };
  }
  if (pick.picked !== state.expectedPick) {
    return {
      kind: "fail",
      reason: `await_pick returned option ${String(pick.picked)}, the extension chose ${state.expectedPick}`,
      evidence,
    };
  }
  if (pick.anomalies.length !== 1) {
    return { kind: "fail", reason: `await_pick returned ${pick.anomalies.length} anomalies, expected 1`, evidence };
  }
  const anomaly = pick.anomalies[0];
  const expected = state.expectedAnomaly;
  if (anomaly === undefined) return { kind: "fail", reason: "the anomaly array has a hole", evidence };
  if (anomaly.index !== expected.index || anomaly.note !== expected.note) {
    return {
      kind: "fail",
      reason: `anomaly came back as index=${anomaly.index} note=${JSON.stringify(anomaly.note)}`,
      evidence,
    };
  }
  if (JSON.stringify(anomaly.region) !== JSON.stringify(expected.region)) {
    return {
      kind: "fail",
      reason: `anomaly region came back as ${JSON.stringify(anomaly.region)}, expected ${JSON.stringify(expected.region)}`,
      evidence,
    };
  }
  evidence.push(`option ${expected.index} (1-based) + its anomaly round-tripped intact`);
  return { kind: "pass", evidence };
}

async function phaseCleanup(input: Readonly<{ context: Context; options: Options }>): Promise<PhaseOutcome> {
  const state = input.context.requireState();
  if (input.options.keepProposal) {
    return {
      kind: "skip",
      reason: `--keep: ${state.proposalId} left on the ${input.options.driveMode} drive`,
    };
  }
  const drive = await input.context.drive();
  const located = await resolveProposalFolder({ drive, state });
  if (located.kind === "missing") return { kind: "fail", reason: located.reason, evidence: [] };

  // Counted before and after, so an over-delete is visible rather than inferred.
  const inboxBefore = await drive.listChildren({ parentId: located.inbox.id });
  await drive.deleteFile({ id: located.folder.id });
  const remaining = await drive.listChildren({ parentId: located.inbox.id });
  const evidence = [
    `deleted ${located.folder.id} (${state.proposalId})`,
    `inbox: ${inboxBefore.length} folder(s) before, ${remaining.length} after — ` +
      `${remaining.map((file) => file.name).join(" ") || "<none>"}`,
  ];
  if (remaining.some((file) => file.id === located.folder.id)) {
    return { kind: "fail", reason: "the proposal folder survived the delete", evidence };
  }
  if (remaining.length !== inboxBefore.length - 1) {
    return {
      kind: "fail",
      reason: `the delete removed ${inboxBefore.length - remaining.length} inbox children, expected exactly 1`,
      evidence,
    };
  }
  input.context.clearState();
  return { kind: "pass", evidence };
}

type HarnessState = Readonly<{
  driveMode: DriveMode;
  sideDescribe: string;
  proposalId: string;
  /** null when propose_slides did not report one; the folder is then found by name. */
  folderId: string | null;
  manifestFileId: string | null;
  slideFileIds: readonly string[];
  expectedPick: number;
  expectedAnomaly: Anomaly;
}>;

/**
 * The composition root: it owns the backend and the proposal side, opens each lazily (so
 * `--only fixtures` never touches Drive), and persists the cross-phase state that makes
 * `--only` genuine rather than cosmetic.
 */
type Context = Readonly<{
  workDir: string;
  drive(): Promise<StagingDrive>;
  side(): Promise<ProposalSide>;
  requireState(): HarnessState;
  saveState(state: HarnessState): void;
  clearState(): void;
  close(): Promise<void>;
}>;

function openContext(options: Options): Context {
  const statePath = join(options.workDir, "state.json");
  let openedDrive: StagingDrive | null = null;
  let openedSide: ProposalSide | null = null;

  async function drive(): Promise<StagingDrive> {
    if (openedDrive !== null) return openedDrive;
    openedDrive = await openDrive(options);
    return openedDrive;
  }

  async function side(): Promise<ProposalSide> {
    if (openedSide !== null) return openedSide;
    openedSide = await openSide({ options, drive: await drive() });
    return openedSide;
  }

  return {
    workDir: options.workDir,
    drive,
    side,
    requireState() {
      if (!existsSync(statePath)) {
        throw new Error(`no ${statePath} — run the "propose" phase first (or drop --only)`);
      }
      return readState(statePath);
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

async function openDrive(options: Options): Promise<StagingDrive> {
  switch (options.driveMode) {
    case "fake":
      return fakeStagingDrive({ root: join(options.workDir, "drive") });
    case "real": {
      const loaded = await loadOAuthClient();
      if (loaded.kind !== "ok") throw new Error(`cannot open real Drive: ${describeAuthFailure(loaded)}`);
      return googleStagingDrive({ auth: loaded.auth, accountLabel: loaded.granted.length > 0 ? "oauth user" : "unknown" });
    }
    default:
      return assertNever(options.driveMode);
  }
}

async function openSide(input: Readonly<{ options: Options; drive: StagingDrive }>): Promise<ProposalSide> {
  const reference = (): ProposalSide =>
    referenceProposalSide({
      drive: input.drive,
      nowMs: () => Date.now(),
      randomFraction: () => Math.random(),
      faults: input.options.faults,
    });

  switch (input.options.serverMode) {
    case "reference":
      return reference();
    case "mcp": {
      const opened = await openMcpProposalSide({
        serverPath: SERVER_PATH,
        repoRoot: REPO_ROOT,
        startupTimeoutMs: 20_000,
      });
      if (opened.kind === "absent") throw new Error(`--server mcp: ${opened.reason}`);
      console.log(`      mcp server tools: ${opened.tools.join(", ")}`);
      return opened.side;
    }
    case "auto": {
      // The fake backend is local to this process, so the real server — which talks to
      // real Drive — cannot be pointed at it. Fake drive therefore implies the reference
      // side, and that is said out loud rather than inferred by the reader.
      if (input.options.driveMode === "fake") {
        console.log("      server=auto + drive=fake -> reference side (the real server cannot see a local fake Drive)");
        return reference();
      }
      const opened = await openMcpProposalSide({
        serverPath: SERVER_PATH,
        repoRoot: REPO_ROOT,
        startupTimeoutMs: 20_000,
      });
      if (opened.kind === "ready") {
        console.log(`      mcp server tools: ${opened.tools.join(", ")}`);
        return opened.side;
      }
      console.log(`      server=auto -> reference side: ${opened.reason}`);
      return reference();
    }
    default:
      return assertNever(input.options.serverMode);
  }
}

function readState(statePath: string): HarnessState {
  // Written by saveState in an earlier phase, so its shape is this harness's own
  // invariant; a mismatch is a harness bug and should throw rather than be tolerated.
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${statePath} is not an object`);
  return parsed as HarnessState;
}

type ParsedArguments =
  | Readonly<{ kind: "run"; options: Options }>
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "invalid"; reason: string }>;

function parseArguments(argv: readonly string[]): ParsedArguments {
  let driveMode: DriveMode = "fake";
  let serverMode: ServerMode = "auto";
  let phases: readonly PhaseName[] = PHASE_ORDER;
  let workDir = join(HERE, ".work");
  let keepProposal = false;
  let pickedIndex = 2;
  let budgetSeconds = 25;
  let faults: readonly FaultName[] = [];

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
      case "--drive": {
        if (value !== "fake" && value !== "real") return { kind: "invalid", reason: "--drive takes fake|real" };
        driveMode = value;
        position += 1;
        break;
      }
      case "--server": {
        if (value !== "auto" && value !== "mcp" && value !== "reference") {
          return { kind: "invalid", reason: "--server takes auto|mcp|reference" };
        }
        serverMode = value;
        position += 1;
        break;
      }
      case "--only":
      case "--step": {
        if (value === undefined) return { kind: "invalid", reason: `${flag} needs a phase name` };
        const requested: PhaseName[] = [];
        for (const token of value.split(",").filter((entry) => entry.length > 0)) {
          if (!isPhaseName(token)) return { kind: "invalid", reason: `unknown phase "${token}"` };
          requested.push(token);
        }
        if (requested.length === 0) return { kind: "invalid", reason: `${flag} needs a phase name` };
        // Kept in canonical order so --only await,pick still runs pick first.
        phases = PHASE_ORDER.filter((phase) => requested.includes(phase));
        position += 1;
        break;
      }
      case "--work": {
        if (value === undefined) return { kind: "invalid", reason: "--work needs a directory" };
        workDir = resolve(value);
        position += 1;
        break;
      }
      case "--picked": {
        const index = Number(value);
        if (!Number.isInteger(index) || index < 1 || index > FIXTURES.length) {
          return { kind: "invalid", reason: `--picked takes a 1-based index in 1..${FIXTURES.length}` };
        }
        pickedIndex = index;
        position += 1;
        break;
      }
      case "--inject": {
        if (value === undefined) return { kind: "invalid", reason: `--inject takes ${FAULT_NAMES.join("|")}` };
        const requested: FaultName[] = [];
        for (const token of value.split(",").filter((entry) => entry.length > 0)) {
          if (!isFaultName(token)) return { kind: "invalid", reason: `unknown fault "${token}"` };
          requested.push(token);
        }
        faults = requested;
        position += 1;
        break;
      }
      case "--budget-seconds": {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return { kind: "invalid", reason: "--budget-seconds takes a positive number" };
        }
        budgetSeconds = seconds;
        position += 1;
        break;
      }
      default:
        return { kind: "invalid", reason: `unknown flag "${String(flag)}"` };
    }
  }

  return {
    kind: "run",
    options: { driveMode, serverMode, phases, workDir, keepProposal, pickedIndex, budgetSeconds, faults },
  };
}

/**
 * A parse-boundary guard over an argv token, so it cannot be exhaustive over PhaseName.
 * A new phase must be added here by hand — which is why PHASE_PURPOSE is a total
 * Record<PhaseName, string> that fails to compile when one is missed.
 */
function isPhaseName(token: string): token is PhaseName {
  return PHASE_ORDER.includes(token as PhaseName);
}

/** The same parse-boundary guard, over --inject's argv token. */
function isFaultName(token: string): token is FaultName {
  return FAULT_NAMES.includes(token as FaultName);
}

function report(input: Readonly<{ phase: PhaseName; outcome: PhaseOutcome; seconds: number }>): void {
  const column = `${input.phase.padEnd(9)} ${input.seconds.toFixed(2).padStart(6)}s`;
  switch (input.outcome.kind) {
    case "pass":
      console.log(`PASS  ${column}`);
      for (const line of input.outcome.evidence) console.log(`      ${line}`);
      return;
    case "skip":
      console.log(`SKIP  ${column}`);
      console.log(`      ${input.outcome.reason}`);
      return;
    case "fail":
      console.log(`FAIL  ${column}`);
      console.log(`      WHAT BROKE: ${input.outcome.reason}`);
      console.log(`      invariant:  ${PHASE_PURPOSE[input.phase]}`);
      for (const line of input.outcome.evidence) console.log(`      ${line}`);
      return;
    default:
      assertNever(input.outcome);
  }
}

function runCommand(
  options: Readonly<{ command: string; args: readonly string[]; timeoutMs: number }>,
): Readonly<{ status: number; output: string }> {
  try {
    const stdout = execFileSync(options.command, [...options.args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: options.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (cause) {
    const failure = cause as Readonly<{ status?: number | null; stdout?: string; stderr?: string }>;
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` || describe(cause),
    };
  }
}

function usage(): string {
  const phaseLines = PHASE_ORDER.map((phase) => `    ${phase.padEnd(9)} ${PHASE_PURPOSE[phase]}`).join("\n");
  return [
    "usage: npx tsx mcp/sasha-slides/e2e/run-e2e.ts [flags]",
    "",
    "  --drive fake|real        staging backend (default fake; real needs .auth credentials)",
    "  --server auto|mcp|reference",
    "                           auto = real server when mcp/sasha-slides/server.ts exists and",
    "                           --drive real, otherwise the in-process reference writer",
    "  --only a,b  / --step a   run only these phases, in canonical order",
    "  --work DIR               scratch + fake-drive root (default mcp/sasha-slides/e2e/.work)",
    "  --picked N               1-based option the simulated extension chooses (default 2)",
    "  --budget-seconds N       stop before exceeding this wall clock (default 25)",
    "  --keep                   do not delete the proposal folder",
    `  --inject a,b             break the protocol on purpose (${FAULT_NAMES.join("|")}) — proves`,
    "                           the assertions bite; every one of them must turn a phase red",
    "  --list                   print this and exit",
    "",
    "phases:",
    phaseLines,
  ].join("\n");
}

function firstLine(text: string): string {
  const [line] = text.split("\n");
  return (line ?? "").trim();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

void main();
