import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposal, listOpenWork, type ProposalEnvironment } from "../proposal.ts";
import type { FeedbackEnvironment } from "../feedback/feedback.ts";
import { createFakeDrive } from "./fake-drive.ts";
import { createFakeComments } from "./fake-comments.ts";

/**
 * THE USER SHOULD NEVER HAVE TO TYPE AN IDENTIFIER.
 *
 * The add-on's "nothing is listening" notice told the user to paste
 * "call await_feedback for proposal p_1791145806407_yig6ws", and the user asked why an opaque
 * id is in a sentence written for a person.
 *
 * Making the PRESENTATION the identifier does not work: comments live on the candidate files
 * rather than on the deck, `manifest.presentationId` is optional and in practice null, and the
 * brokered `drive.file` scope cannot read a deck this connector did not create. So the sentence
 * gets no identifier at all -- `open_work` answers "what is waiting for me?" from the
 * authenticated caller alone and hands the id back for the MODEL to use.
 */

const FIXED_NOW = Date.parse("2026-10-04T12:00:00.000Z");

function slidePath(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "sasha-open-work-")), "slide.html");
  writeFileSync(path, `<!doctype html><html><body>${body}</body></html>`);
  return path;
}

type Harness = Readonly<{
  proposal: ProposalEnvironment;
  feedback: FeedbackEnvironment;
  comments: ReturnType<typeof createFakeComments>;
  tick: (milliseconds: number) => void;
}>;

function harness(): Harness {
  let clock = FIXED_NOW;
  const now = (): Date => new Date(clock);
  const drive = createFakeDrive();
  const comments = createFakeComments({ now, pageObjectIds: ["p"], defaultFileId: "unused-deck" });
  let suffix = 0;
  return {
    proposal: {
      drive: drive.channel,
      now,
      // Distinct and ASCENDING, because a proposal id is the only thing that orders proposals.
      randomSuffix: () => `aaaaa${String(suffix++)}`,
      sleep: async () => undefined,
      statFile: () => ({ bytes: 64 }),
      warn: () => undefined,
    },
    feedback: { channel: comments.channel, now, sleep: async () => undefined, warn: () => undefined },
    comments,
    tick: (milliseconds) => {
      clock += milliseconds;
    },
  };
}

async function stage(options: Readonly<{ built: Harness; label: string }>): Promise<Readonly<{ proposalId: string; firstFileId: string }>> {
  const made = await createProposal({
    env: options.built.proposal,
    slides: [{ path: slidePath(options.label), label: options.label }],
    presentationId: null,
  });
  assert.equal(made.kind, "ok", `staging ${options.label} failed: ${JSON.stringify(made)}`);
  if (made.kind !== "ok") throw new Error("unreachable");
  const first = made.slides[0];
  assert.ok(first !== undefined);
  return { proposalId: made.proposalId, firstFileId: first.fileId };
}

test("with nothing staged, open_work says so rather than inventing a proposal", async () => {
  const built = harness();
  const work = await listOpenWork({ env: built.proposal, feedback: built.feedback });
  assert.deepEqual(work, { kind: "ok", items: [] });
});

test("a staged proposal is open work, with its candidates counted", async () => {
  const built = harness();
  const only = await stage({ built, label: "only" });
  const work = await listOpenWork({ env: built.proposal, feedback: built.feedback });
  assert.equal(work.kind, "ok");
  if (work.kind !== "ok") return;
  assert.deepEqual(work.items, [
    { proposalId: only.proposalId, candidateCount: 1, unresolved: 0, unreadableReason: null },
  ]);
});

test("with nothing commented on, the newest proposal leads", async () => {
  const built = harness();
  await stage({ built, label: "older" });
  built.tick(60_000);
  const newer = await stage({ built, label: "newer" });
  const work = await listOpenWork({ env: built.proposal, feedback: built.feedback });
  assert.equal(work.kind, "ok");
  if (work.kind !== "ok") return;
  assert.equal(work.items.length, 2);
  assert.equal(work.items[0]?.proposalId, newer.proposalId);
});

/**
 * The reason this is not simply "the newest": the newest proposal is usually the one already
 * dealt with, and pointing a session at it is pointing it away from the thing being waited on.
 */
test("an unanswered comment outranks being newer", async () => {
  const built = harness();
  const older = await stage({ built, label: "older" });
  built.tick(60_000);
  await stage({ built, label: "newer" });
  built.comments.putUserComment({ text: "the borders are uneven", anchor: null, fileId: older.firstFileId });

  const work = await listOpenWork({ env: built.proposal, feedback: built.feedback });
  assert.equal(work.kind, "ok");
  if (work.kind !== "ok") return;
  assert.equal(work.items[0]?.proposalId, older.proposalId, "the one with an open comment leads");
  assert.equal(work.items[0]?.unresolved, 1);
  assert.equal(work.items[1]?.unresolved, 0);
});
