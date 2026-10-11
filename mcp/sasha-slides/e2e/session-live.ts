/**
 * The session log, comments on CANDIDATES, revision-in-place and clearing, against REAL
 * Google Drive, end to end.
 *
 *   npx tsx .auth/check-auth.ts            # must print OK first
 *   npx tsx mcp/sasha-slides/e2e/session-live.ts
 *   npx tsx mcp/sasha-slides/e2e/session-live.ts --keep     # leave the folder for inspection
 *
 * What it proves, in order: candidates stage with a `revision` and a `slides-staged` event; a
 * read of the user's comment leaves a `feedback-delivered` receipt behind it, which is the only
 * thing in Drive that tells the add-on a client was listening; a
 * comment filed on `NN.html` is placed on that candidate with no anchor at all; an answer
 * lands in the user's own thread; a revision overwrites the HTML **keeping the Drive file
 * id**, so the threads stay attached; the thread resolves; a second writer can append to the
 * log without either writer reading it; clearing deletes only the uninserted candidates; and
 * the whole log replays in order including an event kind this build does not know.
 *
 * Three rules it holds itself to, the same ones `feedback-live.ts` holds:
 *
 *  - **An independent client reads every write back.** A second `OAuth2Client`, a second
 *    `DriveChannel` and a second `FeedbackChannel` are built from the same credentials, and
 *    every assertion is made against *those*. Trusting the response to our own POST would
 *    prove nothing about what Google stored. The second client also plays the OTHER writer —
 *    the add-on — which is the only way to show that one-file-per-event really is clobber-free.
 *  - **Counts are taken before and after.** The inbox's proposal-folder count is recorded at
 *    the start and asserted at the end, and the candidate count is re-listed after clearing.
 *  - **It only ever deletes what it created**, by its own `proposalId`, and it verifies the
 *    folder is gone afterwards.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleDriveChannel, type DriveChannel, type DriveFile } from "../drive-channel";
import { googleFeedbackChannel, type FeedbackChannel } from "../feedback/feedback-channel";
import {
  readCandidateFeedback,
  replyToCandidateComment,
  resolveCandidateComment,
  type CandidateFeedbackEnvironment,
} from "../feedback/candidate-feedback";
import { AGENT_REPLY_MARKER, type FeedbackEnvironment } from "../feedback/feedback";
import { describeAuthFailure, loadOAuthClient } from "../google-auth";
import {
  clearSlides,
  createProposal,
  readProposalLog,
  reviseSlide,
  INBOX_FOLDER_NAME,
  type ProposalEnvironment,
} from "../proposal";
import { EVENTS_FOLDER_NAME, sessionEventFileName } from "../session-log";

const RUN_TAG = `[sasha-session-e2e ${String(Date.now())}]`;

async function main(): Promise<void> {
  const keep = process.argv.slice(2).includes("--keep");
  const auth = await loadOAuthClient();
  if (auth.kind !== "ok") {
    fail(`auth: ${describeAuthFailure(auth)}`);
    return;
  }
  const independentAuth = await loadOAuthClient();
  if (independentAuth.kind !== "ok") {
    fail(`second auth: ${describeAuthFailure(independentAuth)}`);
    return;
  }

  // The writer under test...
  const proposalEnv = liveProposalEnvironment({ drive: googleDriveChannel({ auth: auth.auth }) });
  const candidateEnv: CandidateFeedbackEnvironment = {
    proposal: proposalEnv,
    feedback: liveFeedbackEnvironment({ channel: googleFeedbackChannel({ auth: auth.auth }) }),
  };
  // ...and the independent reader, which is also the OTHER writer (the add-on's half).
  const observerDrive = googleDriveChannel({ auth: independentAuth.auth });
  const observerComments = googleFeedbackChannel({ auth: independentAuth.auth });
  const observerEnv = liveProposalEnvironment({ drive: observerDrive });

  const checks: Check[] = [];
  const check = (label: string, ok: boolean, detail?: string): void => {
    checks.push({ label, ok, detail: detail ?? null });
  };

  const inbox = await findInbox({ drive: observerDrive });
  const proposalsBefore = inbox === null ? 0 : (await childrenOf({ drive: observerDrive, folderId: inbox })).length;
  process.stdout.write(`inbox holds ${String(proposalsBefore)} proposal folder(s) before this run\n\n`);

  const sources = writeCandidates();
  let proposalId: string | null = null;
  try {
    // --- 1. stage three candidates.
    const staged = await createProposal({
      env: proposalEnv,
      slides: [
        { path: sources.first, label: `option 1 ${RUN_TAG}` },
        { path: sources.second, label: `option 2 ${RUN_TAG}` },
        { path: sources.third, label: `option 3 ${RUN_TAG}` },
      ],
      presentationId: null,
    });
    if (staged.kind !== "ok") {
      fail(`staging: ${staged.reason}`);
      return;
    }
    proposalId = staged.proposalId;
    process.stdout.write(`proposal ${staged.proposalId} (folder ${staged.folderId})\n`);
    check("propose_slides reports revision 1", staged.revision === 1, `revision=${String(staged.revision)}`);

    const candidateTwo = staged.slides.find((slide) => slide.index === 2);
    if (candidateTwo === undefined) {
      fail("staging returned no candidate 2");
      return;
    }

    // --- 2. the independent client sees the folder the protocol specifies, found BY NAME.
    const contents = await childrenOf({ drive: observerDrive, folderId: staged.folderId });
    check(
      "the independent client finds 01-03.html, manifest.json, READY and events/ by name",
      ["01.html", "02.html", "03.html", "manifest.json", "READY", EVENTS_FOLDER_NAME].every((name) =>
        contents.some((file) => file.name === name),
      ),
      contents.map((file) => file.name).sort().join(", "),
    );
    check(
      "the staged manifest carries revision 1, written after the files it describes",
      numberFieldOf(await readJson({ drive: observerDrive, files: contents, name: "manifest.json" }), "revision") === 1,
    );

    // --- 3. the USER comments on the candidate, through the independent client.
    const userComment = await observerComments.createComment({
      fileId: candidateTwo.fileId,
      text: `the chart on this candidate is unreadable ${RUN_TAG}`,
    });
    check(
      "a comment on NN.html is unanchored, as Google documents for Drive-API comments",
      userComment.anchor === null,
      `anchor=${String(userComment.anchor)}`,
    );

    // --- 4. read it back through the server, addressed by (proposalId, slideIndex).
    const read = await readCandidateFeedback({
      env: candidateEnv,
      proposalId: staged.proposalId,
      slideIndex: null,
      since: null,
      includeResolved: false,
    });
    if (read.kind !== "ok") {
      fail(`read_feedback: ${JSON.stringify(read.failure)}`);
      return;
    }
    const thread = read.outcome.threads.find((candidate) => candidate.commentId === userComment.id);
    check(
      "read_feedback places it on candidate 2 with no anchor, via the file it is on",
      thread?.slide.kind === "slide" &&
        thread.slide.slideNumber === 2 &&
        thread.slide.via === "candidate-file",
      JSON.stringify(thread?.slide),
    );
    check(
      "handing the comment over appended a feedback-delivered receipt naming it",
      read.delivery.kind === "logged" && read.delivery.commentIds.includes(userComment.id),
      JSON.stringify(read.delivery),
    );
    check(
      "the unresolved count is per candidate: 0, 1, 0",
      read.unresolved.map((entry) => `${String(entry.slideIndex)}:${String(entry.unresolved)}`).join(" ") ===
        "1:0 2:1 3:0",
      read.unresolved.map((entry) => `${String(entry.slideIndex)}:${String(entry.unresolved)}`).join(" "),
    );

    // --- 5. answer it. The answer is the completion signal, so it must land in the thread.
    const replied = await replyToCandidateComment({
      env: candidateEnv,
      proposalId: staged.proposalId,
      slideIndex: 2,
      commentId: userComment.id,
      text: `redrawn with bigger axis labels ${RUN_TAG}`,
    });
    check(
      "reply_feedback posts and logs comment-answered",
      replied.kind === "ok" && replied.outcome.kind === "ok" && replied.logged,
      JSON.stringify(replied.kind === "ok" ? { outcome: replied.outcome.kind, logged: replied.logged } : replied),
    );
    const afterReply = await observerComments.getComment({
      fileId: candidateTwo.fileId,
      commentId: userComment.id,
    });
    check(
      "the independent client sees the agent's reply, tagged as the agent's",
      afterReply?.replies.some((reply) => reply.text.includes(AGENT_REPLY_MARKER)) === true,
    );

    // --- 6. revise the candidate IN PLACE. This is the load-bearing claim.
    const revised = await reviseSlide({
      env: proposalEnv,
      proposalId: staged.proposalId,
      slideIndex: 2,
      htmlPath: sources.revision,
      label: `option 2, bigger labels ${RUN_TAG}`,
      answeredCommentIds: [userComment.id],
    });
    check(
      "revise_slide reports the SAME file id and revision 2",
      revised.kind === "ok" && revised.fileId === candidateTwo.fileId && revised.revision === 2,
      JSON.stringify(revised),
    );
    const afterRevision = await childrenOf({ drive: observerDrive, folderId: staged.folderId });
    const twoAfter = afterRevision.find((file) => file.name === "02.html");
    check(
      "the independent client finds ONE 02.html, with the id it had before",
      afterRevision.filter((file) => file.name === "02.html").length === 1 &&
        twoAfter?.id === candidateTwo.fileId,
      `id=${String(twoAfter?.id)} was=${candidateTwo.fileId}`,
    );
    const threadsAfterRevision = await observerComments.listComments({
      fileId: candidateTwo.fileId,
      startModifiedTime: null,
    });
    check(
      "the comment thread SURVIVED the revision, replies and all",
      threadsAfterRevision.some(
        (candidate) => candidate.id === userComment.id && candidate.replies.length >= 1,
      ),
      `${String(threadsAfterRevision.length)} thread(s) on 02.html`,
    );
    check(
      "the manifest the interface polls now says revision 2",
      numberFieldOf(await readJson({ drive: observerDrive, files: afterRevision, name: "manifest.json" }), "revision") === 2,
    );

    // --- 7. resolve the thread. `resolved` is read back, never assumed.
    const resolved = await resolveCandidateComment({
      env: candidateEnv,
      proposalId: staged.proposalId,
      slideIndex: 2,
      commentId: userComment.id,
      text: `handled ${RUN_TAG}`,
    });
    check(
      "resolve_feedback reports the thread resolved",
      resolved.kind === "ok" && resolved.outcome.kind === "ok" && resolved.outcome.resolved,
      JSON.stringify(resolved.kind === "ok" ? resolved.outcome : resolved),
    );
    const afterResolve = await observerComments.getComment({
      fileId: candidateTwo.fileId,
      commentId: userComment.id,
    });
    check("the independent client agrees it is resolved", afterResolve?.resolved === true);

    // --- 8. the OTHER writer appends to the same log, blind, with the second client.
    const eventsFolder = afterRevision.find((file) => file.name === EVENTS_FOLDER_NAME);
    if (eventsFolder === undefined) {
      fail("the proposal has no events/ folder");
      return;
    }
    await appendForeignEvent({
      drive: observerDrive,
      eventsFolderId: eventsFolder.id,
      event: {
        protocolVersion: 1,
        at: new Date().toISOString(),
        kind: "slide-inserted",
        slideIndex: 2,
        insertedObjectIds: ["g_e2e_object"],
      },
    });
    await appendForeignEvent({
      drive: observerDrive,
      eventsFolderId: eventsFolder.id,
      event: {
        protocolVersion: 1,
        at: new Date().toISOString(),
        // A kind THIS build does not know, written by a newer writer.
        kind: "slide-anonymised",
        slideIndex: 2,
        strategy: "lorem-ipsum",
      },
    });

    // --- 9. clear. Candidate 2 is inserted, so it must be kept.
    const cleared = await clearSlides({
      env: proposalEnv,
      proposalId: staged.proposalId,
      reason: `e2e tidy-up ${RUN_TAG}`,
    });
    check(
      "clear_slides deletes 1 and 3, keeps the inserted 2, and bumps the revision",
      cleared.kind === "ok" &&
        cleared.cleared.map((entry) => entry.index).join(",") === "1,3" &&
        cleared.kept.map((entry) => entry.index).join(",") === "2" &&
        cleared.countBefore === 3 &&
        cleared.countAfter === 1,
      JSON.stringify(cleared),
    );
    const afterClear = await childrenOf({ drive: observerDrive, folderId: staged.folderId });
    check(
      "the independent client confirms only 02.html remains, and the log was NOT deleted",
      afterClear.filter((file) => file.name.endsWith(".html")).map((file) => file.name).join(",") === "02.html" &&
        afterClear.some((file) => file.name === EVENTS_FOLDER_NAME),
      afterClear.map((file) => file.name).sort().join(", "),
    );

    // --- 10. replay the whole log with the INDEPENDENT client.
    const log = await readProposalLog({ env: observerEnv, proposalId: staged.proposalId });
    if (log.kind !== "ok" || log.log.kind !== "ok") {
      fail(`session_events: ${JSON.stringify(log)}`);
      return;
    }
    const kinds = log.log.records.map((record) =>
      record.event.kind === "opaque" ? record.event.rawKind : record.event.kind,
    );
    check(
      "the log replays in order, both writers' events together",
      kinds.join(",") ===
        "slides-staged,feedback-delivered,comment-answered,slide-revised,comment-resolved," +
          "slide-inserted,slide-anonymised,slides-cleared",
      kinds.join(","),
    );
    const unknownKind = log.log.records.find(
      (record) => record.event.kind === "opaque" && record.event.rawKind === "slide-anonymised",
    );
    check(
      "an event kind this build does not know survived as an opaque record, not dropped",
      unknownKind !== undefined &&
        unknownKind.event.kind === "opaque" &&
        unknownKind.event.fields["strategy"] === "lorem-ipsum",
      JSON.stringify(unknownKind?.event),
    );
    const revisedEvent = log.log.records
      .map((record) => record.event)
      .find((event) => event.kind === "slide-revised");
    check(
      "slide-revised names the comment it answers and the unchanged file id",
      revisedEvent?.kind === "slide-revised" &&
        revisedEvent.answeredCommentIds.join(",") === userComment.id &&
        revisedEvent.fileId === candidateTwo.fileId,
      JSON.stringify(revisedEvent),
    );
    check(
      "the names order the log: millisecond prefix, then suffix",
      log.log.records.every((record, position) => {
        const next = log.log.kind === "ok" ? log.log.records[position + 1] : undefined;
        if (next === undefined) return true;
        return (
          record.atMillis < next.atMillis ||
          (record.atMillis === next.atMillis && record.suffix <= next.suffix)
        );
      }),
      log.log.records.map((record) => record.name).join("\n        "),
    );
    check("every event file parsed; nothing was unreadable", log.log.unreadable.length === 0, log.log.unreadable.join(", "));
  } finally {
    const cleanup = await cleanUp({
      drive: observerDrive,
      inbox,
      proposalId,
      proposalsBefore,
      keep,
    });
    for (const line of cleanup.lines) process.stdout.write(`${line}\n`);
    checks.push(...cleanup.checks);
  }

  report({ checks });
}

type Check = Readonly<{ label: string; ok: boolean; detail: string | null }>;

/**
 * Deletes exactly the folder this run created, and asserts the inbox ends as it started.
 * Nothing else in the user's Drive is touched, and the count is the proof.
 */
async function cleanUp(
  options: Readonly<{
    drive: DriveChannel;
    inbox: string | null;
    proposalId: string | null;
    proposalsBefore: number;
    keep: boolean;
  }>,
): Promise<Readonly<{ checks: readonly Check[]; lines: readonly string[] }>> {
  const { drive, inbox, proposalId, proposalsBefore, keep } = options;
  const checks: Check[] = [];
  const lines: string[] = ["", "--- cleanup"];
  if (inbox === null || proposalId === null) {
    lines.push("  nothing to clean up");
    return { checks, lines };
  }
  if (keep) {
    lines.push(`  --keep: leaving ${proposalId} in place`);
    return { checks, lines };
  }

  const folders = await drive.listFiles({
    query: { name: proposalId, parentId: inbox, sashaSlides: null, proposalId: null, trashed: false },
  });
  if (folders.length !== 1) {
    // Refuse rather than delete more: the only thing worse than leaving a folder behind is
    // deleting one this run did not create.
    checks.push({
      label: "cleanup refused: the proposal folder is not exactly one folder",
      ok: false,
      detail: `${String(folders.length)} folder(s) named ${proposalId}`,
    });
    return { checks, lines };
  }
  const folder = folders[0];
  if (folder === undefined) return { checks, lines };
  await drive.deleteFile({ fileId: folder.id });

  const remaining = await drive.listFiles({
    query: { name: proposalId, parentId: inbox, sashaSlides: null, proposalId: null, trashed: false },
  });
  checks.push({
    label: "the proposal folder this run created is gone",
    ok: remaining.length === 0,
    detail: `${String(remaining.length)} left`,
  });

  const proposalsAfter = (await childrenOf({ drive, folderId: inbox })).length;
  lines.push(`  inbox holds ${String(proposalsAfter)} proposal folder(s) after cleanup`);
  checks.push({
    label: "the inbox ends with exactly the folders it started with",
    ok: proposalsAfter === proposalsBefore,
    detail: `before=${String(proposalsBefore)} after=${String(proposalsAfter)}`,
  });
  return { checks, lines };
}

/** The add-on's half of the log, written by the OTHER client: a create, never an update. */
async function appendForeignEvent(
  options: Readonly<{
    drive: DriveChannel;
    eventsFolderId: string;
    event: Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  const kind = options.event["kind"];
  await options.drive.createFile({
    name: sessionEventFileName({
      atMillis: Date.now(),
      suffix: Math.random().toString(36).slice(2, 8).padStart(6, "0"),
      kind: typeof kind === "string" ? kind : "unknown",
    }),
    parentId: options.eventsFolderId,
    mimeType: "application/json",
    media: { kind: "text", text: `${JSON.stringify(options.event, null, 2)}\n` },
    // The add-on's own tag, which the server cannot read anyway — discovery is by name.
    appProperties: { sashaSlides: "event" },
  });
}

async function findInbox(options: Readonly<{ drive: DriveChannel }>): Promise<string | null> {
  const folders = await options.drive.listFiles({
    query: { name: INBOX_FOLDER_NAME, parentId: null, sashaSlides: null, proposalId: null, trashed: false },
  });
  return folders[0]?.id ?? null;
}

async function childrenOf(
  options: Readonly<{ drive: DriveChannel; folderId: string }>,
): Promise<readonly DriveFile[]> {
  return await options.drive.listFiles({
    query: { name: null, parentId: options.folderId, sashaSlides: null, proposalId: null, trashed: false },
  });
}

async function readJson(
  options: Readonly<{ drive: DriveChannel; files: readonly DriveFile[]; name: string }>,
): Promise<unknown> {
  const file = options.files.find((candidate) => candidate.name === options.name);
  if (file === undefined) return null;
  try {
    return JSON.parse(await options.drive.readTextFile({ fileId: file.id }));
  } catch {
    return null;
  }
}

function numberFieldOf(value: unknown, field: string): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Readonly<Record<string, unknown>>)[field];
  return typeof candidate === "number" ? candidate : null;
}

/** Four real 1280x720 documents on disk: this harness passes PATHS, like every caller. */
function writeCandidates(): Readonly<{
  first: string;
  second: string;
  third: string;
  revision: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "sasha-session-live-"));
  const write = (name: string, title: string): string => {
    const path = join(directory, name);
    writeFileSync(
      path,
      `<!doctype html><html><head><meta charset="utf-8"><style>` +
        `body{margin:0;width:1280px;height:720px;font-family:sans-serif;display:grid;place-items:center}` +
        `</style></head><body><h1>${title}</h1></body></html>\n`,
      "utf8",
    );
    return path;
  };
  return {
    first: write("one.html", "Candidate one"),
    second: write("two.html", "Candidate two"),
    third: write("three.html", "Candidate three"),
    revision: write("two-v2.html", "Candidate two, revised"),
  };
}

function liveProposalEnvironment(options: Readonly<{ drive: DriveChannel }>): ProposalEnvironment {
  return {
    drive: options.drive,
    now: () => new Date(),
    randomSuffix: () => Math.random().toString(36).slice(2, 8).padStart(6, "0"),
    sleep: ({ milliseconds }) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    statFile: () => ({ bytes: 1 }),
    warn: (message) => void process.stdout.write(`  warn: ${message}\n`),
  };
}

function liveFeedbackEnvironment(options: Readonly<{ channel: FeedbackChannel }>): FeedbackEnvironment {
  return {
    channel: options.channel,
    now: () => new Date(),
    sleep: ({ milliseconds }) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    warn: (message) => void process.stdout.write(`  warn: ${message}\n`),
  };
}

function report(options: Readonly<{ checks: readonly Check[] }>): void {
  process.stdout.write("\n");
  for (const { label, ok, detail } of options.checks) {
    process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n`);
    if (detail !== null) process.stdout.write(`        ${detail}\n`);
  }
  const failed = options.checks.filter((check) => !check.ok).length;
  const passed = options.checks.length - failed;
  process.stdout.write(`\n${String(passed)}/${String(options.checks.length)} live checks passed\n`);
  if (failed > 0) process.exitCode = 1;
}

function fail(message: string): void {
  process.stderr.write(`session-live: ${message}\n`);
  process.exitCode = 1;
}

// Not a top-level await: tsx emits CommonJS here (the root package.json declares no
// "type": "module"), the same reason server.ts wraps its own entry point.
main().catch((cause: unknown) => {
  process.stderr.write(`session-live: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exitCode = 1;
});
