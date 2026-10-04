// The READY-observer state machine, end to end against a fake Drive: reducer, effect executor, the
// inbox NAME WALK, poll cadence, backoff and the persisted `seen` set. No network, no Apps Script,
// no timers (the timer is injected and fired by hand), so the whole file runs in milliseconds.
//
// The fake is a real folder tree, so "discovery is by NAME, not by appProperties" is a property the
// tests can actually fail on: a correctly tagged READY in the wrong folder must stay invisible.

import assert from "node:assert/strict";
import test from "node:test";
import type { ProposalMark } from "./bridge.ts";
import { FOLDER_MIME_TYPE, fakeDrive, type FakeDrive } from "./fake-drive.ts";
import { nextCandidate, pollDelayMs, type Viewers } from "./observer.ts";
import {
  createObserver,
  fetchProposal,
  type Announcer,
  type Observer,
  type PollTimer,
  type SeenStore,
} from "./observer-runtime.ts";
import type { Proposal } from "./observer.ts";

test("no open picker means no polling at all", async () => {
  const harness = await observerHarness();
  await harness.viewers({ count: 0, anyVisible: false });
  assert.equal(harness.drive.files().length, 0);
  assert.equal(harness.timer.pending(), null);
  assert.equal(harness.observer.snapshot().phase.kind, "stopped");
});

test("a visible sidebar polls at 5 s and a hidden one at 30 s", async () => {
  const harness = await observerHarness();
  await harness.viewers({ count: 1, anyVisible: true });
  assert.equal(harness.timer.pending(), 5_000);
  await harness.viewers({ count: 1, anyVisible: false });
  assert.equal(harness.timer.pending(), 30_000);
});

test("a READY proposal is offered with 1-based slides and the folder it must write PICK into", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_1", count: 3, presentationId: "deck_1" });
  await harness.viewers({ count: 1, anyVisible: true });

  const offered = harness.announced();
  assert.equal(offered.length, 1);
  const proposal = offered[0];
  assert.ok(proposal !== undefined);
  assert.equal(proposal.proposalId, "p_1");
  assert.equal(proposal.count, 3);
  assert.equal(proposal.presentationId, "deck_1");
  assert.equal(proposal.folderId, "folder_p_1");
  assert.deepEqual(
    proposal.slides.map((slide) => slide.index),
    [1, 2, 3],
  );
  assert.equal(harness.observer.snapshot().phase.kind, "offering");
});

test("a proposal folder with every slide and a manifest but no READY yet is invisible", async () => {
  const harness = await observerHarness();
  // A REAL proposal folder under the inbox, fully staged except for the final mark -- which is the
  // only thing that makes the name walk skip it.
  harness.drive.stageProposal({ proposalId: "p_partial", count: 3, presentationId: null, ready: false });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
  assert.equal(harness.observer.snapshot().phase.kind, "waiting");
});

test("a READY outside the inbox is not a proposal -- discovery is a NAME walk, not a file search", async () => {
  const harness = await observerHarness();
  harness.drive.put({
    id: "stray_folder",
    name: "p_stray",
    createdTime: "2026-10-03T12:00:00.000Z",
    parents: ["somewhere_else"],
    mimeType: FOLDER_MIME_TYPE,
    appProperties: {},
    body: "",
  });
  harness.drive.put({
    id: "stray_ready",
    name: "READY",
    createdTime: "2026-10-03T12:00:01.000Z",
    parents: ["stray_folder"],
    mimeType: "application/json",
    appProperties: { sashaSlides: "ready", proposalId: "p_stray" },
    body: JSON.stringify({ protocolVersion: 1, proposalId: "p_stray", count: 1, manifestFileId: "nope" }),
  });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
});

test("a READY whose body names another proposal is rejected against its FOLDER name", async () => {
  const drive = fakeDrive();
  drive.put({
    id: "ready_mismatch",
    name: "READY",
    createdTime: "2026-10-03T12:00:00.000Z",
    parents: ["folder_p_claimed"],
    mimeType: "application/json",
    appProperties: {},
    body: JSON.stringify({ protocolVersion: 1, proposalId: "p_other", count: 1, manifestFileId: "m" }),
  });
  const loaded = await fetchProposal({
    drive: drive.api,
    // Discovery is by name, so THIS is the folder's name -- there are no appProperties to consult.
    proposalId: "p_claimed",
    readyFileId: "ready_mismatch",
    folderId: "folder_p_claimed",
  });
  assert.equal(loaded.kind, "rejected");
  assert.match(loaded.kind === "rejected" ? loaded.reason : "", /its folder p_claimed/);
});

test("nextCandidate skips partial and answered folders and takes the oldest of the rest", () => {
  const marks = [
    { proposalId: "p_partial", folderId: "f1", readyFileId: null, pickFileId: null, createdTime: "1" },
    { proposalId: "p_done", folderId: "f2", readyFileId: "r2", pickFileId: "k2", createdTime: "2" },
    { proposalId: "p_seen", folderId: "f3", readyFileId: "r3", pickFileId: null, createdTime: "3" },
    { proposalId: "p_next", folderId: "f4", readyFileId: "r4", pickFileId: null, createdTime: "4" },
    { proposalId: "p_later", folderId: "f5", readyFileId: "r5", pickFileId: null, createdTime: "5" },
  ] as const satisfies readonly ProposalMark[];
  assert.deepEqual(nextCandidate({ marks, seenProposalIds: ["p_seen"] }), {
    proposalId: "p_next",
    readyFileId: "r4",
    folderId: "f4",
  });
  assert.equal(nextCandidate({ marks: [], seenProposalIds: [] }), null);
  assert.equal(
    nextCandidate({ marks, seenProposalIds: ["p_seen", "p_next", "p_later"] }),
    null,
    "every unanswered folder having been seen means nothing is left to offer",
  );
});

test("a proposal that already has a PICK is never offered again", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_answered", count: 2, presentationId: null });
  harness.drive.put({
    id: "pick_answered",
    name: "PICK",
    createdTime: "2026-10-03T12:00:01.000Z",
    parents: [harness.drive.proposalFolderId("p_answered")],
    mimeType: "application/json",
    appProperties: { sashaSlides: "pick", proposalId: "p_answered" },
    body: "{}",
  });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
});

test("an unknown protocolVersion is ignored with a warning and never retried", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_future", count: 1, presentationId: null, protocolVersion: 99 });
  await harness.viewers({ count: 1, anyVisible: true });

  assert.deepEqual(harness.announced(), []);
  assert.ok(harness.warnings().some((warning) => warning.includes("protocolVersion 99")));
  assert.deepEqual(await harness.seen.read(), ["p_future"]);

  // The next poll must not reload it: that is what marking it seen is for.
  const callsBefore = harness.warnings().length;
  await harness.tick();
  assert.equal(harness.warnings().length, callsBefore);
});

test("a transport failure backs off, keeps the proposal unanswered, and succeeds on retry", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_flaky", count: 1, presentationId: null });
  harness.drive.failNext(2, "503 from Drive");

  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
  assert.equal(harness.observer.snapshot().consecutiveFailures, 1);
  assert.equal(harness.timer.pending(), 10_000, "5 s doubled once");
  assert.deepEqual(await harness.seen.read(), [], "a transport failure must not mark it answered");

  await harness.tick();
  assert.equal(harness.observer.snapshot().consecutiveFailures, 2);
  assert.ok(harness.troubles().length > 0, "two failures in a row are announced to the user");

  await harness.tick();
  assert.equal(harness.announced().length, 1);
  assert.equal(harness.observer.snapshot().consecutiveFailures, 0);
});

test("resolving an offer persists it and polls again immediately", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_a", count: 1, presentationId: null, createdTime: "2026-10-03T12:00:00.000Z" });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.equal(harness.announced().length, 1);

  harness.drive.stageProposal({ proposalId: "p_b", count: 2, presentationId: null, createdTime: "2026-10-03T12:05:00.000Z" });
  harness.observer.dispatch({ kind: "resolved", proposalId: "p_a", nowMs: 0 });
  await harness.observer.settled();

  assert.deepEqual(await harness.seen.read(), ["p_a"]);
  assert.deepEqual(
    harness.announced().map((proposal) => proposal.proposalId),
    ["p_a", "p_b"],
    "the queued proposal is offered without waiting for the next tick",
  );
});

test("a viewer that appears after the offer still hears about it", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_1", count: 1, presentationId: null });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.equal(harness.announced().length, 1);

  await harness.viewers({ count: 2, anyVisible: true });
  assert.equal(harness.announced().length, 2, "re-announced, so the new tab can render it");
  assert.equal(harness.announced()[1]?.proposalId, "p_1");
});

test("the restored seen set suppresses a proposal from a previous session", async () => {
  const harness = await observerHarness({ seeded: ["p_old"] });
  harness.drive.stageProposal({ proposalId: "p_old", count: 1, presentationId: null });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
});

test("pollDelayMs backs off exponentially and is capped", () => {
  const visible: Viewers = { count: 1, anyVisible: true };
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 0 }), 5_000);
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 1 }), 10_000);
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 4 }), 80_000);
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 40 }), 80_000, "4 doublings is the limit");
  const hidden: Viewers = { count: 1, anyVisible: false };
  assert.equal(pollDelayMs({ viewers: hidden, consecutiveFailures: 0 }), 30_000);
  assert.equal(pollDelayMs({ viewers: hidden, consecutiveFailures: 4 }), 120_000, "capped, not 480 s");
});

type Harness = Readonly<{
  drive: FakeDrive;
  observer: Observer;
  seen: SeenStore;
  timer: Readonly<{ pending(): number | null; fire(): void }>;
  viewers(viewers: Viewers): Promise<void>;
  tick(): Promise<void>;
  announced(): readonly Proposal[];
  troubles(): readonly string[];
  warnings(): readonly string[];
}>;

async function observerHarness({ seeded = [] }: { seeded?: readonly string[] } = {}): Promise<Harness> {
  const drive = fakeDrive();
  const announced: Proposal[] = [];
  const troubles: string[] = [];
  const warnings: string[] = [];
  const announcer: Announcer = {
    proposal(proposal) {
      announced.push(proposal);
    },
    trouble(message) {
      troubles.push(message);
    },
  };

  let scheduled: Readonly<{ delayMs: number; fire: () => void }> | null = null;
  const timer: PollTimer = {
    schedule(spec) {
      scheduled = spec;
    },
    cancel() {
      scheduled = null;
    },
  };

  let persisted: readonly string[] = seeded;
  const seen: SeenStore = {
    async read() {
      return persisted;
    },
    async write(seenProposalIds) {
      persisted = seenProposalIds;
    },
  };

  const observer = createObserver({
    drive: drive.api,
    announcer,
    timer,
    seen,
    log: { warn: (message) => warnings.push(message) },
    nowMs: () => 0,
  });
  await observer.start();

  return {
    drive,
    observer,
    seen,
    timer: {
      pending: () => scheduled?.delayMs ?? null,
      fire: () => scheduled?.fire(),
    },
    async viewers(viewers) {
      observer.dispatch({ kind: "viewers-changed", viewers, nowMs: 0 });
      await observer.settled();
    },
    async tick() {
      const pending = scheduled;
      assert.ok(pending !== null, "expected a poll to be scheduled");
      scheduled = null;
      pending.fire();
      await observer.settled();
    },
    announced: () => announced,
    troubles: () => troubles,
    warnings: () => warnings,
  };
}
