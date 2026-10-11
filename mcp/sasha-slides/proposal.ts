/**
 * The staging protocol of PROTOCOL.md, expressed against the injected `DriveChannel` so it
 * can be exercised end to end with no credentials (see `test/proposal.test.ts`).
 *
 * Two properties of this file are load-bearing and easy to break:
 *
 *  - **`READY` is written last.** `createProposal` awaits each upload in sequence — slide
 *    HTML, then `manifest.json`, then `READY` — so an observer that sees `READY` may assume
 *    the proposal is complete. Parallelising those uploads would silently violate the
 *    contract, which is why the test asserts on the channel's recorded call order rather
 *    than on the final set of files.
 *  - **Slide HTML is never read here.** Paths go in as `DriveMedia` and the channel streams
 *    them; nothing in this module ever opens a slide's contents.
 */
import { countUnresolvedThreads, type FeedbackEnvironment } from "./feedback/feedback.ts";
import type { DriveChannel, DriveFile, DriveMedia, SashaRole } from "./drive-channel";
import { assertNever } from "./google-auth";
import {
  appendSessionEvent,
  ensureEventsFolder,
  readSessionEvents,
  SESSION_LOG_PROTOCOL_VERSION,
  type ReadSessionEventsOutcome,
  type SessionEvent,
} from "./session-log";

/** `manifest.json` as PROTOCOL.md defines it. */
export type ProposalManifest = Readonly<{
  protocolVersion: number;
  proposalId: string;
  createdAt: string;
  presentationId: string | null;
  count: number;
  /**
   * Bumped on **every** change to the candidate set, and written LAST.
   *
   * It is the poll signal: a reader re-reads the proposal only when this moves (PROTOCOL.md
   * "A revision replaces the candidate in place"). That is why `reviseSlide` and
   * `clearSlides` write the manifest after the files they describe and after their event —
   * a revision visible before the thing it describes would be read as a complete state that
   * is in fact half written.
   */
  revision: number;
  slides: readonly ManifestSlide[];
}>;

export type ManifestSlide = Readonly<{
  index: number;
  fileId: string;
  name: string;
  /** A short human caption for the picker — never a transcription of the slide. */
  label: string | null;
}>;

/** `PICK`, written by the extension. `picked` is null when the user dismissed the picker. */
export type PickRecord = Readonly<{
  protocolVersion: number;
  proposalId: string;
  picked: number | null;
  decidedAt: string;
  insertedObjectIds: readonly string[];
  anomalies: readonly PickAnomaly[];
}>;

export type PickAnomaly = Readonly<{
  index: number;
  note: string;
  /** Fractional (0–1) against the 1280x720 slide, so it survives scaling. */
  region: AnomalyRegion | null;
}>;

export type AnomalyRegion = Readonly<{ x: number; y: number; w: number; h: number }>;

/**
 * Everything this module touches that is not pure. Required, not defaulted: a unit that can
 * silently fall back to the production clock or filesystem has a path no test exercises.
 */
export type ProposalEnvironment = Readonly<{
  drive: DriveChannel;
  now: () => Date;
  /** Six base36 characters for the `proposalId` suffix. */
  randomSuffix: () => string;
  sleep: (options: Readonly<{ milliseconds: number }>) => Promise<void>;
  /** Existence/size probe for a slide path. Deliberately cannot read contents. */
  statFile: (path: string) => Readonly<{ bytes: number }> | null;
  warn: (message: string) => void;
}>;

export const PROTOCOL_VERSION = 1;
export const INBOX_FOLDER_NAME = "Sasha Slides Inbox";

export type SlideSource = Readonly<{ path: string; label: string | null }>;

export type CreateProposalOutcome =
  | Readonly<{
      kind: "ok";
      proposalId: string;
      folderId: string;
      manifestFileId: string;
      count: number;
      /** 1 for a first staging. The poll signal every reader watches. */
      revision: number;
      slides: readonly ManifestSlide[];
    }>
  | Readonly<{ kind: "invalid-input"; reason: string }>
  /**
   * Staging reached Drive and Drive said no. A separate variant from `invalid-input` because
   * the two want opposite responses: bad input needs the caller to change something, an
   * unreachable Drive needs it to try again — and either way the caller must get a VALUE,
   * since a surface that returns nothing is how this project once shipped a tool that spun
   * for ever.
   */
  | Readonly<{ kind: "drive-failed"; reason: string }>;

export const FIRST_REVISION = 1;

export async function createProposal(
  options: Readonly<{
    env: ProposalEnvironment;
    slides: readonly SlideSource[];
    presentationId: string | null;
  }>,
): Promise<CreateProposalOutcome> {
  const { env, slides, presentationId } = options;
  if (slides.length === 0) return { kind: "invalid-input", reason: "slides is empty" };
  const missing = slides.filter((slide) => env.statFile(slide.path) === null).map((slide) => slide.path);
  if (missing.length > 0) {
    return { kind: "invalid-input", reason: `not a readable file: ${missing.join(", ")}` };
  }

  const proposalId = newProposalId({ env });
  const folderAndSlides = await uploadCandidates({ env, proposalId, slides });
  if (folderAndSlides.kind === "drive-failed") return folderAndSlides;
  const { folder, uploaded } = folderAndSlides;

  // The log before the manifest, so a reader that wakes on `revision` already finds the line
  // that explains where these candidates came from. The folder is created even for a
  // proposal that never gets a comment: a log that appears only once something happens is
  // indistinguishable from a log that failed to appear.
  let eventsFolderId: string;
  try {
    eventsFolderId = await ensureEventsFolder({ env, proposalId, folderId: folder.id });
  } catch (cause) {
    return { kind: "drive-failed", reason: `could not create the events folder: ${describeCause(cause)}` };
  }
  const staged = await appendSessionEvent({
    env,
    proposalId,
    eventsFolderId,
    event: {
      kind: "slides-staged",
      protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
      at: env.now().toISOString(),
      proposalId,
      revision: FIRST_REVISION,
      count: uploaded.length,
      slides: uploaded,
    },
  });
  if (staged.kind === "drive-failed") {
    // No manifest and no READY were written, so nothing can pick this half-staged folder.
    return { kind: "drive-failed", reason: `could not write the session log: ${staged.reason}` };
  }

  const manifest: ProposalManifest = {
    protocolVersion: PROTOCOL_VERSION,
    proposalId,
    createdAt: env.now().toISOString(),
    presentationId,
    count: uploaded.length,
    revision: FIRST_REVISION,
    slides: uploaded,
  };
  let manifestFile: DriveFile;
  try {
    manifestFile = await env.drive.createFile({
      name: "manifest.json",
      parentId: folder.id,
      mimeType: "application/json",
      media: jsonMedia(manifest),
      appProperties: { sashaSlides: "manifest", proposalId },
    });

    await env.drive.createFile({
      name: "READY",
      parentId: folder.id,
      mimeType: "application/json",
      media: jsonMedia({
        protocolVersion: PROTOCOL_VERSION,
        proposalId,
        count: uploaded.length,
        manifestFileId: manifestFile.id,
      }),
      appProperties: { sashaSlides: "ready", proposalId },
    });
  } catch (cause) {
    return { kind: "drive-failed", reason: describeCause(cause) };
  }

  return {
    kind: "ok",
    proposalId,
    folderId: folder.id,
    manifestFileId: manifestFile.id,
    count: uploaded.length,
    revision: FIRST_REVISION,
    slides: uploaded,
  };
}

export type PickOutcome =
  | Readonly<{ kind: "decided"; pick: PickRecord; polls: number }>
  | Readonly<{ kind: "timeout"; waitedSeconds: number; polls: number }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "unsupported-version"; version: number | null }>;

/**
 * Polls the one narrow query that can answer the question — `sashaSlides=pick` plus this
 * `proposalId` — with exponential backoff, and reports a timeout as a value. A pick the
 * server cannot interpret is reported, never guessed at.
 */
export async function awaitPick(
  options: Readonly<{
    env: ProposalEnvironment;
    proposalId: string;
    timeoutSeconds: number;
    /**
     * Called once per poll, so the caller can keep its client's request timer alive. A
     * Model Context Protocol client kills a request after its own default (60 s measured)
     * unless a progress notification arrives, and this wait is minutes long by design.
     */
    onPoll?: (progress: Readonly<{ polls: number; elapsedMs: number }>) => void;
  }>,
): Promise<PickOutcome> {
  const { env, proposalId, timeoutSeconds, onPoll } = options;
  const folder = await findOne({ env, role: "proposal", proposalId });
  if (folder === null) return { kind: "unknown-proposal" };

  const startedAtMs = env.now().getTime();
  const deadlineMs = startedAtMs + timeoutSeconds * 1000;
  let delayMs = FIRST_POLL_DELAY_MS;
  let polls = 0;
  for (;;) {
    polls += 1;
    const pickFile = await findOne({ env, role: "pick", proposalId });
    // Reported BEFORE any early return, so a poll that finds the pick still counts as one.
    onPoll?.({ polls, elapsedMs: env.now().getTime() - startedAtMs });
    if (pickFile !== null) {
      const read = await readPick({ env, fileId: pickFile.id });
      switch (read.kind) {
        case "ok":
          return { kind: "decided", pick: read.pick, polls };
        case "unsupported-version":
          return { kind: "unsupported-version", version: read.version };
        case "unreadable":
          return { kind: "unreadable", reason: read.reason };
        default:
          return assertNever(read);
      }
    }
    const remainingMs = deadlineMs - env.now().getTime();
    if (remainingMs <= 0) {
      return {
        kind: "timeout",
        waitedSeconds: Math.round((env.now().getTime() - startedAtMs) / 100) / 10,
        polls,
      };
    }
    // The last sleep is clipped to the deadline, so the budget is spent polling rather
    // than on a final oversized wait that would overshoot it.
    await env.sleep({ milliseconds: Math.min(delayMs, remainingMs) });
    delayMs = Math.min(MAX_POLL_DELAY_MS, Math.round(delayMs * POLL_BACKOFF_FACTOR));
  }
}

export type ProposalState = Readonly<{
  proposalId: string;
  found: boolean;
  ready: boolean;
  picked: boolean;
  slideFileCount: number;
  manifest: ManifestRead;
}>;

export type ManifestRead =
  | Readonly<{ kind: "ok"; manifest: ProposalManifest }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "unsupported-version"; version: number | null }>;

/** One `proposalId`-scoped listing, classified by the `sashaSlides` appProperty. */
export async function readProposalState(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string }>,
): Promise<ProposalState> {
  const { env, proposalId } = options;
  const files = await env.drive.listFiles({
    query: { name: null, parentId: null, sashaSlides: null, proposalId, trashed: false },
  });
  const byRole = new Map<SashaRole, DriveFile[]>();
  for (const file of files) {
    const role = asSashaRole(file.appProperties["sashaSlides"]);
    if (role === null) continue;
    const bucket = byRole.get(role);
    if (bucket === undefined) byRole.set(role, [file]);
    else bucket.push(file);
  }
  const manifestFile = byRole.get("manifest")?.[0] ?? null;
  return {
    proposalId,
    found: (byRole.get("proposal")?.length ?? 0) > 0,
    ready: (byRole.get("ready")?.length ?? 0) > 0,
    picked: (byRole.get("pick")?.length ?? 0) > 0,
    slideFileCount: byRole.get("slide")?.length ?? 0,
    manifest:
      manifestFile === null ? { kind: "absent" } : await readManifest({ env, fileId: manifestFile.id }),
  };
}

export type SlideImagesOutcome =
  | Readonly<{ kind: "ok"; files: readonly Readonly<{ index: number; path: string }>[] }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/**
 * Downloads any rendered previews the extension has published for this proposal.
 *
 * PROTOCOL.md defines no render artifact — rendering is the content script's job, client
 * side — so this cannot manufacture images. It looks for `image/*` files tagged with the
 * proposal (protocol-defined query, no invented appProperty), streams them to `outDir` and
 * returns paths; when the extension has published none it says so rather than faking it.
 */
export async function downloadSlideImages(
  options: Readonly<{
    env: ProposalEnvironment;
    proposalId: string;
    indices: readonly number[] | null;
    outDir: string;
  }>,
): Promise<SlideImagesOutcome> {
  const { env, proposalId, indices, outDir } = options;
  const files = await env.drive.listFiles({
    query: { name: null, parentId: null, sashaSlides: null, proposalId, trashed: false },
  });
  if (files.length === 0) return { kind: "unknown-proposal" };

  const images = files
    .filter((file) => file.mimeType.startsWith("image/"))
    .map((file) => ({ file, index: imageIndex(file) }))
    .filter((candidate): candidate is Readonly<{ file: DriveFile; index: number }> => candidate.index !== null)
    .filter((candidate) => indices === null || indices.includes(candidate.index))
    .sort((left, right) => left.index - right.index);
  if (images.length === 0) {
    return {
      kind: "unavailable",
      reason:
        "no rendered previews exist for this proposal. Rendering happens client-side in the " +
        "Google Slides extension and PROTOCOL.md defines no render artifact, so the server " +
        "cannot produce images; the slide HTML itself is the authoritative form.",
    };
  }

  const written: Readonly<{ index: number; path: string }>[] = [];
  for (const image of images) {
    const destinationPath = `${outDir.replace(/\/+$/, "")}/${image.file.name}`;
    await env.drive.downloadBinaryFile({ fileId: image.file.id, destinationPath });
    written.push({ index: image.index, path: destinationPath });
  }
  return { kind: "ok", files: written };
}

export type ReviseSlideOutcome =
  | Readonly<{
      kind: "ok";
      slideIndex: number;
      /** Unchanged by the revision — asserted by the live e2e, because the threads hang off it. */
      fileId: string;
      name: string;
      /** The new manifest revision. Readers wake on this. */
      revision: number;
      answeredCommentIds: readonly string[];
    }>
  | Readonly<{ kind: "invalid-input"; reason: string }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "unknown-slide"; available: readonly number[] }>
  | Readonly<{ kind: "manifest-unusable"; reason: string }>
  | Readonly<{ kind: "drive-failed"; stage: ReviseStage; reason: string }>;

/** How far a failed revision got, so a caller knows what a retry will repeat. */
export type ReviseStage = "locate" | "upload" | "event" | "manifest";

/**
 * Replaces one candidate's HTML **in place** and records it.
 *
 * `htmlPath` is a PATH, never markup: the paths-in-ids-out rule is the product, and a tool
 * argument carrying a slide's HTML would put the whole candidate in the model's context on
 * every round trip.
 *
 * The file id does not change, which is the entire reason to revise rather than re-stage:
 * the user's comment threads live on `NN.html`, so a new file would silently detach every
 * thread from the slide it is about.
 *
 * Order is load-bearing and is asserted on the recorded call transcript, not on final state:
 * **HTML, then the event, then the manifest.** `revision` is the poll signal, so bumping it
 * before the thing it describes would publish a half-written state. A failure between the
 * steps is reported with the `stage` it reached and the manifest is left alone, so no reader
 * has seen the partial result and calling this again simply redoes it.
 */
export async function reviseSlide(
  options: Readonly<{
    env: ProposalEnvironment;
    proposalId: string;
    slideIndex: number;
    htmlPath: string;
    label: string | null;
    answeredCommentIds: readonly string[];
  }>,
): Promise<ReviseSlideOutcome> {
  const { env, proposalId, slideIndex, htmlPath, label, answeredCommentIds } = options;
  if (!Number.isSafeInteger(slideIndex) || slideIndex < 1) {
    return { kind: "invalid-input", reason: `slideIndex must be a 1-based integer, got ${String(slideIndex)}` };
  }
  if (env.statFile(htmlPath) === null) {
    return { kind: "invalid-input", reason: `not a readable file: ${htmlPath}` };
  }

  const located = await locateProposal({ env, proposalId });
  switch (located.kind) {
    case "unknown-proposal":
      return { kind: "unknown-proposal" };
    case "drive-failed":
      return { kind: "drive-failed", stage: "locate", reason: located.reason };
    case "ok":
      break;
    default:
      return assertNever(located);
  }
  const { location } = located;
  const usable = usableManifest(location);
  if (usable.kind === "unusable") return { kind: "manifest-unusable", reason: usable.reason };

  const candidate = location.candidates.find((entry) => entry.index === slideIndex);
  if (candidate === undefined) {
    return { kind: "unknown-slide", available: location.candidates.map((entry) => entry.index) };
  }

  const revision = usable.manifest.revision + 1;
  try {
    await env.drive.updateFileContent({
      fileId: candidate.fileId,
      mimeType: "text/html",
      media: { kind: "local-file", path: htmlPath },
    });
  } catch (cause) {
    return { kind: "drive-failed", stage: "upload", reason: describeCause(cause) };
  }

  const logged = await appendToLog({
    env,
    proposalId,
    folderId: location.folderId,
    event: {
      kind: "slide-revised",
      protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
      at: env.now().toISOString(),
      slideIndex,
      fileId: candidate.fileId,
      revision,
      answeredCommentIds,
      label,
    },
  });
  if (logged.kind === "failed") {
    // Deliberately before the manifest bump: the new HTML is in place but no reader has been
    // told to re-read it, so the proposal is still consistent and a retry is safe.
    return { kind: "drive-failed", stage: "event", reason: logged.reason };
  }

  const written = await writeManifest({
    env,
    manifestFileId: usable.manifestFileId,
    manifest: {
      ...usable.manifest,
      revision,
      slides: usable.manifest.slides.map((slide) =>
        slide.index === slideIndex ? { ...slide, label: label ?? slide.label } : slide,
      ),
    },
  });
  if (written.kind === "failed") {
    return { kind: "drive-failed", stage: "manifest", reason: written.reason };
  }
  return { kind: "ok", slideIndex, fileId: candidate.fileId, name: candidate.name, revision, answeredCommentIds };
}

export type ClearSlidesOutcome =
  | Readonly<{
      kind: "ok";
      cleared: readonly CandidateFile[];
      /** Kept because the log or `PICK` says they are already in the user's deck. */
      kept: readonly CandidateFile[];
      countBefore: number;
      countAfter: number;
      revision: number;
    }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "manifest-unusable"; reason: string }>
  | Readonly<{ kind: "drive-failed"; stage: ClearStage; reason: string }>
  /** The re-count after deleting did not match the plan. Reported, never papered over. */
  | Readonly<{ kind: "verification-failed"; expected: readonly number[]; found: readonly number[] }>;

export type ClearStage = "locate" | "delete" | "verify" | "event" | "manifest";

/**
 * Deletes the **uninserted** candidates and records it. Never silent: an uninserted set that
 * vanishes without a line in the log is indistinguishable from a bug, and this protocol has
 * already shipped one "it just showed nothing" failure.
 *
 * "Inserted" is read from the log's `slide-inserted` events and, for an add-on that still
 * only writes `PICK`, from a `PICK` naming inserted object ids. Those candidates are kept:
 * deleting the HTML a deck page came from would destroy the only record of what was inserted.
 *
 * The count is taken before and re-listed after, and a mismatch is an outcome rather than a
 * log line — a destructive loop whose assumption is off by one over-deletes silently.
 */
export async function clearSlides(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string; reason: string | null }>,
): Promise<ClearSlidesOutcome> {
  const { env, proposalId, reason } = options;
  const located = await locateProposal({ env, proposalId });
  switch (located.kind) {
    case "unknown-proposal":
      return { kind: "unknown-proposal" };
    case "drive-failed":
      return { kind: "drive-failed", stage: "locate", reason: located.reason };
    case "ok":
      break;
    default:
      return assertNever(located);
  }
  const { location } = located;
  const usable = usableManifest(location);
  if (usable.kind === "unusable") return { kind: "manifest-unusable", reason: usable.reason };

  const inserted = await insertedSlideIndices({ env, proposalId, folderId: location.folderId });
  const countBefore = location.candidates.length;
  const kept = location.candidates.filter((candidate) => inserted.includes(candidate.index));
  const doomed = location.candidates.filter((candidate) => !inserted.includes(candidate.index));

  for (const candidate of doomed) {
    try {
      await env.drive.deleteFile({ fileId: candidate.fileId });
    } catch (cause) {
      // Stop at the first failure rather than carrying on: the verification below would then
      // be comparing against a plan that is no longer what happened.
      return { kind: "drive-failed", stage: "delete", reason: `${candidate.name}: ${describeCause(cause)}` };
    }
  }

  const after = await locateProposal({ env, proposalId });
  switch (after.kind) {
    case "unknown-proposal":
      return { kind: "verification-failed", expected: kept.map((entry) => entry.index), found: [] };
    case "drive-failed":
      return { kind: "drive-failed", stage: "verify", reason: after.reason };
    case "ok":
      break;
    default:
      return assertNever(after);
  }
  const remaining = after.location.candidates.map((candidate) => candidate.index).sort(byNumber);
  const expected = kept.map((candidate) => candidate.index).sort(byNumber);
  if (remaining.join(",") !== expected.join(",")) {
    return { kind: "verification-failed", expected, found: remaining };
  }

  const revision = usable.manifest.revision + 1;
  const logged = await appendToLog({
    env,
    proposalId,
    folderId: location.folderId,
    event: {
      kind: "slides-cleared",
      protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
      at: env.now().toISOString(),
      revision,
      clearedSlideIndices: doomed.map((candidate) => candidate.index),
      keptSlideIndices: expected,
      reason,
    },
  });
  if (logged.kind === "failed") return { kind: "drive-failed", stage: "event", reason: logged.reason };

  const written = await writeManifest({
    env,
    manifestFileId: usable.manifestFileId,
    manifest: {
      ...usable.manifest,
      revision,
      count: kept.length,
      slides: usable.manifest.slides.filter((slide) => expected.includes(slide.index)),
    },
  });
  if (written.kind === "failed") return { kind: "drive-failed", stage: "manifest", reason: written.reason };

  return {
    kind: "ok",
    cleared: doomed,
    kept,
    countBefore,
    countAfter: remaining.length,
    revision,
  };
}

export type ProposalLogOutcome =
  | Readonly<{ kind: "ok"; revision: number | null; log: ReadSessionEventsOutcome }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/**
 * The session log of one proposal, in order, with the manifest `revision` it was read at so
 * a caller can tell whether it has the current state.
 */
export async function readProposalLog(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string }>,
): Promise<ProposalLogOutcome> {
  const { env, proposalId } = options;
  const located = await locateProposal({ env, proposalId });
  switch (located.kind) {
    case "unknown-proposal":
      return { kind: "unknown-proposal" };
    case "drive-failed":
      return { kind: "drive-failed", reason: located.reason };
    case "ok":
      return {
        kind: "ok",
        revision: revisionOf(located.location.manifest),
        log: await readSessionEvents({ env, proposalId, folderId: located.location.folderId }),
      };
    default:
      return assertNever(located);
  }
}

export type CandidateFile = Readonly<{ index: number; fileId: string; name: string }>;

export type FindCandidateOutcome =
  | Readonly<{ kind: "ok"; folderId: string; candidate: CandidateFile }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "unknown-slide"; available: readonly number[] }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/**
 * `(proposalId, slideIndex)` to the Drive file id of `NN.html` — the address a comment on a
 * candidate is filed against. This is what repoints the whole feedback channel off the
 * presentation and onto the thing the user is actually reviewing.
 */
export async function findCandidate(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string; slideIndex: number }>,
): Promise<FindCandidateOutcome> {
  const listed = await listCandidates(options);
  switch (listed.kind) {
    case "unknown-proposal":
    case "drive-failed":
      return listed;
    case "ok": {
      const candidate = listed.candidates.find((entry) => entry.index === options.slideIndex);
      return candidate === undefined
        ? { kind: "unknown-slide", available: listed.candidates.map((entry) => entry.index) }
        : { kind: "ok", folderId: listed.folderId, candidate };
    }
    default:
      return assertNever(listed);
  }
}

export type ListCandidatesOutcome =
  | Readonly<{ kind: "ok"; folderId: string; revision: number | null; candidates: readonly CandidateFile[] }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/** Every `NN.html` still staged, in index order — one listing, so unresolved counts are cheap. */
export async function listCandidates(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string }>,
): Promise<ListCandidatesOutcome> {
  const located = await locateProposal(options);
  switch (located.kind) {
    case "unknown-proposal":
    case "drive-failed":
      return located;
    case "ok":
      return {
        kind: "ok",
        folderId: located.location.folderId,
        revision: revisionOf(located.location.manifest),
        candidates: located.location.candidates,
      };
    default:
      return assertNever(located);
  }
}

export type AppendProposalEventOutcome =
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/**
 * Appends one event to a proposal's log. `folderId` comes from a `findCandidate` /
 * `listCandidates` the caller has already done, so answering a comment costs one create and
 * not a second listing.
 *
 * It does **not** bump `manifest.revision`: the candidate set did not change, and the log is
 * discovered by listing `events/`, which is the only signal two writers who cannot see each
 * other can share. Bumping the manifest for an event would put the add-on and the server in a
 * read-modify-write on the same file — exactly what one-file-per-event exists to avoid.
 */
export async function appendProposalEvent(
  options: Readonly<{
    env: ProposalEnvironment;
    proposalId: string;
    folderId: string;
    event: SessionEvent;
  }>,
): Promise<AppendProposalEventOutcome> {
  const written = await appendToLog(options);
  switch (written.kind) {
    case "ok":
      return { kind: "ok" };
    case "failed":
      return { kind: "drive-failed", reason: written.reason };
    default:
      return assertNever(written);
  }
}

/** `p_<epochMillis>_<6 base36>` — sortable and collision-free without coordination. */
export function newProposalId(options: Readonly<{ env: ProposalEnvironment }>): string {
  return `p_${String(options.env.now().getTime())}_${options.env.randomSuffix()}`;
}

/** `01.html` … `NN.html`, widened past two digits only if a proposal ever needs it. */
export function slideFileName(options: Readonly<{ index: number; count: number }>): string {
  const width = Math.max(2, String(options.count).length);
  return `${String(options.index).padStart(width, "0")}.html`;
}

const FIRST_POLL_DELAY_MS = 750;
const POLL_BACKOFF_FACTOR = 1.6;
const MAX_POLL_DELAY_MS = 5000;

type UploadedCandidates =
  | Readonly<{ kind: "ok"; folder: DriveFile; uploaded: readonly ManifestSlide[] }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/**
 * The inbox, the proposal folder and every candidate, in that order.
 *
 * **Sequential on purpose**: the READY-last invariant is this loop's ordering, and
 * parallelising the uploads would violate the contract without changing the final set of
 * files — which is why the test asserts on the recorded call order, not on the result.
 */
async function uploadCandidates(
  options: Readonly<{
    env: ProposalEnvironment;
    proposalId: string;
    slides: readonly SlideSource[];
  }>,
): Promise<UploadedCandidates> {
  const { env, proposalId, slides } = options;
  try {
    const inboxId = await ensureInboxFolder({ env });
    const folder = await env.drive.createFolder({
      name: proposalId,
      parentId: inboxId,
      appProperties: { sashaSlides: "proposal", proposalId },
    });
    const uploaded: ManifestSlide[] = [];
    for (const [position, slide] of slides.entries()) {
      const index = position + 1;
      const name = slideFileName({ index, count: slides.length });
      const file = await env.drive.createFile({
        name,
        parentId: folder.id,
        mimeType: "text/html",
        media: { kind: "local-file", path: slide.path },
        appProperties: { sashaSlides: "slide", proposalId, index: String(index) },
      });
      uploaded.push({ index, fileId: file.id, name: file.name, label: slide.label });
    }
    return { kind: "ok", folder, uploaded };
  } catch (cause) {
    return { kind: "drive-failed", reason: describeCause(cause) };
  }
}

async function ensureInboxFolder(options: Readonly<{ env: ProposalEnvironment }>): Promise<string> {
  const { env } = options;
  const existing = await env.drive.listFiles({
    query: {
      name: INBOX_FOLDER_NAME,
      parentId: null,
      sashaSlides: "inbox",
      proposalId: null,
      trashed: false,
    },
  });
  const first = existing[0];
  if (first !== undefined) return first.id;
  const created = await env.drive.createFolder({
    name: INBOX_FOLDER_NAME,
    parentId: null,
    appProperties: { sashaSlides: "inbox" },
  });
  return created.id;
}

function jsonMedia(document: unknown): DriveMedia {
  return { kind: "text", text: `${JSON.stringify(document, null, 2)}\n` };
}

async function findOne(
  options: Readonly<{ env: ProposalEnvironment; role: SashaRole; proposalId: string }>,
): Promise<DriveFile | null> {
  const files = await options.env.drive.listFiles({
    query: {
      name: null,
      parentId: null,
      sashaSlides: options.role,
      proposalId: options.proposalId,
      trashed: false,
    },
  });
  return files[0] ?? null;
}

type PickRead =
  | Readonly<{ kind: "ok"; pick: PickRecord }>
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "unsupported-version"; version: number | null }>;

/**
 * Parse boundary for a document another component wrote. Nothing below this function sees
 * `unknown`; an unknown `protocolVersion` is reported and logged, never interpreted.
 */
async function readPick(
  options: Readonly<{ env: ProposalEnvironment; fileId: string }>,
): Promise<PickRead> {
  const json = await readJsonDocument(options);
  if ("error" in json) return { kind: "unreadable", reason: json.error };
  const version = asNumber(json.json["protocolVersion"]);
  if (version !== PROTOCOL_VERSION) {
    options.env.warn(
      `ignoring PICK with unsupported protocolVersion ${String(version)} (this server speaks ${String(PROTOCOL_VERSION)})`,
    );
    return { kind: "unsupported-version", version };
  }
  const proposalId = asString(json.json["proposalId"]);
  const decidedAt = asString(json.json["decidedAt"]);
  if (proposalId === null) return { kind: "unreadable", reason: "PICK has no string proposalId" };
  if (decidedAt === null) return { kind: "unreadable", reason: "PICK has no string decidedAt" };
  const rawPicked = json.json["picked"];
  const picked = asNumber(rawPicked);
  if (picked === null && rawPicked !== null) {
    return { kind: "unreadable", reason: "PICK.picked is neither a number nor null" };
  }
  return {
    kind: "ok",
    pick: {
      protocolVersion: version,
      proposalId,
      picked,
      decidedAt,
      insertedObjectIds: asArray(json.json["insertedObjectIds"]).flatMap((entry) => {
        const objectId = asString(entry);
        return objectId === null ? [] : [objectId];
      }),
      anomalies: asArray(json.json["anomalies"]).flatMap((entry) => {
        const anomaly = parseAnomaly(entry);
        return anomaly === null ? [] : [anomaly];
      }),
    },
  };
}

function parseAnomaly(value: unknown): PickAnomaly | null {
  const record = asRecord(value);
  if (record === null) return null;
  const index = asNumber(record["index"]);
  const note = asString(record["note"]);
  if (index === null || note === null) return null;
  return { index, note, region: parseRegion(record["region"]) };
}

function parseRegion(value: unknown): AnomalyRegion | null {
  const record = asRecord(value);
  if (record === null) return null;
  const x = asNumber(record["x"]);
  const y = asNumber(record["y"]);
  const w = asNumber(record["w"]);
  const h = asNumber(record["h"]);
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

async function readManifest(
  options: Readonly<{ env: ProposalEnvironment; fileId: string }>,
): Promise<ManifestRead> {
  const json = await readJsonDocument(options);
  if ("error" in json) return { kind: "unreadable", reason: json.error };
  const version = asNumber(json.json["protocolVersion"]);
  if (version !== PROTOCOL_VERSION) {
    options.env.warn(
      `ignoring manifest.json with unsupported protocolVersion ${String(version)} (this server speaks ${String(PROTOCOL_VERSION)})`,
    );
    return { kind: "unsupported-version", version };
  }
  const proposalId = asString(json.json["proposalId"]);
  const createdAt = asString(json.json["createdAt"]);
  const count = asNumber(json.json["count"]);
  if (proposalId === null || createdAt === null || count === null) {
    return { kind: "unreadable", reason: "manifest.json is missing proposalId, createdAt or count" };
  }
  return {
    kind: "ok",
    manifest: {
      protocolVersion: version,
      proposalId,
      createdAt,
      presentationId: asString(json.json["presentationId"]),
      count,
      // A manifest written before `revision` existed reads as the first revision rather
      // than as unreadable: an older writer must not break a newer reader either.
      revision: asNumber(json.json["revision"]) ?? FIRST_REVISION,
      slides: asArray(json.json["slides"]).flatMap((entry) => {
        const slide = parseManifestSlide(entry);
        return slide === null ? [] : [slide];
      }),
    },
  };
}

function parseManifestSlide(value: unknown): ManifestSlide | null {
  const record = asRecord(value);
  if (record === null) return null;
  const index = asNumber(record["index"]);
  const fileId = asString(record["fileId"]);
  const name = asString(record["name"]);
  if (index === null || fileId === null || name === null) return null;
  return { index, fileId, name, label: asString(record["label"]) };
}

/** The proposal folder, its manifest and the candidates still in it — one listing. */
type ProposalLocation = Readonly<{
  folderId: string;
  manifestFileId: string | null;
  manifest: ManifestRead;
  candidates: readonly CandidateFile[];
}>;

type LocateProposalOutcome =
  | Readonly<{ kind: "ok"; location: ProposalLocation }>
  | Readonly<{ kind: "unknown-proposal" }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/**
 * One `proposalId`-scoped listing, classified by role, plus the manifest read.
 *
 * A Drive failure is a value here rather than a thrown error, because every caller of this
 * is a tool that must answer the model with something: this project has already shipped one
 * surface that spun forever because a failure returned silently.
 */
async function locateProposal(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string }>,
): Promise<LocateProposalOutcome> {
  const { env, proposalId } = options;
  let files: readonly DriveFile[];
  try {
    files = await env.drive.listFiles({
      query: { name: null, parentId: null, sashaSlides: null, proposalId, trashed: false },
    });
  } catch (cause) {
    return { kind: "drive-failed", reason: describeCause(cause) };
  }

  const folder = files.find((file) => file.appProperties["sashaSlides"] === "proposal");
  if (folder === undefined) return { kind: "unknown-proposal" };
  const manifestFile = files.find((file) => file.appProperties["sashaSlides"] === "manifest") ?? null;
  const candidates = files
    .filter((file) => file.appProperties["sashaSlides"] === "slide")
    .flatMap((file) => {
      const index = candidateIndex(file);
      return index === null ? [] : [{ index, fileId: file.id, name: file.name }];
    })
    .sort((left, right) => left.index - right.index);

  let manifest: ManifestRead = { kind: "absent" };
  if (manifestFile !== null) {
    try {
      manifest = await readManifest({ env, fileId: manifestFile.id });
    } catch (cause) {
      return { kind: "drive-failed", reason: describeCause(cause) };
    }
  }
  return {
    kind: "ok",
    location: { folderId: folder.id, manifestFileId: manifestFile?.id ?? null, manifest, candidates },
  };
}

type UsableManifest =
  | Readonly<{ kind: "ok"; manifestFileId: string; manifest: ProposalManifest }>
  | Readonly<{ kind: "unusable"; reason: string }>;

/**
 * A change to the candidate set must bump `revision`, and a revision cannot be bumped from a
 * manifest that cannot be read — guessing one would hand every reader a number that means
 * nothing. So an unreadable manifest declines the whole operation rather than half-doing it.
 */
function usableManifest(location: ProposalLocation): UsableManifest {
  const { manifestFileId, manifest } = location;
  if (manifestFileId === null) return { kind: "unusable", reason: "the proposal folder holds no manifest.json" };
  switch (manifest.kind) {
    case "ok":
      return { kind: "ok", manifestFileId, manifest: manifest.manifest };
    case "absent":
      return { kind: "unusable", reason: "manifest.json could not be found in the listing" };
    case "unreadable":
      return { kind: "unusable", reason: `manifest.json could not be parsed: ${manifest.reason}` };
    case "unsupported-version":
      return {
        kind: "unusable",
        reason: `manifest.json declares protocolVersion ${String(manifest.version)}; this server only writes version ${String(PROTOCOL_VERSION)}`,
      };
    default:
      return assertNever(manifest);
  }
}

type LogWrite = Readonly<{ kind: "ok" }> | Readonly<{ kind: "failed"; reason: string }>;

/** Finds (or creates) `events/` and appends one file. Never reads the log to write to it. */
async function appendToLog(
  options: Readonly<{
    env: ProposalEnvironment;
    proposalId: string;
    folderId: string;
    event: SessionEvent;
  }>,
): Promise<LogWrite> {
  const { env, proposalId, folderId, event } = options;
  let eventsFolderId: string;
  try {
    eventsFolderId = await ensureEventsFolder({ env, proposalId, folderId });
  } catch (cause) {
    return { kind: "failed", reason: describeCause(cause) };
  }
  const appended = await appendSessionEvent({ env, proposalId, eventsFolderId, event });
  switch (appended.kind) {
    case "ok":
      return { kind: "ok" };
    case "drive-failed":
      return { kind: "failed", reason: appended.reason };
    default:
      return assertNever(appended);
  }
}

type ManifestWrite = Readonly<{ kind: "ok" }> | Readonly<{ kind: "failed"; reason: string }>;

/**
 * Overwrites `manifest.json` **in place**, keeping its id so a reader holding it keeps
 * reading the same file. Safe to update rather than create because the manifest has exactly
 * one writer — unlike the log, which has two that cannot see each other.
 */
async function writeManifest(
  options: Readonly<{
    env: ProposalEnvironment;
    manifestFileId: string;
    manifest: ProposalManifest;
  }>,
): Promise<ManifestWrite> {
  try {
    await options.env.drive.updateFileContent({
      fileId: options.manifestFileId,
      mimeType: "application/json",
      media: jsonMedia(options.manifest),
    });
    return { kind: "ok" };
  } catch (cause) {
    return { kind: "failed", reason: describeCause(cause) };
  }
}

/**
 * The candidates that are already in the user's deck, and so are not disposable.
 *
 * Two sources because the add-on is mid-migration: the log's `slide-inserted` events are the
 * contract, and a `PICK` carrying `insertedObjectIds` is what an add-on built against the
 * previous section writes. A read failure yields the empty set deliberately — but it is
 * warned about, because clearing then deletes more than it otherwise would.
 */
async function insertedSlideIndices(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string; folderId: string }>,
): Promise<readonly number[]> {
  const { env, proposalId, folderId } = options;
  const indices = new Set<number>();
  const log = await readSessionEvents({ env, proposalId, folderId });
  switch (log.kind) {
    case "ok":
      for (const record of log.records) {
        if (record.event.kind === "slide-inserted") indices.add(record.event.slideIndex);
      }
      break;
    case "no-log":
      break;
    case "drive-failed":
      env.warn(
        `could not read the session log of ${proposalId} before clearing (${log.reason}); ` +
          "falling back to PICK alone to decide what is already inserted",
      );
      break;
    default:
      return assertNever(log);
  }

  const pickFile = await findOne({ env, role: "pick", proposalId });
  if (pickFile === null) return [...indices];
  const read = await readPick({ env, fileId: pickFile.id });
  switch (read.kind) {
    case "ok":
      if (read.pick.picked !== null && read.pick.insertedObjectIds.length > 0) {
        indices.add(read.pick.picked);
      }
      break;
    case "unreadable":
    case "unsupported-version":
      env.warn(`PICK for ${proposalId} could not be read before clearing; treating nothing as inserted`);
      break;
    default:
      return assertNever(read);
  }
  return [...indices];
}

/** Null when there is no usable manifest: a reader is told "unknown", never a made-up number. */
function revisionOf(manifest: ManifestRead): number | null {
  switch (manifest.kind) {
    case "ok":
      return manifest.manifest.revision;
    case "absent":
    case "unreadable":
    case "unsupported-version":
      return null;
    default:
      return assertNever(manifest);
  }
}

/** The index the server tagged `NN.html` with, else the `NN` its filename starts with. */
function candidateIndex(file: DriveFile): number | null {
  const tagged = Number.parseInt(file.appProperties["index"] ?? "", 10);
  if (Number.isSafeInteger(tagged)) return tagged;
  const match = /^(\d+)/.exec(file.name);
  if (match === null) return null;
  const fromName = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(fromName) ? fromName : null;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function byNumber(left: number, right: number): number {
  return left - right;
}

type JsonDocument = Readonly<{ json: Readonly<Record<string, unknown>> }> | Readonly<{ error: string }>;

async function readJsonDocument(
  options: Readonly<{ env: ProposalEnvironment; fileId: string }>,
): Promise<JsonDocument> {
  try {
    const parsed: unknown = JSON.parse(await options.env.drive.readTextFile({ fileId: options.fileId }));
    const record = asRecord(parsed);
    return record !== null ? { json: record } : { error: "top level is not an object" };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** The index the extension tagged a preview with, else the `NN` its filename starts with. */
function imageIndex(file: DriveFile): number | null {
  const tagged = Number.parseInt(file.appProperties["index"] ?? "", 10);
  if (Number.isSafeInteger(tagged)) return tagged;
  const match = /^(\d+)/.exec(file.name);
  if (match === null) return null;
  const fromName = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(fromName) ? fromName : null;
}

/**
 * Parse-boundary guard, not an exhaustive switch: the input is an arbitrary string from
 * Drive, so it has no `never` position. Add new roles here by hand when PROTOCOL.md grows.
 */
function asSashaRole(value: string | undefined): SashaRole | null {
  switch (value) {
    case "inbox":
    case "proposal":
    case "slide":
    case "manifest":
    case "ready":
    case "pick":
    case "events":
    case "event":
      return value;
    default:
      return null;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * WHAT IS WAITING FOR THE SIGNED-IN USER, with no identifier supplied by anybody.
 *
 * THE PROBLEM IT CLOSES. The add-on's "nothing is listening" notice used to tell the user to
 * paste `call await_feedback for proposal p_1791145806407_yig6ws`, and an opaque id in a
 * sentence meant for a human is homework, not an instruction.
 *
 * WHY NOT ADDRESS IT BY PRESENTATION, which is the obvious alternative: comments were
 * deliberately moved OFF the deck and onto the candidate `NN.html` files (that is the whole
 * point of reviewing a slide before it is inserted), `manifest.presentationId` is optional and
 * in practice null, and under the brokered `drive.file` scope this connector cannot read a deck
 * it did not create. A deck id would therefore be a key that opens nothing.
 *
 * WHAT IT DOES INSTEAD. The caller is already authenticated -- `--stdio` by a token file,
 * `--http` by a per-user bearer -- so "whose work?" is answered before the call starts, and the
 * proposal id goes back to the MODEL to pass to the other tools. The Model Context Protocol
 * revision of 2026-07-28 asks for exactly this: a server-minted handle bound to the verified
 * user rather than one a person types.
 *
 * THE ORDER IS THE ANSWER TO THE QUESTION. "Newest" is wrong precisely when it matters -- the
 * newest proposal is usually the one already dealt with -- so anything with an unanswered
 * comment ranks above anything without, and ties break newest-first. `proposalId` sorts by time
 * by construction (`newProposalId`), so no extra Drive field is needed.
 */
export async function listOpenWork(
  options: Readonly<{ env: ProposalEnvironment; feedback: FeedbackEnvironment }>,
): Promise<ListOpenWorkOutcome> {
  const { env, feedback } = options;
  let folders: readonly DriveFile[];
  try {
    folders = await env.drive.listFiles({
      query: { name: null, parentId: null, sashaSlides: "proposal", proposalId: null, trashed: false },
    });
  } catch (cause) {
    return { kind: "drive-failed", reason: describeCause(cause) };
  }

  const items: OpenWorkItem[] = [];
  for (const folder of folders) {
    const proposalId = folder.appProperties["proposalId"];
    if (proposalId === undefined || proposalId === "") continue;
    const listed = await listCandidates({ env, proposalId });
    if (listed.kind !== "ok") {
      // One unreadable proposal must not hide the others, and it must not be silently dropped
      // either: a session told "nothing is waiting" would stop, which is the worst answer.
      items.push({
        proposalId,
        candidateCount: 0,
        unresolved: 0,
        unreadableReason: listed.kind === "drive-failed" ? listed.reason : "the proposal could not be read",
      });
      continue;
    }
    const counts = await countUnresolvedThreads({
      env: feedback,
      targets: listed.candidates.map((candidate) => ({
        kind: "candidate" as const,
        proposalId,
        slideIndex: candidate.index,
        fileId: candidate.fileId,
      })),
    });
    items.push({
      proposalId,
      candidateCount: listed.candidates.length,
      // A candidate whose count Drive would not give is counted as zero rather than guessed at.
      // `unreadableReason` is where "we could not tell" is said; the number never carries it.
      unresolved: counts.reduce((total, count) => total + (count.unresolved ?? 0), 0),
      unreadableReason: null,
    });
  }

  return { kind: "ok", items: [...items].sort(byWhatNeedsAnsweringFirst) };
}

/** An open comment outranks being newer; ties go to the newer proposal (ids sort by time). */
function byWhatNeedsAnsweringFirst(left: OpenWorkItem, right: OpenWorkItem): number {
  if (left.unresolved !== right.unresolved) return right.unresolved - left.unresolved;
  return left.proposalId < right.proposalId ? 1 : left.proposalId > right.proposalId ? -1 : 0;
}

/** One proposal this user has staged, and whether anything on it is waiting for an answer. */
export type OpenWorkItem = Readonly<{
  proposalId: string;
  candidateCount: number;
  unresolved: number;
  /** Non-null when Drive would not say; the item is still listed, never silently dropped. */
  unreadableReason: string | null;
}>;

export type ListOpenWorkOutcome =
  | Readonly<{ kind: "ok"; items: readonly OpenWorkItem[] }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;
